/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号 + upgrade 迁移
 * - 级联删除、整库导入导出、首屏幂等播种
 */
import Dexie, { type Table } from 'dexie'
import type { Station } from '@/types/station'
import type { Building } from '@/types/building'
import type { Valve } from '@/types/valve'
import type { Measure } from '@/types/measure'
import type { Adjust } from '@/types/adjust'
import type { StationMigration } from '@/types/migration'

export const DB_NAME = 'gbheatgrid'
export const DB_VERSION = 3

export const LS_KEYS = {
  dbVersion: 'gbheatgrid:db-version',
  lastBackupAt: 'gbheatgrid:last-backup-at',
  uiPrefs: 'gbheatgrid:ui-prefs'
} as const

export interface UiPrefs {
  lastStationId: string | null
  onlyImbalanced: boolean
}

export const DEFAULT_UI_PREFS: UiPrefs = { lastStationId: null, onlyImbalanced: false }

export interface BackupPayload {
  app: 'gbheatgrid'
  dbVersion: number
  exportedAt: string
  stations: Station[]
  buildings: Building[]
  valves: Valve[]
  measures: Measure[]
  adjusts: Adjust[]
  /**
   * 并站迁移记录。旧版本备份（v1/v2）不含此字段，导入时按缺省空数组处理；
   * 历史实测 / 调节单缺归属快照时再由迁移时效解析兜底，兼容旧备份。
   */
  stationMigrations?: StationMigration[]
}

export interface RevisionedFields {
  revision?: number
}

/**
   楼栋 / 阀门 / 迁移记录等行级版本号：乐观锁依据，确认前被别人改过即判定冲突。
   新建行写当前值，更新行在原基础上 +1。
 */
export const ROW_REVISION = 2

export type StationRow = Station & RevisionedFields
export type BuildingRow = Building & RevisionedFields
export type ValveRow = Valve & RevisionedFields
export type MeasureRow = Measure & RevisionedFields
export type AdjustRow = Adjust & RevisionedFields
export type StationMigrationRow = StationMigration & RevisionedFields

class HeatGridDatabase extends Dexie {
  stations!: Table<StationRow, string>
  buildings!: Table<BuildingRow, string>
  valves!: Table<ValveRow, string>
  measures!: Table<MeasureRow, string>
  adjusts!: Table<AdjustRow, string>
  stationMigrations!: Table<StationMigrationRow, string>

  constructor() {
    super(DB_NAME)

    this.version(1).stores({
      stations: 'id, name, commissionYear',
      buildings: 'id, stationId, name, heatMode',
      valves: 'id, buildingId, code, position',
      measures: 'id, valveId, date',
      adjusts: 'id, valveId, state'
    })

    // v2：阀门补 stationId 冗余列并在升级时回填；实测补 revision；调节单补 reviewNote
    this.version(2)
      .stores({
        stations: 'id, name, commissionYear, updatedAt',
        buildings: 'id, stationId, name, heatMode, updatedAt',
        valves: 'id, buildingId, stationId, code, position, updatedAt',
        measures: 'id, valveId, date, operator, updatedAt',
        adjusts: 'id, valveId, state, executor, updatedAt'
      })
      .upgrade(async (tx) => {
        const buildings = (await tx.table('buildings').toArray()) as Array<{ id: string; stationId: string }>
        const stationOfBuilding = new Map(buildings.map((item) => [item.id, item.stationId]))

        await tx
          .table('valves')
          .toCollection()
          .modify((valve: Record<string, unknown>) => {
            valve.revision = ROW_REVISION
            if (typeof valve.stationId !== 'string' || valve.stationId.length === 0) {
              valve.stationId = stationOfBuilding.get(String(valve.buildingId)) ?? ''
            }
            if (typeof valve.currentOpening !== 'number' || !Number.isFinite(valve.currentOpening)) {
              valve.currentOpening = 50
            }
          })

        for (const name of ['stations', 'buildings', 'measures', 'adjusts']) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION
            })
        }

        await tx
          .table('adjusts')
          .toCollection()
          .modify((adjust: Record<string, unknown>) => {
            if (typeof adjust.reviewNote !== 'string') adjust.reviewNote = ''
            if (adjust.state !== '待下发' && adjust.state !== '已调节' && adjust.state !== '已复核') {
              adjust.state = '待下发'
            }
          })
      })

    // v3：并站迁移——新增迁移记录表；实测 / 调节单补 stationId 归属快照索引。
    // 旧行不回填归属快照（回填会把历史数据错误归到当前站），缺省时由迁移时效解析兜底。
    this.version(DB_VERSION).stores({
      stations: 'id, name, commissionYear, updatedAt',
      buildings: 'id, stationId, name, heatMode, updatedAt',
      valves: 'id, buildingId, stationId, code, position, updatedAt',
      measures: 'id, valveId, stationId, date, operator, updatedAt',
      adjusts: 'id, valveId, stationId, state, executor, updatedAt',
      stationMigrations: 'id, sourceStationId, targetStationId, effectiveAt, createdAt'
    })
  }
}

export const db = new HeatGridDatabase()

export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/* ============================ 演示数据播种 ============================ */

/** 演示数据基准时间（2024-11-20 09:00 +08:00），供测试按播种时钟推演生效时点 */
export const SEED_STAMP = Date.parse('2024-11-20T09:00:00+08:00')
const stamp = (offsetDays = 0): number => SEED_STAMP + offsetDays * 86400000

const SEED_STATIONS: StationRow[] = [
  { id: 'st-1', name: '阳光家园换热站', heatAreaM2: 86000, designFlowM3h: 320, supplyTempC: 55, returnTempC: 40, commissionYear: 2015, createdAt: stamp(-300), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'st-2', name: '锦绣花园换热站', heatAreaM2: 64000, designFlowM3h: 240, supplyTempC: 52, returnTempC: 38, commissionYear: 2018, createdAt: stamp(-280), updatedAt: stamp(-1), revision: ROW_REVISION }
]

const SEED_BUILDINGS: BuildingRow[] = [
  { id: 'bd-1', stationId: 'st-2', name: '3号楼', areaM2: 4800, floors: 11, units: 2, heatMode: '地暖', createdAt: stamp(-290), updatedAt: stamp(-10), revision: ROW_REVISION + 1 },
  { id: 'bd-2', stationId: 'st-1', name: '5号楼', areaM2: 5200, floors: 12, units: 2, heatMode: '散热器', createdAt: stamp(-289), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'bd-3', stationId: 'st-1', name: '7号楼', areaM2: 4100, floors: 9, units: 1, heatMode: '地暖', createdAt: stamp(-288), updatedAt: stamp(-3), revision: ROW_REVISION },
  { id: 'bd-4', stationId: 'st-2', name: 'A座', areaM2: 6800, floors: 15, units: 3, heatMode: '散热器', createdAt: stamp(-270), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'bd-5', stationId: 'st-2', name: 'B座', areaM2: 5900, floors: 14, units: 2, heatMode: '地暖', createdAt: stamp(-269), updatedAt: stamp(-1), revision: ROW_REVISION }
]

const SEED_VALVES: ValveRow[] = [
  { id: 'vv-1', buildingId: 'bd-1', stationId: 'st-2', code: 'BL-3-01', dn: 65, currentOpening: 60, designFlowM3h: 32, position: '楼栋总阀', createdAt: stamp(-280), updatedAt: stamp(-10), revision: ROW_REVISION + 1 },
  { id: 'vv-2', buildingId: 'bd-1', stationId: 'st-2', code: 'BL-3-02', dn: 50, currentOpening: 45, designFlowM3h: 18, position: '单元立管', createdAt: stamp(-280), updatedAt: stamp(-10), revision: ROW_REVISION + 1 },
  { id: 'vv-3', buildingId: 'bd-2', stationId: 'st-1', code: 'BL-5-01', dn: 65, currentOpening: 75, designFlowM3h: 35, position: '楼栋总阀', createdAt: stamp(-279), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'vv-4', buildingId: 'bd-2', stationId: 'st-1', code: 'BL-5-02', dn: 50, currentOpening: 55, designFlowM3h: 20, position: '单元立管', createdAt: stamp(-279), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'vv-5', buildingId: 'bd-3', stationId: 'st-1', code: 'BL-7-01', dn: 50, currentOpening: 40, designFlowM3h: 22, position: '楼栋总阀', createdAt: stamp(-278), updatedAt: stamp(-3), revision: ROW_REVISION },
  { id: 'vv-6', buildingId: 'bd-3', stationId: 'st-1', code: 'BL-7-02', dn: 40, currentOpening: 35, designFlowM3h: 14, position: '单元立管', createdAt: stamp(-278), updatedAt: stamp(-3), revision: ROW_REVISION },
  { id: 'vv-7', buildingId: 'bd-4', stationId: 'st-2', code: 'BL-A-01', dn: 80, currentOpening: 85, designFlowM3h: 48, position: '楼栋总阀', createdAt: stamp(-260), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'vv-8', buildingId: 'bd-4', stationId: 'st-2', code: 'BL-A-02', dn: 50, currentOpening: 70, designFlowM3h: 22, position: '单元立管', createdAt: stamp(-260), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'vv-9', buildingId: 'bd-5', stationId: 'st-2', code: 'BL-B-01', dn: 65, currentOpening: 50, designFlowM3h: 30, position: '楼栋总阀', createdAt: stamp(-259), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'vv-10', buildingId: 'bd-5', stationId: 'st-2', code: 'BL-B-02', dn: 50, currentOpening: 30, designFlowM3h: 18, position: '单元立管', createdAt: stamp(-259), updatedAt: stamp(-1), revision: ROW_REVISION }
]

function mkMeasure(
  id: string,
  valveId: string,
  dayOffset: number,
  flowM3h: number,
  supply: number,
  back: number,
  room: number,
  operator: string,
  stationId?: string
): MeasureRow {
  return {
    id,
    valveId,
    // 归属站快照：历史数据按当时归属认账（见 v3 并站迁移演示数据）
    stationId,
    date: new Date(SEED_STAMP + dayOffset * 86400000).toISOString().slice(0, 10),
    flowM3h,
    supplyTempC: supply,
    returnTempC: back,
    roomTempC: room,
    operator,
    createdAt: stamp(dayOffset),
    updatedAt: stamp(dayOffset),
    revision: ROW_REVISION
  }
}

const SEED_MEASURES: MeasureRow[] = [
  // vv-1（3号楼）在 -10 日由 st-1 迁入 st-2：-16/-14 的历史实测仍认 st-1，之后录的认 st-2
  mkMeasure('ms-1-1', 'vv-1', -16, 17.8, 53, 41, 18.9, '王海', 'st-1'),
  mkMeasure('ms-1-2', 'vv-1', -2, 18.6, 51, 39.5, 19.4, '王海', 'st-2'),
  mkMeasure('ms-2-1', 'vv-2', -16, 11.9, 53, 41, 20.3, '王海', 'st-1'),
  mkMeasure('ms-2-2', 'vv-2', -2, 12.4, 51, 39.5, 20.6, '王海', 'st-2'),
  mkMeasure('ms-3-1', 'vv-3', -15, 36.2, 52, 40, 20.4, '李强'),
  mkMeasure('ms-3-2', 'vv-3', -1, 38.8, 50, 39, 21.2, '李强'),
  mkMeasure('ms-4-1', 'vv-4', -15, 23.1, 52, 40, 22.1, '李强'),
  mkMeasure('ms-4-2', 'vv-4', -1, 24.6, 50, 39, 22.6, '李强'),
  mkMeasure('ms-5-1', 'vv-5', -15, 14.4, 52, 40, 18.8, '赵明'),
  mkMeasure('ms-5-2', 'vv-5', -1, 15.1, 50, 38.5, 19.0, '赵明'),
  mkMeasure('ms-6-1', 'vv-6', -14, 13.4, 52, 40, 19.9, '赵明'),
  mkMeasure('ms-6-2', 'vv-6', -1, 13.9, 50, 38.5, 20.1, '赵明'),
  mkMeasure('ms-7-1', 'vv-7', -13, 54.2, 51, 39, 21.1, '孙倩'),
  mkMeasure('ms-7-2', 'vv-7', -1, 56.4, 49, 38, 21.8, '孙倩'),
  mkMeasure('ms-8-1', 'vv-8', -13, 17.6, 51, 39, 19.2, '孙倩'),
  mkMeasure('ms-8-2', 'vv-8', -1, 18.2, 49, 38, 19.5, '孙倩'),
  mkMeasure('ms-9-1', 'vv-9', -12, 21.4, 50, 38, 18.6, '孙倩'),
  mkMeasure('ms-9-2', 'vv-9', -1, 22.1, 49, 37.5, 18.8, '孙倩'),
  mkMeasure('ms-10-1', 'vv-10', -12, 21.8, 50, 38, 23.0, '王海'),
  mkMeasure('ms-10-2', 'vv-10', -1, 22.6, 49, 37.5, 23.4, '王海')
]

const SEED_ADJUSTS: AdjustRow[] = [
  // 历史调节单按派单时归属认账：aj-1 派单时 3号楼仍在 st-1，虽已复核闭环也保留原站快照
  { id: 'aj-1', valveId: 'vv-1', stationId: 'st-1', targetOpening: 55, basis: '3号楼 BL-3-01 失衡度 30.2%，流量比 0.58 明显偏小，需增大开度补流', executor: '王海', state: '已复核', reviewNote: '复核后流量比回升至 0.96，室温 20.4℃，合格', createdAt: stamp(-14), updatedAt: stamp(-6), revision: ROW_REVISION },
  { id: 'aj-2', valveId: 'vv-5', stationId: 'st-1', targetOpening: 60, basis: '7号楼 BL-7-01 失衡度 23.5%，楼栋整体偏小，建议开度由 40% 调至 60%', executor: '赵明', state: '已调节', reviewNote: '', createdAt: stamp(-9), updatedAt: stamp(-4), revision: ROW_REVISION },
  { id: 'aj-3', valveId: 'vv-9', stationId: 'st-2', targetOpening: 62, basis: 'B座 BL-B-01 失衡度 20.2%，流量比 0.74 偏小', executor: '孙倩', state: '待下发', reviewNote: '', createdAt: stamp(-3), updatedAt: stamp(-3), revision: ROW_REVISION },
  { id: 'aj-4', valveId: 'vv-4', stationId: 'st-1', targetOpening: 50, basis: '5号楼 BL-5-02 失衡度 20.0%，流量比 1.23 偏大，需关小阀门', executor: '李强', state: '待下发', reviewNote: '', createdAt: stamp(-2), updatedAt: stamp(-2), revision: ROW_REVISION }
]

/**
 * 并站迁移演示记录：
 * - mg-1：3号楼已在 -10 日由阳光家园（st-1）整栋划到锦绣花园（st-2），
 *   其 -16 日实测与 -14 日调节单仍认 st-1，当前排行 / 录数走 st-2；
 * - mg-2：7号楼（bd-3）计划 +7 日划到 st-2，迁移台可直接看到「待生效」，
 *   但该楼 vv-5 有「已调节未复核」单（aj-2），再次提交会被挡住，演示拦截口径。
 */
const SEED_MIGRATIONS: StationMigrationRow[] = [
  {
    id: 'mg-1',
    sourceStationId: 'st-1',
    targetStationId: 'st-2',
    buildingIds: ['bd-1'],
    valveIds: ['vv-1', 'vv-2'],
    buildingNames: ['3号楼'],
    valveCodes: ['BL-3-01', 'BL-3-02'],
    effectiveAt: stamp(-10),
    activatedAt: stamp(-10),
    operator: '调度室',
    remark: '两站并网首批：3号楼就近切到锦绣花园换热站',
    createdAt: stamp(-11),
    updatedAt: stamp(-10),
    revision: ROW_REVISION
  },
  {
    id: 'mg-2',
    sourceStationId: 'st-1',
    targetStationId: 'st-2',
    buildingIds: ['bd-3'],
    valveIds: ['vv-5', 'vv-6'],
    buildingNames: ['7号楼'],
    valveCodes: ['BL-7-01', 'BL-7-02'],
    effectiveAt: stamp(7),
    operator: '调度室',
    remark: '并网第二批（计划中）：待 BL-7-01 调节单复核闭环后执行',
    createdAt: stamp(-1),
    updatedAt: stamp(-1),
    revision: ROW_REVISION
  }
]

export async function seedDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.stations, db.buildings, db.valves, db.measures, db.adjusts, db.stationMigrations],
    async () => {
      await db.stations.bulkPut(SEED_STATIONS)
      await db.buildings.bulkPut(SEED_BUILDINGS)
      await db.valves.bulkPut(SEED_VALVES)
      await db.measures.bulkPut(SEED_MEASURES)
      await db.adjusts.bulkPut(SEED_ADJUSTS)
      await db.stationMigrations.bulkPut(SEED_MIGRATIONS)
    }
  )
}

/** 首屏调用：打开数据库并在主表为空时播种演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open()
  if ((await db.stations.count()) === 0) {
    await seedDatabase()
  }
}

/* ============================== 级联删除 ============================== */

export async function deleteStationCascade(stationId: string): Promise<void> {
  await db.transaction('rw', db.stations, db.buildings, db.valves, db.measures, db.adjusts, async () => {
    const buildings = await db.buildings.where('stationId').equals(stationId).toArray()
    await deleteValvesOfBuildings(buildings.map((item) => item.id))
    if (buildings.length > 0) await db.buildings.bulkDelete(buildings.map((item) => item.id))
    await db.stations.delete(stationId)
  })
}

export async function deleteBuildingCascade(buildingId: string): Promise<void> {
  await db.transaction('rw', db.buildings, db.valves, db.measures, db.adjusts, async () => {
    await deleteValvesOfBuildings([buildingId])
    await db.buildings.delete(buildingId)
  })
}

export async function deleteValveCascade(valveId: string): Promise<void> {
  await db.transaction('rw', db.valves, db.measures, db.adjusts, async () => {
    await db.measures.where('valveId').equals(valveId).delete()
    await db.adjusts.where('valveId').equals(valveId).delete()
    await db.valves.delete(valveId)
  })
}

async function deleteValvesOfBuildings(buildingIds: string[]): Promise<void> {
  if (buildingIds.length === 0) return
  const valves = await db.valves.where('buildingId').anyOf(buildingIds).toArray()
  const valveIds = valves.map((valve) => valve.id)
  if (valveIds.length > 0) {
    await db.measures.where('valveId').anyOf(valveIds).delete()
    await db.adjusts.where('valveId').anyOf(valveIds).delete()
    await db.valves.bulkDelete(valveIds)
  }
}

/* ============================ 整库导入导出 ============================ */

export async function countAll(): Promise<Record<string, number>> {
  const [stations, buildings, valves, measures, adjusts, stationMigrations] = await Promise.all([
    db.stations.count(),
    db.buildings.count(),
    db.valves.count(),
    db.measures.count(),
    db.adjusts.count(),
    db.stationMigrations.count()
  ])
  return { stations, buildings, valves, measures, adjusts, stationMigrations }
}

export async function exportSnapshot(): Promise<BackupPayload> {
  const [stations, buildings, valves, measures, adjusts, stationMigrations] = await Promise.all([
    db.stations.toArray(),
    db.buildings.toArray(),
    db.valves.toArray(),
    db.measures.toArray(),
    db.adjusts.toArray(),
    db.stationMigrations.toArray()
  ])
  const strip = <T extends RevisionedFields>(row: T): Omit<T, 'revision'> => {
    const { revision: _revision, ...rest } = row
    return rest
  }
  return {
    app: 'gbheatgrid',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    stations: stations.map(strip),
    buildings: buildings.map(strip),
    valves: valves.map(strip),
    measures: measures.map(strip),
    adjusts: adjusts.map(strip),
    stationMigrations: stationMigrations.map(strip)
  }
}

/**
 * 整库导入：兼容旧备份。
 * - v1/v2 备份没有 stationMigrations 字段，按空数组处理；
 * - 旧实测 / 调节单没有 stationId 归属快照时保留缺省，读取侧按时效解析兜底；
 * - 迁移记录只追加、不做字段升级，原样写回。
 */
export async function importSnapshot(payload: BackupPayload): Promise<void> {
  await db.transaction(
    'rw',
    [db.stations, db.buildings, db.valves, db.measures, db.adjusts, db.stationMigrations],
    async () => {
      await Promise.all([
        db.stations.clear(),
        db.buildings.clear(),
        db.valves.clear(),
        db.measures.clear(),
        db.adjusts.clear(),
        db.stationMigrations.clear()
      ])
      const rev = <T>(row: T): T & RevisionedFields => ({ ...row, revision: ROW_REVISION })
      await db.stations.bulkPut((payload.stations ?? []).map(rev))
      await db.buildings.bulkPut((payload.buildings ?? []).map(rev))
      await db.valves.bulkPut((payload.valves ?? []).map(rev))
      await db.measures.bulkPut((payload.measures ?? []).map(rev))
      await db.adjusts.bulkPut((payload.adjusts ?? []).map(rev))
      await db.stationMigrations.bulkPut((payload.stationMigrations ?? []).map(rev))
    }
  )
}

export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.stations, db.buildings, db.valves, db.measures, db.adjusts, db.stationMigrations],
    async () => {
      await Promise.all([
        db.stations.clear(),
        db.buildings.clear(),
        db.valves.clear(),
        db.measures.clear(),
        db.adjusts.clear(),
        db.stationMigrations.clear()
      ])
    }
  )
}

export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDatabase()
}

/* ============================ 本地 UI 偏好 ============================ */

export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs)
    if (!raw) return { ...DEFAULT_UI_PREFS }
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    return {
      lastStationId: typeof parsed.lastStationId === 'string' ? parsed.lastStationId : null,
      onlyImbalanced: parsed.onlyImbalanced === true
    }
  } catch {
    return { ...DEFAULT_UI_PREFS }
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs))
}

export function stampDbVersion(): void {
  localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
}

export function readStampedDbVersion(): number {
  const parsed = Number(localStorage.getItem(LS_KEYS.dbVersion))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
}

export function stampBackupTime(iso: string): void {
  localStorage.setItem(LS_KEYS.lastBackupAt, iso)
}

export function readLastBackupAt(): string | null {
  return localStorage.getItem(LS_KEYS.lastBackupAt)
}
