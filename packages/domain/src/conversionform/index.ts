/**
 * conversionform 域导出面（T16 两种形态转换：订单式=本地先执行后同步（FC-05～12）；
 * 库存式=外部先成功再本地（FC-13～21）；共用 FC-01～04/FC-S1～S5）。
 *
 * 目录名 conversionform 与既有 process 域（生产订单/工艺）区分：本域是形态转换业务，
 * 不与 process/order（生产订单）混同——生产订单仅作为转换前后锚点被只读引用。
 *
 * 注意：domain/src/index.ts 为共享文件不改动——conversionform 面未并入包名入口，
 * 消费方（application/tests）暂以源码/dist 相对路径引用；L0 整合步在 domain index
 * 追加 `export * from './conversionform'` 后改包名导入（与 shipping 整合同一口径）。
 */
export * from './errors'
export * from './permissions'
export * from './order-conversion-rules'
export * from './stock-conversion-rules'
