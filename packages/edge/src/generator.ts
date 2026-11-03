/**
 * 可配置模拟点位发生器（OT-31：模拟设备承载合同内可判定行为；证据须标明模拟环境）。
 * 全部发生器为确定性纯函数（tick 序号 → 数值），无随机源——测试可精确断言。
 */

export type SimulatedSemantic =
  | 'meter_length'
  | 'speed'
  | 'temperature'
  | 'weight'
  | 'stop_signal'
  | 'inspection_result'
  | 'other'

export interface SimulatedPointConfig {
  deviceSerial: string
  pointCode: string
  /** 原始单位（OT-10：原始值＋原始单位上报，服务端归一） */
  unit: string
  semantic: SimulatedSemantic
  /** 设备侧质量码（OT-11：映射表未配置的码服务端按 uncertain） */
  deviceQualityCode?: string
  /** 值函数：tick 序号（0 起）→ 数值；缺省恒 0 */
  value?: (tickIndex: number) => number
}

/** 计长（累计递增：每 tick +step）——计长→报工数量映射的典型源。 */
export function meterCounter(step = 1): (i: number) => number {
  return (i: number) => (i + 1) * step
}

/** 速度（正弦波动，幅度可调）。 */
export function sineWave(base: number, amplitude: number): (i: number) => number {
  return (i: number) => Number((base + amplitude * Math.sin(i)).toFixed(4))
}

/** 停机信号（前 upTicks 个 tick 停机电平、其后恢复）——停机→停机事件映射的典型源。 */
export function stopSignal(upTicks: number, stopLevel = 1, runLevel = 0): (i: number) => number {
  return (i: number) => (i < upTicks ? stopLevel : runLevel)
}

/** 恒值发生器。 */
export function constant(value: number): () => number {
  return () => value
}
