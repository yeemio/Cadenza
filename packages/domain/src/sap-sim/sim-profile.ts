/**
 * R1 SAP 参考映射（代码侧镜像 delivery/sap-sim-rework-20261030/SAP-REFERENCE-PROFILE.md）。
 * 基线：SAP S/4HANA 2021 on-premise, OData V2。
 * 每条映射标注 SAP_STANDARD / CADENZA_EXTENSION / SIM_ASSUMPTION。
 */

export type SapSimMappingTag = 'SAP_STANDARD' | 'CADENZA_EXTENSION' | 'SIM_ASSUMPTION'

export interface SapSimTopicOperationMapping {
  topic: string
  direction: 'MOM_TO_SAP' | 'SAP_TO_MOM'
  sap_api: string
  sap_operation: string
  mapping_tag: SapSimMappingTag
  /** 模拟器按该映射执行的处理器名（引擎分派键） */
  handler:
    | 'PRODUCTION_RELEASE'
    | 'PRODUCTION_REVISION'
    | 'MASTER_VERSION_BUNDLE'
    | 'MATERIAL_DOCUMENT'
    | 'EXECUTION_BUNDLE'
    | 'QUALITY_STOCK_BLOCK'
    | 'REWORK_RECLASSIFICATION'
    | 'CANCEL_REQUEST'
  /** 物料凭证语义（GoodsMovementCode 口径；material document 处理器用） */
  goods_movement_code?: '01' | '02' | '03' | '04' | '05' | '06' | '07'
  notes: string
}

export const SAP_SIM_BASELINE = {
  product: 'SAP S/4HANA on-premise',
  version: '2021',
  protocol: 'OData V2',
  confirmation_api: 'API_PROD_ORDER_CONFIRMATION_2_SRV',
  material_document_api: 'API_MATERIAL_DOCUMENT_SRV',
  actual_connection: false as const,
} as const

/** topic → SAP 对象/操作映射（冻结 56 消息出现的 topic 全集；模拟支持子集见 profile）。 */
export const SAP_SIM_TOPIC_OPERATION_MAP: readonly SapSimTopicOperationMapping[] = [
  {
    topic: 'PRODUCTION_RELEASE',
    direction: 'SAP_TO_MOM',
    sap_api: 'API_PRODUCTION_ORDER_SRV (OData V2, 生产订单对象族)',
    sap_operation: '生产订单下达/接收通知（订单存在性按 A_ProductionOrder 域）',
    mapping_tag: 'CADENZA_EXTENSION',
    handler: 'PRODUCTION_RELEASE',
    notes: 'Cadenza 抽象 topic；模拟侧落 sim_sap_order（版本+组织身份门控）',
  },
  {
    topic: 'PRODUCTION_REVISION',
    direction: 'SAP_TO_MOM',
    sap_api: 'API_PRODUCTION_ORDER_SRV',
    sap_operation: '订单修订（版本父子链）',
    mapping_tag: 'CADENZA_EXTENSION',
    handler: 'PRODUCTION_REVISION',
    notes: 'SAP 无"消息级版本链"公开字段；父子版本门控为 Cadenza 扩展，模拟按事实判 WAIT_PARENT/STALE',
  },
  {
    topic: 'MASTER_VERSION_BUNDLE',
    direction: 'SAP_TO_MOM',
    sap_api: '—（主数据对象族，非单一 API）',
    sap_operation: '主数据/组织/单位/路线版本打包输入',
    mapping_tag: 'CADENZA_EXTENSION',
    handler: 'MASTER_VERSION_BUNDLE',
    notes: 'SIM 记录为主数据输入事实，不冒充任何 SAP 单据',
  },
  {
    topic: 'MATERIAL_CONSUMPTION',
    direction: 'MOM_TO_SAP',
    sap_api: 'API_MATERIAL_DOCUMENT_SRV',
    sap_operation: 'POST A_MaterialDocumentHeader（GoodsMovementCode=03 Goods Issue，行引用 ManufacturingOrder）',
    mapping_tag: 'SAP_STANDARD',
    handler: 'MATERIAL_DOCUMENT',
    goods_movement_code: '03',
    notes: 'GoodsMovementType 口径下生产投料 SAP 标准为 261；模拟按行扣 sim_sap_stock',
  },
  {
    topic: 'PRODUCTION_OUTPUT',
    direction: 'MOM_TO_SAP',
    sap_api: 'API_PROD_ORDER_CONFIRMATION_2_SRV + API_MATERIAL_DOCUMENT_SRV',
    sap_operation: 'POST 订单确认（产出量）→ 关联货物接收（GoodsMovementCode=02）',
    mapping_tag: 'SAP_STANDARD',
    handler: 'MATERIAL_DOCUMENT',
    goods_movement_code: '02',
    notes: '确认成功则模拟侧同时生成确认号与物料凭证号；HTTP 已接收与业务已提交分列',
  },
  {
    topic: 'INTERMEDIATE_OUTPUT',
    direction: 'MOM_TO_SAP',
    sap_api: 'API_PROD_ORDER_CONFIRMATION_2_SRV（中间工序确认）',
    sap_operation: 'POST 工序确认（中间产出）',
    mapping_tag: 'SIM_ASSUMPTION',
    handler: 'MATERIAL_DOCUMENT',
    goods_movement_code: '02',
    notes: '冻结合同选定中间库存型工序走 SIM 口径（不与成品交付相加）',
  },
  {
    topic: 'STOCK_TRANSFER_ISSUE',
    direction: 'MOM_TO_SAP',
    sap_api: 'API_MATERIAL_DOCUMENT_SRV',
    sap_operation: 'POST A_MaterialDocumentHeader（GoodsMovementCode=04 Transfer Posting；IssuingOrReceivingPlant）',
    mapping_tag: 'SAP_STANDARD',
    handler: 'MATERIAL_DOCUMENT',
    goods_movement_code: '04',
    notes: '发方库位减少、集团在途增加；集团总量不变（合同不变量）',
  },
  {
    topic: 'STOCK_TRANSFER_RECEIPT',
    direction: 'MOM_TO_SAP',
    sap_api: 'API_MATERIAL_DOCUMENT_SRV',
    sap_operation: 'POST A_MaterialDocumentHeader（GoodsMovementCode=04；收货方工厂）',
    mapping_tag: 'SAP_STANDARD',
    handler: 'MATERIAL_DOCUMENT',
    goods_movement_code: '04',
    notes: '冲在途、入收方；收货与质量结论分开',
  },
  {
    topic: 'SHIPMENT_CONFIRM',
    direction: 'MOM_TO_SAP',
    sap_api: 'API_MATERIAL_DOCUMENT_SRV（发货过账口径）',
    sap_operation: 'POST A_MaterialDocumentHeader（GoodsMovementCode=03，发货）',
    mapping_tag: 'SIM_ASSUMPTION',
    handler: 'MATERIAL_DOCUMENT',
    goods_movement_code: '03',
    notes: 'SAP 交票/装运确认走 LE 对象族；本地模拟按发货过账口径登记 sim 单据',
  },
  {
    topic: 'SCRAP_CONFIRM',
    direction: 'MOM_TO_SAP',
    sap_api: 'API_MATERIAL_DOCUMENT_SRV',
    sap_operation: 'POST A_MaterialDocumentHeader（GoodsMovementCode=03，报废发出）',
    mapping_tag: 'SAP_STANDARD',
    handler: 'MATERIAL_DOCUMENT',
    goods_movement_code: '03',
    notes: '数量报废确认 ≠ 实物已处置',
  },
  {
    topic: 'QUANTITY_RECONCILIATION',
    direction: 'MOM_TO_SAP',
    sap_api: '—（对账为 Cadenza 概念）',
    sap_operation: '数量对账登记回执',
    mapping_tag: 'CADENZA_EXTENSION',
    handler: 'MATERIAL_DOCUMENT',
    notes: '模拟侧登记对账回执单据；≠ 21 对象 RECON 产品闭环（R4）',
  },
  {
    topic: 'EXECUTION_BUNDLE',
    direction: 'MOM_TO_SAP',
    sap_api: 'API_PROD_ORDER_CONFIRMATION_2_SRV（批量确认）',
    sap_operation: 'POST 多行确认（每行独立键/数量/单位）',
    mapping_tag: 'CADENZA_EXTENSION',
    handler: 'EXECUTION_BUNDLE',
    notes: '包装回执不能代替子行核对；每行独立 sim 事实',
  },
  {
    topic: 'QUALITY_STOCK_BLOCK',
    direction: 'MOM_TO_SAP',
    sap_api: '—（质量状态过账走 QM 对象族）',
    sap_operation: '质量阻断通知接收（不过账库存）',
    mapping_tag: 'SIM_ASSUMPTION',
    handler: 'QUALITY_STOCK_BLOCK',
    notes: '传输收到 ≠ 质量状态已过账；模拟落 QUALITY_NOTICE 事实不动库存',
  },
  {
    topic: 'REWORK_RECLASSIFICATION',
    direction: 'MOM_TO_SAP',
    sap_api: 'API_MATERIAL_DOCUMENT_SRV（转储过账口径）',
    sap_operation: '返工重分类（要求模拟侧存在返工指令）',
    mapping_tag: 'CADENZA_EXTENSION',
    handler: 'REWORK_RECLASSIFICATION',
    notes: '无返工指令事实 → REJECTED_MISSING_REWORK_ORDER（输出由事实推导）',
  },
  {
    topic: 'CANCEL_REQUEST',
    direction: 'SAP_TO_MOM',
    sap_api: 'API_MATERIAL_DOCUMENT_SRV（Cancel function import）',
    sap_operation: '按原单冲销（生成反向凭证，不删历史）',
    mapping_tag: 'SAP_STANDARD',
    handler: 'CANCEL_REQUEST',
    notes: '已有产出事实 → REJECT_ALREADY_PRODUCED（不删除生产事实）',
  },
] as const

export const SAP_SIM_MAPPED_TOPICS = SAP_SIM_TOPIC_OPERATION_MAP.map((m) => m.topic)

export function findSapSimTopicMapping(topic: string): SapSimTopicOperationMapping | null {
  return SAP_SIM_TOPIC_OPERATION_MAP.find((m) => m.topic === topic) ?? null
}

/** 模拟侧单据号号码段（SAP 风格定长；由模拟器生成，非调用方申报）。 */
export function formatSimSapDocumentNo(kind: string, seq: number): string {
  const padded = String(seq).padStart(7, '0')
  switch (kind) {
    case 'MATERIAL_DOCUMENT':
      return `SIMMD${padded}` // SAP 物料凭证 10 位风格
    case 'PRODUCTION_CONFIRMATION':
      return `SIMPC${padded}`
    case 'DELIVERY_CONFIRM':
      return `SIMDL${padded}`
    case 'SCRAP_CONFIRM':
      return `SIMSC${padded}`
    case 'QTY_RECONCILIATION':
      return `SIMQR${padded}`
    case 'BUNDLE_LINE_ACK':
      return `SIMBL${padded}`
    case 'MASTER_BUNDLE':
      return `SIMMB${padded}`
    case 'QUALITY_NOTICE':
      return `SIMQN${padded}`
    case 'REJECT_NOTICE':
      return `SIMRJ${padded}`
    default:
      return `SIMXX${padded}`
  }
}
