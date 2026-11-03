import { MaintenanceRuleViolation } from './errors'

/**
 * 停机事件规则（MT-09/MT-S2——[合同新造]）。
 *
 * 置"维修"即开停机事件、复机关闭即闭停机事件；起止时间原子记录；
 * 同设备停机区间不重叠、无负时长。停机原因分类字典 → GAP-F22 待裁
 * （当前最小机制：原因必填文本，字典化后升级为字典校验）。
 */

/** 停机事件区间视图（endAt 可空 = 在停机中，MT-S2）。 */
export interface DowntimeInterval {
  startAt: string
  endAt: string | null
}

/** MT-09：停机原因必填（分类字典 GAP-F22 待裁，裁定前为必填文本）。 */
export function assertDowntimeReason(reason: unknown): void {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new MaintenanceRuleViolation('MT-09', '停机事件必须记录停机原因（原因为空不可开停机事件）')
  }
}

/** 时刻比较（毫秒；非法时间字符串按 NaN 处理为拒绝）。 */
function toMs(iso: string): number {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) {
    throw new MaintenanceRuleViolation('MT-09', `停机时间非法：${iso}`)
  }
  return ms
}

/**
 * MT-09：同设备停机区间不重叠（应用层守卫，与库层 exclusion 约束双保险）。
 * 在停机中的既有区间（endAt=null）与任何新区间重叠即拒绝。
 */
export function assertNoDowntimeOverlap(
  candidate: DowntimeInterval,
  existing: readonly DowntimeInterval[],
): void {
  const candStart = toMs(candidate.startAt)
  const candEnd = candidate.endAt === null ? Number.POSITIVE_INFINITY : toMs(candidate.endAt)
  if (candEnd < candStart) {
    throw new MaintenanceRuleViolation('MT-09', '停机区间存在负时长（endAt 早于 startAt），拒绝')
  }
  for (const interval of existing) {
    const start = toMs(interval.startAt)
    const end = interval.endAt === null ? Number.POSITIVE_INFINITY : toMs(interval.endAt)
    // 半开区间 (start, end] 口径：紧邻区间（前 end == 后 start）不算重叠
    if (candStart < end && start < candEnd) {
      throw new MaintenanceRuleViolation(
        'MT-09',
        `同设备停机区间不重叠：新停机区间与既有停机事件重叠（既有 ${interval.startAt} ~ ${interval.endAt ?? '在停机中'}）`,
      )
    }
  }
}

/** MT-09：闭停机事件守卫——结束时间不早于开始时间（无负时长；复机与排程竞态下可解释）。 */
export function assertDowntimeCloseNoNegativeDuration(startAt: string, endAt: string): void {
  if (toMs(endAt) < toMs(startAt)) {
    throw new MaintenanceRuleViolation('MT-09', `闭停机事件存在负时长（start=${startAt}，end=${endAt}），拒绝`)
  }
}
