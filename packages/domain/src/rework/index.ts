/**
 * rework 域导出面（T15 倒轴/分盘/分托解绑/轴号修正/轴码退役）——
 * 冻结合同 architecture/contracts/frozen/p2/rework-split.md（RS-01～RS-37 + RS-S1～S6）。
 * 注意：domain/src/index.ts 为共享文件不改动——rework 面未并入包名入口，
 * 消费方（application/persistence/apps.api/tests）暂以源码/dist 相对路径引用；L0 整合步在
 * domain index 追加 `export * from './rework'` 后改包名导入（与 shipping/reverse 同一整合口径）。
 */
export * from './errors'
export * from './reel-split-rules'
export * from './pallet-rules'
export * from './axis-correction-rules'
export * from './axis-retire-rules'
