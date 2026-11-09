/**
 * 边缘本地缓冲（OT-14/OT-17）：断网时样本在网关侧持久缓冲；达到容量上限时
 * 丢弃最旧原始样本并记录溢出统计（条数、时段、设备），不静默丢弃。
 * 缓冲条目必带 持久设备序列号＋事件时间＋唯一事件 ID（OT-14）。
 */

export interface BufferedSample {
  deviceSerial: string
  pointCode: string
  eventId: string
  gatewaySeq: number
  eventTime: string
  rawValue: number
  rawUnit: string
  deviceQualityCode: string
}

/** 溢出统计（OT-17：条数/时段/设备；上报服务端入 ot_stats 与事件留痕）。 */
export interface OverflowStats {
  count: number
  firstAt: string
  lastAt: string
  deviceSerials: string[]
}

export interface DeliveryBatch {
  samples: BufferedSample[]
  overflow: OverflowStats | null
}

function mergeOverflow(a: OverflowStats | null, b: OverflowStats | null): OverflowStats | null {
  if (a === null) return b === null ? null : { ...b, deviceSerials: [...b.deviceSerials] }
  if (b === null) return { ...a, deviceSerials: [...a.deviceSerials] }
  return {
    count: a.count + b.count,
    firstAt: a.firstAt,
    lastAt: b.lastAt,
    deviceSerials: [...new Set([...a.deviceSerials, ...b.deviceSerials])],
  }
}

export class EdgeBuffer {
  private readonly entries: BufferedSample[] = []
  private overflow: OverflowStats | null = null
  private delivery: DeliveryBatch | null = null

  constructor(public readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`[OT-17] 缓冲容量必须为正整数（收到：${capacity}）`)
    }
  }

  /** 入缓冲；满载丢最旧并累计溢出统计（OT-17）。 */
  push(sample: BufferedSample): void {
    if (this.entries.length >= this.capacity) {
      const dropped = this.entries.shift()
      if (this.overflow === null) {
        this.overflow = {
          count: 1,
          firstAt: dropped!.eventTime,
          lastAt: dropped!.eventTime,
          deviceSerials: [dropped!.deviceSerial],
        }
      } else {
        this.overflow.count += 1
        this.overflow.lastAt = dropped!.eventTime
        if (!this.overflow.deviceSerials.includes(dropped!.deviceSerial)) {
          this.overflow.deviceSerials.push(dropped!.deviceSerial)
        }
      }
    }
    this.entries.push(sample)
  }

  get size(): number {
    return this.entries.length
  }

  /** 窥视待重放条目（不清空——重传模拟用同一批条目，服务端按 OT-16 去重）。 */
  peek(): BufferedSample[] {
    return [...this.entries]
  }

  /** Freeze one batch; new arrivals and their overflow belong to the next batch. */
  beginDelivery(): DeliveryBatch {
    if (this.delivery !== null) throw new Error('A delivery is already in flight')
    const batch = { samples: this.peek(), overflow: this.overflow }
    this.overflow = null
    this.delivery = batch
    return batch
  }

  finishDelivery(batch: DeliveryBatch, acknowledged: boolean): void {
    if (this.delivery !== batch) throw new Error('Unknown delivery batch')
    if (acknowledged) {
      const ids = new Set(batch.samples.map((s) => `${s.deviceSerial}\0${s.eventId}`))
      for (let i = this.entries.length - 1; i >= 0; i -= 1) {
        const s = this.entries[i]!
        if (ids.has(`${s.deviceSerial}\0${s.eventId}`)) this.entries.splice(i, 1)
      }
    } else {
      this.overflow = mergeOverflow(batch.overflow, this.overflow)
    }
    this.delivery = null
  }

  peekOverflowStats(): OverflowStats | null {
    return mergeOverflow(this.delivery?.overflow ?? null, this.overflow)
  }

  /** 确认送达后清空缓冲（落检查点由调用方随缓冲一起持久化，OT-15）。 */
  drain(): BufferedSample[] {
    if (this.delivery !== null) throw new Error('Cannot drain an unacknowledged delivery')
    const out = [...this.entries]
    this.entries.length = 0
    this.overflow = null
    return out
  }

  restore(entries: BufferedSample[], overflow: OverflowStats | null = null): void {
    if (this.delivery !== null) throw new Error('Cannot restore during delivery')
    this.entries.length = 0
    for (const e of entries) this.entries.push(e)
    this.overflow = mergeOverflow(null, overflow)
  }

  /** Compatibility accessor; only a successful delivery may acknowledge these statistics. */
  takeOverflowStats(): OverflowStats | null {
    return this.peekOverflowStats()
  }
}
