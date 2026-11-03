/**
 * 时间基准（capability-contract §1 总则）：
 * 自然语言相对时间（"本周/最近 7 天"）由 B 线编排层换算为显式起止时刻后传参，
 * 换算时区 Asia/Shanghai（本仓无工厂级时区配置，登记 GAP-P11）；
 * 服务端时间一律 ISO-8601（UTC）。
 */

export interface ResolvedTimeRange {
  expression: string
  from: string
  to: string
  timeZone: 'Asia/Shanghai'
}

export type RelativeTimeExpression = 'today' | 'this_week' | 'last_7_days' | 'last_30_days' | 'this_month'

const SUPPORTED: readonly RelativeTimeExpression[] = ['today', 'this_week', 'last_7_days', 'last_30_days', 'this_month']

export function isRelativeTimeExpression(value: unknown): value is RelativeTimeExpression {
  return typeof value === 'string' && (SUPPORTED as readonly string[]).includes(value)
}

const TZ = 'Asia/Shanghai'

interface WallClock {
  year: number
  month: number // 1-12
  day: number // 1-31
  hour: number
  minute: number
  second: number
}

/** 取某时刻在 Asia/Shanghai 的挂钟读数。 */
function wallClock(instant: Date): WallClock {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const parts = fmt.formatToParts(instant)
  const pick = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0')
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour: pick('hour') % 24, // 某些 ICU 版本把午夜渲染为 24
    minute: pick('minute'),
    second: pick('second'),
  }
}

/** 把 Asia/Shanghai 挂钟读数换回 UTC 时刻（两遍迭代求偏移；中国无夏令时，稳定收敛）。 */
function wallClockToInstant(wall: WallClock): Date {
  const target = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
  let ts = target
  for (let i = 0; i < 2; i += 1) {
    const asZoned = wallClock(new Date(ts))
    const back = Date.UTC(asZoned.year, asZoned.month - 1, asZoned.day, asZoned.hour, asZoned.minute, asZoned.second)
    const offset = back - ts // 该时刻的时区偏移（东八区恒 +8h）
    const next = target - offset
    if (next === ts) break
    ts = next
  }
  return new Date(ts)
}

function startOfDay(instant: Date): Date {
  const wall = wallClock(instant)
  return wallClockToInstant({ ...wall, hour: 0, minute: 0, second: 0 })
}

function addDays(instant: Date, days: number): Date {
  return new Date(instant.getTime() + days * 24 * 60 * 60 * 1000)
}

function addMonths(wall: WallClock, months: number): Date {
  const monthIndex = wall.year * 12 + (wall.month - 1) + months
  const year = Math.floor(monthIndex / 12)
  const month = (monthIndex % 12) + 1
  return wallClockToInstant({ year, month, day: 1, hour: 0, minute: 0, second: 0 })
}

/**
 * 换算相对时间为显式 [from, to)（to 为排他上界，按自然日切）。
 *  - today：本自然日；
 *  - this_week：本周（周一起算）至下周一；
 *  - last_7_days / last_30_days：最近 N 个自然日（含今日，AQ-AMB-02 缺省口径）；
 *  - this_month：本月 1 日至下月 1 日。
 */
export function resolveRelativeTime(expression: RelativeTimeExpression, now: Date): ResolvedTimeRange {
  const dayStart = startOfDay(now)
  let from: Date
  let to: Date
  switch (expression) {
    case 'today':
      from = dayStart
      to = addDays(dayStart, 1)
      break
    case 'this_week': {
      const wall = wallClock(now)
      // 星期一锚点：今天零点回退「本周已过天数」（周一=0）
      const todayStart = wallClockToInstant({ ...wall, hour: 0, minute: 0, second: 0 })
      const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' })
      const weekdayName = fmt.format(now)
      const index = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(weekdayName)
      const offset = index < 0 ? 0 : index
      from = addDays(todayStart, -offset)
      to = addDays(from, 7)
      break
    }
    case 'last_7_days':
      from = addDays(dayStart, -6)
      to = addDays(dayStart, 1)
      break
    case 'last_30_days':
      from = addDays(dayStart, -29)
      to = addDays(dayStart, 1)
      break
    case 'this_month': {
      const wall = wallClock(now)
      from = addMonths(wall, 0)
      to = addMonths(wall, 1)
      break
    }
  }
  return { expression, from: from.toISOString(), to: to.toISOString(), timeZone: TZ }
}

/** Asia/Shanghai 日期键（yyyy-mm-dd），限额日计数用。 */
export function shanghaiDateKey(now: Date): string {
  const wall = wallClock(now)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`
}
