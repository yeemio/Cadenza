import {
  checkSuspectScan,
  summarizeBatchInspectionStatus,
  unitDefectState,
} from '@cadenza/domain'
import type { QdRepositories } from './disposition-repositories'

/**
 * disposition 域查询服务（只读；QD-01 扫码只查询、QD-10 码异常状态投影、QD-15 批次状态
 * 投影重算视图、QD-16 影响圈定正向追溯、QD-S2 版本链/处置记录并存可查）。
 * 采购质检视图消费 0006 既有表（inspection_record 首检/复检双链 + batch_judgement + receipt_detail）。
 */

export interface QdQueryDeps {
  qd: QdRepositories
  inv: {
    units: import('./inventory-repositories').InventoryUnitRepository
    balances: import('./inventory-repositories').StockBalanceRepository
    reservations: import('./inventory-repositories').ReservationRepository
  }
}

export interface SuspectScanCheckView {
  unitNo: string
  ok: boolean
  reason: string | null
  reasonLabel: string | null
  hasSuspect: boolean
  qualityStatus: string | null
}

export interface InspectionCodeView {
  unitNo: string | null
  barcodeValue: string
  effectiveConclusion: 'pending' | 'qualified' | 'unqualified' | 'exempt' | null
  effectiveVersion: number | null
  effectiveInspectionType: 'first' | 're' | null
  hasReInspection: boolean
  chainLength: number
  history: Array<{ version: number; inspectionType: string; conclusion: string; isEffective: boolean; source: string; inspector: string | null; inspectedAt: string | null }>
}

export interface BatchInspectionView {
  batchNo: string
  storageStatus: 'stored' | 'returned'
  storedInspectionStatus: string
  recomputedStatus: string
  codes: InspectionCodeView[]
  judgementChain: Array<{ version: number; conclusion: string; note: string | null; judgeBy: string; judgedAt: string; isEffective: boolean }>
}

export class DispositionQueryService {
  constructor(private readonly deps: QdQueryDeps) {}

  /** QD-01：存疑扫码预检（只查询不改数据）。 */
  async suspectScanCheck(plantId: string, unitNo: string, barcodeKind: string): Promise<SuspectScanCheckView> {
    const unit = await this.deps.inv.units.findByUnitNo(plantId, unitNo)
    const balances = unit === null ? [] : await this.deps.inv.balances.listActiveByUnit(unit.id)
    const hasSuspect = balances.some((b) => b.qualityStatus === 'suspect')
    const result = checkSuspectScan({
      hasLinkedMaterial: unit !== null && unit.materialId !== '',
      isPalletCode: barcodeKind === 'pallet',
      isReceived: unit !== null,
      hasLocation: balances.length > 0,
      alreadySuspect: hasSuspect,
    })
    const labels: Record<string, string> = {
      no_material: '该轴不存在关联料品',
      pallet_code: '扫的是托码',
      not_received: '码未入库',
      no_location: '码没有库位',
      already_suspect: '码已标记存疑',
    }
    return {
      unitNo,
      ok: result === 'ok',
      reason: result === 'ok' ? null : result,
      reasonLabel: result === 'ok' ? null : labels[result] ?? result,
      hasSuspect,
      qualityStatus: balances[0]?.qualityStatus ?? null,
    }
  }

  /** 存疑记录＋处置链并存可查（QD-S1/QD-03：原存疑记录不覆盖）。 */
  async suspectHistory(plantId: string, unitNo: string): Promise<{
    suspectRecords: unknown[]
    dispositions: unknown[]
    qualityStatus: string | null
  }> {
    const unit = await this.deps.inv.units.findByUnitNo(plantId, unitNo)
    if (unit === null) return { suspectRecords: [], dispositions: [], qualityStatus: null }
    const suspectRecords = await this.deps.qd.suspectRecords.listByUnit(unit.id)
    const dispositions = await this.deps.qd.dispositions.listByUnitNo(plantId, unitNo, 50)
    const balances = await this.deps.inv.balances.listActiveByUnit(unit.id)
    return { suspectRecords, dispositions, qualityStatus: balances[0]?.qualityStatus ?? null }
  }

  /** QD-10：成品异常列表。 */
  async defectList(filter: {
    enterpriseId: string
    plantIds: string[] | null
    plantId?: string
    unitNoLike?: string
    reviewStatus?: string
    page: number
    pageSize: number
  }): Promise<{ items: unknown[]; total: number }> {
    return this.deps.qd.defects.listPaged(filter)
  }

  /** QD-10：码异常状态投影（该码该料品是否存在未审核异常 → 无异常/异常未处理）。 */
  async unitDefectState(plantId: string, unitNo: string, materialId: string): Promise<string> {
    const unit = await this.deps.inv.units.findByUnitNo(plantId, unitNo)
    if (unit === null) return unitDefectState(false)
    const open = await this.deps.qd.defects.findOpenByUnitMaterial(unit.id, materialId)
    return unitDefectState(open !== null)
  }

  /** QD-12/13/15：批次质检视图（码结论版本链+生效指针+判定版本链+重算批次状态）。 */
  async batchInspectionView(batchNo: string): Promise<BatchInspectionView | null> {
    const batch = await this.deps.qd.batchQc.findByNo(batchNo)
    if (batch === null) return null
    const details = await this.deps.qd.batchQc.listDetails(batch.id)
    const codes: InspectionCodeView[] = []
    for (const detail of details) {
      const chain = await this.deps.qd.inspectionChain.listChainForDetail(detail.detailId)
      const effective = await this.deps.qd.inspectionChain.findEffectiveForDetail(detail.detailId)
      codes.push({
        unitNo: detail.unitNo,
        barcodeValue: detail.barcodeValue,
        effectiveConclusion: effective?.conclusion ?? null,
        effectiveVersion: effective?.version ?? null,
        effectiveInspectionType: effective?.inspectionType ?? null,
        hasReInspection: chain.some((r) => r.inspectionType === 're'),
        chainLength: chain.length,
        history: chain
          .sort((a, b) => a.version - b.version)
          .map((r) => ({
            version: r.version,
            inspectionType: r.inspectionType,
            conclusion: r.conclusion,
            isEffective: r.isEffective,
            source: r.source,
            inspector: r.inspector,
            inspectedAt: r.inspectedAt,
          })),
      })
    }
    codes.sort((a, b) => (a.unitNo ?? a.barcodeValue).localeCompare(b.unitNo ?? b.barcodeValue))
    const effectiveRows = await this.deps.qd.inspectionChain.listEffectiveByBatch(batch.id)
    const judgements = await this.deps.qd.judgements.listChainByBatch(batch.id)
    return {
      batchNo,
      storageStatus: batch.storageStatus,
      storedInspectionStatus: batch.inspectionStatus,
      recomputedStatus: summarizeBatchInspectionStatus(effectiveRows.map((r) => r.conclusion)),
      codes,
      judgementChain: judgements.map((j) => ({
        version: j.version,
        conclusion: j.conclusion,
        note: j.note,
        judgeBy: j.judgeBy,
        judgedAt: j.judgedAt,
        isEffective: j.isEffective,
      })),
    }
  }

  /** QD-16：撤检/切换结论拦截后的影响圈定（正向追溯 IT-35：批次→已流转产品）。 */
  async forwardImpact(batchNo: string): Promise<Array<{ toType: string; toId: string; edgeKind: string; quantity: string }> | null> {
    const batch = await this.deps.qd.batchQc.findByNo(batchNo)
    if (batch === null) return null
    return this.deps.qd.trace.forwardImpactByBatch(batch.id)
  }

  /** 处置记录列表（QD-20 四类＋存疑恢复；放行/报废 reason 落库）。 */
  async dispositionList(plantId: string, unitNo: string): Promise<unknown[]> {
    return this.deps.qd.dispositions.listByUnitNo(plantId, unitNo, 100)
  }
}
