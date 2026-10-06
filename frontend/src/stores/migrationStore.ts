/**
 * 并网迁移状态（Pinia）
 * 维护迁移记录集合、当前迁移单草稿与最近一次预演结果。
 * 页面只读 store；预演与整包提交走 utils/stationTransferService。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useIdbTable } from '@/hooks/useIdbTable'
import type { StationTransferRow } from '@/utils/db'
import type {
  StationTransfer,
  TransferPreview
} from '@/types/stationTransfer'
import {
  buildTransferPreview,
  commitStationTransfer,
  type CommitResult,
  type ExpectedRevisions,
  type TransferPlan
} from '@/utils/stationTransferService'

export type { TransferPreview }

export const useMigrationStore = defineStore('migration', () => {
  const transferTable = useIdbTable<StationTransferRow>((database) => database.stationTransfers, {
    sortByUpdatedAt: false
  })

  /** 最近一次预演结果（含受影响阀门、未完调节单与拦截项） */
  const preview = ref<TransferPreview | null>(null)
  /** 预演所对应的迁移参数，确认时据此冻结修订号 */
  const previewPlan = ref<Omit<TransferPlan, 'expected'> | null>(null)
  const previewLoading = ref(false)
  const submitting = ref(false)

  const transfers = computed<StationTransferRow[]>(() =>
    [...transferTable.rows.value].sort((a, b) => b.effectiveAt - a.effectiveAt || b.createdAt - a.createdAt)
  )

  const pendingTransfers = computed(() => transfers.value.filter((item) => item.effectiveAt > Date.now()))

  function transfersOfBuilding(buildingId: string): StationTransfer[] {
    return transfers.value.filter((item) => item.buildingIds.includes(buildingId))
  }

  async function runPreview(plan: Omit<TransferPlan, 'expected'>): Promise<TransferPreview> {
    previewLoading.value = true
    try {
      const result = await buildTransferPreview(plan)
      preview.value = result
      previewPlan.value = { ...plan }
      return result
    } finally {
      previewLoading.value = false
    }
  }

  function clearPreview(): void {
    preview.value = null
    previewPlan.value = null
  }

  /** 从最近一次预演提取冻结修订号，供整包提交做乐观锁 */
  function expectedRevisionsFromPreview(): ExpectedRevisions {
    const current = preview.value
    const buildings: Record<string, number> = {}
    const valves: Record<string, number> = {}
    if (current) {
      current.buildings.forEach((item) => {
        buildings[item.id] = item.revision
      })
      current.valves.forEach((item) => {
        valves[item.id] = item.revision
      })
    }
    return { buildings, valves }
  }

  async function commit(plan: Omit<TransferPlan, 'expected'>): Promise<CommitResult> {
    submitting.value = true
    try {
      const result = await commitStationTransfer({ ...plan, expected: expectedRevisionsFromPreview() })
      clearPreview()
      return result
    } finally {
      submitting.value = false
    }
  }

  return {
    transferTable,
    transfers,
    pendingTransfers,
    preview,
    previewPlan,
    previewLoading,
    submitting,
    transfersOfBuilding,
    runPreview,
    clearPreview,
    commit
  }
})
