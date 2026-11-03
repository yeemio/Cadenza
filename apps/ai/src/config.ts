/**
 * apps/ai 进程配置装载（DS-17：RuntimeProfile 以 env 装配）。
 *
 * 运行身份分离（AR-07）：apps/ai 进程环境凭据中不得出现生产数据库连接串——
 * 本进程对生产库无账号、不执行 SQL（AR-R2/DS-02）。装载时 fail-fast：
 * 检测到 DATABASE_URL 即拒绝启动（测试断言位）。
 */
import { DEFAULT_RUNTIME_PROFILE, withProfileOverrides } from '../../../packages/integrations/dsh'
import type { RuntimeProfile } from '../../../packages/integrations/dsh'

export interface AiRuntimeConfig {
  port: number
  /** 公开运行接口的内部服务令牌（接入层转发凭据；不构成权限来源，dsh-edge §4）。 */
  internalToken: string
  /** 会话存储/运行记录独立数据目录（AR-08）。 */
  dataDir: string
  /** 受控查询客户端模式：mock（合同级回放，首版缺省）｜http（真实内部接口，L0 整合 AR-22 接通）。 */
  controlledQueryMode: 'mock' | 'http'
  controlledQueryBaseUrl: string
  /** 调用 apps/api 内部受控查询接口的服务令牌。 */
  internalQueryToken: string
  /** Optional metadata-only anchor endpoint; complete runtime logs always stay in dataDir. */
  sessionEventSinkUrl: string | null
  /** mock 场景文件（JSON：模型脚本+查询信封脚本+能力清单；测试按需注入，DS-13）。 */
  mockScenarioFile: string | null
  profile: RuntimeProfile
}

function intEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

/** AI_TENANT_LIMITS：按租户限额覆盖表（JSON：{ "<enterpriseId>": { maxConcurrentTurns?, dailyTurnLimit?, perTurnBudgetMs? } }）。 */
function parseTenantLimitOverrides(raw: string | undefined): Record<string, Partial<{ maxConcurrentTurns: number; dailyTurnLimit: number; perTurnBudgetMs: number }>> {
  if (raw === undefined || raw.length === 0) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const result: Record<string, Partial<{ maxConcurrentTurns: number; dailyTurnLimit: number; perTurnBudgetMs: number }>> = {}
    for (const [enterpriseId, value] of Object.entries(parsed)) {
      if (typeof value !== 'object' || value === null) continue
      const limits: Partial<{ maxConcurrentTurns: number; dailyTurnLimit: number; perTurnBudgetMs: number }> = {}
      const record = value as Record<string, unknown>
      for (const key of ['maxConcurrentTurns', 'dailyTurnLimit', 'perTurnBudgetMs'] as const) {
        const num = Number(record[key])
        if (Number.isInteger(num) && num > 0) limits[key] = num
      }
      result[enterpriseId] = limits
    }
    return result
  } catch {
    return {}
  }
}

export class ConfigError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AiRuntimeConfig {
  // AR-07 fail-fast：运行身份分离——apps/ai 环境不得携带生产库连接串。
  if (typeof env['DATABASE_URL'] === 'string' && env['DATABASE_URL'].length > 0) {
    throw new ConfigError(
      'ERR_DATABASE_URL_FORBIDDEN',
      'apps/ai 进程环境检测到 DATABASE_URL：AI 运行服务无生产数据库账号（AR-07/AR-R2），拒绝启动。',
    )
  }
  const profile = withProfileOverrides(DEFAULT_RUNTIME_PROFILE, {
    toolCallLimitPerTurn: intEnv(env['AI_TOOL_CALL_LIMIT'], DEFAULT_RUNTIME_PROFILE.toolCallLimitPerTurn),
    singleQueryTimeoutMs: intEnv(env['AI_SINGLE_QUERY_TIMEOUT_MS'], DEFAULT_RUNTIME_PROFILE.singleQueryTimeoutMs),
    turnBudgetMs: intEnv(env['AI_TURN_BUDGET_MS'], DEFAULT_RUNTIME_PROFILE.turnBudgetMs),
    sessionIdleTimeoutMs: intEnv(env['AI_SESSION_IDLE_TIMEOUT_MS'], DEFAULT_RUNTIME_PROFILE.sessionIdleTimeoutMs),
    sweepIntervalMs: intEnv(env['AI_SWEEP_INTERVAL_MS'], DEFAULT_RUNTIME_PROFILE.sweepIntervalMs),
    tenantLimitOverrides: parseTenantLimitOverrides(env['AI_TENANT_LIMITS']),
  })
  const controlledQueryMode = env['AI_CONTROLLED_QUERY_MODE'] === 'http' ? 'http' : 'mock'
  const controlledQueryBaseUrl = env['AI_CONTROLLED_QUERY_BASE_URL'] ?? 'http://127.0.0.1:3001/internal/aiquery'
  return {
    port: intEnv(env['AI_RUNTIME_PORT'], 4300),
    internalToken: env['AI_RUNTIME_INTERNAL_TOKEN'] ?? 'cadenza-ai-dev-internal-token',
    dataDir: env['AI_DATA_DIR'] ?? './ai-runtime-data',
    controlledQueryMode,
    controlledQueryBaseUrl,
    internalQueryToken: env['AI_INTERNAL_QUERY_TOKEN'] ?? 'cadenza-ai-dev-query-token',
    sessionEventSinkUrl: resolveSessionEventSinkUrl(env),
    mockScenarioFile: env['AI_MOCK_SCENARIO_FILE'] ?? null,
    profile,
  }
}

/** Metadata forwarding is opt-in; HTTP query mode does not enable log copying. */
function resolveSessionEventSinkUrl(env: NodeJS.ProcessEnv): string | null {
  const explicit = env['AI_SESSION_EVENT_SINK_URL']
  return explicit === undefined || explicit === '' || explicit === 'off' ? null : explicit
}
