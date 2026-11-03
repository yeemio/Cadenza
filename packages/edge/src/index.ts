/**
 * @cadenza/edge 导出面：边缘采集模拟网关（T21/P3-A）。
 * 真实设备协议接入一律留现场（SITE_PENDING，OT-31）；本包承载合同内全部可判定
 * 行为的模拟环境：点位发生器（确定性）、断网本地缓冲、溢出统计、检查点续发、
 * 补传与重传载荷构造。
 */
export * from './buffer'
export * from './checkpoint'
export * from './generator'
export * from './gateway'
export * from './adapters'
export * from './transport'
