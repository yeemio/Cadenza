import { InventoryRuleViolation } from './errors'

/**
 * 时间双轨纯规则 —— 对应冻结合同 inventory-trace-core.md §7：IT-37。
 */

/**
 * IT-37：实际时间（业务时间）与系统时间分列，不得混用。
 * 系统时间由服务端产生（stock_transaction.created_at）；业务时间由命令载荷/业务事实携带
 * （business_time 列）；不得把订单开工时间当作每张报工的开工时间。
 */
export interface TimeTracks {
  businessTime: string
  systemTime: string
}

export function splitTimeTracks(businessTime: string | null | undefined, systemTime: string): TimeTracks {
  if (businessTime === null || businessTime === undefined || Number.isNaN(Date.parse(businessTime))) {
    throw new InventoryRuleViolation('IT-37', '业务时间缺失或非法（ISO-8601）；业务时间与系统时间必须分列')
  }
  if (Number.isNaN(Date.parse(systemTime))) {
    throw new InventoryRuleViolation('IT-37', '系统时间非法')
  }
  return { businessTime, systemTime }
}

/** 工厂日历参数（GAP-A3/GAP-C4 班次细则未裁：默认零点白班起点、无跨午夜补正，参数可配）。 */
export interface ShiftCalendarConfig {
  /** 白班起点小时（0-23，默认 0） */
  dayShiftStartHour: number
  dayShiftStartMinute?: number
  /** UTC 偏移小时（默认 +8 中国标准时间；细则 GAP-A3 待现场） */
  utcOffsetHours: number
}

export const DEFAULT_SHIFT_CALENDAR: ShiftCalendarConfig = { dayShiftStartHour: 0, utcOffsetHours: 8 }

/**
 * IT-37：班次日期按工厂日历＋时区＋白班起点单独计算。
 * 以工厂本地时区把时刻折算为"班次日"：白班起点前的小时归前一班次日（跨午夜补正待 GAP-A3 裁定）。
 */
export function computeShiftDate(businessTime: string, config: ShiftCalendarConfig = DEFAULT_SHIFT_CALENDAR): string {
  const ms = Date.parse(businessTime)
  if (Number.isNaN(ms)) {
    throw new InventoryRuleViolation('IT-37', `业务时间非法：${businessTime}`)
  }
  const minute = config.dayShiftStartMinute ?? 0
  if (!Number.isInteger(config.dayShiftStartHour) || config.dayShiftStartHour < 0 || config.dayShiftStartHour > 23 ||
      !Number.isInteger(minute) || minute < 0 || minute > 59 || !Number.isFinite(config.utcOffsetHours) || Math.abs(config.utcOffsetHours) > 14) {
    throw new InventoryRuleViolation('IT-37', '工厂时区或白班起点配置非法')
  }
  return new Date(ms + config.utcOffsetHours * 3_600_000 - (config.dayShiftStartHour * 60 + minute) * 60_000).toISOString().slice(0, 10)
}
