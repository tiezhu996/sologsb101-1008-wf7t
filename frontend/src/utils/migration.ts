/**
 * 并站迁移领域逻辑（纯函数 + 整包事务）
 *
 * 时效归属口径：
 * - 排行 / 录实测 / 派调节单：按「当前生效归属」，楼栋一旦越过生效时点即走新站；
 * - 生效前的历史实测（按实测日期日终判定）、历史调节单（按 createdAt 判定）：
 *   仍认来源站，绝不因楼栋改挂而追溯改站；
 * - 历史数据没有归属快照（旧备份）时，用迁移记录按时效解析兜底，兜底再失败才认阀门当前冗余站。
 *
 * 整包写入口径：
 * - 楼栋归属（buildings.stationId）、阀门冗余站（valves.stationId）、迁移记录
 *   三处必须在同一 Dexie 事务内写入；
 * - 未完调节单（待下发 / 已调节未复核）直接挡住迁移；
 * - 楼栋或阀门的 revision 在确认前被别人改过：整包不写入，原数据原样保留；
 * - 事务失败时用迁移前整包快照恢复，不能只换掉一半。
 */
import {
  db,
  createId,
  ROW_REVISION,
  type AdjustRow,
  type BuildingRow,
  type StationMigrationRow,
  type ValveRow,
  type MeasureRow
} from '@/utils/db'
import type { StationMigration } from '@/types/migration'
import type { AdjustState } from '@/types/adjust'

/** 预检 / 提交时发现归属被修订过的冲突项 */
export interface MigrationConflict {
  kind: '楼栋' | '阀门'
  id: string
  name: string
  /** 预检时看到的 revision */
  expectedRevision: number
  /** 提交时实际的 revision */
  actualRevision: number | null
}

/** 挡住迁移的未完调节单 */
export interface OpenAdjustBlocker {
  adjustId: string
  valveId: string
  valveCode: string
  buildingName: string
  state: AdjustState
}

export interface MigrationPreview {
  sourceStationId: string
  targetStationId: string
  effectiveAt: number
  buildingIds: string[]
  buildings: BuildingRow[]
  valves: ValveRow[]
  /** 未完调节单（待下发 / 已调节未复核），非空即不允许迁移 */
  blockers: OpenAdjustBlocker[]
  conflicts: MigrationConflict[]
}

/** 提交入参，expected* 为预检页确认时持有的 revision 快照 */
export interface CommitMigrationInput {
  sourceStationId: string
  targetStationId: string
  buildingIds: string[]
  effectiveAt: number
  operator: string
  remark: string
  expectedBuildingRevisions: Record<string, number>
  expectedValveRevisions: Record<string, number>
}

/** 确认前数据被别人改过：整包不写入并保留原数据 */
export class MigrationConflictError extends Error {
  conflicts: MigrationConflict[]
  blockers: OpenAdjustBlocker[]
  constructor(conflicts: MigrationConflict[], blockers: OpenAdjustBlocker[]) {
    const conflictText = conflicts.map((item) => `${item.kind}「${item.name}」`).join('、')
    const blockerText = blockers.map((item) => `${item.valveCode}（${item.state}）`).join('、')
    const parts: string[] = []
    if (conflictText.length > 0) parts.push(`${conflictText} 在确认前已被他人修订`)
    if (blockerText.length > 0) parts.push(`${blockerText} 仍有未完调节单`)
    super(parts.join('；') || '迁移条件校验未通过')
    this.name = 'MigrationConflictError'
    this.conflicts = conflicts
    this.blockers = blockers
  }
}

/* --------------------------- 时点归属解析（纯函数） --------------------------- */

type MigrationLike = Pick<StationMigration, 'buildingIds' | 'sourceStationId' | 'targetStationId' | 'effectiveAt'>

/**
 * 计算楼栋在指定时点的归属站 id（迁移链按时点分段）。
 * - 时点命中某次迁移之后：取该时点前最近一次迁移的目标站；
 * - 时点早于该楼栋最早一次迁移（旧数据缺归属快照的兜底）：认最早迁移的来源站；
 * - 该楼栋没有任何迁移记录：返回 null，由调用方回退到楼栋当前 stationId。
 */
export function resolveBuildingStationAt(
  buildingId: string,
  at: number,
  migrations: MigrationLike[]
): string | null {
  const hits = migrations
    .filter((item) => item.buildingIds.includes(buildingId))
    .sort((a, b) => a.effectiveAt - b.effectiveAt)
  if (hits.length === 0) return null
  if (at < hits[0].effectiveAt) return hits[0].sourceStationId
  let current = hits[0].sourceStationId
  for (const hit of hits) {
    if (at >= hit.effectiveAt) current = hit.targetStationId
    else break
  }
  return current
}

/** 实测按日期的「当日日终」判定归属：当日录入的实测与当日生效的迁移同序，视为新站 */
export function endOfMeasureDay(date: string): number | null {
  const matched = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(date)
  if (!matched) return null
  const [, year, month, day] = matched
  return new Date(Number(year), Number(month) - 1, Number(day), 23, 59, 59, 999).getTime()
}

/**
 * 实测记录的归属站：
 * 1. 记录自带归属快照（v3 之后录入）直接使用，绝不追溯改写；
 * 2. 旧记录缺快照时，按实测日期日终在迁移链上解析；
 * 3. 仍无法判定时回退阀门当前冗余站。
 */
export function resolveMeasureStationId(
  measure: Pick<MeasureRow, 'stationId' | 'valveId' | 'date' | 'createdAt'>,
  valve: Pick<ValveRow, 'buildingId' | 'stationId'> | undefined,
  migrations: MigrationLike[]
): string {
  if (measure.stationId) return measure.stationId
  const at = endOfMeasureDay(measure.date) ?? measure.createdAt ?? Date.now()
  return resolveByValve(at, migrations, valve)
}

/**
 * 调节单的归属站：
 * 1. 记录自带归属快照（v3 之后派单）直接使用，绝不追溯改写；
 * 2. 旧记录缺快照时，按派单时间 createdAt 在迁移链上解析；
 * 3. 仍无法判定时回退阀门当前冗余站。
 */
export function resolveAdjustStationId(
  adjust: Pick<AdjustRow, 'stationId' | 'valveId' | 'createdAt'>,
  valve: Pick<ValveRow, 'buildingId' | 'stationId'> | undefined,
  migrations: MigrationLike[]
): string {
  if (adjust.stationId) return adjust.stationId
  return resolveByValve(adjust.createdAt ?? Date.now(), migrations, valve)
}

/** 阀门在指定时点的归属站（供排行 / 录数 / 派单按当前生效归属使用） */
export function resolveValveStationAt(
  valve: Pick<ValveRow, 'id' | 'buildingId' | 'stationId'>,
  building: Pick<BuildingRow, 'id' | 'stationId'> | null | undefined,
  at: number,
  migrations: MigrationLike[]
): string {
  const resolved = resolveBuildingStationAt(valve.buildingId, at, migrations)
  if (resolved) return resolved
  if (building && building.stationId) return building.stationId
  return valve.stationId
}

function resolveByValve(
  at: number,
  migrations: MigrationLike[],
  valve: Pick<ValveRow, 'buildingId' | 'stationId'> | undefined
): string {
  if (valve) {
    const resolved = resolveBuildingStationAt(valve.buildingId, at, migrations)
    if (resolved) return resolved
  }
  return valve?.stationId ?? ''
}

/* ------------------------------- 预检 ------------------------------- */

/** 预检：列出受影响楼栋 / 阀门，并汇总未完调节单拦截项 */
export async function previewMigration(input: {
  sourceStationId: string
  targetStationId: string
  effectiveAt: number
  buildingIds: string[]
}): Promise<MigrationPreview> {
  const { sourceStationId, targetStationId, effectiveAt, buildingIds } = input
  const [allBuildings, allValves, allAdjusts] = await Promise.all([
    db.buildings.toArray(),
    db.valves.toArray(),
    db.adjusts.toArray()
  ])

  const buildings = allBuildings.filter((item) => buildingIds.includes(item.id))
  const idSet = new Set(buildingIds)
  const valves = allValves.filter((item) => idSet.has(item.buildingId))
  const valveById = new Map(valves.map((item) => [item.id, item]))
  const buildingById = new Map(buildings.map((item) => [item.id, item]))

  const blockers: OpenAdjustBlocker[] = allAdjusts
    .filter((adjust) => adjust.state !== '已复核')
    .map((adjust) => {
      const valve = valveById.get(adjust.valveId)
      if (!valve) return null
      const building = buildingById.get(valve.buildingId)
      return {
        adjustId: adjust.id,
        valveId: valve.id,
        valveCode: valve.code,
        buildingName: building ? building.name : '未知楼栋',
        state: adjust.state
      }
    })
    .filter((item): item is OpenAdjustBlocker => item !== null)
    .sort((a, b) => a.valveCode.localeCompare(b.valveCode, 'zh-Hans-CN'))

  return { sourceStationId, targetStationId, effectiveAt, buildingIds, buildings, valves, blockers, conflicts: [] }
}

/* --------------------------- 整包提交（事务） --------------------------- */

/**
 * 提交迁移：
 * - 生效时点已到（常见情形）：楼栋归属、阀门冗余站、迁移记录三处一起写入；
 * - 生效时点在未来：只写迁移记录（内含楼栋 / 阀门快照），到点后由 activateDueMigrations
 *   幂等补齐楼栋归属与阀门冗余站两处物理写入，待生效期间一切读取仍认来源站。
 * - 事务内重新读取最新数据核对 revision，确认前被改过则抛 MigrationConflictError，整包不写入；
 * - 未完调节单在事务内再挡一次（预检之后、确认之前可能新派单）；
 * - Dexie 事务本身保证原子回滚；再叠加一层迁移前快照兜底恢复。
 */
export async function commitMigration(input: CommitMigrationInput, at: number = Date.now()): Promise<StationMigrationRow> {
  const snapshot = await captureTablesSnapshot(input.buildingIds)

  try {
    return await db.transaction(
      'rw',
      [db.buildings, db.valves, db.stationMigrations, db.adjusts],
      async () => {
        const due = input.effectiveAt <= at
        const latestBuildings = await db.buildings.where('id').anyOf(input.buildingIds).toArray()
        const conflicts: MigrationConflict[] = []
        const blockers: OpenAdjustBlocker[] = []

        if (latestBuildings.length !== input.buildingIds.length) {
          const found = new Set(latestBuildings.map((item) => item.id))
          input.buildingIds.forEach((buildingId) => {
            if (!found.has(buildingId)) {
              conflicts.push({
                kind: '楼栋',
                id: buildingId,
                name: '已删除楼栋',
                expectedRevision: input.expectedBuildingRevisions[buildingId] ?? ROW_REVISION,
                actualRevision: null
              })
            }
          })
        }

        latestBuildings.forEach((building) => {
          const expected = input.expectedBuildingRevisions[building.id]
          if (expected !== undefined && (building.revision ?? 0) !== expected) {
            conflicts.push({
              kind: '楼栋',
              id: building.id,
              name: building.name,
              expectedRevision: expected,
              actualRevision: building.revision ?? null
            })
          }
          // 预约未来生效时不立即翻归属，来源站一致性留到激活时再核对
          if (due && building.stationId !== input.sourceStationId) {
            conflicts.push({
              kind: '楼栋',
              id: building.id,
              name: building.name,
              expectedRevision: input.expectedBuildingRevisions[building.id] ?? ROW_REVISION,
              actualRevision: building.revision ?? null
            })
          }
        })

        const latestValves = await db.valves.where('buildingId').anyOf(input.buildingIds).toArray()
        latestValves.forEach((valve) => {
          const expected = input.expectedValveRevisions[valve.id]
          if (expected !== undefined && (valve.revision ?? 0) !== expected) {
            conflicts.push({
              kind: '阀门',
              id: valve.id,
              name: valve.code,
              expectedRevision: expected,
              actualRevision: valve.revision ?? null
            })
          }
        })

        const valveIds = latestValves.map((item) => item.id)
        if (valveIds.length > 0) {
          const openAdjusts = await db.adjusts
            .where('valveId')
            .anyOf(valveIds)
            .filter((adjust) => adjust.state !== '已复核')
            .toArray()
          openAdjusts.forEach((adjust) => {
            const valve = latestValves.find((item) => item.id === adjust.valveId)
            const building = latestBuildings.find((item) => item.id === valve?.buildingId)
            blockers.push({
              adjustId: adjust.id,
              valveId: adjust.valveId,
              valveCode: valve ? valve.code : adjust.valveId,
              buildingName: building ? building.name : '未知楼栋',
              state: adjust.state
            })
          })
        }

        if (conflicts.length > 0 || blockers.length > 0) {
          throw new MigrationConflictError(conflicts, blockers)
        }

        const nextRevision = (value?: number): number => (typeof value === 'number' ? value + 1 : ROW_REVISION)

        // 生效时点已到才物理翻楼栋归属与阀门冗余站；预约未来生效只写迁移记录
        const writeAt = Date.now()
        if (due) {
          const buildingRows = latestBuildings.map((building) => ({
            ...building,
            stationId: input.targetStationId,
            revision: nextRevision(building.revision),
            updatedAt: writeAt
          }))
          const valveRows = latestValves.map((valve) => ({
            ...valve,
            stationId: input.targetStationId,
            revision: nextRevision(valve.revision),
            updatedAt: writeAt
          }))
          await db.buildings.bulkPut(buildingRows)
          await db.valves.bulkPut(valveRows)
        }

        const record: StationMigrationRow = {
          id: createId('mg'),
          sourceStationId: input.sourceStationId,
          targetStationId: input.targetStationId,
          buildingIds: [...input.buildingIds],
          valveIds,
          buildingNames: latestBuildings.map((item) => item.name),
          valveCodes: latestValves.map((item) => item.code),
          effectiveAt: input.effectiveAt,
          activatedAt: due ? at : undefined,
          operator: input.operator.trim() || '未署名',
          remark: input.remark.trim(),
          createdAt: writeAt,
          updatedAt: writeAt,
          revision: ROW_REVISION
        }
        await db.stationMigrations.put(record)
        return record
      }
    )
  } catch (error) {
    // 事务已整体回滚；若底层 IndexedDB 回滚异常，用迁移前快照再兜底恢复，绝不留下半迁移状态
    if (!(error instanceof MigrationConflictError)) {
      await restoreTablesSnapshot(snapshot).catch((restoreError: unknown) => {
        console.error('迁移失败后的快照恢复也失败了', restoreError)
      })
    }
    throw error
  }
}

/* --------------------------- 迁移前快照与兜底恢复 --------------------------- */

/**
 * 到点激活：把已过生效时点但尚未物理翻牌的预约批次落地。
 * - 幂等：已激活（activatedAt 有值）的记录跳过；
 * - 每条记录独立事务，单条失败不影响其余批次（仍保留待下轮重试）；
 * - 激活时再查一次未完调节单：若楼栋在等待期间新出现未闭环单，跳过本轮并告警，不翻牌。
 */
export interface ActivationResult {
  activated: StationMigrationRow[]
  skipped: Array<{ migration: StationMigrationRow; reason: string }>
}

export async function activateDueMigrations(at: number = Date.now()): Promise<ActivationResult> {
  const result: ActivationResult = { activated: [], skipped: [] }
  const pending = await db.stationMigrations
    .where('effectiveAt').belowOrEqual(at)
    .toArray()
  const dueList = pending
    .filter((migration) => migration.activatedAt === undefined)
    .sort((a, b) => a.effectiveAt - b.effectiveAt)

  for (const migration of dueList) {
    try {
      const done = await db.transaction('rw', [db.buildings, db.valves, db.stationMigrations, db.adjusts], async () => {
        const fresh = await db.stationMigrations.get(migration.id)
        if (!fresh || fresh.activatedAt !== undefined) return null // 已被其他标签页激活

        const buildings = await db.buildings.where('id').anyOf(fresh.buildingIds).toArray()
        const valves = await db.valves.where('buildingId').anyOf(fresh.buildingIds).toArray()
        const valveIds = valves.map((valve) => valve.id)
        const openAdjusts = valveIds.length > 0
          ? await db.adjusts
              .where('valveId')
              .anyOf(valveIds)
              .filter((adjust) => adjust.state !== '已复核')
              .toArray()
          : []
        if (openAdjusts.length > 0) {
          return { blocked: true }
        }

        const stampValue = at
        const nextRevision = (value?: number): number => (typeof value === 'number' ? value + 1 : ROW_REVISION)
        // 只翻仍挂在来源站的楼栋/阀门；已被后续批次改挂的保持现状，避免覆盖更新的归属
        await db.buildings.bulkPut(
          buildings
            .filter((building) => building.stationId === fresh.sourceStationId)
            .map((building) => ({
              ...building,
              stationId: fresh.targetStationId,
              revision: nextRevision(building.revision),
              updatedAt: stampValue
            }))
        )
        await db.valves.bulkPut(
          valves
            .filter((valve) => valve.stationId === fresh.sourceStationId)
            .map((valve) => ({
              ...valve,
              stationId: fresh.targetStationId,
              revision: nextRevision(valve.revision),
              updatedAt: stampValue
            }))
        )
        const activated: StationMigrationRow = { ...fresh, activatedAt: stampValue, updatedAt: stampValue }
        await db.stationMigrations.put(activated)
        return { blocked: false, activated }
      })

      if (done === null) continue
      if (done.blocked) {
        result.skipped.push({ migration, reason: '仍有未完调节单，待闭环后激活' })
      } else if (done.activated) {
        result.activated.push(done.activated)
      }
    } catch (error) {
      result.skipped.push({
        migration,
        reason: error instanceof Error ? error.message : '激活失败，将在下轮重试'
      })
    }
  }
  return result
}

interface TableSnapshot {
  buildings: BuildingRow[]
  valves: ValveRow[]
}

async function captureTablesSnapshot(buildingIds: string[]): Promise<TableSnapshot> {
  const buildings = await db.buildings.where('id').anyOf(buildingIds).toArray()
  const valves = await db.valves.where('buildingId').anyOf(buildingIds).toArray()
  return { buildings, valves }
}

async function restoreTablesSnapshot(snapshot: TableSnapshot): Promise<void> {
  await db.transaction('rw', db.buildings, db.valves, async () => {
    if (snapshot.buildings.length > 0) await db.buildings.bulkPut(snapshot.buildings)
    if (snapshot.valves.length > 0) await db.valves.bulkPut(snapshot.valves)
  })
}
