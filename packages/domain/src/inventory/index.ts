/**
 * inventory 域（库存记账与追溯内核）——对应冻结合同 inventory-trace-core.md
 * （IT-01～IT-37 业务规则 + IT-S1～S10 表级约束，表级落库见 persistence 迁移 0004）。
 */
export * from './errors'
export * from './quantity'
export * from './stock-state'
export * from './availability'
export * from './identity'
export * from './posting'
export * from './conservation'
export * from './reservation-rules'
export * from './time'
export * from './permissions'
