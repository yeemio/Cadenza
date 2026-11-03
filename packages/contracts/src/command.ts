/**
 * 命令入口合同（SYSTEM_ARCHITECTURE §4.1）。
 *
 * - operationId 是幂等键的一部分（按 企业 + 命令种类 + operationId 唯一）；
 * - 提交响应丢失后，终端用原 operationId 查询，不得自动换新键重发；
 * - 用户、企业、工厂及有效权限由认证会话与服务端计算，不信客户端自报。
 */

/** 命令信封。payload 为业务载荷；数量字段一律 DecimalString（禁 number）。 */
export interface CommandEnvelope<TPayload = Record<string, unknown>> {
  /** 幂等操作号，由发起端生成（如 UUID） */
  operationId: string
  /** 命令种类标识，如 'inventory.receive-goods' */
  commandType: string
  /** 目标聚合/对象 ID */
  targetId: string
  /** 乐观并发：客户端观察到的目标修订号 */
  expectedRevision: number
  /** 业务载荷（数量字段十进制字符串） */
  payload: TPayload
  /** 发起设备标识（PDA/终端可携带） */
  deviceId?: string
  /** 客户端观测时间（ISO-8601，仅作参考，服务端时间以服务端为准） */
  observedAt?: string
}

/** 命令结果状态（五种可区分终态/中间态，对应 §4.1 的最低要求）。 */
export const CommandResultStatus = {
  /** 成功且已入账（与业务事务共同持久化） */
  COMMITTED: 'COMMITTED',
  /** 已保存草稿 */
  DRAFT_SAVED: 'DRAFT_SAVED',
  /** 业务校验失败（业务拒绝） */
  BUSINESS_REJECTION: 'BUSINESS_REJECTION',
  /** 乐观并发冲突，须刷新后重试 */
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  /** 提交响应未知，终端应持原 operationId 查询终态 */
  UNKNOWN_PENDING_QUERY: 'UNKNOWN_PENDING_QUERY',
} as const

export type CommandResultStatusValue =
  (typeof CommandResultStatus)[keyof typeof CommandResultStatus]

/** 命令结果。失败态带 errorCode（见 ERROR_CODES），成功态可带 data。 */
export interface CommandResult<TData = unknown> {
  operationId: string
  status: CommandResultStatusValue
  /** 失败时的机器可读错误码（ERR_ 前缀） */
  errorCode?: string
  /** 失败时的人类可读信息 */
  errorMessage?: string
  /** 成功时的结果数据（数量字段十进制字符串） */
  data?: TData
  /** 服务端受理时间（ISO-8601） */
  occurredAt: string
}
