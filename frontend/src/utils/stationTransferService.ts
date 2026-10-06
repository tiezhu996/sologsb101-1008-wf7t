/**
 * 并网迁移领域服务：
 * - buildTransferPreview：确认前预演，列受影响阀门与未完调节单，给出硬性拦截项；
 * - commitStationTransfer：楼栋归属 / 阀门冗余站标识 / 迁移记录三处同一事务整包写入，
 *   乐观锁检测「确认前被别人改过」，事务失败自动回滚（不会只换掉一半），
 *   提交后再校验一次，异常时按迁移前快照补偿恢复。
 */
import { db, createId, type AdjustRow, type BuildingRow, type StationTransferRow, type ValveRow } from '@/utils/db'
import type {
  StationTransferCommitError,
  TransferBlockingOrder,
  TransferPreview,
  TransferRevisionConflict
} from '@/types/stationTransfer'

export interface ExpectedRevisions {
  /** 确认时（预览生成）的楼栋修订号：buildingId → revision */
  buildings: Record<string, number>
  /** 确认时（预览生成）的阀门修订号：valveId → revision */
  valves: Record<string, number>
}

export interface TransferPlan {
  sourceStationId: string
  targetStationId: string
  effectiveAt: number
  buildingIds: string[]
  reason: string
  operator: string
  /** 预览阶段冻结的修订号；确认提交时逐一比对，发现被改过整包中止 */
  expected: ExpectedRevisions
}

function fail(error: StationTransferCommitError): never {
  throw error
}

/** 未完调节单：待下发（未下发）或已调节未复核，都是硬性拦截 */
function blockingReason(state: AdjustRow['state']): string | null {
  if (state === '待下发') return '存在未下发调节单，需先下发或撤销'
  if (state === '已调节') return '存在已调节未复核调节单，需先复核闭环'
  return null
}

/** 确认前预演：纯读操作，不写任何数据 */
export async function buildTransferPreview(plan: Omit<TransferPlan, 'expected'>): Promise<TransferPreview> {
  const sourceId = plan.sourceStationId
  const targetId = plan.targetStationId
  const [source, target, allBuildings, allValves, allAdjusts, allTransfers] = await Promise.all([
    db.stations.get(sourceId),
    db.stations.get(targetId),
    db.buildings.toArray(),
    db.valves.toArray(),
    db.adjusts.toArray(),
    db.stationTransfers.toArray()
  ])

  const blockers: string[] = []
  const warnings: string[] = []

  if (!source) blockers.push(`来源站不存在（${sourceId}）`)
  if (!target) blockers.push(`目标站不存在（${targetId}）`)
  if (sourceId && targetId && sourceId === targetId) blockers.push('来源站与目标站不能相同')
  if (plan.buildingIds.length === 0) blockers.push('请至少勾选一栋楼')
  if (!Number.isFinite(plan.effectiveAt)) blockers.push('生效时点不合法')

  const wanted = new Set(plan.buildingIds)
  const buildings = allBuildings.filter((building) => wanted.has(building.id))
  if (buildings.length !== plan.buildingIds.length) {
    blockers.push('勾选楼栋中有已被删除的楼栋，请刷新后重新勾选')
  }
  const moved = buildings.filter((building) => building.stationId !== sourceId)
  if (moved.length > 0) {
    blockers.push(`以下楼栋当前已不属于来源站：${moved.map((item) => item.name).join('、')}`)
  }

  const buildingIds = new Set(buildings.map((item) => item.id))
  const valves = allValves.filter((valve) => buildingIds.has(valve.buildingId))
  const valveById = new Map(valves.map((valve) => [valve.id, valve]))

  // 未完调节单（未下发 / 已调节未复核）——硬性拦截
  const blockingOrders: TransferBlockingOrder[] = []
  allAdjusts.forEach((adjust) => {
    const reason = blockingReason(adjust.state)
    if (!reason) return
    const valve = valveById.get(adjust.valveId)
    if (!valve) return
    const building = buildings.find((item) => item.id === valve.buildingId)
    blockingOrders.push({
      adjustId: adjust.id,
      valveId: valve.id,
      valveCode: valve.code,
      buildingId: valve.buildingId,
      buildingName: building ? building.name : '未知楼栋',
      state: adjust.state as '待下发' | '已调节',
      reason
    })
  })
  if (blockingOrders.length > 0) {
    blockers.push(`有 ${blockingOrders.length} 张未完调节单（未下发或已调节未复核），处理完才能迁移`)
  }

  // 同一楼栋存在尚未生效的迁移单——不论路径方向，都不允许重复预约
  const now = Date.now()
  const overlap = allTransfers.filter(
    (transfer) =>
      transfer.effectiveAt > now && transfer.buildingIds.some((id) => wanted.has(id))
  )
  if (overlap.length > 0) {
    blockers.push(`所选楼栋已有 ${overlap.length} 张待生效迁移单，请勿重复迁移`)
  }

  if (Number.isFinite(plan.effectiveAt) && plan.effectiveAt <= now) {
    warnings.push('生效时点早于当前时间：提交后立即按目标站认定，请确认是否为并网点补录')
  }

  return {
    sourceStationId: sourceId,
    targetStationId: targetId,
    buildings: buildings.map((building) => ({
      id: building.id,
      name: building.name,
      areaM2: building.areaM2,
      heatMode: building.heatMode,
      revision: building.revision ?? 0
    })),
    valves: valves.map((valve) => ({
      id: valve.id,
      code: valve.code,
      buildingId: valve.buildingId,
      buildingName: buildings.find((item) => item.id === valve.buildingId)?.name ?? '未知楼栋',
      dn: valve.dn,
      currentOpening: valve.currentOpening,
      revision: valve.revision ?? 0
    })),
    blockingOrders,
    blockers,
    warnings
  }
}

export interface CommitResult {
  record: StationTransferRow
  buildingCount: number
  valveCount: number
}

/**
 * 整包迁移：
 * 1. 事务内重读楼栋/阀门/调节单/迁移记录；
 * 2. 乐观锁比对 revision、来源站归属、未完调节单、重叠待生效单，任一不符整体抛错回滚；
 * 3. 楼栋 stationId、阀门冗余 stationId、迁移记录三处一起写入；
 * 4. 事务提交后再读校验，失败则用迁移前快照补偿恢复原数据。
 */
export async function commitStationTransfer(plan: TransferPlan): Promise<CommitResult> {
  const now = Date.now()
  // 用对象持有事务产物，避免闭包内赋值被控制流窄化为 never
  const outcome: { record: StationTransferRow | null } = { record: null }

  // 迁移前快照（用于补偿恢复）
  let buildingsBefore: BuildingRow[] = []
  let valvesBefore: ValveRow[] = []

  await db.transaction(
    'rw',
    db.buildings,
    db.valves,
    db.adjusts,
    db.stationTransfers,
    async () => {
      const [allBuildings, allValves, allAdjusts, allTransfers] = await Promise.all([
        db.buildings.toArray(),
        db.valves.toArray(),
        db.adjusts.toArray(),
        db.stationTransfers.toArray()
      ])

      if (plan.sourceStationId === plan.targetStationId) {
        fail({ code: 'INVALID_PLAN', message: '来源站与目标站不能相同' })
      }
      if (plan.buildingIds.length === 0 || !Number.isFinite(plan.effectiveAt)) {
        fail({ code: 'INVALID_PLAN', message: '迁移参数不完整' })
      }

      const wanted = new Set(plan.buildingIds)
      const buildings = allBuildings.filter((building) => wanted.has(building.id))
      if (buildings.length !== plan.buildingIds.length) {
        fail({ code: 'INVALID_PLAN', message: '勾选楼栋中有已被删除的楼栋，请刷新后重试' })
      }

      // 乐观锁：楼栋或阀门在确认前被别人改过 → 整包中止、不写入、保留原数据
      const conflicts: TransferRevisionConflict[] = []
      buildings.forEach((building) => {
        const expected = plan.expected.buildings[building.id]
        const actual = building.revision ?? 0
        if (typeof expected === 'number' && expected !== actual) {
          conflicts.push({
            kind: 'building',
            id: building.id,
            label: building.name,
            expectedRevision: expected,
            actualRevision: actual
          })
        }
      })

      const buildingIds = new Set(buildings.map((item) => item.id))
      const valves = allValves.filter((valve) => buildingIds.has(valve.buildingId))
      valves.forEach((valve) => {
        const expected = plan.expected.valves[valve.id]
        const actual = valve.revision ?? 0
        if (typeof expected === 'number' && expected !== actual) {
          conflicts.push({
            kind: 'valve',
            id: valve.id,
            label: valve.code,
            expectedRevision: expected,
            actualRevision: actual
          })
        }
      })
      if (conflicts.length > 0) {
        fail({
          code: 'CONCURRENT_REVISION',
          message: `确认前有 ${conflicts.length} 处楼栋/阀门被别人改过，迁移已中止，原数据保留`,
          conflicts
        })
      }

      // 来源站归属必须与预览一致（防止楼栋期间已被挂走）
      const movedBuildings = buildings.filter((building) => building.stationId !== plan.sourceStationId)
      if (movedBuildings.length > 0) {
        fail({
          code: 'BUILDING_MOVED',
          message: `楼栋已不属于来源站：${movedBuildings.map((item) => item.name).join('、')}`
        })
      }

      // 未完调节单：事务内再查一遍，防止预览后被人新派单
      const valveIds = new Set(valves.map((valve) => valve.id))
      const openAdjusts = allAdjusts.filter(
        (adjust) => valveIds.has(adjust.valveId) && blockingReason(adjust.state) !== null
      )
      if (openAdjusts.length > 0) {
        fail({
          code: 'BLOCKING_ORDERS',
          message: `检测到 ${openAdjusts.length} 张未完调节单（预览后可能有新派单），迁移已阻止`
        })
      }

      // 重叠待生效迁移（按楼栋判定，与来源站方向无关）
      const overlap = allTransfers.filter(
        (transfer) =>
          transfer.effectiveAt > now && transfer.buildingIds.some((id) => wanted.has(id))
      )
      if (overlap.length > 0) {
        fail({ code: 'OVERLAP_PENDING', message: '所选楼栋存在待生效迁移单，请勿重复迁移' })
      }

      // 留存迁移前快照（提交后用于 post-check 补偿）
      buildingsBefore = buildings.map((item) => ({ ...item }))
      valvesBefore = valves.map((item) => ({ ...item }))

      // 三处一起写入（同事务：任一失败整体回滚，不会只换掉一半）
      const nextBuildingRows: BuildingRow[] = buildings.map((building) => ({
        ...building,
        stationId: plan.targetStationId,
        updatedAt: now,
        revision: (building.revision ?? 0) + 1
      }))
      const nextValveRows: ValveRow[] = valves.map((valve) => ({
        ...valve,
        stationId: plan.targetStationId,
        updatedAt: now,
        revision: (valve.revision ?? 0) + 1
      }))

      outcome.record = {
        id: createId('tr'),
        sourceStationId: plan.sourceStationId,
        targetStationId: plan.targetStationId,
        effectiveAt: plan.effectiveAt,
        buildingIds: buildings.map((item) => item.id),
        valveIds: valves.map((item) => item.id),
        reason: plan.reason.trim(),
        operator: plan.operator.trim() || '调度',
        buildingSnapshots: buildingsBefore.map((building) => ({
          buildingId: building.id,
          name: building.name,
          fromStationId: building.stationId,
          revision: building.revision ?? 0
        })),
        createdAt: now,
        updatedAt: now,
        revision: 1
      }

      await db.buildings.bulkPut(nextBuildingRows)
      await db.valves.bulkPut(nextValveRows)
      await db.stationTransfers.put(outcome.record!)
    }
  )

  if (!outcome.record) fail({ code: 'WRITE_FAILED', message: '迁移事务未生成记录' })
  const committed = outcome.record

  // 提交后校验：三处写入必须齐全一致，否则按迁移前快照补偿恢复
  try {
    const [savedRecord, savedBuildings, savedValves] = await Promise.all([
      db.stationTransfers.get(committed.id),
      db.buildings.bulkGet(committed.buildingIds),
      db.valves.bulkGet(committed.valveIds)
    ])
    if (!savedRecord) throw new Error('迁移记录缺失')
    const badBuilding = savedBuildings.some((row) => !row || row.stationId !== plan.targetStationId)
    const badValve = savedValves.some((row) => !row || row.stationId !== plan.targetStationId)
    if (badBuilding || badValve) throw new Error('楼栋或阀门归属未全部改挂')
  } catch (error) {
    await restoreBefore(committed, buildingsBefore, valvesBefore)
    fail({
      code: 'WRITE_FAILED',
      message: `迁移写入不完整，已恢复迁移前数据：${error instanceof Error ? error.message : '未知错误'}`
    })
  }

  return { record: committed, buildingCount: committed.buildingIds.length, valveCount: committed.valveIds.length }
}

/** 补偿恢复：删掉迁移记录，楼栋 / 阀门按快照还原 */
async function restoreBefore(
  record: StationTransferRow,
  buildingsBefore: BuildingRow[],
  valvesBefore: ValveRow[]
): Promise<void> {
  try {
    await db.transaction('rw', db.buildings, db.valves, db.stationTransfers, async () => {
      if (buildingsBefore.length > 0) await db.buildings.bulkPut(buildingsBefore)
      if (valvesBefore.length > 0) await db.valves.bulkPut(valvesBefore)
      await db.stationTransfers.delete(record.id)
    })
  } catch (error) {
    // 恢复也失败：保留现场并抛出，交由人工处理，绝不静默
    throw new Error(`迁移失败且自动恢复失败：${error instanceof Error ? error.message : '未知错误'}`)
  }
}
