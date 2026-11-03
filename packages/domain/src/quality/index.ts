/**
 * quality 域导出面（T12 质量放行：质量状态轴/参数化闸门/检验规范版本化/存疑；规则底稿 04 §A-T12）。
 * 注意：domain/src/index.ts 为共享文件不改动——quality 面未并入包名入口，
 * 消费方（application/tests）暂以源码/dist 相对路径引用；L0 整合步在 domain index 追加
 * `export * from './quality'` 后改包名导入（与 masterdata/inventory/purchase 同一整合口径）。
 */
export * from './errors'
export * from './permissions'
export * from './quality-axis'
export * from './gate'
export * from './inspection-rules'
export * from './suspect-rules'
