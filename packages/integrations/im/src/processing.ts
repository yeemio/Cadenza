/**
 * 渠道事件处理记录与去重（IM-06/07，frozen/p4/im-channels.md §2；IM-05 首版包内存储）。
 *
 * - 去重键 = (channelKind, enterpriseAppRef, platformMessageId)（IM-06）：重复回调命中同一处理记录
 *   → 幂等丢弃（可观测计数），不重复进入问数流程、不重复消耗模型、不重复回复；
 * - 处理记录（IM-07）：每条入站消息一条；messageKey、requestId、处理阶段时间线、发送结果、时间戳；
 *   重试（平台重推/己方重放）复用同一处理记录推进，不新建；
 * - 先例：IF-08 五元组幂等、IT-19 流水幂等键（同构思想）。
 */
import type { ImChannelKind } from './messages'

/** 去重键（IM-06 原文三元组）。 */
export interface ImMessageKey {
  channelKind: ImChannelKind
  enterpriseAppRef: string
  platformMessageId: string
}

export function imMessageKeyString(key: ImMessageKey): string {
  if (
    key.enterpriseAppRef.length === 0 ||
    key.platformMessageId.length === 0 ||
    key.enterpriseAppRef.includes('|') ||
    key.platformMessageId.includes('|')
  ) {
    throw new Error('去重键非法：enterpriseAppRef/platformMessageId 不得为空或含“|” [IM-06-2]')
  }
  return `${key.channelKind}|${key.enterpriseAppRef}|${key.platformMessageId}`
}

/** 处理阶段（IM-07 生命周期可观测；note 承载规则码/补充信息）。 */
export type ImProcessingPhase =
  | 'received' // 已受理（记录建立）
  | 'duplicate_dropped' // 重复回调幂等丢弃（IM-06-1）
  | 'group_intercepted' // 群目标拦截（IM-11-1；不创建问数轮）
  | 'identity_unresolved' // 未绑定 → no_permission 引导（IM-03-1）
  | 'binding_verified' // 绑定码验证通过并登记
  | 'binding_rejected' // 绑定码无效（IM-03-2）
  | 'unbind_done' // 解绑完成
  | 'unbind_noop' // 解绑时本就未绑定
  | 'turn_started' // 问数轮发起（AR-15 requestId 就位）
  | 'clarify_sent' // 澄清选项已发出（本轮等待用户输入，DS-08）
  | 'sent' // 回答已发送（发送端口 status=sent）
  | 'send_unknown' // 发送结果未知（IM-04-1；不冒称送达、不自动补发）
  | 'send_failed' // 发送失败
  | 'not_sent' // 发送前再检未通过（IM-08-1/2；不发送，审计 not_sent）
  | 'cancelled' // 问数轮已取消（DS-11：取消后不再发送）
  | 'turn_error' // 问数轮异常收口（AR-12：按可理解状态回，不伪装成功）

export interface ImProcessingPhaseEvent {
  phase: ImProcessingPhase
  at: string
  note?: string
}

/** 发送结果（IM-04：sent | unknown | failed；unknown 不得冒称严格送达）。 */
export interface ImSendResult {
  status: 'sent' | 'unknown' | 'failed'
  detail?: string
}

/** 处理记录（IM-07：messageKey、requestId、处理阶段、发送结果、时间戳）。 */
export interface ImProcessingRecord {
  messageKey: string
  /** AR-15 问数轮 requestId；非问数轮流程（绑定/群拦截/未绑定引导）为 null。 */
  requestId: string | null
  phases: ImProcessingPhaseEvent[]
  /** 最近一次发送端口结果（not_sent/未发送为 null）。 */
  sendResult: ImSendResult | null
  /** 同键重复回调丢弃次数（IM-06 可观测计数，记录级）。 */
  duplicateDropCount: number
  receivedAt: string
}

/** 处理记录存储端口（首版包内存储承载，IM-05/GAP-P8；真实接入时 L0 落库替换承载）。 */
export interface ImProcessingRecordStorePort {
  /**
   * 受理（原子占位）：键不存在 → 建立记录（phase=received）返回 { record, duplicate:false }；
   * 键已存在 → 返回既有记录并标记 duplicate:true（IM-06 幂等丢弃 + IM-07 复用同一记录）。
   */
  claim(key: ImMessageKey, receivedAt: string): Promise<{ record: ImProcessingRecord; duplicate: boolean }>
  /** 阶段推进（IM-07 生命周期）。 */
  appendPhase(key: ImMessageKey, phase: ImProcessingPhase, at: string, note?: string): Promise<void>
  /** 关联问数轮 requestId（AR-15）。 */
  setRequestId(key: ImMessageKey, requestId: string): Promise<void>
  /** 记录发送结果（IM-04/IM-07）。 */
  recordSendResult(key: ImMessageKey, result: ImSendResult): Promise<void>
  /** 键查询（观测/测试）。 */
  findByKey(key: ImMessageKey): Promise<ImProcessingRecord | null>
  /** 全量只读快照（观测/测试）。 */
  list(): Promise<ImProcessingRecord[]>
}

/** 进程内处理记录存储（IM-05 首版承载）。 */
export class InMemoryImProcessingRecordStore implements ImProcessingRecordStorePort {
  private readonly records = new Map<string, ImProcessingRecord>()

  async claim(
    key: ImMessageKey,
    receivedAt: string,
  ): Promise<{ record: ImProcessingRecord; duplicate: boolean }> {
    const keyStr = imMessageKeyString(key)
    const existing = this.records.get(keyStr)
    if (existing) {
      existing.duplicateDropCount += 1
      return { record: existing, duplicate: true }
    }
    const record: ImProcessingRecord = {
      messageKey: keyStr,
      requestId: null,
      phases: [{ phase: 'received', at: receivedAt }],
      sendResult: null,
      duplicateDropCount: 0,
      receivedAt,
    }
    this.records.set(keyStr, record)
    return { record, duplicate: false }
  }

  async appendPhase(
    key: ImMessageKey,
    phase: ImProcessingPhase,
    at: string,
    note?: string,
  ): Promise<void> {
    const record = this.records.get(imMessageKeyString(key))
    if (!record) throw new Error('处理记录不存在，无法推进阶段 [IM-07-3]')
    record.phases.push(note ? { phase, at, note } : { phase, at })
  }

  async setRequestId(key: ImMessageKey, requestId: string): Promise<void> {
    const record = this.records.get(imMessageKeyString(key))
    if (!record) throw new Error('处理记录不存在，无法关联 requestId [IM-07-3]')
    record.requestId = requestId
  }

  async recordSendResult(key: ImMessageKey, result: ImSendResult): Promise<void> {
    const record = this.records.get(imMessageKeyString(key))
    if (!record) throw new Error('处理记录不存在，无法记录发送结果 [IM-07-3]')
    record.sendResult = result
  }

  async findByKey(key: ImMessageKey): Promise<ImProcessingRecord | null> {
    return this.records.get(imMessageKeyString(key)) ?? null
  }

  async list(): Promise<ImProcessingRecord[]> {
    return [...this.records.values()]
  }

  get size(): number {
    return this.records.size
  }
}

/** 渠道事件可观测计数器键（IM-06 幂等丢弃计数为合同强制；其余按行为一一对应）。 */
export type ImChannelEventCounter =
  | 'duplicate_dropped'
  | 'group_intercepted'
  | 'unbound_guidance'
  | 'binding_ok'
  | 'binding_rejected'
  | 'unbind'
  | 'turn_clarify'
  | 'turn_answer'
  | 'turn_unavailable'
  | 'turn_cancelled'
  | 'turn_error'
  | 'sent'
  | 'send_unknown'
  | 'send_failed'
  | 'not_sent'

export interface ImChannelEventCountersPort {
  increment(counter: ImChannelEventCounter): void
  snapshot(): Record<ImChannelEventCounter, number>
}

/** 进程内计数器。 */
export class InMemoryImChannelEventCounters implements ImChannelEventCountersPort {
  private readonly counters = new Map<ImChannelEventCounter, number>()

  increment(counter: ImChannelEventCounter): void {
    this.counters.set(counter, (this.counters.get(counter) ?? 0) + 1)
  }

  snapshot(): Record<ImChannelEventCounter, number> {
    const keys: ImChannelEventCounter[] = [
      'duplicate_dropped',
      'group_intercepted',
      'unbound_guidance',
      'binding_ok',
      'binding_rejected',
      'unbind',
      'turn_clarify',
      'turn_answer',
      'turn_unavailable',
      'turn_cancelled',
      'turn_error',
      'sent',
      'send_unknown',
      'send_failed',
      'not_sent',
    ]
    return Object.fromEntries(keys.map((k) => [k, this.counters.get(k) ?? 0])) as Record<
      ImChannelEventCounter,
      number
    >
  }
}
