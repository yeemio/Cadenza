import { useEffect, useState } from 'react'
import { t } from './translate'
import type { ShiftInfoDto } from '../api/types'

export interface ShiftCalendarConfig {
  dayShiftStartHour: number
  dayShiftStartMinute?: number
  utcOffsetHours: number
}
/** Mirror of the server formula; UI receives the same explicit calendar. */
export function computeBusinessShiftDate(instant: Date, config: ShiftCalendarConfig): string {
  const minute = config.dayShiftStartMinute ?? 0
  if (!Number.isFinite(config.utcOffsetHours) || Math.abs(config.utcOffsetHours) > 14 ||
      !Number.isInteger(config.dayShiftStartHour) || config.dayShiftStartHour < 0 || config.dayShiftStartHour > 23 ||
      !Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error('Invalid factory calendar')
  return new Date(instant.getTime() + config.utcOffsetHours * 3_600_000 - (config.dayShiftStartHour * 60 + minute) * 60_000).toISOString().slice(0, 10)
}
export function factoryClock(instant: Date, utcOffsetHours: number): string {
  const local = new Date(instant.getTime() + utcOffsetHours * 3_600_000)
  return `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`
}
export function formatUtcOffset(hours: number): string {
  const minutes = Math.round(Math.abs(hours) * 60)
  return `UTC${hours >= 0 ? '+' : '-'}${Math.floor(minutes / 60)}${minutes % 60 ? ':' + String(minutes % 60).padStart(2, '0') : ''}`
}
/** Names/codes do not establish a timezone. Retained only for import compatibility. */
export function plantTimezoneOffsetHours(_plantName?: string | null, _plantCode?: string | null): null { return null }

export function BusinessClock({ plantId, loadCalendar, className, now }: {
  plantId?: string | null
  loadCalendar?: (query: { plantId: string; at?: string }) => Promise<ShiftInfoDto>
  className?: string
  now?: () => Date
  /** Legacy display labels are deliberately not timezone inputs. */
  plantName?: string | null
  plantCode?: string | null
}) {
  const [info, setInfo] = useState<ShiftInfoDto | null>(null)
  useEffect(() => {
    let active = true
    setInfo(null)
    const refresh = async () => {
      if (!plantId || !loadCalendar) return
      try {
        const result = await loadCalendar({ plantId, ...(now ? { at: now().toISOString() } : {}) })
        if (active) setInfo(result.plantId === plantId && result.calendar && result.shiftDate ? result : null)
      } catch { if (active) setInfo(null) }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 30_000)
    return () => { active = false; clearInterval(timer) }
  }, [plantId, loadCalendar, now])
  // The shift-date endpoint is the authority; no country/name based local fallback.
  const calendar = info?.calendar
  const available = info?.plantId === plantId && calendar && info.shiftDate
  return <span data-testid="business-clock" data-business-day={available ? info.shiftDate! : undefined}
    data-calendar-verification={available ? calendar.verification : 'UNVERIFIED'}
    className={['whitespace-nowrap rounded-full border bg-card px-2.5 py-1 text-[12px] text-muted-foreground tabular-nums', className].filter(Boolean).join(' ')}>
    {available
      ? `${t('业务日')} ${info.shiftDate}｜${formatUtcOffset(calendar.utcOffsetHours)} ${factoryClock(new Date(info.actualTime), calendar.utcOffsetHours)}｜${calendar.verification === 'UNVERIFIED_DEFAULT' ? t('默认日历待核实') : t('现场班表待核实')}`
      : t('业务日待核实')}
  </span>
}
