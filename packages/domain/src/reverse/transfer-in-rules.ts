// 包内上级目录相对导入（domain/src/reverse → domain/src/inventory）：未逃逸出 domain 包，
// 边界规则对包内子目录场景过宽（同 reporting/metric-rules.ts、trace/genealogy.ts 先例）；单行豁免留痕。
// eslint-disable-next-line no-restricted-imports
import { cmpQty } from '../inventory/quantity'
import { ReverseRuleViolation } from './errors'

/**
 * 调拨入库与跨厂签收纯规则 —— 冻结合同 frozen/p2/warehouse-reverse.md §3（WR-14～WR-17；
 * 原件 调拨入库/调拨入库.md；PI S06；MP-09/MP-11 语义一致）。跨厂/需交接场景必须记录
 * 独立接收事实（接收方扫码上架/签收），不以调出方填库位冒充目标方签收。
 */

/** 入库方式（WR-14：固定库位单生成即已完成〔仅限厂内即时转仓〕；跨厂/需交接走扫码上架）。 */
export const TRANSFER_IN_MODES = ['fixed_location', 'scan_putaway'] as const
export type TransferInMode = (typeof TRANSFER_IN_MODES)[number]

export const TRANSFER_IN_MODE_LABELS: Readonly<Record<TransferInMode, string>> = {
  fixed_location: '固定库位（厂内即时转仓）',
  scan_putaway: '扫码上架（需交接/跨厂）',
}

/** 调拨入库单状态（WR-16/17：待入库→入库中→已完成；删码删空回待入库）。 */
export const TRANSFER_IN_STATUSES = ['pending_in', 'inbounding', 'completed'] as const
export type TransferInStatus = (typeof TRANSFER_IN_STATUSES)[number]

export const TRANSFER_IN_STATUS_LABELS: Readonly<Record<TransferInStatus, string>> = {
  pending_in: '待入库',
  inbounding: '入库中',
  completed: '已完成',
}

/** 码入库状态列（WR-S3）。 */
export const TRANSFER_IN_LINE_STATUSES = ['pending', 'inbound'] as const
export type TransferInLineStatus = (typeof TRANSFER_IN_LINE_STATUSES)[number]

/**
 * WR-14：跨厂签收判定——固定库位单（出库已选库位）生成即已完成的路径**仅限厂内即时转仓**；
 * 跨厂（调出/调入仓库分属不同工厂）必须生成待入库单走接收方扫码上架/签收，记录独立接收事实。
 */
export function isSamePlantImmediateTransfer(fromPlantId: string, toPlantId: string): boolean {
  return fromPlantId === toPlantId
}

/** WR-14：跨厂时禁止以固定库位完成单冒充签收（守卫：跨厂必须走独立接收事实）。 */
export function assertCrossPlantNeedsIndependentReceipt(input: {
  fromPlantId: string
  toPlantId: string
  orderNo: string
}): void {
  if (input.fromPlantId !== input.toPlantId) {
    throw new ReverseRuleViolation(
      'WR-14',
      `调拨 ${input.orderNo}为跨厂调拨（${input.fromPlantId} → ${input.toPlantId}）：必须记录独立接收事实（接收方扫码上架/签收），不以调出方填库位冒充目标方签收（S06）`,
    )
  }
}

/**
 * WR-15：上架库位输入——调入仓库为仓库（WAREHOUSE）时须选库位，提交库位=库位编码或
 * 「货架编码+两位层数」（6 位数字拼位码）；线边仓直接上架不选。
 */
export function assertPutawayLocationInput(input: {
  orderNo: string
  toWarehouseKind: string
  locationCode: string | undefined
}): void {
  if (input.toWarehouseKind === 'LINE_SIDE') return // 线边仓直接上架不选
  if (input.locationCode === undefined || input.locationCode === '') {
    throw new ReverseRuleViolation(
      'WR-15',
      `调拨入库 ${input.orderNo}的调入仓库为仓库类型：须选择库位（库位编码或货架编码+两位层数）`,
    )
  }
}

/** WR-15：上架库位编码形态——库位编码（≥4 位）或货架编码+两位层数（6 位数字：货架 2+区域 2+层 2）。 */
export function isPutawayLocationCodeShape(code: string): boolean {
  return /^[0-9]{6}$/.test(code) || code.length >= 4
}

/** 扫码上架校验事实（WR-15）。 */
export interface PutawayScanFacts {
  unitNo: string
  /** 码不在本单 */
  notInOrder: boolean
  /** 码已入库（本单内） */
  alreadyInboundInOrder: boolean
  /** 托下单码：未按托扫（托下单码须扫托） */
  palletChildWithoutPalletScan: boolean
  /** 码已在库（IT-13 在库拒绝——在途码才可上架） */
  alreadyInStock: boolean
  /** 调入仓库已锁定 */
  toWarehouseLocked: boolean
}

/** WR-15：扫码上架校验（任一命中拒绝）。 */
export function assertPutawayScanAcceptable(facts: PutawayScanFacts): void {
  if (facts.notInOrder) {
    throw new ReverseRuleViolation('WR-15', `单元 ${facts.unitNo}不在本调拨入库单，拒绝上架`)
  }
  if (facts.alreadyInboundInOrder) {
    throw new ReverseRuleViolation('WR-15', `单元 ${facts.unitNo}在本单已入库，不可重复上架`)
  }
  if (facts.palletChildWithoutPalletScan) {
    throw new ReverseRuleViolation('WR-15', `单元 ${facts.unitNo}为托下单码：托下单码须扫托（整托上架），拒绝单品上架`)
  }
  if (facts.alreadyInStock) {
    throw new ReverseRuleViolation('WR-15', `单元 ${facts.unitNo}已在库，拒绝上架`)
  }
  if (facts.toWarehouseLocked) {
    throw new ReverseRuleViolation('WR-15', '调入仓库已锁定，拒绝上架')
  }
}

/** WR-16：扫码删除——该码（托码连同托下码）退回未入库；本单已无已入库码时状态回待入库。 */
export function assertInboundScanRemovable(input: { unitNo: string; lineStatus: string }): void {
  if (input.lineStatus !== 'inbound') {
    throw new ReverseRuleViolation('WR-16', `单元 ${input.unitNo}未处于已入库状态，无可删除的上架记录`)
  }
}

/** WR-16：删码后单据状态重推——已无已入库码 → 回待入库。 */
export function inboundStatusAfterRemoval(inboundLineCount: number): TransferInStatus {
  return inboundLineCount === 0 ? 'pending_in' : 'inbounding'
}

/** 入库行事实（WR-17 完成条件）。 */
export interface InboundLineFacts {
  materialCode: string
  /** Remaining unreceived quantity, never the original required total. */
  pendingQty: string
  inboundQty: string
}

/**
 * WR-17：整单完成须每料品剩余未收数量为零、至少一码已入库。
 * （整码口径下＝全部码行 inbound；按料品聚合断言以贴合原文口径。）
 */
export function assertInboundCompletable(input: {
  orderNo: string
  lines: readonly InboundLineFacts[]
  toWarehouseLocked: boolean
}): void {
  if (input.toWarehouseLocked) {
    throw new ReverseRuleViolation('WR-17', '调入仓库已锁定，不可完成入库')
  }
  if (input.lines.length === 0) {
    throw new ReverseRuleViolation('WR-17', `调拨入库单 ${input.orderNo}无码行，不可完成入库`)
  }
  const inboundTotal = input.lines.filter((l) => cmpQty(l.inboundQty, '0.0000') > 0)
  if (inboundTotal.length === 0) {
    throw new ReverseRuleViolation('WR-17', `调拨入库单 ${input.orderNo}至少须一码已入库，才可完成入库`)
  }
  for (const line of input.lines) {
    if (cmpQty(line.pendingQty, '0.0000') !== 0 || cmpQty(line.inboundQty, '0.0000') <= 0) {
      throw new ReverseRuleViolation(
        'WR-17',
        `料品 ${line.materialCode}仍有待入库数量（${line.pendingQty}）或没有实收（${line.inboundQty}），不可完成整单入库`,
      )
    }
  }
}
