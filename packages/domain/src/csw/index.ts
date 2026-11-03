/**
 * csw 域（受约束排程与外协，T22）——冻结合同 architecture/contracts/frozen/p3/
 * constrained-scheduling.md（CS-01～CS-27 + CS-S1～CS-S5）。
 *
 * 本目录自包含（根 eslint 边界规则限定 domain 包内文件不得以相对路径逃逸出本包）：
 * 承接基线 CS-01～CS-03 属 P1 T09 已冻结行为（scheduling 域），本域只做 G4 增量
 * （有限能力约束、冻结、换型、插单/重排、外协、交期权重），不重写槽位模型。
 *
 * 注意：本文件未加入 domain/src/index.ts 导出（共享文件不可改，L0 整合步统一导出
 * `export * from './csw'`）；application 以 dist 相对导入消费（[L0-整合标记]）。
 */
export * from './errors'
export * from './permissions'
export * from './shared'
export * from './constraint-rules'
export * from './freeze-rules'
export * from './changeover-rules'
export * from './reschedule-rules'
export * from './outsourcing-rules'
