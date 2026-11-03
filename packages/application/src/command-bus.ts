import type { CommandEnvelope, CommandResult, CommandResultStatusValue } from '@cadenza/contracts'
import type {
  AuditWriter,
  AuthSessionRepository,
  OrgNodeRepository,
  RoleRepository,
  ScopeGrantRepository,
  UserAccountRepository,
} from './repositories'

/**
 * 命令总线端口：应用层唯一的命令入口抽象。
 * 实现方（persistence 层组合）负责：幂等（企业+命令种类+operationId，同载荷返原结果、
 * 异载荷拒 ERR_IDEMPOTENT_PAYLOAD_MISMATCH）、命令结果与业务事务共同持久化（含审计）。
 */

/** 命令执行上下文：由认证会话派生，服务端计算（不信客户端自报，合同 §command.ts）。 */
export interface CommandContext {
  actorUserId: string
  actorLoginName: string
  enterpriseId: string
  /** OA-29 高影响操作理由（可空；是否必填由域规则按命令种类校验） */
  reason?: string | null
}

/** 命令处理器在事务内可用的工具集（仓储绑定当前事务客户端）。 */
export interface CommandTools {
  org: OrgNodeRepository
  users: UserAccountRepository
  roles: RoleRepository
  grants: ScopeGrantRepository
  sessions: AuthSessionRepository
  audit: AuditWriter
  /** 服务端系统时间（OA-31：系统时间与业务时间分列）。 */
  now(): Date
  /** actor 的有效岗位许可集合（角色授权 ∪ 用户授权，服务端计算，OA-23/25）。 */
  actorPermissions(): Promise<string[]>
  /** actor 的数据范围（企业/工厂/车间，服务端计算，OA-25）。 */
  actorDataScope(): Promise<{ enterpriseWide: boolean; plantIds: string[] }>
}

/** 处理器结果：业务拒绝也以结果返回（与回执一并持久化，重放返回原结果）。 */
export interface HandlerOutcome {
  status: Exclude<CommandResultStatusValue, 'UNKNOWN_PENDING_QUERY'>
  errorCode?: string
  errorMessage?: string
  data?: unknown
}

/** 命令处理器：一个 commandType 一个实现，运行于命令总线事务内。 */
export interface CommandHandler {
  readonly commandType: string
  handle(
    envelope: CommandEnvelope<unknown>,
    context: CommandContext,
    tools: CommandTools,
  ): Promise<HandlerOutcome>
}

export interface CommandBus {
  execute<TPayload = Record<string, unknown>>(
    envelope: CommandEnvelope<TPayload>,
    context: CommandContext,
  ): Promise<CommandResult>
}
