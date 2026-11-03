/**
 * warehousing 域导出面（T13 入库/移库/调拨：上架/移库/调拨状态机/作业预留锁定；规则底稿 04 §A-T13）。
 * 注意：domain/src/index.ts 为共享文件不改动——warehousing 面未并入包名入口，
 * 消费方（application/tests）暂以源码/dist 相对路径引用；L0 整合步在 domain index 追加
 * `export * from './warehousing'` 后改包名导入（与 masterdata/inventory/purchase 同一整合口径）。
 */
export * from './errors'
export * from './permissions'
export * from './putaway-rules'
export * from './move-rules'
export * from './transfer-rules'
