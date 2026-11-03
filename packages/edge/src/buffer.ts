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

export class EdgeBuffer {
  private readonly entries: BufferedSample[] = []
  private overflow: OverflowStats | null = null

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

  /** 确认送达后清空缓冲（落检查点由调用方随缓冲一起持久化，OT-15）。 */
  drain(): BufferedSample[] {
    const out = [...this.entries]
    this.entries.length = 0
    this.overflow = null
    return out
  }

  restore(entries: BufferedSample[]): void {
    this.entries.length = 0
    for (const e of entries) this.entries.push(e)
    this.overflow = null
  }

  /** 未上报的溢出统计（取出后清零；随下一批上报服务端）。 */
  takeOverflowStats(): OverflowStats | null {
    const out = this.overflow
    this.overflow = null
    return out
  }
}
