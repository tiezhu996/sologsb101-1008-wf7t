/**
 * 楼栋 / 阀门站点归属的响应式解析。
 * 数据源是 stationStore（当前台账）+ migrationStore（迁移记录），
 * 业务页面统一经这里取「某时点所属站」，不直接用 building.stationId 硬判，
 * 以保证生效后走新站、生效前的历史业务仍认原站。
 */
import { computed, type ComputedRef } from 'vue'
import { useStationStore } from '@/stores/stationStore'
import { useMigrationStore } from '@/stores/migrationStore'
import type { Station } from '@/types/station'
import {
  chainOfBuilding,
  resolveStationAt,
  stationOfBuildingAt,
  stationOfBuildingOnDate,
  stationOfValveAt
} from '@/utils/stationAttribution'
import type { StationTransfer } from '@/types/stationTransfer'

export interface StationAttributionApi {
  /** 全部迁移记录（响应式快照） */
  transfers: ComputedRef<StationTransfer[]>
  /** 楼栋在 at 时点的归属站 id */
  buildingStationIdAt: (currentStationId: string, buildingId: string, at: number) => string
  /** 楼栋在某日期的归属站 id（实测按实测日期） */
  buildingStationIdOnDate: (currentStationId: string, buildingId: string, date: string) => string
  /** 阀门在 at 时点的归属站 id */
  valveStationIdAt: (valve: { buildingId: string; stationId: string }, at: number) => string
  /** 当前时点的归属站对象（排行 / 录实测 / 派单用） */
  stationOfBuildingNow: (buildingId: string) => Station | null
  stationOfValveNow: (valve: { buildingId: string; stationId: string }) => Station | null
  /** 历史时点的归属站对象（历史实测 / 调节单 / 导出用） */
  stationOfBuildingAt: (buildingId: string, at: number) => Station | null
  stationOfValveAt: (valve: { buildingId: string; stationId: string }, at: number) => Station | null
  stationOfValveOnDate: (valve: { buildingId: string; stationId: string }, date: string) => Station | null
  /** 当前时点某站名下的楼栋 id 集合（按站筛选用） */
  buildingIdsOfStationNow: (stationId: string) => Set<string>
}

export function useStationAttribution(): StationAttributionApi {
  const stationStore = useStationStore()
  const migrationStore = useMigrationStore()

  const transfers = computed<StationTransfer[]>(() => migrationStore.transfers)

  const buildingStationIdAt = (currentStationId: string, buildingId: string, at: number): string =>
    resolveStationAt(currentStationId, chainOfBuilding(transfers.value, buildingId), at)

  const buildingStationIdOnDate = (currentStationId: string, buildingId: string, date: string): string =>
    stationOfBuildingOnDate(currentStationId, transfers.value, buildingId, date)

  const valveStationIdAt = (valve: { buildingId: string; stationId: string }, at: number): string =>
    stationOfValveAt(valve, stationStore.buildings, transfers.value, at)

  const stationOfBuildingNow = (buildingId: string): Station | null => {
    const building = stationStore.buildingById.get(buildingId)
    if (!building) return null
    const id = stationOfBuildingAt(building.stationId, transfers.value, buildingId, Date.now())
    return stationStore.stationById.get(id) ?? null
  }

  const stationOfValveNow = (valve: { buildingId: string; stationId: string }): Station | null => {
    const id = valveStationIdAt(valve, Date.now())
    return stationStore.stationById.get(id) ?? null
  }

  const stationOfBuildingAtTyped = (buildingId: string, at: number): Station | null => {
    const building = stationStore.buildingById.get(buildingId)
    if (!building) return null
    const id = stationOfBuildingAt(building.stationId, transfers.value, buildingId, at)
    return stationStore.stationById.get(id) ?? null
  }

  const stationOfValveAtTyped = (
    valve: { buildingId: string; stationId: string },
    at: number
  ): Station | null => {
    const id = valveStationIdAt(valve, at)
    return stationStore.stationById.get(id) ?? null
  }

  const stationOfValveOnDate = (
    valve: { buildingId: string; stationId: string },
    date: string
  ): Station | null => {
    const building = stationStore.buildingById.get(valve.buildingId)
    const currentStationId = building ? building.stationId : valve.stationId
    const id = buildingStationIdOnDate(currentStationId, valve.buildingId, date)
    return stationStore.stationById.get(id) ?? null
  }

  const buildingIdsOfStationNow = (stationId: string): Set<string> => {
    const now = Date.now()
    const result = new Set<string>()
    stationStore.buildings.forEach((building) => {
      if (buildingStationIdAt(building.stationId, building.id, now) === stationId) result.add(building.id)
    })
    return result
  }

  return {
    transfers,
    buildingStationIdAt,
    buildingStationIdOnDate,
    valveStationIdAt,
    stationOfBuildingNow,
    stationOfValveNow,
    stationOfBuildingAt: stationOfBuildingAtTyped,
    stationOfValveAt: stationOfValveAtTyped,
    stationOfValveOnDate,
    buildingIdsOfStationNow
  }
}
