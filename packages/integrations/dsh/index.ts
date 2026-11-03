/**
 * packages/integrations/dsh —— DSH 边缘包公开出口（dsh-edge.md §3，DS-14～DS-17）。
 *
 * 包出口仅四族接口 + 运行时声明 + mock 模型适配器（ModelClientPort 的首版实现，
 * 由 apps/ai 组合根装配）：ModelClientPort / ToolDescriptor+ToolResult / SessionStorePort
 * / RuntimeProfile。厂商类型止于此包（DS-04）：不得被 packages/domain、
 * packages/application、packages/contracts、packages/ui、apps/api 引用。
 *
 * 包自身零业务依赖（DS-17）：本包不 import domain/application/contracts 业务面。
 *
 * [L0-整合标记] 本目录暂无 package.json/构建声明（packages/integrations 现有 package.json
 * 为占位、属共享文件不改）；apps/ai 以同程序共编译消费本包源码。L0 整合时可为本目录
 * 补 package.json/构建脚本并改包名导出，届时删除本标记。
 */
export { DSH_RUNTIME_DECLARATION } from './runtime-declaration'
export type { DshRuntimeDeclaration } from './runtime-declaration'
export type {
  AiQueryResultStatus,
  ClarificationOption,
  EnvelopeCompleteness,
  EnvelopeContextEcho,
  EnvelopeFailure,
  EnvelopeFreshness,
  ToolDescriptor,
  ToolResult,
  ToolResultAuditRef,
} from './tools'
export type {
  ModelClientPort,
  ModelMessage,
  ModelRequest,
  ModelRole,
  ModelTurnResult,
  ModelUsage,
  ToolCallIntent,
} from './model-client'
export { MockModelClient } from './mock-model'
export type { MockModelOptions, MockModelStep } from './mock-model'
export type {
  SessionChannel,
  SessionEventRecord,
  SessionLifecycleStatus,
  SessionRuntimeRecord,
  SessionStorePort,
  TurnOutcome,
} from './session-store'
export { DEFAULT_RUNTIME_PROFILE, withProfileOverrides } from './runtime-profile'
export type { RetryPolicy, RuntimeProfile, TenantLimits } from './runtime-profile'
