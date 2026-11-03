/**
 * ot 域导出面（T21 设备与仪器采集：点位合同、量纲归一、质量码、校准关联、
 * 工序会话三态、唯一事件 ID、重传去重、乱序迟到、时钟偏差、坏点、容量分层、
 * 业务事实映射；冻结合同 architecture/contracts/frozen/p3/ot-collection.md）。
 * 注意：domain/src/index.ts 为共享文件不改动——ot 面未并入包名入口，
 * 消费方（application/edge/tests）暂以源码/dist 相对路径引用；L0 整合步在
 * domain index 追加 `export * from './ot'` 后改包名导入（与 shipping 先例同一整合口径）。
 */
export * from './errors'
export * from './permissions'
export * from './gateway-rules'
export * from './point-rules'
export * from './sample-rules'
export * from './ingest-rules'
export * from './time-rules'
export * from './badpoint-rules'
export * from './aggregate-rules'
export * from './mapping-rules'
