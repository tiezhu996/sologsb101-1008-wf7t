<script setup lang="ts">
/**
 * /migration 并网迁移台
 * 选择来源站、目标站与生效时点，勾选要划走的楼栋后先预演：
 * 列出受影响阀门与未完调节单；有未下发或已调节未复核单子时硬性挡住迁移。
 * 确认时整包写入（楼栋归属 / 阀门冗余站标识 / 迁移记录同一事务），
 * 乐观锁检测「确认前被别人改过」，写入失败恢复迁移前数据。
 */
import { computed, reactive, ref } from 'vue'
import { MessagePlugin, DialogPlugin } from 'tdesign-vue-next'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useStationStore } from '@/stores/stationStore'
import { useValveStore } from '@/stores/valveStore'
import { useAdjustStore } from '@/stores/adjustStore'
import { useMigrationStore } from '@/stores/migrationStore'
import {
  EMPTY_TRANSFER_DRAFT,
  effectiveAtOf,
  formatEffectiveAt,
  todayDateString,
  transferPhase,
  type StationTransfer,
  type StationTransferCommitError
} from '@/types/stationTransfer'
import type { StationTransferRow } from '@/utils/db'

const stationStore = useStationStore()
const valveStore = useValveStore()
const adjustStore = useAdjustStore()
const migrationStore = useMigrationStore()

/* ------------------------------ 表单 ------------------------------ */

const form = reactive({
  ...EMPTY_TRANSFER_DRAFT,
  effectiveDate: todayDateString()
})
const formRef = ref()
const selectedBuildingRowKeys = ref<string[]>([])

const rules = {
  sourceStationId: [{ required: true, message: '请选择来源站', type: 'error' as const }],
  targetStationId: [{ required: true, message: '请选择目标站', type: 'error' as const }],
  effectiveDate: [{ required: true, message: '请选择生效日期', type: 'error' as const }],
  effectiveTime: [{ required: true, message: '请选择生效时间', type: 'error' as const }],
  operator: [{ required: true, message: '请填写调度操作人', type: 'error' as const }]
}

const targetOptions = computed(() =>
  stationStore.stations
    .filter((station) => station.id !== form.sourceStationId)
    .map((station) => ({ label: station.name, value: station.id }))
)

/** 来源站下当前可勾选的楼栋（当前时点仍属于来源站；已有待生效迁移的楼栋
 *  在确认时归属已改到目标站，不会出现在该列表里，天然无法重复预约） */
const selectableBuildings = computed(() =>
  form.sourceStationId
    ? stationStore.buildings.filter((building) => building.stationId === form.sourceStationId)
    : []
)

const buildingColumns = [
  { colKey: 'row-select', type: 'multiple', width: 46 },
  { colKey: 'name', title: '楼栋', width: 140 },
  { colKey: 'areaM2', title: '面积(m²)', width: 110 },
  { colKey: 'heatMode', title: '供热方式', width: 100 },
  { colKey: 'valveCount', title: '阀门', width: 80, cell: 'valveCountCell' },
  { colKey: 'openAdjust', title: '未完调节单', width: 110, cell: 'openAdjustCell' }
]

function buildingRowKey(row: { id: string }): string {
  return row.id
}

const openAdjustCountOf = (buildingId: string): number => {
  const valveIds = new Set(
    valveStore.valves.filter((valve) => valve.buildingId === buildingId).map((valve) => valve.id)
  )
  return adjustStore.adjusts.filter(
    (adjust) =>
      valveIds.has(adjust.valveId) && (adjust.state === '待下发' || adjust.state === '已调节')
  ).length
}

function onSourceChange(): void {
  if (form.targetStationId === form.sourceStationId) form.targetStationId = ''
  selectedBuildingRowKeys.value = []
  migrationStore.clearPreview()
}

function onSelectionChange(selection: string[]): void {
  selectedBuildingRowKeys.value = selection
  migrationStore.clearPreview()
}

function effectiveAt(): number {
  return effectiveAtOf(form.effectiveDate, form.effectiveTime)
}

/* ------------------------------ 预演 ------------------------------ */

async function runPreview(): Promise<boolean> {
  try {
    const result = await formRef.value?.validate()
    if (result !== true) return false
  } catch {
    return false
  }
  if (selectedBuildingRowKeys.value.length === 0) {
    MessagePlugin.warning('请先勾选要划到目标站的楼栋')
    return false
  }
  const at = effectiveAt()
  if (!Number.isFinite(at)) {
    MessagePlugin.error('生效时点格式不正确')
    return false
  }
  const preview = await migrationStore.runPreview({
    sourceStationId: form.sourceStationId,
    targetStationId: form.targetStationId,
    effectiveAt: at,
    buildingIds: [...selectedBuildingRowKeys.value],
    reason: form.reason,
    operator: form.operator
  })
  if (preview.blockers.length > 0) {
    MessagePlugin.error(`预检未通过：${preview.blockers[0]}`)
  } else {
    MessagePlugin.success(
      `预检通过：${preview.buildings.length} 栋楼 / ${preview.valves.length} 只阀门可迁移`
    )
  }
  if (preview.warnings.length > 0) MessagePlugin.warning(preview.warnings[0])
  return preview.blockers.length === 0
}

/* ------------------------------ 确认迁移 ------------------------------ */

function confirmTransfer(): void {
  const preview = migrationStore.preview
  if (!preview) {
    MessagePlugin.warning('请先执行预检')
    return
  }
  if (preview.blockers.length > 0) {
    MessagePlugin.error('存在拦截项，迁移已挡住，请先处理未完调节单')
    return
  }
  const at = effectiveAt()
  const sourceName = stationStore.stationById.get(form.sourceStationId)?.name ?? '来源站'
  const targetName = stationStore.stationById.get(form.targetStationId)?.name ?? '目标站'
  const dialog = DialogPlugin.confirm({
    header: '确认整包迁移',
    body:
      `将 ${preview.buildings.length} 栋楼、${preview.valves.length} 只阀门由「${sourceName}」划到「${targetName}」，` +
      `生效时点 ${formatEffectiveAt(at)}。\n` +
      '生效后排行 / 录实测 / 派单走新站；生效前的实测、调节单与导出仍认原站，不追溯改站。\n' +
      '提交前会再次校验修订号：确认前楼栋或阀门被别人改过，整包迁移不写入并保留原数据。',
    confirmBtn: '确认迁移',
    cancelBtn: '取消',
    onConfirm: async () => {
      try {
        const result = await migrationStore.commit({
          sourceStationId: form.sourceStationId,
          targetStationId: form.targetStationId,
          effectiveAt: at,
          buildingIds: [...selectedBuildingRowKeys.value],
          reason: form.reason,
          operator: form.operator
        })
        MessagePlugin.success(
          `迁移单已整包写入：${result.buildingCount} 栋楼 / ${result.valveCount} 只阀门，生效时点 ${formatEffectiveAt(result.record.effectiveAt)}`
        )
        selectedBuildingRowKeys.value = []
        form.reason = ''
        dialog.destroy()
      } catch (error) {
        const commitError = error as StationTransferCommitError
        if (commitError.code === 'CONCURRENT_REVISION' && commitError.conflicts) {
          const names = commitError.conflicts
            .slice(0, 5)
            .map((item) => `${item.label}（修订号 ${item.expectedRevision}→${item.actualRevision}）`)
            .join('、')
          MessagePlugin.error(`确认前被别人改过，已整包中止、未写入：${names}`)
          migrationStore.clearPreview()
        } else {
          MessagePlugin.error(commitError.message || '迁移失败，已恢复迁移前数据')
        }
      }
    }
  })
}

/* ------------------------------ 迁移记录 ------------------------------ */

const phaseFilter = ref<'全部' | '待生效' | '已生效'>('全部')

const filteredTransfers = computed(() =>
  migrationStore.transfers.filter((transfer) => {
    if (phaseFilter.value === '全部') return true
    return transferPhase(transfer) === phaseFilter.value
  })
)

const transferColumns = [
  { colKey: 'effectiveAt', title: '生效时点', width: 160, cell: 'effectiveCell' },
  { colKey: 'phase', title: '状态', width: 90, cell: 'phaseCell' },
  { colKey: 'route', title: '迁移路径', minWidth: 220, cell: 'routeCell' },
  { colKey: 'scope', title: '范围', width: 150, cell: 'scopeCell' },
  { colKey: 'operator', title: '操作人', width: 100 },
  { colKey: 'reason', title: '并网说明', minWidth: 180 }
]

function transferRowKey(row: StationTransferRow): string {
  return row.id
}

const detailVisible = ref(false)
const detailTransfer = ref<StationTransferRow | null>(null)

function openDetail(transfer: StationTransfer): void {
  detailTransfer.value = transfer as StationTransferRow
  detailVisible.value = true
}

function stationName(id: string): string {
  return stationStore.stationById.get(id)?.name ?? '已删除站'
}

function buildingNames(transfer: StationTransfer): string {
  return transfer.buildingIds
    .map((id) => stationStore.buildingById.get(id)?.name ?? '已删除楼栋')
    .join('、')
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-head__title">并网迁移台</h2>
        <p class="page-head__desc">
          两座换热站并网后，楼栋分批划到新站。先预检受影响阀门与未完调节单，再整包写入；
          生效后业务走新站，生效前历史数据仍认原站。
        </p>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="迁移记录" :value="migrationStore.transfers.length" suffix="张" tone="primary" />
      <StatBadge label="待生效" :value="migrationStore.pendingTransfers.length" suffix="张" tone="warning" />
      <StatBadge
        label="已生效"
        :value="migrationStore.transfers.length - migrationStore.pendingTransfers.length"
        suffix="张"
        tone="success"
      />
    </div>

    <div class="panel">
      <h3 class="panel-title">第一步 · 选择迁移单</h3>
      <t-form ref="formRef" :data="form" :rules="rules" label-width="110px" layout="inline">
        <t-form-item label="来源站" name="sourceStationId">
          <t-select
            v-model="form.sourceStationId"
            :options="stationStore.stations.map((station) => ({ label: station.name, value: station.id }))"
            placeholder="划出楼栋的旧站"
            style="width: 240px"
            @change="onSourceChange"
          />
        </t-form-item>
        <t-form-item label="目标站" name="targetStationId">
          <t-select
            v-model="form.targetStationId"
            :options="targetOptions"
            :disabled="!form.sourceStationId"
            placeholder="并入的新站"
            style="width: 240px"
          />
        </t-form-item>
        <t-form-item label="生效日期" name="effectiveDate">
          <t-input v-model="form.effectiveDate" placeholder="YYYY-MM-DD" style="width: 170px" />
        </t-form-item>
        <t-form-item label="生效时间" name="effectiveTime">
          <t-input v-model="form.effectiveTime" placeholder="HH:mm" style="width: 110px" />
        </t-form-item>
        <t-form-item label="调度操作人" name="operator">
          <t-input v-model="form.operator" placeholder="如 调度-周倩" style="width: 170px" />
        </t-form-item>
        <t-form-item label="并网说明" name="reason">
          <t-input v-model="form.reason" placeholder="如 一次网联通，3号楼片区改由新站带" style="width: 320px" />
        </t-form-item>
      </t-form>
    </div>

    <div class="panel" style="margin-top: 16px">
      <div class="panel-head">
        <h3 class="panel-title" style="margin: 0">第二步 · 勾选分批楼栋（{{ selectedBuildingRowKeys.length }}）</h3>
        <div class="toolbar">
          <t-button theme="primary" variant="outline" :loading="migrationStore.previewLoading" @click="runPreview">
            预检受影响范围
          </t-button>
          <t-button
            theme="primary"
            :disabled="!migrationStore.preview || migrationStore.preview.blockers.length > 0"
            :loading="migrationStore.submitting"
            @click="confirmTransfer"
          >
            确认整包迁移
          </t-button>
        </div>
      </div>

      <EmptyPanel
        v-if="!form.sourceStationId"
        title="请先选择来源站"
        description="选定来源站后，这里会列出当前仍挂在该站下的楼栋供分批勾选。"
        compact
      />
      <EmptyPanel
        v-else-if="selectableBuildings.length === 0"
        title="来源站下暂无可迁移楼栋"
        description="该站当前名下没有楼栋，或楼栋已存在待生效迁移单。"
        compact
      />
      <t-table
        v-else
        :data="selectableBuildings"
        :columns="buildingColumns"
        :row-key="buildingRowKey"
        v-model:selected-row-keys="selectedBuildingRowKeys"
        bordered
        stripe
        size="small"
        @select-change="onSelectionChange"
      >
        <template #valveCountCell="{ row }">
          {{ valveStore.valves.filter((valve) => valve.buildingId === row.id).length }}
        </template>
        <template #openAdjustCell="{ row }">
          <t-tag size="small" :theme="openAdjustCountOf(row.id) > 0 ? 'danger' : 'success'" variant="light">
            {{ openAdjustCountOf(row.id) }} 张未完
          </t-tag>
        </template>
      </t-table>
    </div>

    <!-- 预检结果 -->
    <template v-if="migrationStore.preview">
      <t-alert
        v-if="migrationStore.preview.blockers.length > 0"
        theme="error"
        style="margin-top: 16px"
        :message="`预检发现 ${migrationStore.preview.blockers.length} 项拦截，迁移被挡住`"
        :description="migrationStore.preview.blockers.join('；')"
      />
      <t-alert
        v-else
        theme="success"
        style="margin-top: 16px"
        message="预检通过，可整包迁移"
        :description="`楼栋归属、阀门冗余站标识、迁移记录将同一事务写入；生效时点 ${formatEffectiveAt(
          effectiveAt()
        )} 后业务走新站。`"
      />

      <div class="grid-two" style="margin-top: 16px">
        <div class="panel">
          <h3 class="panel-title">受影响阀门（{{ migrationStore.preview.valves.length }}）</h3>
          <t-table
            :data="migrationStore.preview.valves"
            :columns="[
              { colKey: 'code', title: '阀门编号', width: 130 },
              { colKey: 'buildingName', title: '楼栋', minWidth: 120 },
              { colKey: 'dn', title: 'DN', width: 70 },
              { colKey: 'currentOpening', title: '当前开度', width: 90 }
            ]"
            row-key="id"
            bordered
            size="small"
          />
        </div>
        <div class="panel">
          <h3 class="panel-title">
            未完调节单（{{ migrationStore.preview.blockingOrders.length }}）
            <span class="muted">· 未下发 / 已调节未复核一律挡住</span>
          </h3>
          <EmptyPanel
            v-if="migrationStore.preview.blockingOrders.length === 0"
            title="没有未完调节单"
            description="涉及阀门的调节单均已复核闭环，可安全迁移。"
            compact
          />
          <t-table
            v-else
            :data="migrationStore.preview.blockingOrders"
            :columns="[
              { colKey: 'valveCode', title: '阀门', width: 120 },
              { colKey: 'buildingName', title: '楼栋', width: 100 },
              { colKey: 'state', title: '状态', width: 90, cell: 'stateCell' },
              { colKey: 'reason', title: '拦截原因', minWidth: 180 }
            ]"
            row-key="adjustId"
            bordered
            size="small"
          >
            <template #stateCell="{ row }">
              <t-tag size="small" :theme="row.state === '待下发' ? 'warning' : 'primary'" variant="light">
                {{ row.state }}
              </t-tag>
            </template>
          </t-table>
        </div>
      </div>
    </template>

    <!-- 迁移记录 -->
    <div class="panel" style="margin-top: 16px">
      <div class="panel-head">
        <h3 class="panel-title" style="margin: 0">迁移记录（{{ filteredTransfers.length }}）</h3>
        <t-radio-group v-model="phaseFilter" variant="default-filled" size="small">
          <t-radio-button value="全部">全部</t-radio-button>
          <t-radio-button value="待生效">待生效</t-radio-button>
          <t-radio-button value="已生效">已生效</t-radio-button>
        </t-radio-group>
      </div>

      <EmptyPanel
        v-if="filteredTransfers.length === 0"
        title="还没有迁移记录"
        description="完成第一步选择与第二步预检后确认迁移，记录会整包写入，作为历史归属依据。"
        compact
      />
      <t-table
        v-else
        :data="filteredTransfers"
        :columns="transferColumns"
        :row-key="transferRowKey"
        bordered
        stripe
        size="small"
      >
        <template #effectiveCell="{ row }">{{ formatEffectiveAt(row.effectiveAt) }}</template>
        <template #phaseCell="{ row }">
          <t-tag size="small" :theme="transferPhase(row) === '已生效' ? 'success' : 'warning'" variant="light">
            {{ transferPhase(row) }}
          </t-tag>
        </template>
        <template #routeCell="{ row }">
          {{ stationName(row.sourceStationId) }}
          <span class="muted"> → </span>
          <strong>{{ stationName(row.targetStationId) }}</strong>
        </template>
        <template #scopeCell="{ row }">
          <t-button size="small" variant="text" theme="primary" @click="openDetail(row)">
            {{ row.buildingIds.length }} 栋 / {{ row.valveIds.length }} 阀
          </t-button>
        </template>
        <template #reason="{ row }">
          <span class="muted">{{ row.reason || '—' }}</span>
        </template>
      </t-table>
    </div>

    <!-- 详情 -->
    <t-dialog v-model:visible="detailVisible" header="迁移单详情" width="620px" :confirm-btn="null" cancel-btn="关闭">
      <template v-if="detailTransfer">
        <t-descriptions :column="1" bordered size="small">
          <t-descriptions-item label="迁移路径">
            {{ stationName(detailTransfer.sourceStationId) }} → {{ stationName(detailTransfer.targetStationId) }}
          </t-descriptions-item>
          <t-descriptions-item label="生效时点">
            {{ formatEffectiveAt(detailTransfer.effectiveAt) }}（{{ transferPhase(detailTransfer) }}）
          </t-descriptions-item>
          <t-descriptions-item label="操作人 / 时间">
            {{ detailTransfer.operator }} · {{ formatEffectiveAt(detailTransfer.createdAt) }}
          </t-descriptions-item>
          <t-descriptions-item label="并网说明">{{ detailTransfer.reason || '—' }}</t-descriptions-item>
          <t-descriptions-item label="迁移楼栋">
            {{ buildingNames(detailTransfer) }}
          </t-descriptions-item>
        </t-descriptions>
        <p class="muted" style="margin: 12px 0 0">
          生效前这些楼栋已发生的实测、调节单与导出仍认定为「{{ stationName(detailTransfer.sourceStationId) }}」，
          不因本次改挂追溯调整。
        </p>
      </template>
    </t-dialog>
  </div>
</template>
