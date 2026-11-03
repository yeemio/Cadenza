/**
 * purchase 域导出面（T08 采购收货/来料检验/价格复核；规则底稿 04 §A-T08）。
 * 注意：domain/src/index.ts 为共享文件（S2 既有）不改动——purchase 面未并入包名入口，
 * 消费方（application/tests）暂以源码/dist 相对路径引用；L0 整合步在 domain index 追加
 * `export * from './purchase'` 后改包名导入（与 masterdata/inventory 同一整合口径）。
 */
export * from './errors'
export * from './permissions'
export * from './order-status'
export * from './receipt-rules'
export * from './inspection-rules'
export * from './return-rules'
export * from './price-review-rules'
