import { WarehousingRuleViolation } from './errors'

/**
 * 上架规则纯规则 —— 规则底稿 04 §A-T13-1/2（原件 入库管理 §1.2/§2.1/§3.1、调拨入库 §3.2）。
 */

/**
 * 仓库类型字典（底稿 D 节：仓库/线边仓/物流仓/成品仓）。
 * 注意：0003 masterdata 冻结字典为两值（WAREHOUSE/LINE_SIDE，MD-23）；物流仓/成品仓属
 * 底稿 D 节仓储主数据扩展项，本域以字符串参数化承载（命令层由载荷/主数据查询提供事实），
 * L0/主数据域扩展枚举后直连（GAP 登记，不改 0003）。
 */
export const WAREHOUSE_KINDS = ['WAREHOUSE', 'LINE_SIDE', 'LOGISTICS', 'FINISHED'] as const
export type WarehouseKind = (typeof WAREHOUSE_KINDS)[number]

export const WAREHOUSE_KIND_LABELS: Readonly<Record<WarehouseKind, string>> = {
  WAREHOUSE: '仓库',
  LINE_SIDE: '线边仓',
  LOGISTICS: '物流仓',
  FINISHED: '成品仓',
}

/**
 * A-T13-2：上架目标仓库 = 成品类实体物流仓（物流仓/成品仓）。
 * 成品入库目标限物流仓类仓库；逻辑库（LOGICAL）隐藏库位不可作上架目标（不在字典内即拒）。
 */
export const FINISHED_PUTAWAY_WAREHOUSE_KINDS: readonly WarehouseKind[] = ['LOGISTICS', 'FINISHED']

/** 料品类型（MD 域 MATERIAL_TYPE 同值：1=原料 2=半成品 3=成品）。 */
export const MATERIAL_TYPE_FINISHED = 3

/** A-T13-2：上架目标仓库校验（成品类实体物流仓）。 */
export function assertPutawayTargetWarehouse(input: {
  warehouseKind: string
  materialType: number | null
  warehouseId?: string
}): void {
  if (!FINISHED_PUTAWAY_WAREHOUSE_KINDS.includes(input.warehouseKind as WarehouseKind)) {
    throw new WarehousingRuleViolation(
      'A-T13-2',
      `上架目标必须为成品类实体物流仓（物流仓/成品仓）：仓库 ${input.warehouseId ?? ''}类型为 ${input.warehouseKind}`,
    )
  }
  if (input.materialType !== null && input.materialType !== MATERIAL_TYPE_FINISHED) {
    throw new WarehousingRuleViolation(
      'A-T13-2',
      `成品上架的料品类型须为成品（3）：当前 ${input.materialType}`,
    )
  }
}

/**
 * A-T13-2：货架库位 = 货架码 + 层拼位（6 位：货架编号 2 + 区域序号 2 + 层号 2，如 020303）。
 * （MD-31 同构：buildRackLocationCode；本域独立断言避免跨目录引用。）
 */
export function isRackLocationCode(code: string): boolean {
  return /^[0-9]{6}$/.test(code)
}

/** A-T13-2：货架码（8 位说法对应普通库位前缀口径；货架库位为 6 位拼位码）。 */
export function assertRackPutawayLocation(code: string, locationId?: string): void {
  if (!isRackLocationCode(code)) {
    throw new WarehousingRuleViolation(
      'A-T13-2',
      `上架库位必须为货架码+层拼位（6 位数字：货架 2 位+区域 2 位+层 2 位，如 020303）：库位 ${locationId ?? ''}编码 ${code}`,
    )
  }
}

/**
 * A-T13-2：托码确认 = 整托——以托码确认上架时，同托所有未入库任务一并完成；
 * 载荷任务集合必须与同托待入库任务全集一致（不得拆托部分上架）。
 */
export function assertWholePalletPutaway(input: {
  palletCode: string | null | undefined
  payloadTaskIds: readonly string[]
  palletPendingTaskIds: readonly string[]
}): void {
  if ((input.palletCode ?? '').trim() === '') return // 单品确认不走整托断言
  const payload = new Set(input.payloadTaskIds)
  const palletSet = new Set(input.palletPendingTaskIds)
  if (payload.size !== input.payloadTaskIds.length) {
    throw new WarehousingRuleViolation('A-T13-2', '整托上架载荷出现重复任务，拒绝')
  }
  const missing = [...palletSet].filter((id) => !payload.has(id))
  if (missing.length > 0 || payload.size !== palletSet.size) {
    throw new WarehousingRuleViolation(
      'A-T13-2',
      `托码 ${input.palletCode} 确认上架=整托：载荷须包含同托全部未入库任务（缺 ${missing.length} 项/多 ${payload.size - palletSet.size + missing.length} 项）`,
    )
  }
}

/** A-T13-1：待入库任务台账来源（报工/成品质检异步写入；禁手工增删改）。 */
export const PUTAWAY_SOURCE_TYPES = ['work_report', 'finished_inspection'] as const
export type PutawaySourceType = (typeof PUTAWAY_SOURCE_TYPES)[number]

export const PUTAWAY_TASK_STATUSES = ['pending', 'done', 'cancelled'] as const
export type PutawayTaskStatus = (typeof PUTAWAY_TASK_STATUSES)[number]

/** A-T13-1：任务台账无手工增删改——仅 refresh（端口重跑）与 confirm（回填）两通道。 */
export function assertPutawayTaskNotManuallyWritable(input: { channel: 'refresh' | 'confirm' | 'manual' }): void {
  if (input.channel === 'manual') {
    throw new WarehousingRuleViolation(
      'A-T13-1',
      '待入库任务台账禁手工增删改：仅报工/成品质检异步写入（refresh 重跑）与确认入库回填两通道',
    )
  }
}

/** A-T13-1：确认入库只可对待入库（pending）任务执行。 */
export function assertPutawayConfirmable(input: { status: string; sourceRef: string }): void {
  if (input.status !== 'pending') {
    throw new WarehousingRuleViolation(
      'A-T13-1',
      `待入库任务 ${input.sourceRef} 状态为 ${input.status}，仅待入库任务可确认入库`,
    )
  }
}
