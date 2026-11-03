/**
 * 集团分配修订载荷校验（非成本分摊 cost.allocation-version）。
 * 缺必填字段抛 RuleViolation → 命令面 422。
 */
export class GroupRuleViolation extends Error {
  constructor(
    readonly rule: string,
    message: string,
  ) {
    super(message)
    this.name = 'GroupRuleViolation'
  }
}

export const ALLOCATION_REVISION_STATUSES = ['draft', 'submitted', 'approved', 'rejected', 'cancelled'] as const
export type AllocationRevisionStatus = (typeof ALLOCATION_REVISION_STATUSES)[number]

export function assertAllocationRevisionCreatePayload(payload: Record<string, unknown>): {
  plantId: string
  title: string
  reason: string
  revisionNo?: string
} {
  const plantId = asNonEmpty(payload['plantId'], 'plantId')
  const title = asNonEmpty(payload['title'], 'title')
  const reason = asNonEmpty(payload['reason'], 'reason')
  const revisionNo =
    typeof payload['revisionNo'] === 'string' && payload['revisionNo'].trim() !== ''
      ? payload['revisionNo'].trim()
      : undefined
  return { plantId, title, reason, revisionNo }
}

export function assertShortageKittingCheckPayload(payload: Record<string, unknown>): {
  plantId: string
  orderNo: string
} {
  const plantId = asNonEmpty(payload['plantId'], 'plantId')
  const orderNo = asNonEmpty(payload['orderNo'], 'orderNo')
  return { plantId, orderNo }
}

function asNonEmpty(v: unknown, key: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new GroupRuleViolation('G-01', `集团域命令载荷缺少必填字段 ${key}`)
  }
  return v.trim()
}
