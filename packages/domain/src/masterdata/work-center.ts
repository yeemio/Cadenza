import { MasterDataRuleViolation } from './errors'

/**
 * 工作中心与对照表纯规则 —— 对应冻结合同 master-data.md §3：MD-17～MD-21。
 */

/** MD-17：工作中心编码全局唯一；同部门内工作中心名称唯一（active 口径查重输入）。 */
export interface WorkCenterUniquenessCandidate {
  id?: string
  code: string
  name: string
  deptId: string
}

export function findWorkCenterConflict(
  candidate: WorkCenterUniquenessCandidate,
  existing: ReadonlyArray<{ id: string; code: string; name: string; deptId: string }>,
): { field: 'code' | 'name'; value: string } | null {
  for (const row of existing) {
    if (row.id === candidate.id) continue
    if (row.code === candidate.code) return { field: 'code', value: row.code }
    if (row.deptId === candidate.deptId && row.name === candidate.name) {
      return { field: 'name', value: row.name }
    }
  }
  return null
}

/**
 * MD-18：工作中心删除校验顺序（任一命中即拒绝）：
 * ① 被设备引用 → ② 被工序引用 → ③ 被订单工序引用。
 * 工序/订单工序表属后续生产域（未建），调用方按 0 传入并注明预留。
 */
export interface WorkCenterDeleteFacts {
  equipmentRefs: number
  processRefs: number
  orderProcessRefs: number
}

export function assertWorkCenterRetirable(facts: WorkCenterDeleteFacts): void {
  if (facts.equipmentRefs > 0) {
    throw new MasterDataRuleViolation('MD-18', '工作中心被设备引用，不可删除')
  }
  if (facts.processRefs > 0) {
    throw new MasterDataRuleViolation('MD-18', '工作中心被工序引用，不可删除')
  }
  if (facts.orderProcessRefs > 0) {
    throw new MasterDataRuleViolation('MD-18', '工作中心被订单工序引用，不可删除')
  }
}

/** MD-19：对照表唯一键 = (ERP 工作中心编码, 组织编码)。 */
export function workCenterMappingKey(erpWorkCenterCode: string, orgCode: string): string {
  return `${erpWorkCenterCode}:${orgCode}`
}

/**
 * MD-20：对照表新增后触发异步补绑——仅回写当前未绑定记录；编辑映射不触发回写；
 * 不得重指已绑定的历史对象；补绑任务必须可重试（IF-02）。
 * 补绑任务执行属集成块（outbox）；本规则给出触发谓词：仅「新增映射」触发。
 */
export function mappingChangeTriggersBackfill(change: 'create' | 'update' | 'delete'): boolean {
  return change === 'create'
}

/**
 * MD-21：对照表删除前置——删除前须无未完成的补绑任务，否则拒绝（[合同新造]，SA §5）。
 */
export function assertMappingDeletable(facts: { pendingBackfillTasks: number }): void {
  if (facts.pendingBackfillTasks > 0) {
    throw new MasterDataRuleViolation('MD-21', '对照表存在未完成的补绑任务，不可删除')
  }
}
