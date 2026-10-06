/** 调节单：由失衡度排序生成，执行与复核分两步回写状态 */
export type AdjustState = '待下发' | '已调节' | '已复核'

export interface Adjust {
  id: string
  valveId: string
  /**
   * 归属换热站快照：派单时按当时生效归属写入，之后不再改写。
   * 用于并站迁移后「生效前的调节单仍认原站、不追溯改站」；旧备份缺省时按时效解析兜底。
   */
  stationId?: string
  /** 目标开度（%） */
  targetOpening: number
  /** 调节依据 */
  basis: string
  executor: string
  state: AdjustState
  /** 复核意见 */
  reviewNote: string
  createdAt: number
  updatedAt: number
}

export const ADJUST_STATES: AdjustState[] = ['待下发', '已调节', '已复核']

/** 调节单状态机：待下发 → 已调节 → 已复核 */
export const ADJUST_STATE_FLOW: Record<AdjustState, AdjustState | null> = {
  待下发: '已调节',
  已调节: '已复核',
  已复核: null
}

export interface AdjustDraft {
  valveId: string
  /** 归属换热站快照（由派单侧按阀门当前生效归属灌入） */
  stationId?: string
  targetOpening: number
  basis: string
  executor: string
  state: AdjustState
  reviewNote: string
}

export const EMPTY_ADJUST_DRAFT: AdjustDraft = {
  valveId: '',
  stationId: '',
  targetOpening: 50,
  basis: '',
  executor: '',
  state: '待下发',
  reviewNote: ''
}
