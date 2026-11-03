/**
 * disposition 域（T18 质量处置：返工/报废/证书/客诉召回处置链）公开出口。
 * 依据冻结合同 architecture/contracts/frozen/p2/quality-disposition.md（QD-01～QD-25 + QD-S1～S5）。
 * 本文件为独立新文件（不并入 domain/src/index.ts：L0 整合步统一注册导出——零共享文件）。
 */
export * from './errors'
export * from './decimal-util'
export * from './permissions'
export * from './suspect-rules'
export * from './defect-rules'
export * from './purchase-inspection-rules'
export * from './disposition-rules'
