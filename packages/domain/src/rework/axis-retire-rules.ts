/**
 * 轴码退役（轴码清空）规则（RS-34～RS-37）——冻结合同
 * architecture/contracts/frozen/p2/rework-split.md §4。
 *
 * 纯规则面。退役状态 = 本域 axis_code_retire（0011，不改共享 inventory_unit 表结构），
 * 清空记录 = axis_retire_record（append-only 快照，RS-S6）；身份与谱系节点保留（S05）。
 */
import { ReworkRuleViolation } from './errors'

/** 退役候选码事实（RS-34 前置由装配方折叠）。 */
export interface AxisRetireCandidateFacts {
  unitNo: string
  /** 码类型为产品轴码（已扫出有效产品轴号） */
  isProductAxisCode: boolean
  /** 轴码质检已完成 */
  qualityCompleted: boolean
  /** 关联报工已审核 */
  reportReviewed: boolean
  /** 中转轴上不存在未审核的成品轴信息（存在未审核 → 拒绝；GAP-F6） */
  transitAxisPending: boolean
  /** 已入成品仓在库（true = 不可清空） */
  inFinishedGoodsStock: boolean
}

/**
 * RS-34 可执行前置：已扫出有效产品轴号（码类型为产品轴码）且至少勾选一条；
 * 轴码质检已完成、关联报工已审核、中转轴无未审核成品轴信息、未入成品仓在库。
 */
export function assertAxisRetireCandidateExecutable(f: AxisRetireCandidateFacts): void {
  if (!f.isProductAxisCode) {
    throw new ReworkRuleViolation('RS-34', '只能清空产品轴码（已扫出有效产品轴号）')
  }
  if (!f.qualityCompleted) {
    throw new ReworkRuleViolation('RS-34', '轴码质检未完成，不可清空')
  }
  if (!f.reportReviewed) {
    throw new ReworkRuleViolation('RS-34', '关联报工未审核，不可清空')
  }
  if (f.transitAxisPending) {
    throw new ReworkRuleViolation('RS-34', '中转轴存在未审核的成品轴信息，不可清空')
  }
  if (f.inFinishedGoodsStock) {
    throw new ReworkRuleViolation('RS-34', '已入成品仓在库的码不可清空')
  }
}

/** RS-34：至少勾选一条。 */
export function assertAxisRetireSelectionNonEmpty(selectedCount: number): void {
  if (selectedCount < 1) {
    throw new ReworkRuleViolation('RS-34', '至少勾选一条轴码后方可清空')
  }
}

/**
 * RS-36 退役码命令语义（[合同新造]）：退役码在全部库存命令入口显式拒绝
 * （可解释提示"已退役"），正向/反向追溯查询可查。保留字段范围与专门查询入口 → GAP-F3。
 */
export function assertUnitNotRetired(isRetired: boolean, unitNo: string): void {
  if (isRetired) {
    throw new ReworkRuleViolation('RS-36', `轴码 ${unitNo} 已退役，不能执行库存命令（追溯查询可查）`)
  }
}

/** RS-35 清空记录快照（RS-S6 字段集；主事务内一次写入，RS-37）。 */
export interface AxisRetireRecordInput {
  unitId: string
  unitNo: string
  qtyBefore: string
  productionDept: string | null
  productionOrderNo: string | null
  salesOrderNo: string | null
  lineNo: string | null
  materialId: string
  materialCode: string
  processName: string | null
  reportBy: string | null
  reportAt: string | null
  retiredBy: string
  retiredAt: string
}
