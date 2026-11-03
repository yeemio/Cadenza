/**
 * execution 域岗位操作许可（D4：服务端核权命令）。
 *
 * - execution.read：查询（草稿列表/报工详情/五量查询）；
 * - execution.report：报工三入口（保存草稿/提交/编辑/删除）；
 * - execution.review：人工审核/取消审核（班组长+）；
 * - execution.feed：投料（报工投料随 report；单独投料提交）；
 * - execution.labor：工时记录。
 *
 * 数据范围口径（D4/K09）：操作工仅自己参与（无 execution.review 时查询限定本人）；
 * 班组长车间范围（厂范围授权 + execution.review 时放开到授权厂）。
 */
export const EXECUTION_PERMISSIONS = {
  read: 'execution.read',
  report: 'execution.report',
  review: 'execution.review',
  feed: 'execution.feed',
  labor: 'execution.labor',
} as const

export type ExecutionPermission = (typeof EXECUTION_PERMISSIONS)[keyof typeof EXECUTION_PERMISSIONS]
