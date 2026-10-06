/**
 * 并站迁移状态（Pinia）
 * 维护迁移记录列表与预检结果；本 store 只依赖 Dexie 与迁移领域函数，
 * 不反向依赖 station/valve/adjust 等 store，避免 store 间循环依赖。
 * 页面侧的「当前生效归属」统一通过 utils/migration 的时效解析得到。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useIdbTable } from '@/hooks/useIdbTable'
import { db, type BuildingRow, type StationMigrationRow } from '@/utils/db'
import {
  activateDueMigrations,
  commitMigration as commitMigrationTx,
  previewMigration,
  type ActivationResult,
  type CommitMigrationInput,
  type MigrationPreview
} from '@/utils/migration'

export const useMigrationStore = defineStore('migration', () => {
  const migrationTable = useIdbTable<StationMigrationRow>((database) => database.stationMigrations, {
    sortByUpdatedAt: false
  })

  /** 最近一次预检结果（随选择实时刷新） */
  const preview = ref<MigrationPreview | null>(null)
  const previewLoading = ref(false)
  const previewError = ref<string | null>(null)
  /** 预检输入签名，仅用于去掉重复请求 */
  const previewSignature = ref('')
  let previewSeq = 0

  const migrations = computed<StationMigrationRow[]>(() =>
    [...migrationTable.rows.value].sort((a, b) => b.effectiveAt - a.effectiveAt)
  )

  /** 时效解析用的轻量迁移链（只含参与归属计算的字段） */
  const chain = computed(() =>
    migrations.value.map((item) => ({
      buildingIds: item.buildingIds,
      sourceStationId: item.sourceStationId,
      targetStationId: item.targetStationId,
      effectiveAt: item.effectiveAt
    }))
  )

  const pendingCount = computed(() => migrations.value.filter((item) => item.effectiveAt > Date.now()).length)

  /** 到点激活：每次预检 / 进入迁移台前先跑一遍，把预约批次的物理归属翻到目标站（幂等） */
  async function activateDue(): Promise<ActivationResult> {
    return activateDueMigrations(Date.now())
  }

  function migrationsOfBuilding(buildingId: string): StationMigrationRow[] {
    return migrations.value
      .filter((item) => item.buildingIds.includes(buildingId))
      .sort((a, b) => a.effectiveAt - b.effectiveAt)
  }

  async function runPreview(input: {
    sourceStationId: string
    targetStationId: string
    effectiveAt: number
    buildingIds: string[]
  }): Promise<void> {
    const signature = JSON.stringify(input)
    if (signature === previewSignature.value && preview.value) return
    previewSignature.value = signature
    if (input.sourceStationId === '' || input.targetStationId === '' || input.buildingIds.length === 0) {
      preview.value = null
      previewError.value = null
      return
    }
    const seq = ++previewSeq
    previewLoading.value = true
    try {
      const result = await previewMigration(input)
      // 只接受最新一次请求的结果，避免快速切换选择时旧结果覆盖新结果
      if (seq === previewSeq) {
        preview.value = result
        previewError.value = null
      }
    } catch (error) {
      if (seq === previewSeq) {
        previewError.value = error instanceof Error ? error.message : '迁移预检失败'
      }
    } finally {
      if (seq === previewSeq) previewLoading.value = false
    }
  }

  function clearPreview(): void {
    preview.value = null
    previewSignature.value = ''
    previewError.value = null
  }

  /** 整包提交：冲突 / 拦截由 utils/migration 抛错，页面负责提示，事务失败整体回滚 */
  async function commit(input: CommitMigrationInput): Promise<StationMigrationRow> {
    const record = await commitMigrationTx(input)
    clearPreview()
    return record
  }

  /** 供页面校验：来源站下是否存在可迁移楼栋 */
  async function listBuildingsOfStation(stationId: string): Promise<BuildingRow[]> {
    if (!stationId) return []
    return db.buildings.where('stationId').equals(stationId).toArray()
  }

  return {
    migrationTable,
    migrations,
    chain,
    pendingCount,
    preview,
    previewLoading,
    previewError,
    migrationsOfBuilding,
    runPreview,
    clearPreview,
    commit,
    activateDue,
    listBuildingsOfStation
  }
})
