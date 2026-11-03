import { ProcessRuleViolation } from './errors'

/**
 * 工序主数据规则 —— [底稿 A1-3]（PRD 工序管理 §2.1）。
 *
 * - 唯一性：同一所属部门下工序名称不能重复；同一公司组织编码下工序编码不能重复（active 口径）；
 * - 删除拦截顺序（先命中先拦截）：① 被工序模板明细引用 → ② 被订单排产引用 → ③ 被订单工序引用
 *   （①②表属后续域未建，调用方按 0 传入并注明预留；③ 为本块 order_operation 真实计数）；
 * - 编辑锁：已被订单排产引用的工序，工作中心、所属部门不可改（排产表未建按 false 预留）；
 * - 模板无状态流转、逻辑删除不查引用（工序模板弱口径照记；模板表不在本块）。
 */

/** [底稿 A1-3] 唯一性查重输入与判定（排除自身；active 口径由调用方过滤）。 */
export interface OperationDefinitionUniquenessCandidate {
  id?: string
  deptId: string
  name: string
  companyOrgCode: string
  code: string
}

export function findOperationDefinitionConflict(
  candidate: OperationDefinitionUniquenessCandidate,
  existing: ReadonlyArray<{
    id: string
    deptId: string
    name: string
    companyOrgCode: string
    code: string
  }>,
): { field: 'name' | 'code'; value: string } | null {
  for (const row of existing) {
    if (row.id === candidate.id) continue
    if (row.deptId === candidate.deptId && row.name === candidate.name) {
      return { field: 'name', value: row.name }
    }
    if (row.companyOrgCode === candidate.companyOrgCode && row.code === candidate.code) {
      return { field: 'code', value: row.code }
    }
  }
  return null
}

/**
 * [底稿 A1-3] 删除拦截顺序（任一命中即拒绝，先命中先提示）：
 * ① 模板引用（表未建按 0 预留）→ ② 订单排产引用（表未建按 0 预留）→ ③ 订单工序引用（真实计数）。
 */
export interface OperationDefinitionDeleteFacts {
  templateRefs: number
  schedulingRefs: number
  orderOperationRefs: number
}

export function assertOperationDefinitionRetirable(facts: OperationDefinitionDeleteFacts): void {
  if (facts.templateRefs > 0) {
    throw new ProcessRuleViolation('A1-3', '在模版中使用的工序不能删除')
  }
  if (facts.schedulingRefs > 0) {
    throw new ProcessRuleViolation('A1-3', '已排产的工序不能删除')
  }
  if (facts.orderOperationRefs > 0) {
    throw new ProcessRuleViolation('A1-3', '当前工序已经被使用，无法删除')
  }
}

/**
 * [底稿 A1-3] 编辑锁：已被订单排产引用的工序，工作中心/所属部门不可改
 * （schedulingReferenced 为 false 预留：排产表属 T09 未建，落地后接真值）。
 */
export function assertOperationDefinitionLockedFieldsEditable(
  facts: { schedulingReferenced: boolean },
  patch: { workCenterId?: string; deptId?: string },
): void {
  if (!facts.schedulingReferenced) return
  if (patch.workCenterId !== undefined || patch.deptId !== undefined) {
    throw new ProcessRuleViolation(
      'A1-3',
      '已被订单排产引用的工序，工作中心与所属部门不可变更（其余字段可编辑）',
    )
  }
}

/** [底稿 A1-3] 工序名称首尾不允许空格（PRD §2.1 交互；保存口径同校）。 */
export function assertOperationNameNoEdgeSpaces(name: string): void {
  if (name !== name.trim()) {
    throw new ProcessRuleViolation('A1-3', '工序名称首尾不允许空格')
  }
}
