import type { BufferedSample } from './buffer'

/**
 * 协议适配器（OT-05：OPC UA 等实际协议按现场设备逐台接入；统一数据合同，
 * 不因协议差异产生第二套点词语义）。
 *
 * **SITE_PENDING / BLOCKED_EXTERNAL（OT-31）**：真实厂商设备接入读回为
 * BLOCKED_EXTERNAL，未见现场不声称已接通——OpcUaAdapter 与 VendorPrivateAdapter
 * 为现场占位，调用即抛错并带 SITE_PENDING 标记；合同全部可判定行为由
 * SimulatedAdapter（开发协议服务＋匿名数据）承载。
 */

export type RawProtocolSample = {
  deviceSerial: string
  pointCode: string
  /** 协议原始值（适配器不改写——OT-10：禁止边缘侧丢弃原始值只传换算值） */
  rawValue: number
  rawUnit: string
  deviceQualityCode: string
  /** 协议侧时间戳（设备侧事件时间，OT-09 双轨之一） */
  eventTime: string
}

export interface ProtocolAdapter {
  readonly protocol: string
  /** SITE_PENDING=true 表示真实协议未接通（现场接入前不可用） */
  readonly sitePending: boolean
  read(): AsyncGenerator<RawProtocolSample>
}

/** 模拟适配器：从预置样本序列按序产出（开发协议服务＋匿名数据，OT-31）。 */
export class SimulatedAdapter implements ProtocolAdapter {
  readonly protocol = 'simulated'
  readonly sitePending = false

  constructor(private readonly samples: readonly RawProtocolSample[]) {}

  async *read(): AsyncGenerator<RawProtocolSample> {
    for (const s of this.samples) yield s
  }
}

function sitePendingError(protocol: string): Error {
  return new Error(
    `[OT-05/SITE_PENDING] ${protocol} 真实协议接入留现场待实施（BLOCKED_EXTERNAL，OT-31）：` +
      `未见现场不声称已接通；模拟环境用 SimulatedAdapter 承载合同行为`,
  )
}

/** OPC UA 适配器（OT-05：现场逐台接入前 SITE_PENDING 占位）。 */
export class OpcUaAdapter implements ProtocolAdapter {
  readonly protocol = 'opc-ua'
  readonly sitePending = true

  async *read(): AsyncGenerator<RawProtocolSample> {
    throw sitePendingError('OPC UA')
  }
}

/** 厂商私有协议适配器（OT-05：按现场设备逐台接入前 SITE_PENDING 占位）。 */
export class VendorPrivateAdapter implements ProtocolAdapter {
  readonly protocol = 'vendor-private'
  readonly sitePending = true

  async *read(): AsyncGenerator<RawProtocolSample> {
    throw sitePendingError('厂商私有协议')
  }
}

/** 适配器原始样本 → 缓冲条目（事件 ID 构造见 gateway.ts，OT-15）。 */
export function toBufferedSample(
  raw: RawProtocolSample,
  eventId: string,
  gatewaySeq: number,
): BufferedSample {
  return {
    deviceSerial: raw.deviceSerial,
    pointCode: raw.pointCode,
    eventId,
    gatewaySeq,
    eventTime: raw.eventTime,
    rawValue: raw.rawValue,
    rawUnit: raw.rawUnit,
    deviceQualityCode: raw.deviceQualityCode,
  }
}
