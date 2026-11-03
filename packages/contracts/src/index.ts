export * from './decimal'
export * from './command'
export * from './errors'
export * from './pagination'
export * from './auth'
export * from './masterdata'
export * from './inventory'
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
// L0 整合步（P2/P4 批次 2026-10-28）：P2 六域 + AI 问数
export * from './rework'
export * from './conversion'
export * from './reverse'
export * from './disposition'
export * from './maintenance'
export * from './reporting'
export * from './aiquery'
// L0 整合步（Wave5）桶冲突显名消解（TS2308）：masterdata 与 scheduling 各自声明同形
// EquipmentStatusDtoValue；显名再导出优先于 export *，既有 masterdata 口径不变。
export type { EquipmentStatusDtoValue } from './masterdata'
// L0 整合步（P2/P4 批次 2026-10-28）桶冲突显名消解（TS2308）：
// - BatchInspectionStatusValue：purchase 与 disposition 同形（6 值联合一致）——purchase 版胜出；
// - EquipmentStatusLogDto：masterdata（occurredAt/source:string）与 maintenance
//   （createdAt/source:'WEB'|'PDA'）同名不同形——masterdata 版胜出（UI status-logs 端点消费方），
//   maintenance 版仅在其 contracts/maintenance.ts 文件内局部使用。
export type { BatchInspectionStatusValue } from './purchase'
export type { EquipmentStatusLogDto } from './masterdata'
