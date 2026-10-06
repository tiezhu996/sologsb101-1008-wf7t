/** 实测：某阀门某日的一组流量与三温读数 */
export interface Measure {
  id: string
  valveId: string
  /**
   * 归属换热站快照：录入时按当时生效归属写入，之后不再改写。
   * 用于并站迁移后「生效前的实测仍认原站」；旧备份缺省时按时效解析兜底。
   */
  stationId?: string
  /** 实测日期 YYYY-MM-DD */
  date: string
  /** 实测流量（m³/h） */
  flowM3h: number
  supplyTempC: number
  returnTempC: number
  roomTempC: number
  operator: string
  createdAt: number
  updatedAt: number
}

export interface MeasureDraft {
  valveId: string
  /** 归属换热站快照（由录入页按阀门当前生效归属灌入，不要求手填） */
  stationId?: string
  date: string
  flowM3h: number
  supplyTempC: number
  returnTempC: number
  roomTempC: number
  operator: string
}

export const EMPTY_MEASURE_DRAFT: MeasureDraft = {
  valveId: '',
  stationId: '',
  date: '',
  flowM3h: 0,
  supplyTempC: 50,
  returnTempC: 40,
  roomTempC: 20,
  operator: ''
}

/** 室温设计目标值（℃），用于计算室温偏差 */
export const ROOM_TARGET_C = 20

export interface MeasureBatchRow {
  valveId: string
  date: string
  flowM3h: number
  supplyTempC: number
  returnTempC: number
  roomTempC: number
  operator: string
}
