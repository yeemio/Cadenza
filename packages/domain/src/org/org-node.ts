import { OrgRuleViolation } from './errors'

/**
 * 组织树（机构）纯规则 —— 对应冻结合同 org-auth.md §1/§6：
 * OA-01/02/03/04/05/06/07/08/34。
 */

/** OA-08 目标组织层级：enterprise → legal_entity → plant → department/work_center。 */
export type OrgNodeKind = 'enterprise' | 'legal_entity' | 'plant' | 'department' | 'work_center'

export const ORG_NODE_KINDS: readonly OrgNodeKind[] = [
  'enterprise',
  'legal_entity',
  'plant',
  'department',
  'work_center',
]

/**
 * OA-03 机构类型字典仅 3 值：1=车间、2=质检部、3=物流部。
 * 注意：该 3 值字典与四层组织模型的映射未定义（GAP-A4），本域不冒充已有映射；
 * dept_category 仅约束 department 节点的分类属性。
 */
export const DEPT_CATEGORY = { WORKSHOP: 1, QUALITY: 2, LOGISTICS: 3 } as const

export type DeptCategoryValue = (typeof DEPT_CATEGORY)[keyof typeof DEPT_CATEGORY]

export const DEPT_CATEGORY_VALUES: readonly number[] = [
  DEPT_CATEGORY.WORKSHOP,
  DEPT_CATEGORY.QUALITY,
  DEPT_CATEGORY.LOGISTICS,
]

/** OA-08 层级配对：每种节点的合法上级类型（等价机制替代触发器的一部分）。 */
export const ALLOWED_PARENT_KIND: Readonly<Record<OrgNodeKind, readonly (OrgNodeKind | null)[]>> = {
  enterprise: [null],
  legal_entity: ['enterprise'],
  plant: ['legal_entity'],
  department: ['plant', 'department'],
  work_center: ['department'],
}

export interface OrgNodePathInfo {
  id: string
  kind: OrgNodeKind
  /** 物化路径：根为 '/<id>/'，子级为父 path 追加 '<id>/'（OA-34） */
  path: string
}

/**
 * OA-34 path 前缀判定祖先关系（含自身）：ancestor.path 是 node.path 的前缀
 * ⟺ ancestor 是 node 的祖先或自身。
 */
export function isAncestorOrSelf(
  ancestor: { id: string; path: string },
  node: { id: string; path: string },
): boolean {
  return ancestor.path.length <= node.path.length && node.path.startsWith(ancestor.path)
}

/**
 * OA-02 上级机构校验：不可选自身、不可选本级任意下级（组织树无环）；
 * 叠加 OA-08 层级配对。node 为 null 表示新建（只需配对校验）。
 */
export function assertValidParent(
  node: { id: string; path: string } | null,
  parent: OrgNodePathInfo | null,
  childKind: OrgNodeKind,
): void {
  const allowedParents = ALLOWED_PARENT_KIND[childKind]
  const parentKind = parent?.kind ?? null
  if (!allowedParents.includes(parentKind)) {
    throw new OrgRuleViolation(
      'OA-02',
      `上级机构类型非法：${childKind} 的上级须为 ${allowedParents
        .map((k) => (k === null ? '（无，根节点）' : k))
        .join(' / ')}`,
    )
  }
  if (node === null || parent === null) return
  if (parent.id === node.id) {
    throw new OrgRuleViolation('OA-02', '不可选择自身作为上级机构')
  }
  if (isAncestorOrSelf(node, parent)) {
    throw new OrgRuleViolation('OA-02', '不可选择本级下级机构作为上级（组织树无环）')
  }
}

/** OA-34 物化路径计算：根 '/<id>/'，子级 = 父 path + '<id>/'。 */
export function computeNodePath(parentPath: string | null, id: string): string {
  return `${parentPath ?? '/'}${id}/`
}

/** OA-34 深度计算：根 depth=0。 */
export function computeNodeDepth(parentDepth: number | null): number {
  return (parentDepth ?? -1) + 1
}

export interface OrgNodeFieldInput {
  kind: OrgNodeKind
  /** OA-04 工厂编码（plant 节点必填，最长 10 字符） */
  plantCode?: string | null
  /** OA-04 公司组织编码（选填） */
  companyOrgCode?: string | null
  /** OA-03 机构类型（department 节点必填，字典 3 值） */
  deptCategory?: number | null
}

/** OA-03/OA-04 机构字段口径校验。 */
export function assertOrgNodeFields(input: OrgNodeFieldInput): void {
  if (input.kind === 'plant') {
    const plantCode = input.plantCode ?? ''
    if (plantCode.length === 0 || plantCode.length > 10) {
      throw new OrgRuleViolation('OA-04', '工厂编码必填且最长 10 字符')
    }
  }
  if (input.kind === 'department') {
    if (input.deptCategory == null) {
      throw new OrgRuleViolation('OA-03', '机构类型必填（1=车间 2=质检部 3=物流部）')
    }
    if (!DEPT_CATEGORY_VALUES.includes(input.deptCategory)) {
      throw new OrgRuleViolation('OA-03', `机构类型字典仅 3 值（1/2/3），拒绝输入：${input.deptCategory}`)
    }
  }
}

/**
 * OA-05/OA-07 机构删除前置（任一命中拒绝）：
 * - 本机构及全部下级均未挂用户（OA-05）；
 * - 被工作中心引用（OA-07，活动 work_center 子节点）；
 * - 被仓库/设备引用（OA-07；仓库与设备表属 master-data 域，本阶段未建表，调用方按 0 传入并注明）。
 * OA-06 删除执行为对全部下级的逻辑删除（状态列），由持久化层 retireSubtree 落实。
 */
export interface OrgNodeDeleteFacts {
  usersInSubtree: number
  workCenterRefs: number
  warehouseRefs: number
  equipmentRefs: number
}

export function assertOrgNodeDeletable(facts: OrgNodeDeleteFacts): void {
  if (facts.usersInSubtree > 0) {
    throw new OrgRuleViolation('OA-05', '本机构或其下级机构仍挂有用户，不可删除')
  }
  if (facts.workCenterRefs > 0) {
    throw new OrgRuleViolation('OA-07', '机构被工作中心引用，不可删除')
  }
  if (facts.warehouseRefs > 0) {
    throw new OrgRuleViolation('OA-07', '机构被仓库引用，不可删除')
  }
  if (facts.equipmentRefs > 0) {
    throw new OrgRuleViolation('OA-07', '机构被设备引用，不可删除')
  }
}
