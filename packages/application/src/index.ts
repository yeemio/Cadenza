/**
 * application 层（扁平布局：eslint 包边界规则禁止上级相对导入 '../..'，见根 eslint.config.mjs）。
 * 端口：command-bus / unit-of-work / repositories；
 * 服务：password / login / session-verifier；
 * 用例：org-handlers（命令处理器）/ org-queries（查询服务）。
 */
export * from './command-bus'
export * from './unit-of-work'
export * from './repositories'
export * from './password'
export * from './login'
export * from './session-verifier'
export * from './org-handlers'
export * from './org-queries'
export * from './masterdata-repositories'
export * from './masterdata-handlers'
export * from './masterdata-queries'
export * from './inventory-repositories'
export * from './inventory-posting'
export * from './inventory-handlers'
export * from './inventory-queries'
export * from './process-repositories'
export { createProcessCommandHandlers } from './process-handlers'
export * from './process-queries'
export * from './purchase-repositories'
export * from './purchase-handlers'
export * from './purchase-queries'
export * from './scheduling-repositories'
export * from './scheduling-handlers'
export * from './scheduling-queries'
export * from './execution-repositories'
export * from './execution-handlers'
export * from './execution-queries'
export * from './quality-repositories'
export * from './quality-handlers'
export * from './quality-queries'
export * from './warehousing-repositories'
export * from './warehousing-handlers'
export * from './warehousing-queries'
export * from './shipping-repositories'
export * from './shipping-handlers'
export * from './shipping-queries'
// L0 整合步（P3 批次 2026-10-28）：OT 采集/约束排程外协/SPC 校准/能源成本
export * from './ot-repositories'
export * from './ot-handlers'
export * from './ot-queries'
export * from './csw-repositories'
export * from './csw-posting'
export * from './csw-handlers'
export * from './csw-queries'
export * from './spc-repositories'
export * from './spc-handlers'
export * from './spc-queries'
export * from './cost-repositories'
export * from './cost-handlers'
export * from './cost-queries'
// L0 整合步（P2/P4 批次 2026-10-28）：P2 六域 + AI 问数
export * from './rework-repositories'
export * from './rework-handlers'
export * from './rework-queries'
export * from './conversion-repositories'
export * from './conversion-handlers'
export * from './conversion-queries'
export * from './reverse-repositories'
export * from './reverse-handlers'
export * from './reverse-queries'
export * from './disposition-repositories'
export * from './disposition-handlers'
export * from './disposition-queries'
export * from './maintenance-repositories'
export * from './maintenance-handlers'
export * from './maintenance-queries'
export * from './reporting-repositories'
export * from './reporting-handlers'
export * from './reporting-queries'
export * from './aiquery-repositories'
export * from './aiquery-service'
// L0 整合步（Wave5）桶冲突显名消解（TS2308）：OrderSchedulingStatus 由
// scheduling-repositories 声明、scheduling-queries 自 domain 转出——同名两源；
// 显名再导出优先于 export *，以 repositories 定义为准。
export type { OrderSchedulingStatus } from './scheduling-repositories'
// L0 整合步（P2/P4 批次 2026-10-28）桶冲突显名消解（TS2308）：
// - ProductionOrderView：process-queries（Omit<ProductionOrderRecord,...> 既有口径）与
//   conversion-repositories（转换前后锚点投影）同名不同形——process 版胜出，
//   conversion 版以别名 ConversionProductionOrderView 导出（persistence conversion 消费别名）；
// - InspectionRecordRow/NewInspectionRecord：purchase-repositories（既有 0006 检验记录面）与
//   disposition-repositories（QD-13 检验链，含 re_inspection 结论版本链）同名不同形——
//   purchase 版胜出，disposition 版以别名 DispectionInspectionRecordRow 前缀导出
//   （persistence disposition 消费别名）。
export type { ProductionOrderView } from './process-queries'
export type { ProductionOrderView as ConversionProductionOrderView } from './conversion-repositories'
export type { InspectionRecordRow, NewInspectionRecord } from './purchase-repositories'
export type {
  InspectionRecordRow as DispositionInspectionRecordRow,
  NewInspectionRecord as NewDispositionInspectionRecord,
} from './disposition-repositories'
// IF-01 料品入站（集成块；MD-01 业务面仍无料品写命令）
export * from './integration-material-repositories'
export * from './integration-material-handlers'
// G 场景：集团分配修订 + 缺料/齐套专用 API
export * from './group-repositories'
export * from './group-handlers'
export * from './group-queries'

export * from './production-repositories'
export * from './production-handlers'
export * from './production-queries'
export * from './scan-block-repositories'
export * from './scan-block-handlers'
export * from './scan-block-queries'
export * from './sap-sim-repositories'
export * from './sap-sim-service'
export * from './sap-sim-engine-repositories'
export * from './sap-sim-engine-service'
export * from './sap-recon-handlers'
export * from './sap-recon-queries'
export * from './sap-recon-repositories'
export * from './sap-recon-derivation'
