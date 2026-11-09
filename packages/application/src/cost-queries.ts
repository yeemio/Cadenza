 
import {
  computeOee,
  configuredOeeBasis, equipmentOeeOutput, oeeIntervalMinutes, oeeDowntimeInPlan, validOeeWindow,
  div4Safe,
} from '@cadenza/domain'
import type { VerifiedAuthContext } from './session-verifier'
import type {
  CostAcquisitionLineRepository,
  CostAcquisitionRunRepository,
  CostAllocationVersionRepository,
  CostFactReaders,
  CostLaborCheckRepository,
  CostMeterReadingRepository,
  CostMeterRepository,
  CostPriceVersionRepository,
  CostReconItemRepository,
} from './cost-repositories'

/**
 * cost 域查询服务（只读；数据范围服务端过滤 OA-24/25；CE-02 不触发任何业务写）。
 *
 * 查询面（7）：
 * - orderCostSummary：订单成本 估算/实测两列（CE-17）+ 在制按工序已投入（CE-18）；
 * - acquisitionDetail：归集产出+明细（CE-15 源事实回算路径）；
 * - energyIntensity：产品族/订单级能源单耗+覆盖率（CE-09）；
 * - oee：设备 OEE（CE-10 分母齐备后计算，缺项展示）；
 * - reconList / laborCheckList：对账清单（CE-S5）/工时核对（CA-12 差异分析报表）；
 * - meters/readings/versions：配置查询。
 */
export interface CostQueryDeps {
  meters: CostMeterRepository
  readings: CostMeterReadingRepository
  allocationVersions: CostAllocationVersionRepository
  priceVersions: CostPriceVersionRepository
  runs: CostAcquisitionRunRepository
  lines: CostAcquisitionLineRepository
  reconItems: CostReconItemRepository
  laborChecks: CostLaborCheckRepository
  facts: CostFactReaders
}

export class CostQueryService {
  constructor(private readonly deps: CostQueryDeps) {}

  private plantScope(auth: VerifiedAuthContext): string[] | null {
    return auth.dataScope.enterpriseWide ? null : auth.dataScope.plantIds
  }

  // ---------------- 订单成本汇总（CE-17/CE-18） ----------------

  async orderCostSummary(auth: VerifiedAuthContext, orderId: string): Promise<Record<string, unknown> | null> {
    const order = await this.deps.facts.findProductionOrder(orderId)
    if (order === null) return null
    if (!this.plantScopeAllows(auth, order.plantId)) return null

    const runs = await this.deps.runs.listPaged({ plantIds: this.plantScope(auth), orderId, page: 1, pageSize: 1 })
    const latest = runs.items[0] ?? null
    const bomLines = await this.deps.facts.findPublishedBomLines(orderId)
    const priceItems = latest === null ? [] : await this.deps.priceVersions.findItems(latest.priceVersionId)
    const estimate = bomLines === null
      ? { possible: false, missingReason: '无已发布 BOM 版本（估算缺项）', amount: null, lines: [] }
      : {
          possible: true,
          missingReason: null,
          amount: null as string | null,
          lines: bomLines.map((line) => {
            const price = priceItems.find((p) => p.materialCode === line.materialCode)
            const theoreticalQty = (Number(line.qtyPerUnit) * Number(order.plannedQty)).toFixed(4)
            if (price === undefined) {
              return { materialCode: line.materialCode, theoreticalQty, unitPrice: null, uomCode: line.uomCode, amount: null, priceMissing: true }
            }
            return {
              materialCode: line.materialCode,
              theoreticalQty,
              unitPrice: price.unitPrice,
              uomCode: line.uomCode,
              amount: (Number(theoreticalQty) * Number(price.unitPrice)).toFixed(4),
              priceMissing: false,
            }
          }),
        }
    if (estimate.possible) {
      estimate.amount = estimate.lines.some((l: { priceMissing: boolean }) => l.priceMissing)
        ? null
        : (estimate.lines as Array<{ amount: string | null }>).reduce((acc, l) => acc + Number(l.amount ?? 0), 0).toFixed(4)
      if (estimate.amount === null) estimate.missingReason = '存在缺价行（数量列示+缺价标注，不填默认价 CE-14）'
    }

    // CE-18：在制按工序已投入（材料+工时，实测口径）——取最新 run 明细聚合
    const wipByOperation = new Map<string, { orderOperationId: string | null; operationSeq: number | null; materialQty: number; materialAmount: number | null; laborHours: number }>()
    const ops = await this.deps.facts.listOrderOperations(orderId)
    const opById = new Map(ops.map((o) => [o.id, o]))
    if (latest !== null) {
      const lines = await this.deps.lines.listByRun(latest.id)
      for (const line of lines) {
        if (line.sourceKind !== 'material' && line.sourceKind !== 'labor') continue
        const key = line.orderOperationId ?? ''
        const agg = wipByOperation.get(key) ?? {
          orderOperationId: line.orderOperationId,
          operationSeq: line.orderOperationId !== null ? opById.get(line.orderOperationId)?.seq ?? null : null,
          materialQty: 0,
          materialAmount: 0,
          laborHours: 0,
        }
        if (line.sourceKind === 'material') {
          agg.materialQty += Number(line.quantity)
          agg.materialAmount = line.amount === null ? null : (agg.materialAmount ?? 0) + Number(line.amount)
        } else {
          agg.laborHours += Number(line.quantity)
        }
        wipByOperation.set(key, agg)
      }
    }

    return {
      orderId: order.id,
      orderNo: order.orderNo,
      orderStatus: order.orderStatus,
      plannedQty: order.plannedQty,
      // CE-17：两列并存
      estimate,
      actual: latest === null ? null : {
        runId: latest.id,
        runNo: latest.runNo,
        shiftDate: latest.shiftDate,
        dataCutoffAt: latest.dataCutoffAt,
        amount: latest.actualAmount,
        estimateAmount: latest.estimateAmount,
        anyPriceMissing: latest.actualAmount === null,
        laborSource: latest.laborSource,
        equipmentCostCaliber: latest.equipmentCostCaliber,
      },
      // CE-18：在制按工序已投入（实测口径）
      wipByOperation: [...wipByOperation.values()].map((w) => ({
        orderOperationId: w.orderOperationId,
        operationSeq: w.operationSeq,
        materialQty: w.materialQty.toFixed(4),
        materialAmount: w.materialAmount === null ? null : w.materialAmount.toFixed(4),
        laborHours: w.laborHours.toFixed(4),
      })),
    }
  }

  // ---------------- 归集明细（CE-15 回算路径） ----------------

  async acquisitionDetail(auth: VerifiedAuthContext, runId: string): Promise<Record<string, unknown> | null> {
    const run = await this.deps.runs.findById(runId)
    if (run === null) return null
    if (!this.plantScopeAllows(auth, run.plantId)) return null
    const lines = await this.deps.lines.listByRun(runId)
    return {
      run: {
        runId: run.id,
        runNo: run.runNo,
        orderId: run.orderId,
        allocationVersionId: run.allocationVersionId,
        priceVersionId: run.priceVersionId,
        shiftDate: run.shiftDate,
        shiftCalendarId: run.shiftCalendarId,
        dataCutoffAt: run.dataCutoffAt,
        shiftSnapshotAnchor: run.shiftSnapshotAnchor,
        estimateAmount: run.estimateAmount,
        actualAmount: run.actualAmount,
        energyMeteredUsage: run.energyMeteredUsage,
        energyEstimatedUsage: run.energyEstimatedUsage,
        energyCoverageRatio: run.energyCoverageRatio,
        machineHours: run.machineHours,
        laborSource: run.laborSource,
        equipmentCostCaliber: run.equipmentCostCaliber,
        recalcOf: run.recalcOf,
        oldNewComparison: run.oldNewComparison,
      },
      lines: lines.map((l) => ({
        lineId: l.id,
        lineNo: l.lineNo,
        sourceKind: l.sourceKind,
        sourceTable: l.sourceTable,
        sourceFactId: l.sourceFactId,
        valueFlag: l.valueFlag,
        orderOperationId: l.orderOperationId,
        productFamilyId: l.productFamilyId,
        quantity: l.quantity,
        uomCode: l.uomCode,
        theoreticalQuantity: l.theoreticalQuantity,
        varianceQuantity: l.varianceQuantity,
        destinationBreakdownMissing: l.destinationBreakdownMissing,
        unitPrice: l.unitPrice,
        priceMissing: l.priceMissing,
        amount: l.amount,
        facts: l.facts,
      })),
    }
  }

  // ---------------- 能源单耗与覆盖率（CE-09） ----------------

  async energyIntensity(
    auth: VerifiedAuthContext,
    filter: { plantId?: string; shiftDate?: string; page?: number; pageSize?: number },
  ): Promise<{ items: Array<Record<string, unknown>>; total: number }> {
    const runs = await this.deps.runs.listPaged({
      plantIds: this.plantScope(auth),
      plantId: filter.plantId,
      shiftDate: filter.shiftDate,
      page: filter.page ?? 1,
      pageSize: filter.pageSize ?? 20,
    })
    const items: Array<Record<string, unknown>> = []
    for (const run of runs.items) {
      const order = await this.deps.facts.findProductionOrder(run.orderId)
      const lines = await this.deps.lines.listByRun(run.id)
      const energyLines = lines.filter((l) => l.sourceKind === 'energy')
      const metered = energyLines.filter((l) => l.valueFlag === 'measured')
      const estimated = energyLines.filter((l) => l.valueFlag === 'estimated')
      const meteredUsage = metered.reduce((acc, l) => acc + Number(l.quantity), 0)
      const estimatedUsage = estimated.reduce((acc, l) => acc + Number(l.quantity), 0)
      const totalUsage = meteredUsage + estimatedUsage
      const outputs = await this.deps.facts.listOutputsByOrder(run.orderId, run.dataCutoffAt)
      const totalOutput = outputs.reduce((acc, o) => acc + Number(o.quantity), 0)
      items.push({
        runId: run.id,
        orderNo: order?.orderNo ?? null,
        productFamilyId: order?.productFamilyId ?? null,
        shiftDate: run.shiftDate,
        meteredUsage: meteredUsage.toFixed(4),
        estimatedUsage: estimatedUsage.toFixed(4),
        coverageRatio: totalUsage === 0 ? null : div4Safe(meteredUsage.toFixed(4), totalUsage.toFixed(4)),
        uomCode: run.energyUomCode,
        outputQty: totalOutput.toFixed(4),
        intensityPerOutput: totalUsage > 0 && totalOutput > 0 ? div4Safe(totalUsage.toFixed(4), totalOutput.toFixed(4)) : null,
      })
    }
    return { items, total: runs.total }
  }

  // ---------------- OEE（CE-10） ----------------

  async oee(
    auth: VerifiedAuthContext,
    input: { plantId: string; equipmentCode: string; windowStart: string; windowEnd: string },
  ): Promise<Record<string, unknown> | null> {
    if (!this.plantScopeAllows(auth, input.plantId)) return null
    const equipment = await this.deps.facts.findEquipmentByCode(input.plantId, input.equipmentCode)
    if (equipment === null || equipment.enterpriseId !== auth.user.enterpriseId || equipment.plantId !== input.plantId) return null
    const windowValid=validOeeWindow(input.windowStart,input.windowEnd)
    const basis=configuredOeeBasis(process.env['CADENZA_OEE_BASES'],equipment.id)
    const facts=windowValid?await this.deps.facts.equipmentOeeFacts(equipment.id,input.windowStart,input.windowEnd):{outputs:[],downtime:[],downtimeFactCount:0}
    const output=equipmentOeeOutput(facts.outputs,equipment,basis)
    const plannedMinutes=basis&&windowValid?oeeIntervalMinutes(basis.plannedIntervals,input.windowStart,input.windowEnd):null
    const downtimeMinutes=basis&&windowValid&&facts.downtimeFactCount>0?oeeDowntimeInPlan(facts.downtime,basis.plannedIntervals,input.windowStart,input.windowEnd):null
    const result=computeOee({plannedMinutes,downtimeMinutes,standardSpeedPerHour:basis?.standardSpeedPerHour??null,actualOutputQty:output.totalQty,qualifiedQty:output.qualifiedQty})
    const missing=[...new Set([...result.missing,...output.missing,...(!windowValid?['window_invalid']:[]),...(!basis?['equipment_plan_and_rate_basis_missing']:[])])]
    return {
      equipmentId:equipment.id,equipmentCode:equipment.code,windowStart:input.windowStart,windowEnd:input.windowEnd,
      windowSemantics:'[start,end)',plannedTimeBasis:'EXPLICIT_EQUIPMENT_PLAN_INTERSECT_QUERY_WINDOW',
      outputTimeBasis:'SUBMITTED_UNCANCELLED_REPORT_BUSINESS_TIME',equipmentAttributionBasis:'CONSISTENT_REPORT_SESSION_UUID',
      basisId:basis?.basisId??null,outputUomId:basis?.outputUomId??null,outputUomCode:basis?.outputUomCode??null,
      plannedMinutes,downtimeMinutes,standardSpeedPerHour:basis?.standardSpeedPerHour??null,stdRateText:equipment.stdRateText,
      actualOutputQty:output.totalQty,qualifiedQty:output.qualifiedQty,sourceOutputIds:output.rowIds,downtimeFactCount:facts.downtimeFactCount,
      ...result,...(missing.length?{availability:null,performance:null,qualityRate:null,oee:null}:{}),missing,
    }
  }

  // ---------------- 清单查询 ----------------

  async listMeters(auth: VerifiedAuthContext, filter: { plantId?: string; statuses?: string[]; energyTypes?: string[]; page?: number; pageSize?: number }) {
    return this.deps.meters.listPaged({
      plantIds: this.plantScope(auth),
      plantId: filter.plantId,
      statuses: filter.statuses,
      energyTypes: filter.energyTypes,
      page: filter.page ?? 1,
      pageSize: filter.pageSize ?? 20,
    })
  }

  async listReadings(auth: VerifiedAuthContext, filter: { plantId?: string; meterId?: string; page?: number; pageSize?: number }) {
    return this.deps.readings.listPaged({
      plantIds: this.plantScope(auth),
      plantId: filter.plantId,
      meterId: filter.meterId,
      page: filter.page ?? 1,
      pageSize: filter.pageSize ?? 20,
    })
  }

  async listAllocationVersions(auth: VerifiedAuthContext, filter: { plantId?: string; statuses?: string[]; page?: number; pageSize?: number }) {
    const result = await this.deps.allocationVersions.listPaged({
      plantIds: this.plantScope(auth),
      plantId: filter.plantId,
      statuses: filter.statuses,
      page: filter.page ?? 1,
      pageSize: filter.pageSize ?? 20,
    })
    const items = await Promise.all(
      result.items.map(async (v) => ({ ...v, referencedByRuns: await this.deps.allocationVersions.countRunsReferencing(v.id) })),
    )
    return { items, total: result.total }
  }

  async listPriceVersions(auth: VerifiedAuthContext, filter: { plantId?: string; statuses?: string[]; page?: number; pageSize?: number }) {
    return this.deps.priceVersions.listPaged({
      plantIds: this.plantScope(auth),
      plantId: filter.plantId,
      statuses: filter.statuses,
      page: filter.page ?? 1,
      pageSize: filter.pageSize ?? 20,
    })
  }

  async listRuns(auth: VerifiedAuthContext, filter: { plantId?: string; orderId?: string; shiftDate?: string; page?: number; pageSize?: number }) {
    return this.deps.runs.listPaged({
      plantIds: this.plantScope(auth),
      plantId: filter.plantId,
      orderId: filter.orderId,
      shiftDate: filter.shiftDate,
      page: filter.page ?? 1,
      pageSize: filter.pageSize ?? 20,
    })
  }

  async listReconItems(auth: VerifiedAuthContext, filter: { plantId?: string; runId?: string; kinds?: string[]; statuses?: string[]; page?: number; pageSize?: number }) {
    return this.deps.reconItems.listPaged({
      plantIds: this.plantScope(auth),
      plantId: filter.plantId,
      runId: filter.runId,
      kinds: filter.kinds,
      statuses: filter.statuses,
      page: filter.page ?? 1,
      pageSize: filter.pageSize ?? 20,
    })
  }

  async listLaborChecks(auth: VerifiedAuthContext, filter: { plantId?: string; orderId?: string; statuses?: string[]; page?: number; pageSize?: number }) {
    return this.deps.laborChecks.listPaged({
      plantIds: this.plantScope(auth),
      plantId: filter.plantId,
      orderId: filter.orderId,
      statuses: filter.statuses,
      page: filter.page ?? 1,
      pageSize: filter.pageSize ?? 20,
    })
  }

  private plantScopeAllows(auth: VerifiedAuthContext, plantId: string): boolean {
    const scope = this.plantScope(auth)
    return scope === null || scope.includes(plantId)
  }
}

