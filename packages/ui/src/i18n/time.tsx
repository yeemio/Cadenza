import { useEffect, useState } from 'react'
import { t } from './translate'
import { cn } from '../cn'

/**
 * 业务日/工厂时区（R5：顶栏与 PDA 按工厂展示业务日与本地时间）。
 *
 * 口径沿用 domain `computeShiftDate`（冻结合同 inventory-trace-core.md §7 IT-37：
 * 班次日期按工厂日历＋时区＋白班起点折算；默认零点白班起点、无跨午夜补正）。
 * 此处为前端展示镜像实现（@cadenza/ui 不依赖 @cadenza/domain，避免把领域包
 * 拖入浏览器构建；语义一致性由 tests/ui i18n 测试锁定）。
 */

export interface ShiftCalendarConfig {
  /** 白班起点小时（0-23；GAP-A3 未裁，默认 0） */
  dayShiftStartHour: number
  /** 工厂本地 UTC 偏移小时 */
  utcOffsetHours: number
}

/** 班次日：工厂本地时区折算后取日历日；白班起点前的小时归前一班次日（跨午夜补正待 GAP-A3） */
export function computeBusinessShiftDate(instant: Date, config: ShiftCalendarConfig): string {
  const localMs = instant.getTime() + config.utcOffsetHours * 3_600_000
  const localDate = new Date(localMs)
  const hours = localDate.getUTCHours()
  let shiftMs = localMs - hours * 3_600_000
  if (hours < config.dayShiftStartHour) {
    shiftMs -= 86_400_000
  }
  return new Date(shiftMs).toISOString().slice(0, 10)
}

/** 工厂本地 HH:mm（按工厂时区偏移展示） */
export function factoryClock(instant: Date, utcOffsetHours: number): string {
  const local = new Date(instant.getTime() + utcOffsetHours * 3_600_000)
  const hh = String(local.getUTCHours()).padStart(2, '0')
  const mm = String(local.getUTCMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

export function formatUtcOffset(utcOffsetHours: number): string {
  const sign = utcOffsetHours >= 0 ? '+' : '-'
  const abs = Math.abs(utcOffsetHours)
  const hh = Math.floor(abs)
  const mm = Math.round((abs - hh) * 60)
  return `UTC${sign}${hh}${mm > 0 ? `:${String(mm).padStart(2, '0')}` : ''}`
}

/**
 * 工厂时区推断（展示级约定，现场时区配置 SITE_PENDING）：
 * 韩国工厂（工厂名含「韩/KR/한국」或代码 KR 前缀）→ UTC+9；其余默认 UTC+8（中国标准时间）。
 * 会话 DTO 无 plantCode 字段时仅按名称启发式；现场落地时以工厂主档时区字段替换。
 */
export function plantTimezoneOffsetHours(plantName?: string | null, plantCode?: string | null): number {
  const hay = `${plantName ?? ''} ${plantCode ?? ''}`
  if (/KR|한국|韩/i.test(hay)) return 9
  return 8
}

/**
 * 业务日/工厂时钟：顶栏（compact）与 PDA 顶栏共用。
 * 展示：业务日 YYYY-MM-DD｜UTC+8 14:23（ko：업무일 …）。
 * `now` 可注入（测试用）；默认每 30s 自刷新。
 */
export function BusinessClock({
  plantName,
  plantCode,
  className,
  now,
}: {
  plantName?: string | null
  plantCode?: string | null
  className?: string
  now?: () => Date
}) {
  const [instant, setInstant] = useState<Date>(() => (now ? now() : new Date()))
  useEffect(() => {
    if (now) return
    const timer = setInterval(() => setInstant(new Date()), 30_000)
    return () => clearInterval(timer)
  }, [now])
  const utcOffsetHours = plantTimezoneOffsetHours(plantName, plantCode)
  const businessDay = computeBusinessShiftDate(instant, { dayShiftStartHour: 0, utcOffsetHours })
  const clock = factoryClock(instant, utcOffsetHours)
  const tz = formatUtcOffset(utcOffsetHours)
  return (
    <span
      data-testid="business-clock"
      data-business-day={businessDay}
      className={cn(
        'whitespace-nowrap rounded-full border bg-card px-2.5 py-1 text-[12px] text-muted-foreground tabular-nums',
        className,
      )}
    >
      {t('{term} {day}', { term: t('业务日'), day: businessDay })}
      <span className="mx-1.5 text-border" aria-hidden>
        ｜
      </span>
      {t('{tz} {clock}', { tz, clock })}
    </span>
  )
}
