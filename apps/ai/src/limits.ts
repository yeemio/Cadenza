/**
 * 按租户限额（dsh-edge.md DS-10；AR-09/AR-13）。
 *
 * 超限拒绝新轮并返回可理解状态：不无限重试、不排队放大；
 * 限额触发不影响生产进程（apps/ai 与生产库零共享）。
 * 日计数按 Asia/Shanghai 自然日切（时间基准总则）。
 */
import type { RuntimeProfile, TenantLimits } from '../../../packages/integrations/dsh'
import { shanghaiDateKey } from './time-basis'

export type LimitsAcquireResult =
  | { ok: true; enterpriseId: string }
  | { ok: false; which: 'concurrent' | 'daily'; limit: number }

export class TenantLimitsService {
  private readonly inFlight = new Map<string, number>()
  private readonly daily = new Map<string, number>()

  constructor(private readonly profile: RuntimeProfile) {}

  limitsFor(enterpriseId: string): TenantLimits {
    return { ...this.profile.defaultTenantLimits, ...this.profile.tenantLimitOverrides[enterpriseId] }
  }

  tryAcquire(enterpriseId: string, now: Date): LimitsAcquireResult {
    const limits = this.limitsFor(enterpriseId)
    const concurrent = this.inFlight.get(enterpriseId) ?? 0
    if (concurrent >= limits.maxConcurrentTurns) {
      return { ok: false, which: 'concurrent', limit: limits.maxConcurrentTurns }
    }
    const dailyKey = `${enterpriseId}:${shanghaiDateKey(now)}`
    const used = this.daily.get(dailyKey) ?? 0
    if (used >= limits.dailyTurnLimit) {
      return { ok: false, which: 'daily', limit: limits.dailyTurnLimit }
    }
    this.inFlight.set(enterpriseId, concurrent + 1)
    this.daily.set(dailyKey, used + 1)
    return { ok: true, enterpriseId }
  }

  release(enterpriseId: string): void {
    const current = this.inFlight.get(enterpriseId) ?? 0
    if (current <= 1) this.inFlight.delete(enterpriseId)
    else this.inFlight.set(enterpriseId, current - 1)
  }

  inFlightCount(enterpriseId: string): number {
    return this.inFlight.get(enterpriseId) ?? 0
  }
}
