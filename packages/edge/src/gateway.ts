// [L0-整合标记] domain ot 面未并入包名入口（domain/src/index.ts 为共享文件不改动）：
// 唯一事件 ID 构造规则（OT-15）单点定义在 domain ot，此处以 dist 相对导入消费已构建
// 产物（package.json 声明 @cadenza/domain 依赖保证构建拓扑序）；L0 整合后改包名导入。
import { buildEventId } from '../../domain/dist/ot/index.js'
import { EdgeBuffer, type BufferedSample } from './buffer'
import type { EdgeCheckpoint, EdgeCheckpointStore } from './checkpoint'
import { MemoryCheckpointStore } from './checkpoint'
import type { SimulatedPointConfig } from './generator'
import type { IngestBatchPayload, IngestTransport } from './transport'

/**
 * 边缘采集模拟网关（OT-04 拓扑：PLC/SCADA/检测仪/计米器/电子秤 → 边缘网关〔本地缓冲〕→ API）：
 * - 可配置模拟点位发生器（tick 驱动、确定性，无墙钟依赖）；
 * - 断网本地缓冲（OT-14）与恢复补传（OT-17 溢出丢最旧+统计；OT-18 只补数据）；
 * - 唯一事件 ID = 设备序列号+网关内单调序号（OT-15），检查点随缓冲落盘、重装续发；
 * - 重传模拟：replayBuffer() 以同一批条目再次上报（服务端 OT-16 去重）。
 */
export class SimulatedGateway {
  private seq: number
  private readonly buffer: EdgeBuffer
  private online = true
  private tickIndex = 0

  constructor(
    public readonly gatewayCode: string,
    private readonly points: readonly SimulatedPointConfig[],
    options: {
      capacity?: number
      checkpointStore?: EdgeCheckpointStore
      transport?: IngestTransport
      /** 序号起点（多网关实例共用同一设备序列号时错开；正常从 0/检查点起） */
      initialSeq?: number
    } = {},
  ) {
    this.buffer = new EdgeBuffer(options.capacity ?? 10_000)
    this.checkpointStore = options.checkpointStore ?? new MemoryCheckpointStore()
    this.transport = options.transport ?? null
    this.seq = options.initialSeq ?? 0
  }

  private readonly checkpointStore: EdgeCheckpointStore
  private readonly transport: IngestTransport | null

  /** OT-15：从持久检查点恢复（重装续发；缓冲随检查点恢复）。 */
  async restoreFromCheckpoint(): Promise<boolean> {
    const cp = await this.checkpointStore.load(this.gatewayCode)
    if (cp === null) return false
    this.seq = cp.lastSeq
    this.buffer.restore(cp.buffered)
    return true
  }

  async saveCheckpoint(savedAt: string): Promise<void> {
    const cp: EdgeCheckpoint = {
      gatewayCode: this.gatewayCode,
      lastSeq: this.seq,
      buffered: this.buffer.peek(),
      savedAt,
    }
    await this.checkpointStore.save(cp)
  }

  setOnline(online: boolean): void {
    this.online = online
  }

  get isOnline(): boolean {
    return this.online
  }

  get backlog(): number {
    return this.buffer.size
  }

  get lastSeq(): number {
    return this.seq
  }

  /** 产生一个 tick 的样本（OT-15：事件 ID=设备序列号+网关内单调序号，禁裸时间戳）。 */
  private generateTick(eventTime: string): BufferedSample[] {
    const out: BufferedSample[] = []
    for (const point of this.points) {
      this.seq += 1
      out.push({
        deviceSerial: point.deviceSerial,
        pointCode: point.pointCode,
        eventId: buildEventId(point.deviceSerial, this.seq),
        gatewaySeq: this.seq,
        eventTime,
        rawValue: point.value?.(this.tickIndex) ?? 0,
        rawUnit: point.unit,
        deviceQualityCode: point.deviceQualityCode ?? '0',
      })
    }
    this.tickIndex += 1
    return out
  }

  /**
   * 采集一个 tick：在线→直接尝试上行（无传输通道或上行失败→入本地缓冲，OT-14 断网语义）；
   * 离线→入本地缓冲。返回本 tick 产生的样本（确定性断言用）。
   */
  async tick(eventTime: string): Promise<BufferedSample[]> {
    const samples = this.generateTick(eventTime)
    if (this.online && this.transport !== null) {
      try {
        await this.transport.send(this.toPayload(samples))
        return samples
      } catch {
        // 上行失败（模拟断网中段）→ 缓冲后补传
      }
    }
    for (const s of samples) this.buffer.push(s)
    return samples
  }

  /** 缓冲窥视（断网积压可视化，OT-29 监控项数据源）。 */
  peekBuffer(): BufferedSample[] {
    return this.buffer.peek()
  }

  /** 未上报的溢出统计（OT-17：随补传批次上报服务端）。 */
  takeOverflowStats() {
    return this.buffer.takeOverflowStats()
  }

  /** 组装入池批次载荷（OT-09：样本必含字段；OT-17 溢出；OT-15 检查点）。 */
  toPayload(samples: readonly BufferedSample[], withOverflow = true): IngestBatchPayload {
    const overflow = withOverflow ? this.buffer.takeOverflowStats() : null
    return {
      gatewayCode: this.gatewayCode,
      samples: samples.map((s) => ({
        deviceSerial: s.deviceSerial,
        pointCode: s.pointCode,
        eventId: s.eventId,
        eventTime: s.eventTime,
        rawValue: s.rawValue,
        rawUnit: s.rawUnit,
        deviceQualityCode: s.deviceQualityCode,
      })),
      overflow:
        overflow === null
          ? null
          : {
              count: overflow.count,
              firstAt: overflow.firstAt,
              lastAt: overflow.lastAt,
              deviceSerials: overflow.deviceSerials,
            },
      backlogCount: this.buffer.size,
      checkpointSeq: this.seq,
    }
  }

  /**
   * 恢复补传（OT-14/OT-18：只补数据，不生成/重放业务命令——载荷仅为样本批次）。
   * 送达成功后清空缓冲并落检查点（OT-15：检查点随缓冲落盘）。
   */
  async flush(): Promise<{ flushed: number; checkpointSeq: number }> {
    const pending = this.buffer.peek()
    if (pending.length > 0) {
      if (this.transport !== null) {
        await this.transport.send(this.toPayload(pending))
      }
      this.buffer.drain()
    }
    await this.saveCheckpoint(new Date().toISOString())
    return { flushed: pending.length, checkpointSeq: this.seq }
  }

  /**
   * 重传模拟（OT-16：同一批条目再次构造载荷——服务端按 (设备序列号, 唯一事件 ID)
   * 幂等丢弃并累计去重计数；不清缓冲、不推进序号）。
   */
  replayPayload(): IngestBatchPayload | null {
    const pending = this.buffer.peek()
    if (pending.length === 0) return null
    return this.toPayload(pending, false)
  }
}
