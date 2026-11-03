import type { PageResult } from '@cadenza/contracts'
 
import {
  buildMiscalibrationCircle,
  calibrationStatusAt,
  computeToolLifeStatus,
  effectiveToolLife,
  isGaugeSchedulableForInspection,
  isToolSchedulable,
  type CircleMeasurementFact,
  type CircleTestResultFact,
  type CircleUnitFact,
} from '@cadenza/domain'
import type { VerifiedAuthContext } from './session-verifier'
import type {
  SpcCalibrationRecord,
  SpcChangeAdjustmentRecord,
  SpcChangeImpactRecord,
  SpcControlItemRecord,
  SpcControlLimitRecord,
  SpcCrossDomainReader,
  SpcMiscalibrationActionRecord,
  SpcOocTaskRecord,
  SpcPointJudgementRecord,
  SpcProcessChangeRecord,
  SpcRepositories,
  SpcRuleSetRecord,
  SpcSampleRecord,
  SpcToolAdjustmentRecord,
  SpcToolConfigRecord,
  SpcToolLedgerRecord,
  SpcToolUsageRecord,
} from './spc-repositories'

/**
 * spc 域查询服务（读侧，池连接只读；许可由 HTTP 守卫首检，数据范围在本服务内
 * 按授权上下文服务端过滤——与 quality/purchase 查询同口径）。
 *
 * PE-18 失准圈定为可重建查询视图（PE-S4：从 实测→结论→批次链路重建，
 * 不落地为可改写表）；PE-06 变更影响查询三类清单；PE-12 处置链可查。
 */

export interface SpcQueryDeps {
  spc: SpcRepositories
  cross: SpcCrossDomainReader
}

function toPageRequest(query: { page?: number; pageSize?: number }): { page: number; pageSize: number } {
  const page = typeof query.page === 'number' && Number.isInteger(query.page) && query.page >= 1 ? query.page : 1
  const pageSize =
    typeof query.pageSize === 'number' && Number.isInteger(query.pageSize) && query.pageSize >= 1
      ? Math.min(query.pageSize, 100)
      : 20
  return { page, pageSize }
}

export class SpcQueryService {
  constructor(private readonly deps: SpcQueryDeps) {}

  /** 数据范围折算：企业范围 → null（不过滤）；否则限定授权工厂集合。 */
  private plantScope(auth: VerifiedAuthContext): string[] | null {
    return auth.dataScope.enterpriseWide ? null : auth.dataScope.plantIds
  }

  // ---------------- 工艺变更（PE-05/PE-06） ----------------

  async listChanges(
    auth: VerifiedAuthContext,
    query: { plantId?: string; statuses?: string[]; page?: number; pageSize?: number },
  ): Promise<
    PageResult<SpcProcessChangeRecord & { impactSummary: { unexecuted: number; inProcess: number; completed: number } }>
  > {
    const pageRequest = toPageRequest(query)
    const page = await this.deps.spc.changes.listPaged({
      plantIds: this.plantScope(auth),
      plantId: query.plantId,
      statuses: query.statuses,
      ...pageRequest,
    })
    const items = await Promise.all(
      page.items.map(async (change) => {
        const impacts = await this.deps.spc.impacts.listByChange(change.id)
        return {
          ...change,
          impactSummary: {
            unexecuted: impacts.filter((i) => i.category === 'unexecuted').length,
            inProcess: impacts.filter((i) => i.category === 'in_process').length,
            completed: impacts.filter((i) => i.category === 'completed').length,
          },
        }
      }),
    )
    return { items, total: page.total, ...pageRequest }
  }

  /** PE-05/PE-06 变更详情：版本对/审批人/生效时间 + 三类影响清单（含处置结论）+ 调整指令。 */
  async changeDetail(
    auth: VerifiedAuthContext,
    changeId: string,
  ): Promise<{
    change: SpcProcessChangeRecord
    oldSpecLabel: string
    newSpecLabel: string
    impacts: SpcChangeImpactRecord[]
    adjustments: SpcChangeAdjustmentRecord[]
  } | null> {
    const change = await this.deps.spc.changes.findById(changeId)
    if (change === null) return null
    const scope = this.plantScope(auth)
    if (scope !== null && !scope.includes(change.plantId)) return null
    const [oldSpec, newSpec] = await Promise.all([
      this.deps.cross.getProcessSpecRevision(change.oldSpecRevisionId),
      this.deps.cross.getProcessSpecRevision(change.newSpecRevisionId),
    ])
    const label = (s: { name: string; version: number; status: string } | null): string =>
      s === null ? '(版本不存在)' : `${s.name} v${s.version}（${s.status}）`
    return {
      change,
      oldSpecLabel: label(oldSpec),
      newSpecLabel: label(newSpec),
      impacts: await this.deps.spc.impacts.listByChange(changeId),
      adjustments: await this.deps.spc.adjustments.listByChange(changeId),
    }
  }

  // ---------------- 规则集/受控项目/控制图（PE-08~PE-14） ----------------

  async listRuleSets(
    auth: VerifiedAuthContext,
    query: { plantId?: string; statuses?: string[]; page?: number; pageSize?: number },
  ): Promise<PageResult<SpcRuleSetRecord>> {
    const pageRequest = toPageRequest(query)
    const page = await this.deps.spc.ruleSets.listPaged({
      plantIds: this.plantScope(auth),
      plantId: query.plantId,
      statuses: query.statuses,
      ...pageRequest,
    })
    return { items: page.items, total: page.total, ...pageRequest }
  }

  async listControlItems(
    auth: VerifiedAuthContext,
    query: { plantId?: string; page?: number; pageSize?: number },
  ): Promise<PageResult<SpcControlItemRecord>> {
    const pageRequest = toPageRequest(query)
    const page = await this.deps.spc.controlItems.listPaged({
      plantIds: this.plantScope(auth),
      plantId: query.plantId,
      ...pageRequest,
    })
    return { items: page.items, total: page.total, ...pageRequest }
  }

  /** 控制图视图（PE-14：样本带工序执行实例引用与定位字段；判定带判定时点版本）。 */
  async controlChart(
    auth: VerifiedAuthContext,
    controlItemId: string,
  ): Promise<{
    controlItem: SpcControlItemRecord
    ruleSet: { ruleSetId: string; name: string; version: number; chartType: string; criteria: string[]; isDefault: boolean } | null
    limitVersions: SpcControlLimitRecord[]
    samples: Array<SpcSampleRecord & { judgement: SpcPointJudgementRecord | null }>
  } | null> {
    const item = await this.deps.spc.controlItems.findById(controlItemId)
    if (item === null) return null
    const scope = this.plantScope(auth)
    if (scope !== null && !scope.includes(item.plantId)) return null
    let ruleSet: SpcRuleSetRecord | null = null
    if (item.ruleSetId !== null) {
      ruleSet = await this.deps.spc.ruleSets.findByIdOrNull(item.ruleSetId)
    }
    if (ruleSet === null) {
      ruleSet = await this.deps.spc.ruleSets.findLatestPublished(item.plantId, '__default__')
    }
    const [limitVersions, samples, judgements] = await Promise.all([
      this.deps.spc.controlLimits.listByItem(controlItemId),
      this.deps.spc.samples.listAdmittedByItem(controlItemId),
      this.deps.spc.judgements.listByItem(controlItemId),
    ])
    // PE-18 全量样本视图：被拒样本也在样本表中——控制图只看已准入；被拒样本经 gauge 视图/圈定可见
    const judgementBySample = new Map(judgements.map((j) => [j.sampleId, j]))
    return {
      controlItem: item,
      ruleSet:
        ruleSet === null
          ? null
          : {
              ruleSetId: ruleSet.id,
              name: ruleSet.name,
              version: ruleSet.version,
              chartType: ruleSet.chartType,
              criteria: ruleSet.criteria,
              isDefault: ruleSet.isDefault,
            },
      limitVersions,
      samples: samples.map((s) => ({ ...s, judgement: judgementBySample.get(s.id) ?? null })),
    }
  }

  // ---------------- 失控处置链（PE-12） ----------------

  async listOocTasks(
    auth: VerifiedAuthContext,
    query: { plantId?: string; statuses?: string[]; page?: number; pageSize?: number },
  ): Promise<PageResult<SpcOocTaskRecord>> {
    const pageRequest = toPageRequest(query)
    const page = await this.deps.spc.oocTasks.listPaged({
      plantIds: this.plantScope(auth),
      plantId: query.plantId,
      statuses: query.statuses,
      ...pageRequest,
    })
    return { items: page.items, total: page.total, ...pageRequest }
  }

  /** 处置链可查（PE-12）：任务 + 失控样本 + 判定（含命中准则与判定时点版本）。 */
  async oocTaskDetail(
    auth: VerifiedAuthContext,
    oocTaskId: string,
  ): Promise<{
    task: SpcOocTaskRecord
    sample: SpcSampleRecord | null
    judgement: SpcPointJudgementRecord | null
  } | null> {
    const task = await this.deps.spc.oocTasks.findById(oocTaskId)
    if (task === null) return null
    const scope = this.plantScope(auth)
    if (scope !== null && !scope.includes(task.plantId)) return null
    const sample = await this.deps.spc.samples.findById(task.sampleId)
    const judgement = sample === null ? null : await this.deps.spc.judgements.findBySample(sample.id)
    return { task, sample, judgement }
  }

  // ---------------- 器具与校准（PE-15/16/17） ----------------

  async gaugeDetail(
    auth: VerifiedAuthContext,
    gaugeId: string,
  ): Promise<{
    gauge: { id: string; gaugeNo: string; name: string; gaugeKind: string | null; plantId: string }
    calibrationStatus: string
    schedulableForInspection: boolean
    calibrationHistory: SpcCalibrationRecord[]
  } | null> {
    const gauge = await this.deps.spc.gauges.findById(gaugeId)
    if (gauge === null) return null
    const scope = this.plantScope(auth)
    if (scope !== null && !scope.includes(gauge.plantId)) return null
    const history = await this.deps.spc.calibrations.listByGauge(gaugeId)
    const now = new Date().toISOString()
    const status = calibrationStatusAt(
      history.map((r) => ({ calibratedAt: r.calibratedAt, result: r.result, validUntil: r.validUntil })),
      now,
    )
    return {
      gauge: { id: gauge.id, gaugeNo: gauge.gaugeNo, name: gauge.name, gaugeKind: gauge.gaugeKind, plantId: gauge.plantId },
      calibrationStatus: status,
      schedulableForInspection: isGaugeSchedulableForInspection(status),
      calibrationHistory: history,
    }
  }

  // ---------------- 失准圈定（PE-18/PE-19；PE-S4 只读重建） ----------------

  async miscalibrationCircle(
    auth: VerifiedAuthContext,
    gaugeId: string,
    windowFrom: string,
    windowTo: string,
  ): Promise<{
    gauge: { id: string; gaugeNo: string; name: string }
    circle: ReturnType<typeof buildMiscalibrationCircle>
    actions: SpcMiscalibrationActionRecord[]
    dispositionProgress: { acted: number; pending: number }
  } | null> {
    const gauge = await this.deps.spc.gauges.findById(gaugeId)
    if (gauge === null) return null
    const scope = this.plantScope(auth)
    if (scope !== null && !scope.includes(gauge.plantId)) return null

    // 事实收集：该器具全部样本（含被拒）→ 检验结论/放行 → 单元/批次/订单状态
    const samples = await this.deps.spc.samples.listByGauge(gaugeId)
    const measurementFacts: CircleMeasurementFact[] = []
    const testResultFacts = new Map<string, CircleTestResultFact>()
    const unitFacts = new Map<string, CircleUnitFact>()
    for (const s of samples) {
      let productionOrderNo: string | null = null
      if (s.productionOrderId !== null) {
        const order = await this.deps.cross.getProductionOrderById(s.productionOrderId)
        productionOrderNo = order?.orderNo ?? null
      }
      let orderNo: string | null = null
      let lotNo: string | null = null
      if (s.testResultId !== null) {
        const tr = await this.deps.cross.getTestResult(s.testResultId)
        if (tr !== null) {
          const io = await this.deps.cross.getInspectionOrder(tr.inspectionOrderId)
          const dispositions = await this.deps.cross.listDispositionsByInspectionOrder(tr.inspectionOrderId)
          const release = dispositions.length > 0 ? dispositions[dispositions.length - 1]! : null
          let productionOrderStatus: string | null = null
          if (io?.productionOrderNo) {
            productionOrderStatus = await this.deps.cross.getProductionOrderStatus(io.productionOrderNo)
          }
          let lotNoInner: string | null = null
          if (io?.lotId) {
            lotNoInner = (await this.deps.cross.getMaterialLot(io.lotId))?.lotNo ?? null
          }
          testResultFacts.set(tr.id, {
            testResultId: tr.id,
            conclusion: tr.conclusion,
            inspectedAt: tr.inspectedAt,
            inspector: tr.inspector,
            inspectionOrderNo: io?.orderNo ?? '(检验单缺失)',
            inspectionOrderStatus: io?.status ?? 'unknown',
            productionOrderNo: io?.productionOrderNo ?? null,
            productionOrderStatus,
            inventoryUnitId: io?.inventoryUnitId ?? null,
            unitNo: io?.unitNo ?? null,
            lotNo: lotNoInner,
            lotId: io?.lotId ?? null,
            materialCode: io?.materialCode ?? null,
            releasedBy: release?.releasedBy ?? null,
            releasedAt: release?.releasedAt ?? null,
            releaseKind: release?.dispositionKind ?? null,
          })
          if (io?.inventoryUnitId) {
            const unit = await this.deps.cross.getInventoryUnit(io.inventoryUnitId)
            if (unit !== null) {
              unitFacts.set(unit.id, {
                inventoryUnitId: unit.id,
                unitNo: unit.unitNo,
                status: unit.status,
                lotNo: lotNoInner,
                materialCode: io.materialCode,
                productionOrderNo: io.productionOrderNo ?? null,
                productionOrderStatus,
              })
            }
          }
          orderNo = io?.unitNo ?? null
          lotNo = lotNoInner
        }
      }
      measurementFacts.push({
        sampleId: s.id,
        source: s.source,
        sampledAt: s.sampledAt,
        measuredValue: s.measuredValue,
        admission: s.admission,
        testResultId: s.testResultId,
        productionOrderNo,
        operationSeq: s.operationSeq,
        inventoryUnitId: null,
        unitNo: orderNo,
        lotNo,
      })
    }

    const circle = buildMiscalibrationCircle({
      windowFrom,
      windowTo,
      measurements: measurementFacts,
      testResults: [...testResultFacts.values()],
      units: [...unitFacts.values()],
    })
    const actions = await this.deps.spc.miscalibrationActions.listByGaugeWindow(gaugeId, windowFrom, windowTo)
    const totalItems =
      circle.measurements.length +
      circle.inspectionConclusions.length +
      circle.releases.length +
      circle.lots.length +
      circle.wipOrders.length +
      circle.stockUnits.length +
      circle.shippedUnits.length
    const actedRefs = new Set(actions.map((a) => a.itemRef))
    const acted = actedRefs.size
    return {
      gauge: { id: gauge.id, gaugeNo: gauge.gaugeNo, name: gauge.name },
      circle,
      actions,
      dispositionProgress: { acted, pending: Math.max(0, totalItems - acted) },
    }
  }

  // ---------------- 工具寿命（PE-20/PE-21） ----------------

  async listTools(
    auth: VerifiedAuthContext,
    query: { plantId?: string; page?: number; pageSize?: number },
  ): Promise<
    PageResult<
      SpcToolLedgerRecord & {
        adjustmentSum: string
        effectiveLife: string
        status: string
        schedulableForScheduling: boolean
      }
    >
  > {
    const pageRequest = toPageRequest(query)
    const page = await this.deps.spc.tools.listPaged({
      plantIds: this.plantScope(auth),
      plantId: query.plantId,
      ...pageRequest,
    })
    const items = await Promise.all(
      page.items.map(async (tool) => {
        const adjustmentSum = await this.deps.spc.toolAdjustments.sumByTool(tool.id)
        const effective = effectiveToolLife({ accumulated: tool.accumulatedLife, adjustmentSum })
        const status = computeToolLifeStatus({
          ratedLife: tool.ratedLife,
          warningThreshold: tool.warningThreshold,
          effectiveLife: effective,
        })
        return {
          ...tool,
          adjustmentSum,
          effectiveLife: effective,
          status,
          schedulableForScheduling: isToolSchedulable({ status, expirePolicy: tool.expirePolicy }),
        }
      }),
    )
    return { items, total: page.total, ...pageRequest }
  }

  async toolDetail(
    auth: VerifiedAuthContext,
    toolId: string,
  ): Promise<{
    tool: SpcToolLedgerRecord
    adjustmentSum: string
    effectiveLife: string
    status: string
    schedulableForScheduling: boolean
    configHistory: SpcToolConfigRecord[]
    usage: SpcToolUsageRecord[]
    adjustments: SpcToolAdjustmentRecord[]
  } | null> {
    const tool = await this.deps.spc.tools.findById(toolId)
    if (tool === null) return null
    const scope = this.plantScope(auth)
    if (scope !== null && !scope.includes(tool.plantId)) return null
    const [configs, usage, adjustments] = await Promise.all([
      this.deps.spc.toolConfigs.listByTool(toolId),
      this.deps.spc.toolUsages.listByTool(toolId),
      this.deps.spc.toolAdjustments.listByTool(toolId),
    ])
    const adjustmentSum = await this.deps.spc.toolAdjustments.sumByTool(toolId)
    const effective = effectiveToolLife({ accumulated: tool.accumulatedLife, adjustmentSum })
    const status = computeToolLifeStatus({
      ratedLife: tool.ratedLife,
      warningThreshold: tool.warningThreshold,
      effectiveLife: effective,
    })
    return {
      tool,
      adjustmentSum,
      effectiveLife: effective,
      status,
      schedulableForScheduling: isToolSchedulable({ status, expirePolicy: tool.expirePolicy }),
      configHistory: configs,
      usage,
      adjustments,
    }
  }
}
