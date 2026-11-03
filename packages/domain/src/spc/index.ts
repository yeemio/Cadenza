/**
 * spc 域 barrel（工艺变更影响控制 / SPC 规则集与控制限 / 计量校准 / 工具寿命）。
 * 冻结合同：architecture/contracts/frozen/p3/process-change-spc-calibration.md
 * （PE-01～PE-21 业务规则 + PE-S1～PE-S5 表级约束）。
 *
 * 注意（L0-整合标记）：本目录**未并入 packages/domain/src/index.ts**（共享文件，
 * 并行线不自改）——跨包消费方暂以 dist 相对导入（先例 shipping 整合前模式）；
 * L0 整合步在 domain index 追加 `export * from './spc'` 后改包名导入。
 */
export * from './errors'
export * from './permissions'
export * from './quantity'
export * from './change-rules'
export * from './spc-rules'
export * from './calibration-rules'
export * from './tool-rules'
