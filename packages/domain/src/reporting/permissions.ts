/**
 * reporting 域岗位操作许可目录（OA-23 第一元在报表域的最小集）。
 *
 * T20 为只读投影域：查询走 reporting.read；投影维护命令（库存统计投影重建、班次快照重算、
 * 指标定义注册）走 reporting.post——重算只写本域投影表、不触碰业务表（RP-07/RP-18），
 * 与业务命令共用命令总线（幂等+审计）。
 */
export const REPORTING_PERMISSIONS = {
  /** 报表查询（库存统计/轴查询/报工汇总/班次快照/指标定义/追溯） */
  REPORTING_READ: 'reporting.read',
  /** 投影维护（stock-stat 重建、shift-snapshot 重算、metric-definition 注册） */
  REPORTING_POST: 'reporting.post',
} as const

export type ReportingPermission = (typeof REPORTING_PERMISSIONS)[keyof typeof REPORTING_PERMISSIONS]
