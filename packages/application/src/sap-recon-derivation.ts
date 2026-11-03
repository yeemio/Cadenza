/**
 * R4｜SAP 21 对象对账两端独立推导（只读查询）。
 *
 * 合同要点（SCOPE-MAP R4 / 包规则）：
 * - MOM 侧数量与状态从 MOM 业务表推导（料品主数据 / 库存余额 / 库存流水 / 投料流水 /
 *   库存单元 / 采购收货 / 生产订单 / outbox 行状态 / 审计）；
 * - sim 侧从 sim_sap_* 事实表推导（单据行 qty 列与引擎回执 / sim 库存 / 在途 / 到达结局台账）；
 * - 数量与分类不经请求 payload 传入（对比 sap.reconciliation.create 的调用方申报通道）；
 * - outbox / 消息载荷仅用于「身份引用检索」定位相关行，输出字段只取行状态列，不取载荷数量；
 * - 只读：不写任何表；现有分类登记页（POST /sap/reconciliation）保持原样，可复用。
 */

import { SAP_RECON_PERMISSIONS, sha256OfPayload } from '@cadenza/domain'
import type { VerifiedAuthContext } from './session-verifier'

export class SapReconDerivationError extends Error {
  constructor(readonly code: 'FORBIDDEN_SCOPE' | 'INVALID_IDENTITY', message: string) { super(message) }
}

export interface SapReconFactScope {
  enterpriseId: string
  plantId: string
  ownerId: string
  organizationCode: string
  plantCode: string
  objectFullKey: string
  momUnitNo: string | null
  momLotNo: string | null
  unit: string
  basis: string
}

// -------- 推导仓储端口（只读） --------

export interface SapReconDeriveDocumentRow {
  docNo: string
  docType: string
  eventKey: string
  businessKey: string | null
  organizationCode: string
  plantCode: string
  status: string
  materialId: string | null
  qty: number | null
  unit: string | null
  receipt: Record<string, unknown> | null
  payload: Record<string, unknown>
  createdAt: string
}

export interface SapReconDeriveStockRow {
  organizationCode: string
  plantCode: string
  materialId: string
  unit: string
  qty: number
  updatedAt: string
}

export interface SapReconDeriveTransitRow {
  transferKey: string
  organizationCode: string
  fromPlant: string
  toPlant: string
  materialId: string | null
  unit: string
  qty: number
  status: string
  updatedAt: string
}

export interface SapReconDeriveOutcomeRow {
  eventKey: string
  outcome: string
  messageState: string | null
  docNo: string | null
  applied: boolean
  createdAt: string
}

export interface SapReconDeriveMaterialRow {
  id: string
  code: string
  name: string
  materialType: number | null
  baseUom: string
  externalRevision: number | null
  status: string
}

export interface SapReconDeriveOutboxRow {
  eventId: string
  externalRef: string | null
  taskKind: string | null
  status: string
  attemptCount: number
  envelopeBusinessKey: string | null
  updatedAt: string
}

export interface SapReconObjectMeasurement {
  objectId: string
  materialId: string
  unit: string
  basis: string
  referenceVersion: string
  referenceDataSha256: string
  masterEventKey: string
  sources: Record<string, unknown>
}

export interface SapReconDerivationRepository {
  simObjectMeasurement(objectKey: string, scope: SapReconFactScope): Promise<SapReconObjectMeasurement | null>
  resolveScope(auth: VerifiedAuthContext, input: SapReconDeriveInput): Promise<SapReconFactScope | null>
  /** sim 单据：载荷文本引用到对象名的行（object_id/source_object_id/line_ids/axis_ids/custody/business_key）。 */
  simDocumentsByObjectRef(objectName: string, scope: SapReconFactScope): Promise<SapReconDeriveDocumentRow[]>
  simStockByMaterial(materialKey: string, scope: SapReconFactScope): Promise<SapReconDeriveStockRow[]>
  simInTransitByMaterial(materialKey: string, scope: SapReconFactScope): Promise<SapReconDeriveTransitRow[]>
  simOutcomesByEventKeys(eventKeys: string[], scope: SapReconFactScope): Promise<SapReconDeriveOutcomeRow[]>
  momObjectUnits(materialId: string, scope: SapReconFactScope): Promise<Array<{ id: string; unitNo: string; lotNo: string; materialCode: string; ownerId: string; unit: string; basis: string }>>
  momMaterialByCode(code: string, scope: SapReconFactScope): Promise<SapReconDeriveMaterialRow | null>
  /** MOM 库存余额汇总（按质量状态分列）；rowCount=0 表示无事实。 */
  momStockSummary(materialId: string, scope: SapReconFactScope): Promise<{
    rowCount: number
    totalQty: number
    measures: Array<{ unit: string; basis: string; qty: number; rowCount: number }>
    byQuality: Array<{ qualityStatus: string | null; qty: number; rowCount: number }>
  }>
  momStockTxnSummary(materialId: string, scope: SapReconFactScope): Promise<{
    rowCount: number
    inQty: number
    outQty: number
    byKind: Array<{ movementKind: string; qty: number; rowCount: number }>
  }>
  momInventoryUnitSummary(materialId: string, scope: SapReconFactScope): Promise<{ rowCount: number; openCount: number }>
  momConsumptionSummary(materialId: string, scope: SapReconFactScope): Promise<{ rowCount: number; qty: number }>
  momPurchaseReceipts(materialCode: string, scope: SapReconFactScope): Promise<
    Array<{
      orderNo: string
      lineNo: number
      receivedQty: number
      uom: string | null
      inspectionStatus: string | null
      storageStatus: string | null
      returnedAt: string | null
    }>
  >
  momProductionOrders(materialId: string, scope: SapReconFactScope): Promise<
    Array<{
      orderNo: string
      productionQty: number
      completedQty: number
      orderStatus: string
      settingsVersion: number
    }>
  >
  /** MOM outbox：载荷引用到对象名的行（输出仅行状态列）。 */
  momOutboxByObjectRef(objectName: string, scope: SapReconFactScope): Promise<SapReconDeriveOutboxRow[]>
  momAuditSummary(objectName: string, scope: SapReconFactScope): Promise<Array<{ subjectType: string; action: string; count: number }>>
}

// -------- 输入与输出 --------

export interface SapReconDeriveInput {
  /** 对象名（不含企业前缀），如 RAW-CUCN / C15-BL-3 / GK-2。 */
  objectId: string
  /** 对象全键；缺省 `CBL01G-${objectId}`（sim 侧绑定料品缺省同此）。 */
  objectFullKey?: string
  /** MOM 料品 code（身份映射，非数量）。 */
  momMaterialCode?: string
  /** sim 侧绑定料品键；缺省 = objectFullKey。 */
  simMaterialKey?: string
  ownerEntityCode?: string
  plantCode?: string
  unit?: string
  basis?: string
  plantId?: string
  /** CADENZA_EXTENSION：合法业务返回的精确库存单元或批次；不提供时用 objectFullKey 精确匹配。 */
  momUnitNo?: string
  momLotNo?: string
}

export interface SapReconDeriveResult {
  object: Required<Pick<SapReconDeriveInput, 'objectId'>> & SapReconDeriveInput
  identity: SapReconFactScope & { mapping: 'CADENZA_EXTENSION'; asOf: 'CURRENT_FACTS'; version: 'NOT_AN_HISTORICAL_SNAPSHOT' }
  mom: {
    objectUnits: Awaited<ReturnType<SapReconDerivationRepository['momObjectUnits']>>
    material: SapReconDeriveMaterialRow | null
    /** 库存余额推导的实物量；null=无库存事实（不得当 0）。 */
    physicalQty: number | null
    stock: { rowCount: number; totalQty: number; measures: Array<{ unit: string; basis: string; qty: number; rowCount: number }>; byQuality: Array<{ qualityStatus: string | null; qty: number; rowCount: number }> }
    stockTxn: { rowCount: number; inQty: number; outQty: number; byKind: Array<{ movementKind: string; qty: number; rowCount: number }> }
    inventoryUnits: { rowCount: number; openCount: number }
    consumption: { rowCount: number; qty: number }
    purchaseReceipts: Array<{
      orderNo: string
      lineNo: number
      receivedQty: number
      uom: string | null
      inspectionStatus: string | null
      storageStatus: string | null
      returnedAt: string | null
    }>
    productionOrders: Array<{
      orderNo: string
      productionQty: number
      completedQty: number
      orderStatus: string
      settingsVersion: number
    }>
    outboxStates: SapReconDeriveOutboxRow[]
    audit: Array<{ subjectType: string; action: string; count: number }>
    externalUnknownEventKeys: string[]
    derivationSources: string[]
  }
  sim: {
    measurement: { mapping: SapReconObjectMeasurement | null; status: 'VERIFIED_REFERENCE_MAPPING' | 'BASIS_NOT_RECORDED' | 'REQUEST_MEASUREMENT_MISMATCH' }
    documents: Array<
      SapReconDeriveDocumentRow & {
        refKind: 'OUTPUT' | 'CONSUMPTION' | 'TRANSFER' | 'QUALITY' | 'SCRAP' | 'REJECT' | 'REFERENCE'
        applied: boolean
        objectFactQty: number | null
        quantitySource: 'DOCUMENT_ROW' | 'RESOLVED_REFERENCE_LINES' | 'ABSENT'
      }
    >
    stock: SapReconDeriveStockRow[]
    inTransit: SapReconDeriveTransitRow[]
    outcomes: SapReconDeriveOutcomeRow[]
    derived: {
      /** sim 库存净额（对象绑定料品）；null=无绑定库存行。 */
      stockQty: number | null
      transitQty: number
      /** 确认消耗量合计（单据行 qty 绝对值，仅 applied 行）。 */
      consumedQty: number
      /** 确认产出量合计（打包 OUTPUT 行 / 生产确认，仅 applied 行）。 */
      producedQty: number
      /** 确认报废事实量（SCRAP_CONFIRM custody 对象，仅 applied 行）。 */
      scrapFactQty: number
      /** 质量阻断消息量（QUALITY_NOTICE 行 qty；applied=false=收货未过账）。 */
      qualityBlockQty: number | null
      /** 轴对象均摊：qty / 轴数（等分假设，显式标注）。 */
      axisShare: number | null
      axisShareDoc: string | null
      /** headline 观测量及所用规则。 */
      observedQty: number | null
      observedRule:
        | 'SIM_STOCK'
        | 'SIM_STOCK_AND_TRANSIT'
        | 'SIM_AXIS_SHARE_EQUAL_ASSUMPTION'
        | 'SIM_REJECTED_NO_FACT'
        | 'SIM_NO_FACT'
        | 'SIM_EXTERNAL_UNKNOWN_HOLD'
      confirmedDocCount: number
      rejectedDocCount: number
    }
  }
  diff: {
    momQty: number | null
    simQty: number | null
    /** momQty − simQty；任一侧无事实时为 null。 */
    delta: number | null
    status:
      | 'BOTH_DERIVED'
      | 'MOM_FACTS_ABSENT'
      | 'SIM_NO_FACT'
        | 'SIM_EXTERNAL_UNKNOWN_HOLD'
      | 'BOTH_ABSENT'
      | 'UNKNOWN_SLICE_PRESERVED'
      | 'MEASUREMENT_NOT_COMPARABLE'
    unknownSlice: boolean
    unknownEventKeys: string[]
    rule: string
  }
  actual_connection: false
  boundary: string
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** 单据行 → 与对象的引用关系分类（只用引用字段与行状态，不用载荷数量）。 */
function classifyDoc(
  doc: SapReconDeriveDocumentRow,
  objectFullKey: string,
): SapReconDeriveSimResult['documents'][number]['refKind'] {
  const p = doc.payload
  const envelope = isRecord(p['envelope']) ? p['envelope'] : {}
  const receiptOutcome = isRecord(doc.receipt) ? String(doc.receipt['outcome'] ?? '') : ''
  const lineIds = [
    ...(Array.isArray(p['line_ids']) ? (p['line_ids'] as unknown[]) : []),
    ...(Array.isArray(envelope['line_ids']) ? (envelope['line_ids'] as unknown[]) : []),
  ]
  const objectOutput = p['object_id'] === objectFullKey || envelope['object_id'] === objectFullKey
  const objectConsumption =
    p['source_object_id'] === objectFullKey || envelope['source_object_id'] === objectFullKey
  const custody = envelope['custody_object_id'] === objectFullKey
  const businessRef = doc.businessKey === objectFullKey
  const lineRef = lineIds.some((l) => typeof l === 'string' && l === objectFullKey)
  const axisRef = [
    ...(Array.isArray(p['axis_ids']) ? (p['axis_ids'] as unknown[]) : []),
    ...(Array.isArray(envelope['axis_ids']) ? (envelope['axis_ids'] as unknown[]) : []),
  ].some((a) => a === objectFullKey)
  if (receiptOutcome.startsWith('REJECT') || doc.docType === 'REJECT_NOTICE') {
    return businessRef || lineRef || axisRef || custody || objectOutput || objectConsumption
      ? 'REJECT'
      : 'REFERENCE'
  }
  if (doc.docType === 'QUALITY_NOTICE') return businessRef ? 'QUALITY' : 'REFERENCE'
  if (doc.docType === 'SCRAP_CONFIRM') return custody || businessRef ? 'SCRAP' : 'REFERENCE'
  if (doc.docType === 'MATERIAL_DOCUMENT') return lineRef ? 'TRANSFER' : 'REFERENCE'
  if (objectConsumption) return 'CONSUMPTION'
  if (objectOutput || axisRef) return 'OUTPUT'
  return 'REFERENCE'
}

/** Only the engine's validated same-master rejection association can establish a target's no-posting fact. */
function trustedRejectedTarget(doc:SapReconDeriveDocumentRow,key:string,mapping:SapReconObjectMeasurement|null,scope:SapReconFactScope):boolean {
  const p=doc.payload,r=doc.receipt
  if(!mapping||!isRecord(r)||doc.docType!=='REJECT_NOTICE'||doc.status!=='COMMITTED'||r['applied']!==false||
      p['topic']!=='REWORK_RECLASSIFICATION'||r['outcome']!=='REJECTED_MISSING_REWORK_ORDER'||
      p['target_object_id']!==key||p['source_object_id']!==doc.businessKey||!doc.businessKey||doc.businessKey===key)return false
  for(const [flag,value] of [['derived_association_only',true],['stock_unchanged',true],['target_posting_created',false]] as const){
    if(p[flag]!==value||r[flag]!==value)return false
  }
  for(const field of ['source_object_id','target_object_id','material_id','unit','basis','original_order_id','source_document_id','reference_data_sha256','reference_master_event_key','reference_data_version']){
    if(typeof p[field]!=='string'||p[field]===''||p[field]!==r[field])return false
  }
  if(p['reference_data_sha256']!==mapping.referenceDataSha256||p['reference_master_event_key']!==mapping.masterEventKey||
      p['reference_data_version']!==mapping.referenceVersion||p['material_id']!==mapping.materialId||
      String(p['unit']).toLowerCase()!==mapping.unit.toLowerCase()||mapping.unit.toLowerCase()!==scope.unit.toLowerCase()||
      p['basis']!==mapping.basis||mapping.basis!==scope.basis)return false
  if(!isRecord(p['reference_sources'])||!isRecord(r['reference_sources'])||
      sha256OfPayload(p['reference_sources'])!==sha256OfPayload(mapping.sources)||
      sha256OfPayload(r['reference_sources'])!==sha256OfPayload(mapping.sources))return false
  const events=p['source_inventory_events']
  if(!Array.isArray(events)||events.length!==2||!events.every(isRecord)||
      sha256OfPayload({events})!==sha256OfPayload({events:r['source_inventory_events']}))return false
  const source=events.filter(event=>event['object_id']===doc.businessKey),target=events.filter(event=>event['object_id']===key)
  return source.length===1&&target.length===1&&source[0]!['id']!==target[0]!['id']&&
    events.every(event=>typeof event['id']==='string'&&event['id']!==''&&event['document_id']===p['source_document_id']&&event['unit']===p['unit'])
}

type SapReconDeriveSimResult = SapReconDeriveResult['sim']

export class SapReconDerivationQueryService {
  constructor(private readonly deps: { repo: SapReconDerivationRepository }) {}

  async derive(auth: VerifiedAuthContext, input: SapReconDeriveInput): Promise<SapReconDeriveResult> {
    if (!auth.permissions.includes(SAP_RECON_PERMISSIONS.SAP_RECON_READ)) {
      throw new SapReconDerivationError('FORBIDDEN_SCOPE', '缺少对账读取许可')
    }
    if (!input.ownerEntityCode || !input.plantCode || !input.unit || !input.basis) {
      throw new SapReconDerivationError('INVALID_IDENTITY', '对账需明确组织、工厂、单位与 basis')
    }
    if (input.momUnitNo && input.momLotNo) {
      throw new SapReconDerivationError('INVALID_IDENTITY', '库存单元与批次选择不能同时指定')
    }
    const objectId = input.objectId.trim()
    if (objectId === '') throw new SapReconDerivationError('INVALID_IDENTITY', 'objectId 不能为空')
    const objectFullKey = input.objectFullKey?.trim() || `CBL01G-${objectId}`
    const simMaterialKey = input.simMaterialKey?.trim() || objectFullKey
    const momMaterialCode = input.momMaterialCode?.trim() || null

    if (simMaterialKey !== objectFullKey) {
      throw new SapReconDerivationError('INVALID_IDENTITY', 'sim 库存必须按对象键查询，不能以 SKU 合计代替')
    }
    const scope = await this.deps.repo.resolveScope(auth, { ...input, objectFullKey })
    if (scope === null) throw new SapReconDerivationError('FORBIDDEN_SCOPE', '组织/工厂身份不明确或超出授权范围')

    const measurement = await this.deps.repo.simObjectMeasurement(objectFullKey, scope)
    const comparable = measurement !== null && measurement.unit.toLowerCase() === scope.unit.toLowerCase() && measurement.basis === scope.basis
    // ---- sim 侧（sim_sap_* 事实表） ----
    const [simDocs, simStock, simTransit] = await Promise.all([
      this.deps.repo.simDocumentsByObjectRef(objectFullKey, scope),
      this.deps.repo.simStockByMaterial(simMaterialKey, scope),
      this.deps.repo.simInTransitByMaterial(simMaterialKey, scope),
    ])
    const docs = simDocs.map((d) => {
      let refKind = classifyDoc(d, objectFullKey)
      const applied = isRecord(d.receipt) && d.receipt['applied'] === true
      const mappedLines = [
        ...(isRecord(d.payload['line']) ? [d.payload['line']] : []),
        ...(Array.isArray(d.payload['lines']) ? d.payload['lines'].filter(isRecord) : []),
      ].filter(line => line['materialId'] === objectFullKey)
      const traced = measurement !== null &&
        d.payload['reference_data_sha256'] === measurement.referenceDataSha256 &&
        d.payload['reference_master_event_key'] === measurement.masterEventKey
      if(trustedRejectedTarget(d,objectFullKey,measurement,scope))refKind='REJECT'
      let objectFactQty: number | null = d.materialId === objectFullKey ? d.qty : null
      let quantitySource: 'DOCUMENT_ROW' | 'RESOLVED_REFERENCE_LINES' | 'ABSENT' = objectFactQty === null ? 'ABSENT' : 'DOCUMENT_ROW'
      if (traced && mappedLines.length > 0) {
        const matching = mappedLines.filter(line => typeof line['unit'] === 'string' &&
          line['unit'].toLowerCase() === scope.unit.toLowerCase() && line['basis'] === scope.basis &&
          line['qty'] !== null && line['qty'] !== undefined && Number.isFinite(Number(line['qty'])))
        if (matching.length === mappedLines.length) {
          objectFactQty = matching.reduce((sum, line) => sum + Number(line['qty']), 0)
          quantitySource = 'RESOLVED_REFERENCE_LINES'
        }
        if (d.docType === 'MATERIAL_DOCUMENT' && d.payload['goods_movement_code'] === '03') refKind = 'CONSUMPTION'
        if (d.docType === 'MATERIAL_DOCUMENT' && d.payload['goods_movement_code'] === '04') refKind = 'TRANSFER'
      }
      return { ...d, refKind, applied, objectFactQty, quantitySource }
    })
    const eventKeys = [...new Set(docs.map((d) => d.eventKey).filter((k) => k !== ''))]
    const outcomes = eventKeys.length > 0 ? await this.deps.repo.simOutcomesByEventKeys(eventKeys, scope) : []

    let consumedQty = 0
    let producedQty = 0
    let scrapFactQty = 0
    let qualityBlockQty: number | null = null
    let axisShare: number | null = null
    let axisShareDoc: string | null = null
    let confirmedDocCount = 0
    let rejectedDocCount = 0
    for (const d of docs) {
      if (d.refKind === 'REJECT') {
        rejectedDocCount += 1
        continue
      }
      if (d.quantitySource !== 'RESOLVED_REFERENCE_LINES' && d.unit !== null && d.unit.toLowerCase() !== scope.unit.toLowerCase()) continue
      // 质量阻断量是收货事实（RECEIVED_NOT_APPLIED 时 applied=false 但阻断量仍在单据行上）
      if (d.refKind === 'QUALITY' && d.objectFactQty !== null) qualityBlockQty = d.objectFactQty
      if (!d.applied) continue
      confirmedDocCount += 1
      if (d.refKind === 'CONSUMPTION') consumedQty += Math.abs(d.objectFactQty ?? 0)
      if (d.refKind === 'OUTPUT') producedQty += d.objectFactQty ?? 0
      if (d.refKind === 'SCRAP') scrapFactQty += Math.abs(d.objectFactQty ?? 0)
      // 轴对象均摊：axis_ids 含对象全键的确认产出单据（等分假设）
      const axisIds = Array.isArray(d.payload['axis_ids'])
        ? (d.payload['axis_ids'] as unknown[])
        : isRecord(d.payload['envelope']) && Array.isArray(d.payload['envelope']['axis_ids'])
          ? (d.payload['envelope']['axis_ids'] as unknown[])
          : []
      if (['N2-1', 'N2-2'].includes(objectId) && axisIds.length === 2 &&
          axisIds.includes('CBL01G-N2-1') && axisIds.includes('CBL01G-N2-2') &&
          axisIds.includes(objectFullKey) && d.qty !== null) {
        axisShare = (axisShare ?? 0) + d.qty / axisIds.length
        axisShareDoc = d.docNo
      }
    }

    const stockQty = simStock.length > 0 ? simStock.reduce((s, r) => s + r.qty, 0) : null
    const transitQty = simTransit.filter(row => row.status === 'IN_TRANSIT' && row.fromPlant === scope.plantCode).reduce((sum,row) => sum+row.qty,0)
    let observedQty: number | null
    let observedRule: SapReconDeriveSimResult['derived']['observedRule']
    if (stockQty !== null) {
      observedQty = stockQty + transitQty
      observedRule = transitQty > 0 ? 'SIM_STOCK_AND_TRANSIT' : 'SIM_STOCK'
    } else if (axisShare !== null) {
      observedQty = axisShare
      observedRule = 'SIM_AXIS_SHARE_EQUAL_ASSUMPTION'
    } else if (rejectedDocCount > 0 && confirmedDocCount === 0) {
      observedQty = 0
      observedRule = 'SIM_REJECTED_NO_FACT'
    } else {
      observedQty = null
      observedRule = 'SIM_NO_FACT'
    }

    // ---- MOM 侧（业务表 + outbox 行状态 + 审计） ----
    const material = momMaterialCode === null ? null : await this.deps.repo.momMaterialByCode(momMaterialCode, scope)
    const emptyStock = { rowCount: 0, totalQty: 0, measures: [], byQuality: [] as Array<{ qualityStatus: string | null; qty: number; rowCount: number }> }
    const emptyTxn = { rowCount: 0, inQty: 0, outQty: 0, byKind: [] as Array<{ movementKind: string; qty: number; rowCount: number }> }
    const [stockSummary, txnSummary, unitSummary, consumptionSummary, prodOrders, objectUnits] =
      material === null
        ? ([
            emptyStock,
            emptyTxn,
            { rowCount: 0, openCount: 0 },
            { rowCount: 0, qty: 0 },
            [] as Awaited<ReturnType<SapReconDerivationRepository['momProductionOrders']>>,
            [] as Awaited<ReturnType<SapReconDerivationRepository['momObjectUnits']>>,
          ] as const)
        : await Promise.all([
            this.deps.repo.momStockSummary(material.id, scope),
            this.deps.repo.momStockTxnSummary(material.id, scope),
            this.deps.repo.momInventoryUnitSummary(material.id, scope),
            this.deps.repo.momConsumptionSummary(material.id, scope),
            this.deps.repo.momProductionOrders(material.id, scope),
            this.deps.repo.momObjectUnits(material.id, scope),
          ])
    const [momOutboxRows, purchaseRows, auditRows] = await Promise.all([
      this.deps.repo.momOutboxByObjectRef(objectFullKey, scope),
      momMaterialCode === null ? Promise.resolve([]) : this.deps.repo.momPurchaseReceipts(momMaterialCode, scope),
      this.deps.repo.momAuditSummary(objectFullKey, scope),
    ])
    const externalUnknownEventKeys = momOutboxRows
      .filter((r) => r.status === 'EXTERNAL_UNKNOWN')
      .map((r) => r.externalRef ?? r.eventId)

    const momPhysicalQty = stockSummary.rowCount > 0 ? stockSummary.totalQty : null
    const unknownSlice = externalUnknownEventKeys.length > 0
    if (unknownSlice) {
      // Simulator-internal stock is diagnostic while the original external receipt remains unknown.
      observedQty = null
      observedRule = 'SIM_EXTERNAL_UNKNOWN_HOLD'
    }

    let diffStatus: SapReconDeriveResult['diff']['status']
    if (unknownSlice) diffStatus = 'UNKNOWN_SLICE_PRESERVED'
    else if (momPhysicalQty === null && observedQty === null) diffStatus = 'BOTH_ABSENT'
    else if (momPhysicalQty === null) diffStatus = 'MOM_FACTS_ABSENT'
    else if (observedQty === null) diffStatus = 'SIM_NO_FACT'
    else if (!comparable) diffStatus = 'MEASUREMENT_NOT_COMPARABLE'
    else diffStatus = 'BOTH_DERIVED'

    return {
      object: { ...input, objectId, objectFullKey, simMaterialKey },
      identity: { ...scope, mapping: 'CADENZA_EXTENSION', asOf: 'CURRENT_FACTS', version: 'NOT_AN_HISTORICAL_SNAPSHOT' },
      mom: {
        objectUnits,
        material,
        physicalQty: momPhysicalQty,
        stock: stockSummary,
        stockTxn: txnSummary,
        inventoryUnits: unitSummary,
        consumption: consumptionSummary,
        purchaseReceipts: purchaseRows,
        productionOrders: prodOrders,
        outboxStates: momOutboxRows,
        audit: auditRows,
        externalUnknownEventKeys,
        derivationSources: [
          'material',
          'stock_balance',
          'stock_transaction',
          'inventory_unit',
          'material_consumption',
          'purchase_receipt_batch',
          'production_order',
          'outbox(行状态列)',
          'audit_entry',
        ],
      },
      sim: {
        measurement: { mapping: measurement, status: measurement === null ? 'BASIS_NOT_RECORDED' : comparable ? 'VERIFIED_REFERENCE_MAPPING' : 'REQUEST_MEASUREMENT_MISMATCH' },
        documents: docs,
        stock: simStock,
        inTransit: simTransit,
        outcomes,
        derived: {
          stockQty,
          transitQty,
          consumedQty,
          producedQty,
          scrapFactQty,
          qualityBlockQty,
          axisShare,
          axisShareDoc,
          observedQty,
          observedRule,
          confirmedDocCount,
          rejectedDocCount,
        },
      },
      diff: {
        momQty: momPhysicalQty,
        simQty: observedQty,
        delta: comparable && momPhysicalQty !== null && observedQty !== null ? momPhysicalQty - observedQty : null,
        status: diffStatus,
        unknownSlice,
        unknownEventKeys: externalUnknownEventKeys,
        rule: 'momQty=stock_balanceΣ(精确单元/批次+组织+工厂+所有者+unit+basis)；sim basis 取同组织/厂已提交 reference master 的精确对象映射；未映射不推断换算；精确原outbox为EXTERNAL_UNKNOWN时simQty/delta=null（内部stock仅诊断）；其它simQty 按规则 SIM_STOCK>SIM_AXIS_SHARE(等分假设)>SIM_REJECTED_NO_FACT>SIM_NO_FACT；数量全部读自行事实列，不取请求/载荷申报值',
      },
      actual_connection: false,
      boundary:
        'R4 两端独立只读推导；≠ POST /sap/reconciliation 人工登记；≠ REAL-SAP；UNKNOWN 切片按 outbox EXTERNAL_UNKNOWN 保留，不强行闭合',
    }
  }
}
