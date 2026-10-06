/**
 * 楼栋 / 阀门历史归属解析（纯函数，不依赖 IndexedDB，便于测试与复用）。
 *
 * 规则：迁移记录一旦确认即整包写入（楼栋归属立刻改到目标站），
 * 是否对业务生效由 effectiveAt 决定。任意时点 at 下某楼栋的归属站：
 *   从该楼栋当前归属（最后一次迁移的目标站）出发，
 *   倒序跳过所有「生效时点晚于 at」的迁移，剩余链路上最后一次迁移的来源站即原站。
 *
 * 这样：
 * - 生效后的排行 / 实测录入 / 派单（at = now）解析到新站；
 * - 生效前已发生的实测、调节单、导出（at = 业务发生时点）解析到原站；
 * - 未到生效时点的预约迁移对当前业务完全不可见，绝不提前改挂。
 */
import type { StationTransfer } from '@/types/stationTransfer'

/**
 * 解析某楼栋在 at 时点所属换热站。
 * @param currentStationId 楼栋当前 building.stationId（已含全部已确认迁移）
 * @param chain 涉及该楼栋、按生效时点升序的迁移记录
 */
export function resolveStationAt(
  currentStationId: string,
  chain: Pick<StationTransfer, 'sourceStationId' | 'targetStationId' | 'effectiveAt'>[],
  at: number
): string {
  const future = chain
    .filter((item) => item.effectiveAt > at)
    .sort((a, b) => b.effectiveAt - a.effectiveAt)
  let stationId = currentStationId
  for (const transfer of future) {
    // 一致性兜底：链路应首尾相接；只有「当前确实指向该次迁移目标站」才回退
    if (stationId === transfer.targetStationId) stationId = transfer.sourceStationId
  }
  return stationId
}

/** 取某日期（YYYY-MM-DD，按本地当天中午 12:00，避开夏令时边界）的归属判定时点 */
export function atOfDate(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec((date ?? '').trim())
  if (!match) return Date.now()
  const [, y, m, d] = match
  return new Date(Number(y), Number(m) - 1, Number(d), 12, 0, 0, 0).getTime()
}

/** 从迁移集合中筛出涉及某楼栋的链路（升序） */
export function chainOfBuilding(
  transfers: StationTransfer[],
  buildingId: string
): StationTransfer[] {
  return transfers
    .filter((transfer) => transfer.buildingIds.includes(buildingId))
    .sort((a, b) => a.effectiveAt - b.effectiveAt || a.createdAt - b.createdAt)
}

/** 某楼栋在指定日期的归属站（实测记录按实测日期认定） */
export function stationOfBuildingOnDate(
  currentStationId: string,
  transfers: StationTransfer[],
  buildingId: string,
  date: string
): string {
  return resolveStationAt(currentStationId, chainOfBuilding(transfers, buildingId), atOfDate(date))
}

/** 某楼栋在指定时间戳的归属站（调节单按创建时点认定） */
export function stationOfBuildingAt(
  currentStationId: string,
  transfers: StationTransfer[],
  buildingId: string,
  at: number
): string {
  return resolveStationAt(currentStationId, chainOfBuilding(transfers, buildingId), at)
}

/**
 * at 时点某来源站名下的楼栋 id 集合（迁移台以外的页面做按站筛选用）。
 * buildings 传当前楼栋台账（stationId 为最新归属）。
 */
export function buildingIdsOfStationAt(
  buildings: ReadonlyArray<{ id: string; stationId: string }>,
  transfers: StationTransfer[],
  stationId: string,
  at: number
): Set<string> {
  const result = new Set<string>()
  buildings.forEach((building) => {
    if (resolveStationAt(building.stationId, chainOfBuilding(transfers, building.id), at) === stationId) {
      result.add(building.id)
    }
  })
  return result
}

/** 阀门在 at 时点的归属站：经楼栋链路解析 */
export function stationOfValveAt(
  valve: { buildingId: string; stationId: string },
  buildings: ReadonlyArray<{ id: string; stationId: string }>,
  transfers: StationTransfer[],
  at: number
): string {
  const building = buildings.find((item) => item.id === valve.buildingId)
  // 楼栋台账缺失时退回阀门冗余站标识
  const currentStationId = building ? building.stationId : valve.stationId
  return stationOfBuildingAt(currentStationId, transfers, valve.buildingId, at)
}
