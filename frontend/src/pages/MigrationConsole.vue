<script setup lang="ts">
/**
 * /migrations 并站迁移台
 * 两站并网后楼栋分批划到新站：选来源站 / 目标站 / 生效时点与楼栋批次，
 * 先列出受影响阀门与未完调节单；待下发或已调节未复核的单子先挡住迁移。
 * 确认前楼栋或阀门被别人改过：整包不写入并保留原数据；
 * 楼栋归属、阀门冗余站标识、迁移记录三处同事务写入，失败回滚到迁移前。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { MessagePlugin, DialogPlugin } from 'tdesign-vue-next'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useStationStore } from '@/stores/stationStore'
import { useValveStore } from '@/stores/valveStore'
import { useAdjustStore } from '@/stores/adjustStore'
import { useMigrationStore } from '@/stores/migrationStore'
import { MigrationConflictError } from '@/utils/migration'
import { formatEffectiveAt, migrationStatusAt, parseEffectiveAt } from '@/types/migration'

const stationStore = useStationStore()
const valveStore = useValveStore()
const adjustStore = useAdjustStore()
const migrationStore = useMigrationStore()

/* ------------------------------ 迁移表单 ------------------------------ */

const form = reactive({
  sourceStationId: '',
  targetStationId: '',
  /** YYYY-MM-DD HH:mm 文本输入 */
  effectiveText: defaultEffectiveText(),
  buildingIds: [] as string[],
  operator: '',
  remark: ''
})

function defaultEffectiveText(): string {
  const date = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

const stationOptions = computed(() =>
  stationStore.stations.map((station) => ({ label: station.name, value: station.id }))
)

/** 来源站下楼栋（台账当前仍挂在来源站，已划走的不再出现） */
const sourceBuildings = computed(() =>
  stationStore.buildings
    .filter((building) => building.stationId === form.sourceStationId)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
)

/** 已处于待生效迁移中的楼栋不允许重复排期 */
const pendingBuildingIds = computed(() => {
  const now = Date.now()
  const set = new Set<string>()
  migrationStore.migrations.forEach((migration) => {
    if (migration.effectiveAt > now) migration.buildingIds.forEach((id) => set.add(id))
  })
  return set
})

const buildingTableData = computed(() =>
  sourceBuildings.value.map((building) => ({
    id: building.id,
    name: building.name,
    areaM2: building.areaM2,
    heatMode: building.heatMode,
    valveCount: valveStore.valves.filter((valve) => valve.buildingId === building.id).length,
    pendingMigration: pendingBuildingIds.value.has(building.id),
    revision: building.revision ?? 0
  }))
)

const selectedBuildingRows = computed(() =>
  buildingTableData.value.filter((row) => form.buildingIds.includes(row.id))
)

const effectiveAt = computed(() => parseEffectiveAt(form.effectiveText))

const formInvalid = computed(() => {
  if (!form.sourceStationId || !form.targetStationId) return '请先选择来源站与目标站'
  if (form.sourceStationId === form.targetStationId) return '来源站与目标站不能相同'
  if (effectiveAt.value === null) return '生效时点格式应为 YYYY-MM-DD HH:mm'
  if (form.buildingIds.length === 0) return '请勾选至少一栋要划出的楼栋'
  if (form.buildingIds.some((id) => pendingBuildingIds.value.has(id))) return '选中楼栋已排期待生效迁移，不能重复排期'
  return ''
})

/* ------------------------------ 实时预检 ------------------------------ */

watch(
  () => [form.sourceStationId, form.targetStationId, form.effectiveText, [...form.buildingIds].sort().join(',')],
  () => {
    const at = effectiveAt.value
    if (!form.sourceStationId || !form.targetStationId || form.buildingIds.length === 0 || at === null) {
      migrationStore.clearPreview()
      return
    }
    void migrationStore.runPreview({
      sourceStationId: form.sourceStationId,
      targetStationId: form.targetStationId,
      effectiveAt: at,
      buildingIds: [...form.buildingIds]
    })
  },
  { immediate: true }
)

const preview = computed(() => migrationStore.preview)
const blockerCount = computed(() => preview.value?.blockers.length ?? 0)
const canCommit = computed(() => formInvalid.value === '' && blockerCount.value === 0 && preview.value !== null)

const affectedColumns = [
  { colKey: 'code', title: '阀门编号', width: 130 },
  { colKey: 'buildingName', title: '楼栋', width: 120 },
  { colKey: 'dn', title: '口径', width: 80 },
  { colKey: 'position', title: '位置', width: 100 },
  { colKey: 'opening', title: '当前开度', width: 90 },
  { colKey: 'revision', title: '数据版本', width: 90 },
  { colKey: 'openAdjust', title: '未完调节单', width: 160 }
]

const affectedTableData = computed(() => {
  if (!preview.value) return []
  const blockerMap = new Map(preview.value.blockers.map((item) => [item.valveId, item]))
  return preview.value.valves.map((valve) => {
    const blocker = blockerMap.get(valve.id)
    return {
      id: valve.id,
      code: valve.code,
      buildingName:
        preview.value?.buildings.find((building) => building.id === valve.buildingId)?.name ?? '—',
      dn: `DN${valve.dn}`,
      position: valve.position,
      opening: `${valve.currentOpening}%`,
      revision: `v${valve.revision ?? 0}`,
      openAdjust: blocker ? blocker.state : ''
    }
  })
})

/* ------------------------------ 提交迁移 ------------------------------ */

const submitting = ref(false)

function confirmCommit(): void {
  if (!canCommit.value || !preview.value || effectiveAt.value === null) return
  const effective = effectiveAt.value
  const sourceName = stationStore.stationById.get(form.sourceStationId)?.name ?? '来源站'
  const targetName = stationStore.stationById.get(form.targetStationId)?.name ?? '目标站'
  const dialog = DialogPlugin.confirm({
    header: '确认整包迁移',
    body: () =>
      [
        `${form.buildingIds.length} 栋楼（${selectedBuildingRows.value.map((row) => row.name).join('、')}）将由「${sourceName}」整批划到「${targetName}」。`,
        `生效时点：${formatEffectiveAt(effective)}。`,
        '楼栋归属、阀门冗余站标识与迁移记录三处一起写入；确认前数据若被他人改过，整包不写入并保留原数据。'
      ].join('\n'),
    confirmBtn: '确认迁移',
    cancelBtn: '取消',
    onConfirm: async () => {
      dialog.hide()
      await doCommit()
    },
    style: 'white-space: pre-line; line-height: 1.9'
  })
}

async function doCommit(): Promise<void> {
  if (!preview.value || effectiveAt.value === null) return
  submitting.value = true
  try {
    // 预检页持有的 revision 快照随确认一起带上，事务内重新读取核对
    const expectedBuildingRevisions: Record<string, number> = {}
    const expectedValveRevisions: Record<string, number> = {}
    preview.value.buildings.forEach((building) => {
      expectedBuildingRevisions[building.id] = building.revision ?? 0
    })
    preview.value.valves.forEach((valve) => {
      expectedValveRevisions[valve.id] = valve.revision ?? 0
    })
    const record = await migrationStore.commit({
      sourceStationId: form.sourceStationId,
      targetStationId: form.targetStationId,
      buildingIds: [...form.buildingIds],
      effectiveAt: effectiveAt.value,
      operator: form.operator.trim() || '未署名',
      remark: form.remark.trim(),
      expectedBuildingRevisions,
      expectedValveRevisions
    })
    MessagePlugin.success(
      `迁移批次 ${record.id.slice(-6)} 已写入：${record.buildingIds.length} 栋楼 / ${record.valveIds.length} 只阀门，${formatEffectiveAt(record.effectiveAt)} 起走新站`
    )
    resetForm()
    // 立即生效的批次已在事务内翻牌；顺带激活其他刚到点的预约批次
    await migrationStore.activateDue()
  } catch (error) {
    if (error instanceof MigrationConflictError) {
      MessagePlugin.error(`迁移已中止，原数据未改动：${error.message}`)
    } else {
      MessagePlugin.error(
        `迁移失败，已恢复迁移前数据：${error instanceof Error ? error.message : '未知错误'}`
      )
    }
  } finally {
    submitting.value = false
  }
}

function resetForm(): void {
  form.sourceStationId = ''
  form.targetStationId = ''
  form.effectiveText = defaultEffectiveText()
  form.buildingIds = []
  form.operator = ''
  form.remark = ''
  migrationStore.clearPreview()
}

/* ------------------------------ 迁移记录 ------------------------------ */

const recordColumns = [
  { colKey: 'effectiveAt', title: '生效时点', width: 160, cell: 'effectiveCell' },
  { colKey: 'route', title: '迁移去向', minWidth: 220, cell: 'routeCell' },
  { colKey: 'buildings', title: '楼栋批次', minWidth: 200, cell: 'buildingsCell' },
  { colKey: 'valves', title: '受影响阀门', width: 200, cell: 'valvesCell' },
  { colKey: 'operator', title: '经办人', width: 100 },
  { colKey: 'status', title: '状态', width: 100, cell: 'statusCell' },
  { colKey: 'remark', title: '备注', minWidth: 200 }
]

const recordRows = computed(() =>
  migrationStore.migrations.map((migration) => ({
    id: migration.id,
    effectiveAt: migration.effectiveAt,
    sourceName: stationStore.stationById.get(migration.sourceStationId)?.name ?? `已删除站(${migration.sourceStationId})`,
    targetName: stationStore.stationById.get(migration.targetStationId)?.name ?? `已删除站(${migration.targetStationId})`,
    buildingNames: migration.buildingNames,
    valveCodes: migration.valveCodes,
    operator: migration.operator,
    status: migrationStatusAt(migration.effectiveAt),
    remark: migration.remark
  }))
)

function recordRowKey(row: { id: string }): string {
  return row.id
}

/* ------------------------------ 汇总徽标 ------------------------------ */

const stats = computed(() => ({
  total: migrationStore.migrations.length,
  pending: migrationStore.pendingCount,
  effective: migrationStore.migrations.length - migrationStore.pendingCount,
  openAdjusts: adjustStore.adjusts.filter((item) => item.state !== '已复核').length
}))

// 进入迁移台先把已到点的预约批次物理激活（幂等），再展示预检与记录
onMounted(() => {
  void migrationStore.activateDue().then((result) => {
    if (result.skipped.length > 0) {
      MessagePlugin.warning(
        `${result.skipped.length} 个到点批次仍有未完调节单，已暂缓翻牌：${result.skipped
          .map((item) => item.migration.buildingNames.join('、'))
          .join('；')}`
      )
    }
  })
})
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-head__title">并站迁移台</h2>
        <p class="page-head__desc">
          两站并网后楼栋分批划到新站：生效后排行、录实测、派单走新站；生效前的实测、调节单与导出仍认原站，不追溯改站。
        </p>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="迁移批次" :value="stats.total" suffix="批" tone="primary" />
      <StatBadge label="待生效" :value="stats.pending" suffix="批" tone="warning" />
      <StatBadge label="已生效" :value="stats.effective" suffix="批" tone="success" />
      <StatBadge label="全站未完调节单" :value="stats.openAdjusts" suffix="张" tone="danger" />
    </div>

    <div class="grid-migration">
      <!-- 左：批次编排 -->
      <div class="panel">
        <h3 class="panel-title">编排迁移批次</h3>

        <t-form :data="form" label-width="96px">
          <t-form-item label="来源站" required-mark>
            <t-select
              v-model="form.sourceStationId"
              :options="stationOptions"
              placeholder="选择划出楼栋的换热站"
              clearable
            />
          </t-form-item>
          <t-form-item label="目标站" required-mark>
            <t-select
              v-model="form.targetStationId"
              :options="stationOptions"
              placeholder="选择接收楼栋的换热站"
              clearable
            />
          </t-form-item>
          <t-form-item label="生效时点" required-mark>
            <t-input v-model="form.effectiveText" placeholder="YYYY-MM-DD HH:mm，如 2024-11-21 08:00" />
          </t-form-item>
          <t-form-item label="经办人">
            <t-input v-model="form.operator" placeholder="如 调度室 / 王海" />
          </t-form-item>
          <t-form-item label="批次备注">
            <t-textarea v-model="form.remark" :autosize="{ minRows: 2, maxRows: 4 }" placeholder="如 并网第二批，7号楼切新站" />
          </t-form-item>
        </t-form>

        <div class="panel-head" style="margin-top: 4px">
          <h4 class="building-pick-title">勾选划出楼栋（{{ form.buildingIds.length }} / {{ buildingTableData.length }}）</h4>
          <t-button
            size="small"
            variant="text"
            theme="primary"
            :disabled="sourceBuildings.length === 0"
            @click="
              form.buildingIds =
                form.buildingIds.length === buildingTableData.filter((r) => !r.pendingMigration).length
                  ? []
                  : buildingTableData.filter((r) => !r.pendingMigration).map((r) => r.id)
            "
          >
            全选 / 反选
          </t-button>
        </div>

        <EmptyPanel
          v-if="!form.sourceStationId"
          title="先选择来源站"
          description="选定来源换热站后，这里会列出其名下可划出的楼栋。"
          compact
        />
        <EmptyPanel
          v-else-if="buildingTableData.length === 0"
          title="来源站下暂无可迁移楼栋"
          description="该站名下楼栋已全部划走，或还没有登记楼栋。"
          compact
        />
        <t-table
          v-else
          :data="buildingTableData"
          row-key="id"
          bordered
          stripe
          size="small"
          :columns="[
            { colKey: 'check', title: '', width: 44, cell: 'checkCell' },
            { colKey: 'name', title: '楼栋', width: 120 },
            { colKey: 'heatMode', title: '供热方式', width: 100 },
            { colKey: 'areaM2', title: '面积(m²)', width: 100 },
            { colKey: 'valveCount', title: '阀门', width: 70 },
            { colKey: 'pendingMigration', title: '排期', width: 110, cell: 'pendingCell' }
          ]"
        >
          <template #checkCell="{ row }">
            <t-checkbox
              :checked="form.buildingIds.includes(row.id)"
              :disabled="row.pendingMigration"
              @change="
                (checked: boolean) =>
                  (form.buildingIds = checked
                    ? [...form.buildingIds, row.id]
                    : form.buildingIds.filter((id) => id !== row.id))
              "
            />
          </template>
          <template #pendingCell="{ row }">
            <t-tag v-if="row.pendingMigration" size="small" theme="warning" variant="light">待生效中</t-tag>
            <span v-else class="muted">可迁移</span>
          </template>
        </t-table>

        <div v-if="formInvalid" class="form-tip is-warn">{{ formInvalid }}</div>
      </div>

      <!-- 右：预检结果 -->
      <div class="panel">
        <h3 class="panel-title">预检：受影响阀门与未完调节单</h3>

        <template v-if="preview">
          <t-alert
            v-if="blockerCount > 0"
            theme="error"
            :message="`${blockerCount} 张未完调节单挡住本批迁移，请先下发执行并复核闭环（或撤单）后再迁移`"
            style="margin-bottom: 12px"
          />
          <t-alert
            v-else
            theme="success"
            message="未完调节单检查通过：受影响阀门均无待下发 / 已调节未复核单据，可以迁移"
            style="margin-bottom: 12px"
          />

          <div class="preview-meta">
            <span class="muted">受影响楼栋</span>
            <strong>{{ preview.buildings.length }}</strong>
            <span class="muted">受影响阀门</span>
            <strong>{{ preview.valves.length }}</strong>
            <span class="muted">未完调节单</span>
            <strong :style="{ color: blockerCount > 0 ? '#c0392b' : undefined }">{{ blockerCount }}</strong>
          </div>

          <t-table
            :data="affectedTableData"
            :columns="affectedColumns"
            row-key="id"
            bordered
            size="small"
            style="margin-top: 10px"
          >
            <template #openAdjust="{ row }">
              <t-tag v-if="row.openAdjust" size="small" theme="danger" variant="light">
                {{ row.openAdjust }} · 未完
              </t-tag>
              <t-tag v-else size="small" theme="success" variant="light">无未完单</t-tag>
            </template>
          </t-table>

          <t-alert
            theme="info"
            message="提交时会在事务内再次核对：未完调节单可能在预检后新增；楼栋/阀门版本号若已被他人改动，整包不写入并保留原数据。"
            style="margin-top: 12px"
          />

          <div class="toolbar" style="margin-top: 14px; justify-content: flex-end">
            <t-button variant="outline" @click="resetForm">清空重选</t-button>
            <t-button theme="danger" :loading="submitting" :disabled="!canCommit" @click="confirmCommit">
              确认整包迁移
            </t-button>
          </div>
        </template>

        <EmptyPanel
          v-else
          title="尚未形成迁移批次"
          description="在左侧选好来源站、目标站、生效时点并勾选楼栋后，这里实时列出受影响阀门与未完调节单。"
          compact
        />
      </div>
    </div>

    <!-- 迁移记录 -->
    <div class="panel" style="margin-top: 16px">
      <div class="panel-head">
        <h3 class="panel-title" style="margin: 0">迁移记录（{{ recordRows.length }}）</h3>
        <span class="muted">记录只追加不删改；生效前的历史数据按当时归属认原站</span>
      </div>
      <EmptyPanel
        v-if="recordRows.length === 0"
        title="还没有迁移记录"
        description="完成首个迁移批次后，楼栋归属、阀门冗余站与迁移记录会三处一起写入。"
        compact
      />
      <t-table
        v-else
        :data="recordRows"
        :columns="recordColumns"
        :row-key="recordRowKey"
        bordered
        stripe
        size="small"
      >
        <template #effectiveCell="{ row }">{{ formatEffectiveAt(row.effectiveAt) }}</template>
        <template #routeCell="{ row }">
          <span>{{ row.sourceName }}</span>
          <span class="muted"> → </span>
          <strong>{{ row.targetName }}</strong>
        </template>
        <template #buildingsCell="{ row }">
          <t-tag
            v-for="name in row.buildingNames"
            :key="name"
            size="small"
            variant="light"
            theme="primary"
            style="margin: 2px"
          >
            {{ name }}
          </t-tag>
        </template>
        <template #valvesCell="{ row }">
          <span class="muted">{{ row.valveCodes.join('、') || '—' }}</span>
        </template>
        <template #statusCell="{ row }">
          <t-tag size="small" :theme="row.status === '已生效' ? 'success' : 'warning'" variant="light">
            {{ row.status }}
          </t-tag>
        </template>
      </t-table>
    </div>

    <!-- 口径说明 -->
    <div class="panel" style="margin-top: 16px">
      <h3 class="panel-title">认账口径</h3>
      <ul class="rule-list">
        <li>生效时点之后：失衡度排行、实测录入、调节单派单与阀门归属一律走目标站。</li>
        <li>生效时点之前：历史实测按实测日期、调节单按派单时间认来源站，导出同样保留原站，楼栋改挂不追溯改站。</li>
        <li>未完调节单（待下发、已调节未复核）未闭环前，涉及阀门所在楼栋不能迁移。</li>
        <li>楼栋归属、阀门冗余站标识、迁移记录在同一事务内写入；确认前被他人修订则整包不写入，写入失败恢复迁移前数据。</li>
        <li>生效时点在未来的预约批次只先登记迁移记录，待生效期间仍认来源站；到点后自动激活补齐楼栋归属与阀门冗余站。</li>
        <li>旧备份导入：缺迁移记录与归属快照时，历史数据按迁移时效解析兜底，不强制补写。</li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.grid-migration {
  display: grid;
  grid-template-columns: minmax(320px, 420px) 1fr;
  gap: 16px;
  align-items: start;
}

@media (max-width: 1080px) {
  .grid-migration {
    grid-template-columns: 1fr;
  }
}

.building-pick-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.preview-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
  padding: 10px 14px;
  background: #fdfaf6;
  border: 1px solid var(--hg-line);
  border-radius: 8px;
}

.form-tip {
  margin-top: 12px;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 13px;
}

.form-tip.is-warn {
  color: #b35c00;
  background: #fdf3e3;
  border: 1px solid #f0d9b0;
}

.rule-list {
  margin: 0;
  padding-left: 20px;
  color: var(--hg-ink-soft);
  font-size: 13px;
  line-height: 2;
}
</style>
