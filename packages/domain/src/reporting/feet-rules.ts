import type { DecimalString } from '@cadenza/contracts'
import { fromScaledInt, toScaledInt, truncDiv4 } from './decimal-math'

/**
 * 英尺数换算（RP-03，公共换算规则；GAP-F27 待 Owner 最终确认统一口径）：
 * 基本单位为米时按 基本单位数量 ÷ 0.3048 **截取** 4 位小数（不四舍五入），否则显示 `-`；
 * 仅展示列不入账、标注 measurement_basis（IT-10）；报工记录英尺列同规则（RP-12 随行）。
 *
 * 精确性：0.3048 = 3048/10^4，且数量列为 ≤4 位小数十进制字符串，
 * 故 q ÷ 0.3048 = q_int ÷ 3048（定点整数除法即精确截取，无浮点误差）。
 */

/** 基本单位"米"的判定（P1 uom.code 口径：'M' 即米；其余显示 `-`）。 */
export function isMeterUom(uomCode: string | null | undefined): boolean {
  return uomCode !== null && uomCode !== undefined && uomCode.trim().toUpperCase() === 'M'
}

/**
 * 英尺数：米 → trunc4(数量 ÷ 0.3048)；非米 → null（展示 `-`）。
 * 数量非法（非 ≤4 位十进制字符串）抛 [RP-03]（不静默吞错冒充 `-`）。
 */
export function feetDisplay(
  quantity: DecimalString,
  uomCode: string | null | undefined,
): DecimalString | null {
  if (!isMeterUom(uomCode)) return null
  // q ÷ 0.3048 = (q_int/10^4) ÷ (3048/10^4) = q_int ÷ 3048，再定点截 4 位
  return fromScaledInt(truncDiv4(toScaledInt(quantity, 'RP-03'), 3048n))
}
