/**
 * 并站迁移记录：楼栋分批由来源换热站划到目标换热站。
 * 记录一旦写入只追加、不删改，作为「某时点楼栋归属哪座站」的唯一追溯依据；
 * 生效时点之前的实测 / 调节单仍按来源站认账，不因楼栋改挂而追溯改站。
 */
export interface StationMigration {
  id: string
  sourceStationId: string
  targetStationId: string
  /** 本批次划出的楼栋 id */
  buildingIds: string[]
  /** 提交时整包快照的受影响阀门 id（阀门后续可增删，以快照为准） */
  valveIds: string[]
  /** 楼栋名称快照，便于楼栋被删除后仍可读 */
  buildingNames: string[]
  /** 阀门编号快照，便于阀门被删除后仍可读 */
  valveCodes: string[]
  /** 生效时点（毫秒时间戳）：该时点起排行 / 录数 / 派单走目标站 */
  effectiveAt: number
  /**
   * 物理激活时间：楼栋归属与阀门冗余站实际翻到目标站的时间。
   * 立即生效时等于提交时间；预约未来生效时由到点激活补齐。
   */
  activatedAt?: number
  /** 经办人 */
  operator: string
  /** 迁移备注，如并网批次说明 */
  remark: string
  createdAt: number
  updatedAt: number
}

export interface StationMigrationDraft {
  sourceStationId: string
  targetStationId: string
  buildingIds: string[]
  effectiveAt: number
  operator: string
  remark: string
}

export const EMPTY_MIGRATION_DRAFT: StationMigrationDraft = {
  sourceStationId: '',
  targetStationId: '',
  buildingIds: [],
  effectiveAt: 0,
  operator: '',
  remark: ''
}

export type MigrationStatus = '待生效' | '已生效'

/** 迁移记录在指定时点（默认当前）的生效状态 */
export function migrationStatusAt(effectiveAt: number, at: number = Date.now()): MigrationStatus {
  return effectiveAt <= at ? '已生效' : '待生效'
}

const pad2 = (value: number): string => String(value).padStart(2, '0')

/** 格式化为本地时区 YYYY-MM-DD HH:mm */
export function formatEffectiveAt(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return '—'
  const date = new Date(timestamp)
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  )
}

/**
 * 解析生效时点输入（YYYY-MM-DD HH:mm），非法时返回 null。
 * 未填时分按当日 00:00 处理。
 */
export function parseEffectiveAt(text: string): number | null {
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  const matched = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2}))?$/.exec(trimmed)
  if (!matched) return null
  const [, year, month, day, hour, minute] = matched
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    hour ? Number(hour) : 0,
    minute ? Number(minute) : 0,
    0,
    0
  )
  return Number.isNaN(date.getTime()) ? null : date.getTime()
}
