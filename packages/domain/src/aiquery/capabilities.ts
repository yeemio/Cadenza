/**
 * 首版三能力注册定义（capability-contract.md §2～§4 六段合同的段①能力定义；
 * AQ-REG-02 只登记只读查询能力）。
 *
 * 本常量是 0021 ai_capability_registry 注册行的 **部署初始化 seed 来源**（AQ-REG-03：
 * 首版三能力注册行由部署初始化 seed 写入；运行时以注册表行为准——执行只读注册表，
 * 本常量不再参与运行时判定）。definition JSON 与 AQ-S1 definition jsonb 结构一致：
 * inputSchema/requiredPermissions/allowedObjects[{table,fields}]/maxQueryRange/口径参数。
 */
import { AIQUERY_PERMISSIONS } from './permissions'

/** 能力注册行 definition 载荷（AQ-S1 definition jsonb；seed 常量与注册表行同构）。 */
export interface AiCapabilityDefinitionSeed {
  displayName: string
  description: string
  inputSchema: Record<string, unknown>
  requiredPermissions: string[]
  allowedObjects: Array<{ table: string; fields: string[] }>
  maxQueryRange: Record<string, unknown>
  /** 口径参数（AQ-C2 requirementBase：'per_unit'×production_qty / 'total' / null=口径未定，GAP-P4） */
  caliberParams: Record<string, unknown>
}

export interface AiCapabilitySeed {
  capabilityId: string
  version: number
  status: 'enabled' | 'disabled'
  definition: AiCapabilityDefinitionSeed
  remark: string | null
}

/** AQ-C1 订单进度：对象/状态/五量/排程完成度/未完成任务（§2 白名单字段）。 */
export const AIQ_ORDER_PROGRESS: AiCapabilitySeed = {
  capabilityId: 'aq.order-progress',
  version: 1,
  status: 'enabled',
  definition: {
    displayName: '订单进度查询',
    description:
      '回答「这张工作令/生产订单目前做到哪一步，还有哪些任务没完成」：单订单对象与当前状态、五量（草稿/提交/审核/合格/入库）、排程完成度、未完成任务清单。',
    inputSchema: {
      type: 'object',
      properties: {
        orderRef: {
          type: 'object',
          properties: {
            kind: { enum: ['orderId', 'orderNo', 'orderNoLike', 'salesOrderNo'] },
            value: { type: 'string' },
          },
          required: ['kind', 'value'],
        },
      },
      required: ['orderRef'],
    },
    requiredPermissions: [
      AIQUERY_PERMISSIONS.USE,
      'process.read',
      'execution.read',
      'scheduling.read',
    ],
    allowedObjects: [
      {
        table: 'production_order',
        fields: [
          'id',
          'plant_id',
          'order_no',
          'order_type',
          'sales_contract_no',
          'sales_order_no',
          'line_no',
          'material_snapshot',
          'production_qty',
          'uom',
          'order_status',
          'process_config_status',
          'suspended',
          'suspended_reason',
          'actual_start_at',
          'planned_start_at',
          'planned_finish_at',
          'business_closed_at',
          'erp_closed_at',
          'bom_revision_id',
          'route_revision_id',
          'current_settings_version',
          'created_at',
          'updated_at',
        ],
      },
      {
        table: 'order_operation',
        fields: ['id', 'seq', 'settings_version', 'operation_name', 'offline_qty', 'uom', 'production_dept_id', 'updated_at'],
      },
      { table: 'schedule_slot', fields: ['id', 'order_operation_id', 'planned_qty', 'updated_at'] },
      {
        table: 'production_report',
        fields: ['id', 'order_operation_id', 'operation_seq', 'status', 'review_status', 'review_cancelled_at', 'updated_at'],
      },
      {
        table: 'report_output',
        fields: ['id', 'report_id', 'quantity', 'qualified_qty', 'stock_unit_id', 'updated_at'],
      },
    ],
    maxQueryRange: { scope: 'single_order', operations: 'current_settings_version_all' },
    caliberParams: { note: '五量口径 S02/A5-3；未完成判定=五量与排程事实（execution_status 无置位路径，GAP-P9）' },
  },
  remark: '首版注册行（部署初始化 seed，AQ-REG-03）',
}

/** AQ-C2 物料缺口：BOM 需求 vs 可用量 vs 采购在途（§3 白名单字段；价格类物理排除）。 */
export const AIQ_MATERIAL_SHORTAGE: AiCapabilitySeed = {
  capabilityId: 'aq.material-shortage',
  version: 1,
  status: 'enabled',
  definition: {
    displayName: '物料缺口查询',
    description:
      '回答「这张订单还缺哪些材料，哪些已有采购安排」：单订单 BOM 需求行、当前可用量、采购未交量逐料品并排，关联采购单行及状态。缺口数值列首版口径未定（requirementBase 未配置）。',
    inputSchema: {
      type: 'object',
      properties: {
        orderRef: {
          type: 'object',
          properties: {
            kind: { enum: ['orderId', 'orderNo', 'orderNoLike', 'salesOrderNo'] },
            value: { type: 'string' },
          },
          required: ['kind', 'value'],
        },
        includePurchaseLines: { type: 'boolean' },
      },
      required: ['orderRef'],
    },
    requiredPermissions: [
      AIQUERY_PERMISSIONS.USE,
      'process.read',
      'inventory.read',
      'purchase.read',
    ],
    allowedObjects: [
      {
        table: 'production_order',
        fields: ['id', 'plant_id', 'order_no', 'material_snapshot', 'production_qty', 'uom', 'bom_revision_id', 'updated_at'],
      },
      {
        table: 'manufacturing_bom_revision',
        fields: ['id', 'version', 'lines', 'updated_at'],
      },
      {
        table: 'stock_balance',
        fields: ['id', 'unit_id', 'quantity', 'uom_code', 'quality_status', 'status', 'plant_id', 'updated_at'],
      },
      {
        table: 'reservation',
        fields: ['id', 'unit_id', 'quantity', 'status', 'valid_until'],
      },
      {
        table: 'purchase_order_line',
        fields: [
          'id',
          'order_no',
          'line_no',
          'material_code',
          'material_name',
          'spec',
          'model',
          'color',
          'uom_code',
          'planned_qty',
          'received_qty',
          'status',
          'erp_closed',
          'planned_receipt_date',
          'first_arrival_date',
          'last_arrival_date',
          'plant_id',
          'updated_at',
        ],
      },
      { table: 'purchase_receipt_batch', fields: ['id', 'purchase_line_id', 'inspection_status', 'confirm_time'] },
    ],
    maxQueryRange: { bomLinesPerOrder: 500, purchaseLinesPerMaterial: 200 },
    caliberParams: {
      requirementBase: null,
      note: 'requirementBase 未配置=口径未定：缺口数值列固定「口径未定」标注，不得按猜测口径给数（AQ-AMB-03，GAP-P4）',
    },
  },
  remark: '首版注册行（部署初始化 seed，AQ-REG-03；价格类字段物理排除出白名单，GAP-P5）',
}

/** AQ-C3 质量查询：检验未通过与后续处置（§4 白名单字段；复核价格列物理排除）。 */
export const AIQ_QUALITY: AiCapabilitySeed = {
  capabilityId: 'aq.quality',
  version: 1,
  status: 'enabled',
  definition: {
    displayName: '质量查询',
    description:
      '回答「某时间段哪些检验未通过、后续处置是什么」：并查过程/成品检验单与来料检验批次两类对象族，判定/状态/处置事实分列；事实与原因推测分开（解释由 AI 生成并标注推测）。',
    inputSchema: {
      type: 'object',
      properties: {
        objectScope: { enum: ['inspection_order', 'purchase_batch', 'all'] },
        timeRange: {
          type: 'object',
          properties: { from: { type: 'string' }, to: { type: 'string' } },
        },
        conclusions: { type: 'array', items: { enum: ['qualified', 'unqualified'] } },
        inspectionStages: { type: 'array', items: { enum: ['process', 'finished'] } },
        orderNoLike: { type: 'string' },
        page: { type: 'object', properties: { page: { type: 'number' }, pageSize: { type: 'number' } } },
      },
      required: ['timeRange'],
    },
    requiredPermissions: [AIQUERY_PERMISSIONS.USE, 'quality.read', 'purchase.read'],
    allowedObjects: [
      {
        table: 'quality_inspection_order',
        fields: [
          'id',
          'order_no',
          'source_type',
          'inspection_stage',
          'spec_code',
          'spec_version',
          'inventory_unit_id',
          'unit_no',
          'material_code',
          'quantity',
          'uom_code',
          'production_order_no',
          'production_dept_name',
          'plant_id',
          'status',
          'business_time',
          'updated_at',
        ],
      },
      {
        table: 'quality_test_result',
        fields: ['id', 'inspection_order_id', 'version', 'conclusion', 'result_kind', 'is_effective', 'inspector', 'inspected_at'],
      },
      {
        table: 'quality_disposition',
        fields: ['id', 'inspection_order_id', 'disposition_kind', 'based_on_version', 'released_by', 'released_at', 'reason'],
      },
      {
        table: 'quality_hold',
        fields: ['id', 'inventory_unit_id', 'hold_kind', 'status', 'raised_at', 'released_at'],
      },
      {
        table: 'purchase_receipt_batch',
        fields: [
          'id',
          'batch_no',
          'order_no',
          'line_no',
          'material_code',
          'material_name',
          'received_qty',
          'uom_code',
          'inspection_status',
          'storage_status',
          'arrival_time',
          'confirm_time',
          'plant_id',
        ],
      },
      { table: 'receipt_detail', fields: ['id', 'batch_id', 'quality_status', 'quantity'] },
    ],
    maxQueryRange: { timeSpanDays: 92, pageSize: 100 },
    caliberParams: {
      note: '生效结论=当前 is_effective 行（S14）；处置状态=生效结论+最新处置+活动隔离三者并排；时间过滤列=业务时间（检验单 business_time/批次 confirm_time/隔离 raised_at）',
    },
  },
  remark: '首版注册行（部署初始化 seed，AQ-REG-03；价格复核列与外发同步状态列物理排除，GAP-P5）',
}

/** 首版三能力 seed 清单（部署初始化写入 0021 注册表）。 */
export const AI_QUERY_CAPABILITY_SEEDS: readonly AiCapabilitySeed[] = [
  AIQ_ORDER_PROGRESS,
  AIQ_MATERIAL_SHORTAGE,
  AIQ_QUALITY,
]
