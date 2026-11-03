import { OrgRuleViolation } from './errors'

/**
 * 审计纯规则 —— 对应冻结合同 org-auth.md §5：OA-28～OA-31。
 */

/** OA-28 每条业务命令审计记录的最低字段。 */
export interface AuditFact {
  /** 操作者 */
  actor: string
  /** 动作（命令种类或等价动作标识） */
  action: string
  subjectType: string
  subjectId: string
  /** 前状态（可空快照） */
  before?: unknown
  /** 后状态（可空快照） */
  after?: unknown
  /** 理由（可空；高影响操作必填，见下） */
  reason?: string | null
  /** 业务时间与系统时间分列（OA-31）：业务时间（无则同系统时间） */
  businessAt?: string
}

/**
 * OA-29 高影响操作清单映射（org 域 P1 部分）：
 * 原文首期清单中"跨组织配置变更"映射为授权变更与机构退役；
 * 其余清单项（已入账冲销/质量放行/库存差异调整/客户轴段重新分配）属后续业务域，
 * 到位时在各自合同内登记后加入本清单。
 */
export const HIGH_IMPACT_ACTIONS: readonly string[] = [
  'org.grant.grant',
  'org.grant.revoke',
  'org.node.retire',
]

/** OA-29 高影响操作强制填写理由方可执行（OA-S5 的命令层落实；库级约束见迁移说明）。 */
export function assertReasonPresentForHighImpact(action: string, reason: string | null | undefined): void {
  if (HIGH_IMPACT_ACTIONS.includes(action) && !(reason ?? '').length) {
    throw new OrgRuleViolation('OA-29', '高影响操作必须填写理由后方可执行')
  }
}
