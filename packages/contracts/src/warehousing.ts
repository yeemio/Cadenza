import type { DecimalString } from './decimal'
import type { PageResult } from './pagination'

/**
 * warehousing 域公开线合同（L1-P1-SERVER / T13 入库/移库/调拨）。
 *
 * 依据：规则底稿 architecture/contracts/prep/p1/04-supply-chain-rules-T08T12T13T14.md §A-T13；
 * 冻结合同 architecture/contracts/frozen/p1/inventory-trace-core.md（IT-25 两段原子、
 * IT-23 作业预留、IT-19 流水幂等）。
 * - 数量字段一律 DecimalString（IT-07 口径随行：十进制定点、≤4 位小数，禁 number）；
 * - 本文件为独立新文件（不并入 index.ts：L0 整合步统一注册导出）。
 */

// ---------------- 状态字典值 ----------------

/** 待入库任务状态（A-T13-1：报工/成品质检异步写入台账，禁手工增删改）。 */
export type PutawayTaskStatusValue = 'pending' | 'done' | 'cancelled'

/** 调拨状态机（A-T13-10：草稿→待执行→出库中→已出库在途→收货中→完成）。 */
export type TransferStatusValue =
  | 'draft'
  | 'ready'
  | 'shipping'
  | 'shipped_in_transit'
  | 'receiving'
  | 'completed'
  | 'cancelled'

/** 调拨种类（A-T13-5：生产调拨/仓库调拨/自动生成）。 */
export type TransferKindValue = 'production' | 'warehouse' | 'auto'

// ---------------- 查询侧 DTO ----------------

/** 待入库任务视图（A-T13-1）。 */
export interface PutawayTaskDto {
  taskId: string
  sourceType: 'work_report' | 'finished_inspection'
  sourceRef: string
  unitNo: string | null
  palletCode: string | null
  materialId: string
  materialCode: string
  quantity: DecimalString
  uomCode: string
  status: PutawayTaskStatusValue
  statusLabel: string
  inventoryUnitId: string | null
  locationCode: string | null
  putawayBy: string | null
  putawayAt: string | null
  plantId: string
}

export type PutawayTaskPage = PageResult<PutawayTaskDto>

/** 移库记录视图（A-T13-4：原/现库位逐码，append-only）。 */
export interface WarehouseMoveDto {
  moveId: string
  inventoryUnitId: string
  unitNo: string
  fromLocationCode: string | null
  toLocationCode: string | null
  quantity: DecimalString
  uomCode: string
  movedBy: string
  movedAt: string
  reason: string | null
  plantId: string
}

export type WarehouseMovePage = PageResult<WarehouseMoveDto>

/** 调拨行视图（A-T13-10：两段事实 out_qty/in_qty + 锁定预留引用）。 */
export interface TransferLineDto {
  lineId: string
  lineNo: number
  inventoryUnitId: string
  unitNo: string
  materialCode: string | null
  quantity: DecimalString
  outQty: DecimalString
  inQty: DecimalString
  reservationId: string | null
  outDone: boolean
  inDone: boolean
}

/** 调拨单视图（A-T13-6/10：仓库规则 + 状态机）。 */
export interface TransferOrderDto {
  orderId: string
  orderNo: string
  transferKind: TransferKindValue
  fromWarehouseId: string
  toWarehouseId: string
  fromWarehouseCode: string | null
  toWarehouseCode: string | null
  status: TransferStatusValue
  statusLabel: string
  transitLocationCode: string | null
  lockedValidUntil: string | null
  lines: TransferLineDto[]
  plantId: string
}

export type TransferOrderPage = PageResult<Omit<TransferOrderDto, 'lines'>>

// ---------------- 命令载荷 ----------------

/** warehousing.putaway.refresh：入库任务刷新（从 ExecutionEventPort 重跑；台账禁手工增删改）。 */
export interface PutawayRefreshPayload {
  operationId?: string
  plantId: string
  eventTypes?: string[]
  reason?: string
}

/** warehousing.putaway.confirm：组单确认入库（任务台账/组单两入口共用；调 inventory 记账）。 */
export interface PutawayConfirmPayload {
  operationId?: string
  plantId: string
  /** 任务台账入口：逐任务确认（与 taskIds 二选一或并用） */
  taskIds?: string[]
  /** 组单入口：按本机暂存组单（条码/轴号清单）；未确认任务不落库 */
  unitNos?: string[]
  /** 托码（A-T13-2：托码确认=整托，同托全部未入库任务一并完成） */
  palletCode?: string
  toWarehouseId: string
  toWarehouseCode?: string
  /** 仓库类型事实（0003 两值字典外的物流仓/成品仓由载荷提供，GAP 登记） */
  toWarehouseKind?: string
  toLocationId: string
  toLocationCode: string
  ownerId: string
  ownerName: string
  reason?: string
  businessTime?: string
}

/** warehousing.move.execute：移库（同仓内库位移动；原/现库位逐码记录）。 */
export interface MoveExecutePayload {
  operationId?: string
  plantId: string
  unitId: string
  fromLocationId?: string
  toLocationId: string
  toLocationCode: string
  quantity?: DecimalString
  reason?: string
  businessTime?: string
}

/** warehousing.transfer.create：创建调拨单（草稿；行=单元+数量）。 */
export interface TransferCreatePayload {
  operationId?: string
  plantId: string
  transferKind: 'production' | 'warehouse' | 'auto'
  fromWarehouseId: string
  toWarehouseId: string
  fromWarehouseKind?: string
  toWarehouseKind?: string
  transitLocationId: string
  transitLocationCode: string
  lines: Array<{
    unitId: string
    unitNo: string
    quantity: DecimalString
    materialId?: string
    materialCode?: string
    materialType?: number
  }>
  note?: string
  reason?: string
  businessTime?: string
}

/** warehousing.transfer.submit：草稿→待执行（仓库规则校验+逐行锁定=作业预留）。 */
export interface TransferSubmitPayload {
  operationId?: string
  transferOrderId: string
  /** 锁定（作业预留）有效期：必填（A-T13-11/IT-23；过期后旧提交重校验） */
  lockValidUntil: string
  reason?: string
  businessTime?: string
}

/** warehousing.transfer.ship：调拨出库段（单行原子：来源减+在途增，两段事务）。 */
export interface TransferShipPayload {
  operationId?: string
  transferOrderId: string
  lineId: string
  /** 本次调出量（缺省=行计划量；部分调出原码回写剩余并解锁） */
  quantity?: DecimalString
  reason?: string
  businessTime?: string
}

/** warehousing.transfer.transit：在途段（状态推进+对账断言：在途两仓不重复统计；幂等）。 */
export interface TransferTransitPayload {
  operationId?: string
  transferOrderId: string
  reason?: string
  businessTime?: string
}

/** warehousing.transfer.receive：调拨接收段（单行原子：在途减+目的增；全部行收完→完成）。 */
export interface TransferReceivePayload {
  operationId?: string
  transferOrderId: string
  lineId: string
  quantity?: DecimalString
  toLocationId?: string
  toLocationCode?: string
  reason?: string
  businessTime?: string
}
