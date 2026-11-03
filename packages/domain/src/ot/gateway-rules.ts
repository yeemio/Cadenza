import { OtRuleViolation } from './errors'

/**
 * 边缘网关注册与心跳规则（OT-06/OT-S3）：网关注册表登记 工厂、网关标识、
 * 协议配置、采样率、最后心跳；网关离线/恢复事件留痕并告警（事件留痕由应用层
 * 落 ot_gateway_event，本文件承载可判定校验与状态推导）。
 */

/** 网关运行状态（OT-06：按最后心跳与超时阈值推导；离线/恢复事件留痕）。 */
export type GatewayRunStatus = 'online' | 'offline'

export interface GatewaySpecInput {
  gatewayCode: string
  /** 采样率（每秒采样次数，网关缺省值；每点位采样率在点位字典登记，OT-08） */
  sampleRateHz: number
  /** 本地缓冲容量上限（条；溢出语义见 OT-17，边缘侧承载） */
  bufferCapacity: number
  /** 心跳超时阈值（秒；超时即视为离线） */
  heartbeatTimeoutSeconds: number
}

/** OT-06：网关注册载荷校验（网关标识唯一由库级 UNIQUE 承载）。 */
export function assertGatewaySpec(spec: GatewaySpecInput): void {
  if (spec.gatewayCode.length === 0 || spec.gatewayCode.length > 64) {
    throw new OtRuleViolation('OT-06', '网关标识必须为 1–64 个字符')
  }
  if (!Number.isFinite(spec.sampleRateHz) || spec.sampleRateHz <= 0 || spec.sampleRateHz > 1_000_000) {
    throw new OtRuleViolation('OT-06', '采样率必须为正数（每秒采样次数）')
  }
  if (!Number.isInteger(spec.bufferCapacity) || spec.bufferCapacity < 1 || spec.bufferCapacity > 100_000_000) {
    throw new OtRuleViolation('OT-06', '缓冲容量必须为正整数（条）')
  }
  if (
    !Number.isInteger(spec.heartbeatTimeoutSeconds) ||
    spec.heartbeatTimeoutSeconds < 5 ||
    spec.heartbeatTimeoutSeconds > 86_400
  ) {
    throw new OtRuleViolation('OT-06', '心跳超时阈值必须为 5–86400 的整数（秒）')
  }
}

/**
 * OT-06/OT-29：按最后心跳推导网关运行状态。
 * 从未心跳（lastHeartbeatAt=null）→ offline；距最后心跳超过阈值 → offline。
 */
export function deriveGatewayStatus(
  lastHeartbeatAt: string | null,
  heartbeatTimeoutSeconds: number,
  now: string,
): GatewayRunStatus {
  if (lastHeartbeatAt === null) return 'offline'
  const lastMs = Date.parse(lastHeartbeatAt)
  const nowMs = Date.parse(now)
  if (Number.isNaN(lastMs) || Number.isNaN(nowMs)) {
    throw new OtRuleViolation('OT-06', `心跳时间非法：last=${lastHeartbeatAt} now=${now}`)
  }
  return nowMs - lastMs <= heartbeatTimeoutSeconds * 1000 ? 'online' : 'offline'
}
