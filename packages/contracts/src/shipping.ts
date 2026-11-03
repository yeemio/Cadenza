import type { DecimalString } from './decimal'
import type { PageResult } from './pagination'

/**
 * shipping 域公开线合同（L1-P1-SERVER / T14 分段装箱/发运——P1 最后一个业务块）。
 *
 * 依据：规则底稿 architecture/contracts/prep/p1/04-supply-chain-rules-T08T12T13T14.md §A-T14；
 * 冻结合同 architecture/contracts/frozen/p1/interfaces.md（IF-04 DC 分段/组成、IF-05 发货单 PL、
 * IF-06 实发轴同步四态、IF-07 发货状态同步、IF-00.4/00.5/00.6 通用出站规则）。
 * - 数量/段长字段一律 DecimalString（IT-07 口径随行：十进制定点、≤4 位小数，禁 number）；
 * - 本文件为独立新文件（不并入 index.ts：L0 整合步统一注册导出）。
 */

// ---------------- 状态字典值 ----------------

/** PL 状态机（A-T14-1：待装箱→待出库→已出库；外部下发禁手工新增）。 */
export type PlStatusValue = 'pending_packing' | 'ready_to_ship' | 'shipped'

/** PL 行状态（A-T14-3：行扫满→已装箱；删码不满足退回待装箱）。 */
export type PlLineStatusValue = 'pending_packing' | 'packed'

/** 备货三类行（A-T14-3：托盘行/有轴单品/无轴单品）。 */
export type ShipmentLineKindValue = 'pallet' | 'axis_item' | 'plain_item'

/** IF-06 实发轴同步四态（无需同步不是失败态）。 */
export type ActualAxisSyncStatusValue = 'pending' | 'synced' | 'sync_failed' | 'noop_needed'

/** IF-07 发货状态同步独立三态。 */
export type ShippingStatusSyncStatusValue = 'pending' | 'synced' | 'sync_failed'

/** 打包任务状态（A-T14-4：待打包→已绑定；已打包托码库位只读）。 */
export type PackingStatusValue = 'pending' | 'bound' | 'cancelled'

/** 扫码记录种类（A-T14-3 装入 / A-T14-5 补码）。 */
export type ScanKindValue = 'load' | 'supplement'

/** DC 分段/组成同步状态（IF-04 三态：received=已接收、missing=需校验销售订单类型下无组成数据、failed=同步失败可重试）。 */
export type DcCompositionSyncStatusValue = 'received' | 'missing' | 'failed'

// ---------------- 查询侧 DTO ----------------

/** 备货行视图（A-T14-3 三类行 + 打包绑定 + 回传快照列）。 */
export interface ShipmentLineDto {
  lineId: string
  lineNo: number
  lineKind: ShipmentLineKindValue
  materialId: string | null
  materialCode: string
  salesOrderLineNo: string
  customerAxisNo: string | null
  standardSegmentLength: DecimalString | null
  actualSegmentLength: DecimalString | null
  segmentLength: DecimalString | null
  requiredCount: number
  scannedCount: number
  lineStatus: PlLineStatusValue
  packingStatus: PackingStatusValue | null
  packingOrderId: string | null
}

/** PL 视图（A-T14-1/8：状态机 + 出库回传双状态列独立）。 */
export interface ShipmentOrderDto {
  orderId: string
  plNo: string
  salesOrderNo: string
  customerName: string | null
  status: PlStatusValue
  statusLabel: string
  compositionMissing: boolean
  outboundBy: string | null
  outboundAt: string | null
  actualAxisSyncStatus: ActualAxisSyncStatusValue
  actualAxisSyncStatusLabel: string
  shippingStatusSyncStatus: ShippingStatusSyncStatusValue
  shippingStatusSyncStatusLabel: string
  plantId: string
}

export type ShipmentOrderPage = PageResult<ShipmentOrderDto>

/** 扫码记录视图（A-T14-3/5：装入+补码；删码标记留痕）。 */
export interface PackingScanDto {
  scanId: string
  shipmentOrderId: string
  shipmentLineId: string
  lineNo: number
  scanKind: ScanKindValue
  inventoryUnitId: string | null
  unitNo: string
  customerAxisNo: string | null
  actualSegmentLength: DecimalString | null
  scannedBy: string
  scannedAt: string
  deleted: boolean
  deletedBy: string | null
  deletedAt: string | null
}

/** 打包任务视图（A-T14-4：托码+调入库位+逐行扫满+绑定托码）。 */
export interface PackingOrderDto {
  packingId: string
  packingNo: string
  shipmentOrderId: string
  plNo: string | null
  palletCode: string
  toLocationId: string
  toLocationCode: string
  status: PackingStatusValue
  statusLabel: string
  boundBy: string | null
  boundAt: string | null
  lines: Array<{
    lineId: string
    lineNo: number
    materialCode: string
    requiredCount: number
    scannedCount: number
    lineStatus: PlLineStatusValue
  }>
  plantId: string
}

export type PackingOrderPage = PageResult<Omit<PackingOrderDto, 'lines'>>

/** DC 分段/组成视图（IF-04：dcId+销售订单号+行号幂等；缺组成数据标记）。 */
export interface DcCompositionDto {
  id: string
  dcId: string
  salesOrderNo: string
  lineNo: number
  syncStatus: DcCompositionSyncStatusValue
  composition: Record<string, unknown> | null
  missingMarkedAt: string | null
  plantId: string
}

// ---------------- 命令载荷 ----------------

/** shipping.dc-composition.inbound：DC 分段/组成模拟入站（IF-04；缺组成数据→missing 标记）。 */
export interface DcCompositionInboundPayload {
  operationId?: string
  plantId: string
  dcId: string
  salesOrderNo: string
  lineNo: number
  /** 组成数据（段长/分段数量/轴具尺寸类型/红码或托盘/包装方案/虚拟轴号/包装日期时间）；缺省=无组成数据 */
  composition?: Record<string, unknown> | null
  reason?: string
}

/** shipping.pl.inbound：PL 模拟入站（IF-05：发货单号幂等；外部下发禁手工新增）。 */
export interface PlInboundPayload {
  operationId?: string
  plantId: string
  plNo: string
  salesOrderNo: string
  customerName?: string
  externalRevision?: number
  lines: Array<{
    lineNo: number
    lineKind: ShipmentLineKindValue
    materialId?: string
    materialCode: string
    salesOrderLineNo: string
    customerAxisNo?: string
    standardSegmentLength?: DecimalString
    segmentLength?: DecimalString
    requiredCount?: number
  }>
  reason?: string
}

/** shipping.packing.create：打包任务创建（A-T14-4：先扫托码+选调入库位）。 */
export interface PackingCreatePayload {
  operationId?: string
  plantId: string
  shipmentOrderId: string
  palletCode: string
  toLocationId: string
  toLocationCode: string
  reason?: string
}

/** shipping.packing.bind：绑定托码（A-T14-4：每行已扫完+托码+库位；已打包托码库位只读）。 */
export interface PackingBindPayload {
  operationId?: string
  plantId: string
  packingOrderId: string
  reason?: string
}

/** shipping.scan.load：扫码装入（A-T14-3 五拒一成）。 */
export interface ScanLoadPayload {
  operationId?: string
  plantId: string
  shipmentOrderId: string
  lineId: string
  unitNo: string
  /** 实际段长（缺省自库存分段数据读取；显式传入时以传入为准留痕）。 */
  actualSegmentLength?: DecimalString
  reason?: string
}

/** shipping.scan.delete：删码（A-T14-3：删码不满足退回待装箱）。 */
export interface ScanDeletePayload {
  operationId?: string
  plantId: string
  shipmentOrderId: string
  scanId: string
  reason?: string
}

/** shipping.scan.supplement：补码（A-T14-5：无轴行扫码补轴号计入已扫件数，无数量输入）。 */
export interface ScanSupplementPayload {
  operationId?: string
  plantId: string
  shipmentOrderId: string
  lineId: string
  unitNo: string
  actualSegmentLength?: DecimalString
  reason?: string
}

/** shipping.ship.confirm：确认出库（A-T14-7：仅待出库；执行=已出库+出库人+完成时间+库存记已发货）。 */
export interface ShipConfirmPayload {
  operationId?: string
  plantId: string
  shipmentOrderId: string
  reason?: string
  businessTime?: string
}

/** shipping.sync.actual-axis.retry / shipping.sync.status.retry：两条回传重试（失败重试不重做已成功侧）。 */
export interface SyncRetryPayload {
  operationId?: string
  plantId: string
  shipmentOrderId: string
  /** 模拟适配器结果（P1 全部路由指向模拟适配器，GAP-B7；缺省 success）。 */
  outcome?: 'success' | 'failure'
  reason?: string
}

/** shipping.photo.attach：装箱图附件元数据（A-T14-10：仅 APP，部分失败保留已成功）。 */
export interface PhotoAttachPayload {
  operationId?: string
  plantId: string
  shipmentOrderId: string
  photos: Array<{
    fileName: string
    storageKey: string
    contentType?: string
    sizeBytes?: number
  }>
  reason?: string
}
