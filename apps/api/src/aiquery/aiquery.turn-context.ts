/**
 * 问数轮上下文（接入层内存登记；P4-A 补充任务新增）。
 *
 * 承载三类以 requestId 为锚的接入层绑定（AR-15 审计链 / AQ-AMB-04 澄清轮）：
 * - 轮次归属（requestId → sessionId/userId）：取消端点的归属校验（不信任请求体）；
 * - 信封缓存（requestId+toolCallSeq → 六段信封）：B 线工具调用经本接入层 /internal/aiquery/execute
 *   穿透时登记，轮次应答（answerRefs 不含完整 data）时按 auditRef 取回组装给 UI；
 * - 澄清选项（requestId → optionId → confirm 精确重发参数）：服务端绑定承载
 *   （UI 不改写；AQ-AMB-01 用户选择后由接入层带精确参数重执行，A 线不调用模型，AR-01）。
 *
 * 内存登记非业务账本（AR-18/19：业务事实一律经能力查询取当前读面）；
 * 进程重启丢失在途轮上下文——取消按 unknown_request、澄清选项过期重问（恢复语义见交付记录）。
 */
// L0 整合步（未执行前的 dist 相对导入桥接，同 aiquery.composition 注释）：contracts aiquery 面未并入包名入口。
import type { AiQueryEnvelopeDto } from '@cadenza/contracts'

/** 六段信封（字段冻结于 contracts/src/aiquery.ts，AQ-REG-07）。 */
export type AiEnvelopeLike = AiQueryEnvelopeDto

export interface AiClarifyOptionLike {
  id: string
  label: string
  detail?: Record<string, unknown> | null
  confirm?: { capabilityId: string; params: Record<string, unknown> } | null
}

interface TurnRecord {
  sessionId: string
  userId: string
  enterpriseId: string
}

/** FIFO 容量上限（防内存无界；轮次上下文为短生命周期数据）。 */
const MAX_ENTRIES = 2000

export class AiTurnContext {
  private readonly turns = new Map<string, TurnRecord>()
  private readonly envelopes = new Map<string, AiEnvelopeLike>()
  private readonly lastEnvelopeByRequest = new Map<string, AiEnvelopeLike>()
  private readonly clarifyOptions = new Map<string, Map<string, { capabilityId: string; params: Record<string, unknown>; label: string }>>()

  private evict(): void {
    if (this.turns.size <= MAX_ENTRIES && this.envelopes.size <= MAX_ENTRIES) return
    for (const key of this.turns.keys()) {
      if (this.turns.size <= MAX_ENTRIES) break
      this.turns.delete(key)
    }
    for (const key of this.envelopes.keys()) {
      if (this.envelopes.size <= MAX_ENTRIES) break
      this.envelopes.delete(key)
      this.lastEnvelopeByRequest.delete(key.split(':')[0] ?? key)
    }
  }

  registerTurn(requestId: string, record: TurnRecord): void {
    this.turns.set(requestId, record)
    this.evict()
  }

  turnOf(requestId: string): TurnRecord | null {
    return this.turns.get(requestId) ?? null
  }

  registerEnvelope(requestId: string, toolCallSeq: number, envelope: AiEnvelopeLike): void {
    this.envelopes.set(`${requestId}:${String(toolCallSeq)}`, envelope)
    this.lastEnvelopeByRequest.set(requestId, envelope)
    this.evict()
  }

  envelopeOf(requestId: string, toolCallSeq: number): AiEnvelopeLike | null {
    return this.envelopes.get(`${requestId}:${String(toolCallSeq)}`) ?? null
  }

  lastEnvelopeOf(requestId: string): AiEnvelopeLike | null {
    return this.lastEnvelopeByRequest.get(requestId) ?? null
  }

  registerClarifyOptions(requestId: string, options: AiClarifyOptionLike[]): void {
    const map = new Map<string, { capabilityId: string; params: Record<string, unknown>; label: string }>()
    for (const option of options) {
      if (option.confirm !== undefined && option.confirm !== null) {
        map.set(option.id, { capabilityId: option.confirm.capabilityId, params: option.confirm.params, label: option.label })
      }
    }
    this.clarifyOptions.set(requestId, map)
  }

  /** 消费澄清选项（确认后失效，防重放；不存在/已过期 → null）。 */
  consumeClarifyOption(requestId: string, optionId: string): { capabilityId: string; params: Record<string, unknown>; label: string } | null {
    const map = this.clarifyOptions.get(requestId)
    if (map === undefined) return null
    const option = map.get(optionId) ?? null
    if (option !== null) map.delete(optionId)
    return option
  }
}
