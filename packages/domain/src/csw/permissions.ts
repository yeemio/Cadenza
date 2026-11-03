/**
 * csw 域岗位操作许可目录（OA-23 第一元在受约束排程/外协域的最小集）。
 *
 * - csw.read：排程版本/冻结记录/换型矩阵/停机/外协任务/覆盖审计/标记槽位等查询；
 * - csw.post：约束排程与外协命令面（冻结创建、换型矩阵发布、停机登记/关闭、
 *   校准状态等价服务、重排建议/提交、外协任务全生命周期）；
 * - csw.unfreeze：[CS-11] 解冻具名权限——解冻窗口须具名权限＋理由并留痕，
 *   独立于 csw.post（高影响动作单列，HTTP 守卫首检 + 处理器二道防线复核）。
 */
export const CSW_PERMISSIONS = {
  /** 受约束排程与外协查询 */
  CSW_READ: 'csw.read',
  /** 受约束排程与外协命令 */
  CSW_POST: 'csw.post',
  /** [CS-11] 冻结窗口解冻具名权限（高影响，须理由留痕） */
  CSW_UNFREEZE: 'csw.unfreeze',
} as const

export type CswPermission = (typeof CSW_PERMISSIONS)[keyof typeof CSW_PERMISSIONS]
