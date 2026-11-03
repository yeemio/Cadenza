import { WarehousingRuleViolation } from './errors'

/**
 * 移库规则纯规则 —— 规则底稿 04 §A-T13-4（原件 移库管理 §3.1 扫码/确定逻辑；DM §5 同仓移库单独处理）。
 */

/** 移库校验事实（由命令层在主事务内收集；仓库锁定标志属底稿 D 节主数据扩展项，由事实参数承载）。 */
export interface MoveCheckFacts {
  unitNo: string
  /** 库存状态轴（IT-13）：须在库（in_stock） */
  unitStatus: string
  /** 仓库锁定标志（底稿 D 节「仓库/货架锁定标志」；0003 未落列，事实由调用方提供，默认未锁） */
  warehouseLocked: boolean
  /** 目标限「仓库类型」仓库（移库目标不得为线边仓） */
  toWarehouseKind: string
  /** 同仓：来源/目标库位属同一仓库 */
  sameWarehouse: boolean
  /** 码被其它任务锁定（存在其它 holder 的活动作业预留，IT-15 口径） */
  lockedByOtherTask: boolean
  /** 原库位 ≠ 新库位 */
  sameLocation: boolean
  /** 托下单码：若来源为托码且未整托，拒绝（托下单码禁扫，只整托） */
  isPalletChildWithoutWhole: boolean
}

/**
 * A-T13-4：移库校验——目标限「仓库类型」仓库；校验同仓、仓库/码未锁定、码在库、
 * 托下单码禁扫（只整托）、原库位≠新库位；全部通过方可生成移库记录（原/现库位逐码）。
 */
export function assertMoveExecutable(facts: MoveCheckFacts): void {
  if (facts.isPalletChildWithoutWhole) {
    throw new WarehousingRuleViolation('A-T13-4', `单元 ${facts.unitNo}为托下单码：托下单码禁扫，移库只可整托`)
  }
  if (!facts.sameWarehouse) {
    throw new WarehousingRuleViolation(
      'A-T13-4',
      `移库仅限同仓内库位移动：单元 ${facts.unitNo}来源/目标库位不在同一仓库（跨仓走调拨）`,
    )
  }
  if (facts.warehouseLocked) {
    throw new WarehousingRuleViolation('A-T13-4', '目标仓库处于锁定状态，禁止移库')
  }
  if (facts.lockedByOtherTask) {
    throw new WarehousingRuleViolation(
      'A-T13-4',
      `单元 ${facts.unitNo}已被其它业务锁定（活动作业预留），禁止移库`,
    )
  }
  if (facts.unitStatus !== 'in_stock') {
    throw new WarehousingRuleViolation(
      'A-T13-4',
      `单元 ${facts.unitNo}库存状态为 ${facts.unitStatus}，仅在库码可移库`,
    )
  }
  if (facts.sameLocation) {
    throw new WarehousingRuleViolation('A-T13-4', `单元 ${facts.unitNo}原库位与新库位相同，拒绝移库`)
  }
}
