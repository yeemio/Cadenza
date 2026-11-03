/**
 * 运行时配置档案（dsh-edge.md DS-15 第 4 族）。
 *
 * 超时/限额/取消配置的装载类型与缺省值；apps/ai 组合根以 env 覆盖缺省（DS-17）。
 * 缺省依据：
 *  - DS-07：单轮工具调用次数上限缺省 8；
 *  - DS-09：单次受控查询等待超时对齐 A 线 execute 缺省 15s；单轮总预算独立可判；
 *  - DS-10：按租户并发轮数/日调用次数/单轮预算；失败重试上限与退避由配置声明；
 *  - capability-contract §1 总则：时间换算时区固定 Asia/Shanghai（GAP-P11）。
 */

/** 按租户（enterprise）限额（DS-10/AR-09）。 */
export interface TenantLimits {
  /** 并发轮数上限。 */
  maxConcurrentTurns: number
  /** 日调用次数上限。 */
  dailyTurnLimit: number
  /** 单轮预算（毫秒）。 */
  perTurnBudgetMs: number
}

/** 内部受控查询传输重试策略（DS-22：有限重试；上限与退避由配置声明）。 */
export interface RetryPolicy {
  /** 额外重试次数（首次尝试之外）。 */
  maxRetries: number
  /** 退避基数毫秒（指数递增：base * 2^attempt）。 */
  backoffBaseMs: number
}

export interface RuntimeProfile {
  /** 单轮工具调用次数上限（DS-07，缺省 8）。 */
  toolCallLimitPerTurn: number
  /** 单次受控查询等待超时（DS-09，对齐 A 线 execute 缺省 15s）。 */
  singleQueryTimeoutMs: number
  /** 单轮总预算超时（DS-09，独立于单次查询超时可判）。 */
  turnBudgetMs: number
  /** 会话空闲关停阈值（DS-06）。 */
  sessionIdleTimeoutMs: number
  /** closed 会话过期清理保留期（DS-06）。 */
  sessionRetentionMs: number
  /** 空闲扫描间隔。 */
  sweepIntervalMs: number
  /** 租户缺省限额；可用按租户覆盖表放大/收紧。 */
  defaultTenantLimits: TenantLimits
  tenantLimitOverrides: Record<string, Partial<TenantLimits>>
  retry: RetryPolicy
  /** 时间换算时区（固定 Asia/Shanghai，capability-contract §1 总则）。 */
  timezone: 'Asia/Shanghai'
}

export const DEFAULT_RUNTIME_PROFILE: RuntimeProfile = {
  toolCallLimitPerTurn: 8,
  singleQueryTimeoutMs: 15_000,
  turnBudgetMs: 30_000,
  sessionIdleTimeoutMs: 30 * 60_000,
  sessionRetentionMs: 24 * 60 * 60_000,
  sweepIntervalMs: 60_000,
  defaultTenantLimits: {
    maxConcurrentTurns: 4,
    dailyTurnLimit: 200,
    perTurnBudgetMs: 30_000,
  },
  tenantLimitOverrides: {},
  retry: { maxRetries: 1, backoffBaseMs: 200 },
  timezone: 'Asia/Shanghai',
}

/** 以部分覆盖生成新档案（浅合并；不修改入参）。 */
export function withProfileOverrides(base: RuntimeProfile, overrides: Partial<RuntimeProfile>): RuntimeProfile {
  return { ...base, ...overrides }
}
