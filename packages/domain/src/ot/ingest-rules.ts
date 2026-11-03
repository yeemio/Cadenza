import { OtRuleViolation } from './errors'

/**
 * 边缘缓冲、重传与去重的服务端可判定规则（OT-14～OT-19）。
 * 本地持久缓冲与断网补传由边缘网关承载（packages/edge 模拟网关）；
 * 唯一事件 ID 构造规则在此单点定义，边缘与 API 共用同一构造。
 */

// ---------------- OT-15 唯一事件 ID ----------------

/**
 * OT-15：唯一事件 ID 构造 = 设备序列号 + 网关内单调序号；
 * 禁止用裸时间戳充当唯一 ID。网关重装后序号从持久检查点续发
 * （检查点随缓冲落盘——边缘侧承载；服务端按格式校验）。
 */
export function buildEventId(deviceSerial: string, gatewaySeq: number): string {
  return `${deviceSerial}@${gatewaySeq}`
}

export interface ParsedEventId {
  deviceSerial: string
  gatewaySeq: number
}

/** OT-15：唯一事件 ID 解析与格式校验（不匹配 <serial>@<正整数> 即拒）。 */
export function parseEventId(eventId: string): ParsedEventId {
  const at = eventId.lastIndexOf('@')
  if (at <= 0 || at === eventId.length - 1) {
    throw new OtRuleViolation('OT-15', `唯一事件 ID 必须为 设备序列号@网关内单调序号（收到：${eventId}）`)
  }
  const deviceSerial = eventId.slice(0, at)
  const seq = Number(eventId.slice(at + 1))
  if (!Number.isInteger(seq) || seq < 1 || seq > Number.MAX_SAFE_INTEGER) {
    throw new OtRuleViolation('OT-15', `唯一事件 ID 的网关序号必须为正整数（收到：${eventId}）`)
  }
  return { deviceSerial, gatewaySeq: seq }
}

/** OT-15：事件 ID 的设备前缀必须与样本设备序列号一致（防跨设备串号）。 */
export function assertEventIdMatchesDevice(eventId: string, deviceSerial: string): number {
  const parsed = parseEventId(eventId)
  if (parsed.deviceSerial !== deviceSerial) {
    throw new OtRuleViolation(
      'OT-15',
      `唯一事件 ID 设备前缀不匹配：eventId=${eventId} deviceSerial=${deviceSerial}`,
    )
  }
  return parsed.gatewaySeq
}

// ---------------- OT-19 乱序与迟到 ----------------

/**
 * OT-19：迟到判定——事件时间早于该设备已入池的最大事件时间即迟到；
 * 迟到样本允许补插并标"迟到"，不因迟到重算已生成的班次汇总
 * （班次汇总重建走显式重建命令，应用层承载）。
 */
export function isLateSample(eventTime: string, deviceMaxEventTime: string | null): boolean {
  if (deviceMaxEventTime === null) return false
  const eventMs = Date.parse(eventTime)
  const maxMs = Date.parse(deviceMaxEventTime)
  if (Number.isNaN(eventMs) || Number.isNaN(maxMs)) return false
  return eventMs < maxMs
}
