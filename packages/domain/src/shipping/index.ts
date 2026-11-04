/**
 * shipping 域导出面（T14 分段装箱/发运：PL/DC 入站、三类备货行、扫码装入/删码/补码、
 * 打包任务、确认出库、两条独立回传；规则底稿 04 §A-T14 + interfaces.md IF-04/05/06/07）。
 * 注意：domain/src/index.ts 为共享文件不改动——shipping 面未并入包名入口，
 * 消费方（application/tests）暂以源码/dist 相对路径引用；L0 整合步在 domain index 追加
 * `export * from './shipping'` 后改包名导入（与 quality/warehousing 同一整合口径）。
 */
export * from './errors'
export * from './permissions'
export * from './pl-rules'
export * from './scan-rules'
export * from './packing-rules'
export * from './ship-rules'
export * from './fulfilment-rules'
