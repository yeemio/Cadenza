/**
 * reverse 域导出面（T17 仓储异常与逆向：移库台账/无任务调拨/Web 有任务全流程/调拨入库
 * 跨厂签收/采购批次库存纠正/盘点/客户所有物三分/载具借还）——
 * 冻结合同 architecture/contracts/frozen/p2/warehouse-reverse.md（WR-01～WR-28 + WR-S1～S6）。
 * 注意：domain/src/index.ts 为共享文件不改动——reverse 面未并入包名入口，
 * 消费方（application/persistence/apps.api/tests）暂以源码/dist 相对路径引用；L0 整合步在
 * domain index 追加 `export * from './reverse'` 后改包名导入（与 shipping 同一整合口径）。
 */
export * from './errors'
export * from './permissions'
export * from './move-rules'
export * from './transfer-out-rules'
export * from './transfer-in-rules'
export * from './receipt-correction-rules'
export * from './stocktake-rules'
export * from './ownership-carrier-rules'
