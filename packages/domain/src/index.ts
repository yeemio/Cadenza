export * from './org'
export * from './masterdata'
export * from './inventory'
export * from './trace'
export * from './process'
export * from './purchase'
export * from './scheduling'
export * from './execution'
export * from './quality'
export * from './warehousing'
export * from './shipping'
export * from './ot'
export * from './csw'
export * from './spc'
export * from './cost'
// L0 整合步（P2/P4 批次 2026-10-28）：倒轴分托修正退役/形态转换/仓储逆向/质量处置/维保/报表/AI 问数
export * from './rework'
export * from './conversionform'
export * from './reverse'
export * from './disposition'
export * from './maintenance'
export * from './reporting'
export * from './aiquery'
// L0 整合步（P3 批次 2026-10-28）桶冲突显名消解（TS2308）：
// - addQty/cmpQty/subQty：inventory（既有桶口径，csw-posting 等消费方实测依赖）与 csw/shared 同名不同实现；
// - assertProductionDateValid/isValidProductionDate：scheduling 与 csw/shared 同名。
// 显名再导出优先于 export *：既有口径不变；csw 域内部经相对路径用自身版本，语义互不影响。
export { addQty, cmpQty, subQty } from './inventory'
export { assertProductionDateValid, isValidProductionDate } from './scheduling'
// L0 整合步（Wave5）桶冲突显名消解（TS2308）：
// - computeShiftDate：inventory（班次日历口径）与 scheduling（白班起点口径）同名不同语义；
// - BalanceQualityStatus：purchase 与 quality 同形重复声明。
// 显名再导出优先于 export *：既有消费方（inventory/purchase 口径）语义不变；
// scheduling 口径以别名 computeSchedulingShiftDate 导出（域包仅 main 入口，无子路径）。
export { computeShiftDate } from './inventory'
export { computeShiftDate as computeSchedulingShiftDate } from './scheduling'
export type { BalanceQualityStatus } from './purchase'
// L0 整合步（P2/P4 批次 2026-10-28）桶冲突显名消解（TS2308）：
// - assertReturnExecutable：purchase（A-9，{batchInspectionStatus,storageStatus}）与
//   reverse（WR-20，含 batchNo/remark/attachments）同名不同形——purchase 版胜出，
//   reverse 版以别名 assertReverseReturnExecutable 导出（reverse-handlers 消费别名）；
// - TRANSFER_KINDS：warehousing（含 'auto' 三值）与 reverse（两值）同名不同值——warehousing 版胜出
//   （reverse 域内部经相对路径用自身版本，无外部消费方）；
// - BatchInspectionStatus：purchase 与 disposition 同形（6 值联合一致）——purchase 版胜出；
// - EQUIPMENT_STATUS/EQUIPMENT_STATUS_VALUES/EquipmentStatusValue：masterdata 与 maintenance
//   同值——masterdata 版胜出；
// - assertEquipmentStatusValue：masterdata（MD-13、void 返回）与 maintenance（MT-01、
//   返回 EquipmentStatusValue）同名不同形——masterdata 版胜出，maintenance 版以别名
//   assertMaintenanceEquipmentStatusValue 导出（maintenance-handlers 消费别名）；
// - assertOrderTransition：process（ProductionOrderStatus）与 maintenance
//   （MaintenanceOrderStatus）同名不同形——process 版胜出，maintenance 版以别名
//   assertMaintenanceOrderTransition 导出（maintenance-handlers 消费别名）；
// - assertNotDownstreamConsumed：reverse（WR-22，DownstreamUsageFacts 富签名）与
//   disposition（QD-16，{batchNo,downstreamConsumed}）同名不同形——两域均本轮新注册，
//   reverse 版胜出保裸名（reverse-handlers 消费），disposition 版以别名
//   assertDispositionNotDownstreamConsumed 导出（disposition-handlers 消费别名）。
export { assertReturnExecutable } from './purchase'
export { assertReturnExecutable as assertReverseReturnExecutable } from './reverse'
export { TRANSFER_KINDS } from './warehousing'
export type { BatchInspectionStatus } from './purchase'
export { EQUIPMENT_STATUS, EQUIPMENT_STATUS_VALUES } from './masterdata'
export type { EquipmentStatusValue } from './masterdata'
export { assertEquipmentStatusValue } from './masterdata'
export { assertEquipmentStatusValue as assertMaintenanceEquipmentStatusValue } from './maintenance'
export { assertOrderTransition } from './process'
export { assertOrderTransition as assertMaintenanceOrderTransition } from './maintenance'
export { assertNotDownstreamConsumed } from './reverse'
export { assertNotDownstreamConsumed as assertDispositionNotDownstreamConsumed } from './disposition'
export * from './group'
export * from './production'
export * from './scan-block'
export * from './sap-sim'
export * from './sap-recon'
