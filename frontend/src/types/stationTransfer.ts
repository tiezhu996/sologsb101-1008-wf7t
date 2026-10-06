/**
 * 并网迁移记录：两座换热站并网后，楼栋分批由来源站划到目标站。
 *
 * 口径约定（与业务页面保持一致）：
 * - 迁移单创建即整包写入：楼栋归属 building.stationId、阀门冗余 stationId、
 *   迁移记录三处同一事务提交，任一失败全部回滚。
 * - effectiveAt 为生效时点：生效后的排行 / 实测录入 / 派单按目标站；
 *   生效前已发生的实测、调节单与导出仍按发生时点所属的原站认定，不追溯改站。
 * - buildingIds 为本次整包迁移的楼栋清单；buildingSnapshots 留存确认时快照，
 *   便于核对「确认前被别人改过」的乐观锁冲突。
 */
export interface StationTransfer {
  id: string
  sourceStationId: string
  targetStationId: string
  /** 生效时点（毫秒时间戳） */
  effectiveAt: number
  buildingIds: string[]
  /** 整包内阀门 id 清单（提交时按楼栋汇总） */
  valveIds: string[]
  reason: string
  operator: string
  /** 确认时各楼栋 revision，用于冲突排查展示 */
  buildingSnapshots: Array<{
    buildingId: string
    name: string
    fromStationId: string
    revision: number
  }>
  createdAt: number
  updatedAt: number
}

export interface StationTransferDraft {
  sourceStationId: string
  targetStationId: string
  /** 生效时点：日期 + 时分（本地时区） */
  effectiveDate: string
  effectiveTime: string
  buildingIds: string[]
  reason: string
  operator: string
}

export const EMPTY_TRANSFER_DRAFT: StationTransferDraft = {
  sourceStationId: '',
  targetStationId: '',
  effectiveDate: '',
  effectiveTime: '00:00',
  buildingIds: [],
  reason: '',
  operator: ''
}

/** 迁移预览中的未完调节单 */
export interface TransferBlockingOrder {
  adjustId: string
  valveId: string
  valveCode: string
  buildingId: string
  buildingName: string
  state: '待下发' | '已调节'
  reason: string
}

/** 楼栋/阀门与确认时快照的修订差异 */
export interface TransferRevisionConflict {
  kind: 'building' | 'valve'
  id: string
  label: string
  expectedRevision: number
  actualRevision: number
}

/** 迁移预览：受影响阀门、未完调节单与硬性拦截项 */
export interface TransferPreview {
  sourceStationId: string
  targetStationId: string
  buildings: Array<{ id: string; name: string; areaM2: number; heatMode: string; revision: number }>
  valves: Array<{
    id: string
    code: string
    buildingId: string
    buildingName: string
    dn: number
    currentOpening: number
    revision: number
  }>
  blockingOrders: TransferBlockingOrder[]
  blockers: string[]
  warnings: string[]
}

/** 迁移整包提交结果 */
export interface StationTransferCommitError {
  code:
    | 'INVALID_PLAN'
    | 'CONCURRENT_REVISION'
    | 'BUILDING_MOVED'
    | 'BLOCKING_ORDERS'
    | 'OVERLAP_PENDING'
    | 'WRITE_FAILED'
  message: string
  conflicts?: TransferRevisionConflict[]
}

export function todayDateString(): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** 由日期（YYYY-MM-DD）与时分（HH:mm）拼出本地时区毫秒时间戳 */
export function effectiveAtOf(date: string, time: string): number {
  const matchDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim())
  if (!matchDate) return NaN
  const [, y, m, d] = matchDate
  const matchTime = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  const hh = matchTime ? Number(matchTime[1]) : 0
  const mm = matchTime ? Number(matchTime[2]) : 0
  return new Date(Number(y), Number(m) - 1, Number(d), hh, mm, 0, 0).getTime()
}

/** 迁移单是否已到生效时点 */
export function transferIsEffective(transfer: StationTransfer, at: number = Date.now()): boolean {
  return transfer.effectiveAt <= at
}

/** 迁移单状态（由生效时点派生，不入库） */
export type TransferPhase = '待生效' | '已生效'

export function transferPhase(transfer: StationTransfer, at: number = Date.now()): TransferPhase {
  return transferIsEffective(transfer, at) ? '已生效' : '待生效'
}

export function formatEffectiveAt(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const date = new Date(value)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
