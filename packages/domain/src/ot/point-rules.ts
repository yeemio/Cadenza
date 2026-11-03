import { OtRuleViolation } from './errors'

/**
 * 点位主数据与量纲规则（OT-08/OT-S2/OT-10）：每台设备的采集点位登记
 * 点位代码（工厂内唯一）、点位语义、工程单位（引用 uom 字典）、采样率、
 * 量程上下限、是否参与业务判定；点位字典版本化。
 */

/** 点位语义（OT-08：计长/速度/温度/称重/停机信号/检测结果等；闭合集 + other）。 */
export const POINT_SEMANTICS = [
  'meter_length',
  'speed',
  'temperature',
  'weight',
  'stop_signal',
  'inspection_result',
  'other',
] as const

export type PointSemantic = (typeof POINT_SEMANTICS)[number]

export const POINT_SEMANTIC_LABELS: Readonly<Record<PointSemantic, string>> = {
  meter_length: '计长',
  speed: '速度',
  temperature: '温度',
  weight: '称重',
  stop_signal: '停机信号',
  inspection_result: '检测结果',
  other: '其它',
}

export interface PointSpecInput {
  pointCode: string
  semantic: string
  uomCode: string
  /** 采样率（秒/次） */
  sampleRateSeconds: number
  rangeMin: number | null
  rangeMax: number | null
  participatesInBusiness: boolean
  /** OT-12：检测/计量类点位引用出具时的校准记录版本（过期期间样本标"校准状态可疑"） */
  calibrationRecordNo: string | null
  calibrationValidUntil: string | null
}

/** OT-08：点位字典载荷校验（(plant_id, point_code) 唯一由库级索引承载）。 */
export function assertPointSpec(spec: PointSpecInput): void {
  if (spec.pointCode.length === 0 || spec.pointCode.length > 64) {
    throw new OtRuleViolation('OT-08', '点位代码必须为 1–64 个字符')
  }
  if (!POINT_SEMANTICS.includes(spec.semantic as PointSemantic)) {
    throw new OtRuleViolation(
      'OT-08',
      `点位语义必须为 ${POINT_SEMANTICS.join('/')}（收到：${spec.semantic}）`,
    )
  }
  if (spec.uomCode.length === 0 || spec.uomCode.length > 16) {
    throw new OtRuleViolation('OT-08', '工程单位必须引用 uom 字典（1–16 个字符）')
  }
  if (!Number.isFinite(spec.sampleRateSeconds) || spec.sampleRateSeconds <= 0 || spec.sampleRateSeconds > 86_400) {
    throw new OtRuleViolation('OT-08', '采样率必须为正数（秒/次）')
  }
  if ((spec.rangeMin === null) !== (spec.rangeMax === null)) {
    throw new OtRuleViolation('OT-08', '量程上下限必须成对配置')
  }
  if (spec.rangeMin !== null && spec.rangeMax !== null && !(spec.rangeMin < spec.rangeMax)) {
    throw new OtRuleViolation('OT-08', '量程下限必须小于上限')
  }
  if (spec.calibrationValidUntil !== null && Number.isNaN(Date.parse(spec.calibrationValidUntil))) {
    throw new OtRuleViolation('OT-12', '校准有效期必须为合法时间')
  }
  if (spec.calibrationValidUntil !== null && (spec.calibrationRecordNo ?? '') === '') {
    throw new OtRuleViolation('OT-12', '登记校准有效期时必须同时引用校准记录版本号')
  }
}

/** OT-21：量程越界判定（OT-08 量程外；未配置量程的点不做越界判定）。 */
export function isOutOfRange(
  value: number,
  rangeMin: number | null,
  rangeMax: number | null,
): boolean {
  if (rangeMin === null || rangeMax === null) return false
  return value < rangeMin || value > rangeMax
}
