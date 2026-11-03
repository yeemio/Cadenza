import { SchedulingRuleViolation } from './errors'
import { assertProductionDateValid, isValidProductionDate, shiftDate } from './slot-rules'

/**
 * scheduling 域班次跨日纯规则（T09）——规则来源为咨询底稿
 * architecture/contracts/prep/p1/03-production-chain-rules-T05T09T10T11.md 的 A4 节
 * （PRD 现状：仅系统参数「白班开始时间」，当前时间早于它则班次日期取前一天；未配置不能扫设备码）。
 *
 * [合同新造弱化登记] DM §5 目标口径（工厂日历 + 时区 + 白班起点 + 跨午夜/补录/时钟偏差）
 * 属后续报工域合同；P1 本域按 PRD 单参数口径实现：白班起点（工厂级）+ 字符串日期算术
 * （不引入时区库；实际时间以 ISO-8601 字符串的日期/钟面直接比较，保证确定性可复算）。
 */

/** 白班起点合法域：HH:MM 24 小时制（00:00–23:59）。 */
export function isValidDayShiftStart(value: string): boolean {
  if (!/^\d{2}:\d{2}$/.test(value)) return false
  const [h, m] = value.split(':').map((p) => Number(p))
  return h >= 0 && h <= 23 && m >= 0 && m <= 59
}

/** [底稿 A4-1] 白班起点参数校验（工厂级班次参数表唯一参数位）。 */
export function assertDayShiftStartValid(dayShiftStart: string): void {
  if (!isValidDayShiftStart(dayShiftStart)) {
    throw new SchedulingRuleViolation(
      'A4-1',
      `白班开始时间必须为 HH:MM（24 小时制，00:00–23:59）：${dayShiftStart}`,
    )
  }
}

/** [底稿 A4-2] 班次参数已配置才可计算/扫码（PRD 03 §3.1：未配置时不能扫设备码）。 */
export function assertShiftConfigured(dayShiftStart: string | null | undefined): void {
  if (dayShiftStart === null || dayShiftStart === undefined || dayShiftStart === '') {
    throw new SchedulingRuleViolation('A4-2', '工厂未配置白班开始时间，无法计算班次日期（未配置不能扫设备码）')
  }
  assertDayShiftStartValid(dayShiftStart)
}

/**
 * 从 ISO-8601 时间串直接取日期与钟面（YYYY-MM-DD / HH:MM）。
 * 不经 Date 时区转换（避免本地时区偏移把 07:59 推成 23:59 前日）；要求含 'T' 分隔的完整时间。
 */
export function parseShiftClock(iso: string): { date: string; clock: string } {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(iso)
  if (match === null) {
    throw new SchedulingRuleViolation('A4-2', `实际时间必须为含时间的 ISO-8601 字符串：${iso}`)
  }
  const date = match[1]!
  if (!isValidProductionDate(date)) {
    throw new SchedulingRuleViolation('A4-2', `实际时间的日期部分不合法：${iso}`)
  }
  return { date, clock: `${match[2]!}:${match[3]!}` }
}

/** 钟面比较：clock < dayShiftStart（同为 HH:MM 字典序即时间序）。 */
function isBeforeDayShift(clock: string, dayShiftStart: string): boolean {
  return clock < dayShiftStart
}

/**
 * [底稿 A4-2 / PRD 03 §3.1] 班次日期：当前时间早于「白班开始时间」时取前一天，否则取当天
 * （白班 08:00 时 07:59 归前一日、08:00 归当日；等值起点归当日）。
 */
export function computeShiftDate(actualIso: string, dayShiftStart: string): string {
  assertDayShiftStartValid(dayShiftStart)
  const { date, clock } = parseShiftClock(actualIso)
  return isBeforeDayShift(clock, dayShiftStart) ? shiftDate(date, -1) : date
}

/**
 * [底稿 A4-2 / DM §5 双轨] 同一事实同时保存实际时间与业务班次日期：
 * actualTime 为原始 ISO-8601（不重置、不改写），shiftDate 为按白班起点推导的业务日期；
 * 两者并存互不覆盖（报工域消费；开工时间不得当作每张报工的开工时间 K01，本函数不依赖订单时间）。
 */
export interface ShiftDualTrack {
  actualTime: string
  shiftDate: string
  dayShiftStart: string
}

export function buildShiftDualTrack(actualIso: string, dayShiftStart: string): ShiftDualTrack {
  assertShiftConfigured(dayShiftStart)
  return {
    actualTime: actualIso,
    shiftDate: computeShiftDate(actualIso, dayShiftStart),
    dayShiftStart,
  }
}

/**
 * [底稿 A4 / PP §3.2] PDA 排产计划默认日期窗：未选排产日期时含当天及往前 7 天起
 * （即 [当天-7, 当天]；选了日期则只查该日——过滤由查询层执行）。
 */
export function pdaDefaultDateWindow(today: string): string[] {
  assertProductionDateValid(today)
  const dates: string[] = []
  let cursor = today
  for (let i = 0; i < 8; i += 1) {
    dates.unshift(cursor)
    if (i < 7) cursor = shiftDate(cursor, -1)
  }
  return dates
}
