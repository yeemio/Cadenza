/**
 * spc 域岗位操作许可目录（OA-23 第一元在工艺变更/SPC/计量校准域的最小集；
 * 六类入口同检 OA-24 由全局守卫承担）。
 * 工艺工程师/质量/计量人员/班组长共用 spc.post：变更发布、SPC 处置、校准登记与
 * 工具寿命调整均为岗位命令面，差异在审批角色名单（GAP-E16 待裁），不在许可面分层。
 */
export const SPC_PERMISSIONS = {
  /** spc 查询（变更影响、控制图、失控处置链、校准历史、失准圈定、工具台账） */
  SPC_READ: 'spc.read',
  /** spc 命令（变更单、SPC 规则集/控制限/样本/处置、器具与校准、失准处置、工具寿命） */
  SPC_POST: 'spc.post',
} as const

export type SpcPermission = (typeof SPC_PERMISSIONS)[keyof typeof SPC_PERMISSIONS]
