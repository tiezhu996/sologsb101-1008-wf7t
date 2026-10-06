/**
 * 导出工具：整库 JSON 存档、调节单 CSV、剪贴板复制
 */
import type { Station } from '@/types/station'
import type { Building } from '@/types/building'
import type { Valve } from '@/types/valve'
import type { Measure } from '@/types/measure'
import type { Adjust } from '@/types/adjust'
import type { StationMigration } from '@/types/migration'
import { imbalance, balanceLevel, flowRatio } from '@/utils/balance'
import { resolveAdjustStationId } from '@/utils/migration'

export function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function stampSuffix(): string {
  const date = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

export function exportBackupJson(payload: unknown): string {
  const filename = `gbheatgrid-backup-${stampSuffix()}.json`
  download(filename, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8')
  return filename
}

export function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * 导出调节单 CSV（含失衡度与流量比）
 * 换热站按调节单派单时归属快照认账（旧单缺快照时由迁移时效解析兜底），不随楼栋改挂追溯。
 */
export function exportAdjustCsv(
  stations: Station[],
  buildings: Building[],
  valves: Valve[],
  measures: Measure[],
  adjusts: Adjust[],
  migrations: StationMigration[] = []
): string {
  const stationById = new Map(stations.map((station) => [station.id, station]))
  const buildingById = new Map(buildings.map((building) => [building.id, building]))
  const valveById = new Map(valves.map((valve) => [valve.id, valve]))
  const header = [
    '换热站(派单时归属)',
    '楼栋',
    '供热方式',
    '阀门编号',
    '口径DN',
    '位置',
    '设计流量(m³/h)',
    '实测流量(m³/h)',
    '流量比',
    '室温(℃)',
    '失衡度(%)',
    '判级',
    '当前开度(%)',
    '目标开度(%)',
    '调节依据',
    '执行人',
    '状态',
    '复核意见'
  ]
  const lines: string[] = [header.map(csvCell).join(',')]
  adjusts.forEach((adjust) => {
    const valve = valveById.get(adjust.valveId)
    const building = valve ? buildingById.get(valve.buildingId) ?? null : null
    // 历史调节单认原站：优先派单快照，缺省时按 createdAt 在迁移链上解析
    const stationId = resolveAdjustStationId(adjust, valve, migrations)
    const station = stationById.get(stationId) ?? null
    const own = measures.filter((item) => item.valveId === adjust.valveId).sort((a, b) => a.date.localeCompare(b.date))
    const latest = own[own.length - 1]
    const design = valve ? valve.designFlowM3h : 0
    const measured = latest ? latest.flowM3h : 0
    const room = latest ? latest.roomTempC : 0
    const value = imbalance(measured, design, room)
    lines.push(
      [
        station ? station.name : '—',
        building ? building.name : '—',
        building ? building.heatMode : '—',
        valve ? valve.code : '—',
        valve ? valve.dn : '—',
        valve ? valve.position : '—',
        design,
        latest ? measured : '—',
        latest ? flowRatio(measured, design).toFixed(2) : '—',
        latest ? room : '—',
        value,
        balanceLevel(value, measured, design),
        valve ? valve.currentOpening : '—',
        adjust.targetOpening,
        adjust.basis,
        adjust.executor,
        adjust.state,
        adjust.reviewNote
      ]
        .map(csvCell)
        .join(',')
    )
  })
  const filename = `调节单-${stampSuffix()}.csv`
  download(filename, `\uFEFF${lines.join('\n')}`, 'text/csv;charset=utf-8')
  return filename
}

/**
 * 导出失衡度排行 CSV
 * 换热站按「最新实测当时的归属」认账：生效前的历史实测仍认原站，不因楼栋改挂追溯。
 */
export function exportBalanceCsv(
  rows: Array<{
    station: Station | null
    building: Building | null
    valve: Valve
    /** 最新实测当时的归属站（由调用方按时效解析）；无实测时取当前生效站 */
    latestStationId?: string
    measured: number
    ratio: number
    flowDeviation: number
    roomDeviation: number
    imbalanceValue: number
    level: string
  }>,
  stations: Station[] = []
): string {
  const stationById = new Map(stations.map((station) => [station.id, station]))
  const header = ['换热站(实测时归属)', '楼栋', '阀门编号', '设计流量', '实测流量', '流量比', '流量偏差(%)', '室温偏差(℃)', '失衡度(%)', '判级']
  const lines: string[] = [header.map(csvCell).join(',')]
  rows.forEach((row) => {
    const historicalStation = row.latestStationId ? stationById.get(row.latestStationId) ?? null : row.station
    lines.push(
      [
        historicalStation ? historicalStation.name : '—',
        row.building ? row.building.name : '—',
        row.valve.code,
        row.valve.designFlowM3h,
        row.measured,
        row.ratio.toFixed(2),
        row.flowDeviation.toFixed(1),
        row.roomDeviation.toFixed(1),
        row.imbalanceValue.toFixed(1),
        row.level
      ]
        .map(csvCell)
        .join(',')
    )
  })
  const filename = `失衡度排行-${stampSuffix()}.csv`
  download(filename, `\uFEFF${lines.join('\n')}`, 'text/csv;charset=utf-8')
  return filename
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    return false
  }
  return false
}

/** 解析批量粘贴的实测数据：每行 阀门编号,日期,流量,供温,回温,室温[,操作人] */
export function parseMeasureBatch(text: string): Array<{
  code: string
  date: string
  flowM3h: number
  supplyTempC: number
  returnTempC: number
  roomTempC: number
  operator: string
}> {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => {
      const parts = line.split(/[,\t;]/).map((item) => item.trim())
      return {
        code: parts[0] ?? '',
        date: parts[1] ?? '',
        flowM3h: Number(parts[2] ?? 0),
        supplyTempC: Number(parts[3] ?? 0),
        returnTempC: Number(parts[4] ?? 0),
        roomTempC: Number(parts[5] ?? 0),
        operator: parts[6] ?? ''
      }
    })
    .filter((item) => item.code.length > 0)
}
