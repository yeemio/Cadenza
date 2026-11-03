import { ERROR_CODES } from '@cadenza/contracts'
import {
  DEFAULT_METRIC_DEFINITIONS,
  METRIC_FAMILIES,
  ReportingRuleViolation,
  assertGroupKeyShape,
  parseFactSetSpec,
  pickEffectiveDefinition,
  resolveSnapshotValue,
  type FactSetKey,
  type MetricFamily,
} from '@cadenza/domain'
import type { CommandContext, CommandHandler, HandlerOutcome } from './command-bus'
import type { ReportingCommandTools } from './reporting-repositories'

/**
 * reporting 域维护命令处理器（T20 只读投影域——命令只写本域投影表，不触碰业务表）。
 *
 * 命令面（3）：
 * - reporting.stock-stat.rebuild：库存统计投影全量重建（RP-07/S1：可由事件源全量重建、
 *   重建幂等、不重新执行报工或扣库存）；
 * - reporting.shift-snapshot.rebuild：班次快照重算（RP-18/S2：按 (工厂,班次日,指标,版本)
 *   幂等键覆盖；失败与缺失分母保留标记 RP-21；引用后置 referenced——RP-S3 immutable）；
 * - reporting.metric-definition.register：注册指标定义新版本（RP-19：版本化；
 *   referenced 行不可变由库级守卫双保险）。
 *
 * 幂等/回执由 PgCommandBus 承担；规则违例以 [RP-xx] 前缀返回（BUSINESS_REJECTION）。
 * O-8 统一审计（PM 增量单 §3，2026-10-29）：三命令各写一行 audit_entry（tools.audit，
 * 同事务）——操作者 actor/reason + before/after 摘要（register=前一 active 版本指针与新
 * 版本号；rebuild=范围与结果计数）；版本链与命令回执照旧承担事实还原，不重复记账。
 * 首期四族默认定义（[合同新造]最小示例集，GAP-F24/F25 待裁）由 metric-definition.register
 * 逐条注册（载荷 metricKeys=['*'] 时注册全部默认定义）。
 */

type Payload = Record<string, unknown>

function reportingViolationOutcome(error: ReportingRuleViolation): HandlerOutcome {
  let errorCode: string = ERROR_CODES.BUSINESS_RULE
  if (error.rule === 'A-S1') errorCode = ERROR_CODES.FORBIDDEN_SCOPE
  else if (error.rule === 'RP-NOT-FOUND') errorCode = ERROR_CODES.NOT_FOUND
  return { status: 'BUSINESS_REJECTION', errorCode, errorMessage: `[${error.rule}] ${error.message}` }
}

async function run(body: () => Promise<Record<string, unknown>>): Promise<HandlerOutcome> {
  try {
    const data = await body()
    return { status: 'COMMITTED', data }
  } catch (error) {
    if (error instanceof ReportingRuleViolation) return reportingViolationOutcome(error)
    throw error
  }
}

function str(p: Payload, key: string): string | undefined {
  const v = p[key]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function requireStr(p: Payload, key: string, command: string): string {
  const v = str(p, key)
  if (v === undefined) throw new ReportingRuleViolation('RP-19', `${command}：载荷缺少必填字段 ${key}`)
  return v
}

/** 组织范围二道防线（OA-24/26，同 shipping 口径）。 */
async function assertPlantScope(tools: ReportingCommandTools, plantId: string): Promise<void> {
  const scope = await tools.actorDataScope()
  if (!scope.enterpriseWide && !scope.plantIds.includes(plantId)) {
    throw new ReportingRuleViolation('A-S1', `目标工厂不在授权数据范围内（plant=${plantId}）`)
  }
}

// ---------------- 命令：库存统计投影全量重建（RP-07/RP-S1） ----------------

async function stockStatRebuild(
  tools: ReportingCommandTools,
  ctx: CommandContext,
  p: Payload,
): Promise<Record<string, unknown>> {
  const plantId = str(p, 'plantId')
  if (plantId !== undefined) await assertPlantScope(tools, plantId)
  const { reporting } = tools
  // 只读既有域业务事实 → 同事务 DELETE（范围）+ INSERT（RP-07：投影可从事件全量重建；
  // 重建不重新执行报工或扣库存——本命令对业务表零写入）
  const rows = await reporting.sources.collectStockStatSource(plantId)
  for (const row of rows) {
    assertGroupKeyShape(
      row.statKind === 'purchase_receive'
        ? {
            kind: 'purchase_receive',
            unitNo: row.unitNo,
            lotNo: row.lotNo ?? '',
            supplierLotNo: row.supplierLotNo,
            materialCode: row.materialCode,
          }
        : { kind: 'production', unitNo: row.unitNo, orderNo: row.orderNo ?? '', operationSeq: row.operationSeq },
    )
  }
  const projected = await reporting.projections.replaceAll(rows, { plantId, actor: ctx.actorLoginName })
  // O-8 统一审计（一行/命令，OA-28；同事务 OA-26）：操作者 + 范围 + 结果计数；
  // 版本链/回执不重复记账（PM 增量单 §3-O-8 裁定：只补缺失的统一审计行）
  await tools.audit.record({
    actor: ctx.actorLoginName,
    action: 'reporting.stock-stat.rebuild',
    subjectType: 'stock_stat_projection',
    subjectId: plantId ?? 'all-plants',
    after: { scope: plantId ?? 'all-plants', rowsProjected: projected },
    reason: str(p, 'reason') ?? ctx.reason ?? null,
  })
  return { rowsProjected: projected, scope: plantId === undefined ? 'all-plants' : plantId }
}

// ---------------- 命令：班次快照重算（RP-18~RP-22/RP-S2） ----------------

interface DefinitionForEngine {
  id: string
  metricKey: string
  version: number
  caliberVersion: string
  numeratorKind: FactSetKey
  denominatorKind: FactSetKey | null
  uomCode: string
  uomMode: 'plain' | 'percent'
}

async function shiftSnapshotRebuild(
  tools: ReportingCommandTools,
  ctx: CommandContext,
  p: Payload,
): Promise<Record<string, unknown>> {
  const { reporting } = tools
  const plantId = requireStr(p, 'plantId', 'reporting.shift-snapshot.rebuild')
  await assertPlantScope(tools, plantId)
  const shiftDateParam = str(p, 'shiftDate')
  if (shiftDateParam !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(shiftDateParam)) {
    throw new ReportingRuleViolation('RP-18', `班次日期非法（yyyy-MM-dd）：${shiftDateParam}`)
  }
  const metricKeysParam = Array.isArray(p['metricKeys'])
    ? (p['metricKeys'] as unknown[]).filter((k): k is string => typeof k === 'string' && k.length > 0)
    : undefined

  const plant = await tools.org.findById(plantId)
  if (plant === null) {
    throw new ReportingRuleViolation('RP-NOT-FOUND', `目标工厂不存在（plant=${plantId}）`)
  }

  // 指标定义版本选择（RP-19）：active 且生效区间内取最高版本；引用后置位（RP-S3 immutable）
  const allDefinitions = await reporting.definitions.listAll()
  const shiftDates = shiftDateParam === undefined ? await reporting.facts.listShiftDates(plantId) : [shiftDateParam]

  const targets: Array<{ shiftDate: string; def: DefinitionForEngine }> = []
  for (const shiftDate of shiftDates) {
    for (const def of allDefinitions) {
      if (def.status !== 'active') continue
      if (metricKeysParam !== undefined && !metricKeysParam.includes(def.metricKey)) continue
      // RP-19 版本选择按指标 key 分组：同 key 内取生效区间内的最高 active 版本
      // （pickEffectiveDefinition 为全列表择优，跨 key 混入会错选——按 key 过滤后传入）
      const effective = pickEffectiveDefinition(
        allDefinitions
          .filter((d) => d.metricKey === def.metricKey)
          .map((d) => ({
            metricKey: d.metricKey,
            version: d.version,
            status: d.status,
            effectiveFrom: d.effectiveFrom,
            effectiveTo: d.effectiveTo,
          })),
        shiftDate,
      )
      if (effective === null || effective.version !== def.version) continue
      targets.push({
        shiftDate,
        def: {
          id: def.id,
          metricKey: def.metricKey,
          version: def.version,
          caliberVersion: def.caliberVersion,
          numeratorKind: parseFactSetSpec(def.numeratorFactSet).kind,
          denominatorKind: def.denominatorFactSet === null ? null : parseFactSetSpec(def.denominatorFactSet).kind,
          uomCode: def.uomCode,
          uomMode: def.uomMode,
        },
      })
    }
  }

  const snapshots: Array<import('./reporting-repositories').ShiftSnapshotUpsert> = []
  for (const target of targets) {
    const { def } = target
    const factArgs = { plantId, shiftDate: target.shiftDate, uomCode: def.uomCode }
    try {
      const numerator = await reporting.facts.calculate(def.numeratorKind, factArgs)
      const denominator =
        def.denominatorKind === null ? null : await reporting.facts.calculate(def.denominatorKind, factArgs)
      const resolution = resolveSnapshotValue(
        {
          numeratorValue: numerator.value,
          denominatorValue: denominator === null ? null : denominator.value,
        },
        def.uomMode,
        def.metricKey,
      )
      snapshots.push({
        plantId,
        enterpriseId: plant.enterpriseId,
        shiftDate: target.shiftDate,
        metricKey: def.metricKey,
        metricVersion: def.version,
        caliberVersion: def.caliberVersion,
        numeratorValue: numerator.value,
        denominatorValue: denominator === null ? null : denominator.value,
        value: resolution.value,
        uomCode: def.uomCode,
        status: resolution.status,
        missingReason: resolution.missingReason,
        sourceRows: numerator.rows,
        computedBy: ctx.actorLoginName,
        // command_receipt_id 为 uuid FK，而命令总线只向处理器暴露 operationId（自由文本）
        // ——不冒充写入；回执关联由 (commandType, operationId) 在 command_receipt 侧可查
        commandReceiptId: null,
      })
      // RP-S3：快照引用即置 referenced（幂等：已置位时同值 UPDATE 不触发守卫异常）
      await reporting.definitions.markReferenced(def.id)
    } catch (error) {
      // RP-21：投影失败保留失败标记与原因，不中断同批其余指标
      snapshots.push({
        plantId,
        enterpriseId: plant.enterpriseId,
        shiftDate: target.shiftDate,
        metricKey: def.metricKey,
        metricVersion: def.version,
        caliberVersion: def.caliberVersion,
        numeratorValue: null,
        denominatorValue: null,
        value: null,
        uomCode: def.uomCode,
        status: 'projection_failed',
        missingReason: `[RP-21] 指标 ${def.metricKey} 事实集聚合失败：${error instanceof Error ? error.message : String(error)}`,
        sourceRows: 0,
        computedBy: ctx.actorLoginName,
        commandReceiptId: null,
      })
    }
  }

  // RP-S2：幂等键覆盖（重算不产生重复行）
  const stored = await reporting.snapshots.upsertBatch(snapshots)
  const result = {
    snapshots: stored.length,
    ok: stored.filter((s) => s.status === 'ok').length,
    denominatorMissing: stored.filter((s) => s.status === 'denominator_missing').length,
    failed: stored.filter((s) => s.status === 'projection_failed').length,
    shiftDates: shiftDates.length,
  }
  // O-8 统一审计（一行/命令）：操作者 + 范围（工厂/班次日/指标键）+ 结果计数
  await tools.audit.record({
    actor: ctx.actorLoginName,
    action: 'reporting.shift-snapshot.rebuild',
    subjectType: 'shift_snapshot',
    subjectId: plantId,
    after: {
      scope: { plantId, shiftDate: shiftDateParam ?? 'all-dates', metricKeys: metricKeysParam ?? 'all' },
      ...result,
    },
    reason: str(p, 'reason') ?? ctx.reason ?? null,
  })
  return result
}

// ---------------- 命令：指标定义注册（RP-19/RP-S3） ----------------

async function metricDefinitionRegister(
  tools: ReportingCommandTools,
  ctx: CommandContext,
  p: Payload,
): Promise<Record<string, unknown>> {
  const { reporting } = tools
  // 快捷载荷：metricKeys=['*'] → 注册全部默认四族定义（首期框架引导，[合同新造]GAP-F24/F25 待裁）
  if (Array.isArray(p['metricKeys']) && (p['metricKeys'] as unknown[]).includes('*')) {
    const registered: string[] = []
    // O-8：批量注册前各 key 的前一 active 版本指针（审计 before）
    const priorActive = new Map<string, { definitionId: string; version: number }>()
    for (const d of await reporting.definitions.listAll()) {
      if (d.status !== 'active') continue
      const prev = priorActive.get(d.metricKey)
      if (prev === undefined || d.version > prev.version) {
        priorActive.set(d.metricKey, { definitionId: d.id, version: d.version })
      }
    }
    for (const seed of DEFAULT_METRIC_DEFINITIONS) {
      const existing = await reporting.definitions.findByKeyAndVersion(seed.metricKey, seed.version)
      if (existing !== null) continue
      await reporting.definitions.insert({
        metricKey: seed.metricKey,
        family: seed.family,
        version: seed.version,
        caliberVersion: seed.caliberVersion,
        numeratorFactSet: { kind: seed.numeratorFactSet },
        denominatorFactSet: seed.denominatorFactSet === null ? null : { kind: seed.denominatorFactSet },
        uomCode: seed.uomCode,
        uomMode: seed.uomMode,
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
        status: 'active',
        description: seed.description,
        plantId: null,
        enterpriseId: null,
        createdBy: ctx.actorLoginName,
      })
      registered.push(`${seed.metricKey}@v${seed.version}`)
    }
    // O-8 统一审计（一行/命令）：批量引导以批次为 subject，before=各 key 前一 active 指针，after=新版本号清单
    await tools.audit.record({
      actor: ctx.actorLoginName,
      action: 'reporting.metric-definition.register',
      subjectType: 'metric_definition',
      subjectId: 'default-definitions',
      before: Object.fromEntries(
        registered.map((entry) => {
          const key = entry.slice(0, entry.indexOf('@'))
          return [key, priorActive.get(key) ?? null]
        }),
      ),
      after: { registered, skipped: DEFAULT_METRIC_DEFINITIONS.length - registered.length },
      reason: str(p, 'reason') ?? ctx.reason ?? null,
    })
    return { registered, skipped: DEFAULT_METRIC_DEFINITIONS.length - registered.length }
  }

  const metricKey = requireStr(p, 'metricKey', 'reporting.metric-definition.register')
  const familyRaw = requireStr(p, 'family', 'reporting.metric-definition.register')
  if (!(METRIC_FAMILIES as readonly string[]).includes(familyRaw)) {
    throw new ReportingRuleViolation('RP-20', `指标族非法：${familyRaw}（首期四族：${METRIC_FAMILIES.join('/')}）`)
  }
  const family = familyRaw as MetricFamily
  const versionRaw = p['version']
  if (typeof versionRaw !== 'number' || !Number.isInteger(versionRaw) || versionRaw < 1) {
    throw new ReportingRuleViolation('RP-19', 'version 必须为正整数')
  }
  const numerator = parseFactSetSpec(p['numeratorFactSet'])
  const denominatorRaw = p['denominatorFactSet']
  const denominator = denominatorRaw === null || denominatorRaw === undefined ? null : parseFactSetSpec(denominatorRaw)
  const uomCode = requireStr(p, 'uomCode', 'reporting.metric-definition.register')
  const uomModeRaw = p['uomMode'] === 'percent' ? 'percent' : 'plain'
  const effectiveFrom = requireStr(p, 'effectiveFrom', 'reporting.metric-definition.register')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
    throw new ReportingRuleViolation('RP-19', `effectiveFrom 非法（yyyy-MM-dd）：${effectiveFrom}`)
  }
  const effectiveToRaw = str(p, 'effectiveTo') ?? null
  if (effectiveToRaw !== null && !/^\d{4}-\d{2}-\d{2}$/.test(effectiveToRaw)) {
    throw new ReportingRuleViolation('RP-19', `effectiveTo 非法（yyyy-MM-dd）：${effectiveToRaw}`)
  }
  const status = p['status'] === 'draft' || p['status'] === 'retired' ? (p['status'] as 'draft' | 'retired') : 'active'

  const existing = await reporting.definitions.findByKeyAndVersion(metricKey, versionRaw)
  if (existing !== null) {
    // RP-19：同 key 同版本已存在 → 拒（定义变更走新版本行；referenced 行库级 immutable 双保险）
    throw new ReportingRuleViolation(
      'RP-19',
      `指标定义 ${metricKey}@v${versionRaw} 已存在（定义变更须注册新版本行，历史快照不回写）`,
    )
  }
  // O-8：前一 active 版本指针（同 key 现存 active 最高版本；无则 null——首版）
  const priorActiveDef = (await reporting.definitions.listAll())
    .filter((d) => d.metricKey === metricKey && d.status === 'active')
    .reduce<{ definitionId: string; version: number } | null>(
      (acc, d) => (acc === null || d.version > acc.version ? { definitionId: d.id, version: d.version } : acc),
      null,
    )
  const created = await reporting.definitions.insert({
    metricKey,
    family,
    version: versionRaw,
    caliberVersion: requireStr(p, 'caliberVersion', 'reporting.metric-definition.register'),
    numeratorFactSet: numerator,
    denominatorFactSet: denominator,
    uomCode,
    uomMode: uomModeRaw,
    effectiveFrom,
    effectiveTo: effectiveToRaw,
    status,
    description: str(p, 'description') ?? null,
    plantId: str(p, 'plantId') ?? null,
    enterpriseId: null,
    createdBy: ctx.actorLoginName,
  })
  // O-8 统一审计（一行/命令）：before=前一 active 版本指针，after=新版本号与生效范围
  await tools.audit.record({
    actor: ctx.actorLoginName,
    action: 'reporting.metric-definition.register',
    subjectType: 'metric_definition',
    subjectId: created.id,
    before: priorActiveDef,
    after: {
      definitionId: created.id,
      metricKey,
      version: created.version,
      caliberVersion: created.caliberVersion,
      status: created.status,
      effectiveFrom,
      plantId: str(p, 'plantId') ?? null,
    },
    reason: str(p, 'reason') ?? ctx.reason ?? null,
  })
  return { definitionId: created.id, metricKey, version: created.version }
}

// ---------------- 处理器装配 ----------------

interface ReportingCommandSpec {
  commandType: string
  handle: (
    tools: ReportingCommandTools,
    ctx: CommandContext,
    payload: Payload,
    commandReceiptId: string,
  ) => Promise<Record<string, unknown>>
}

const COMMANDS: readonly ReportingCommandSpec[] = [
  { commandType: 'reporting.stock-stat.rebuild', handle: (tools, ctx, p) => stockStatRebuild(tools, ctx, p) },
  {
    commandType: 'reporting.shift-snapshot.rebuild',
    handle: (tools, ctx, p) => shiftSnapshotRebuild(tools, ctx, p),
  },
  {
    commandType: 'reporting.metric-definition.register',
    handle: (tools, ctx, p) => metricDefinitionRegister(tools, ctx, p),
  },
]

export function createReportingCommandHandlers(): readonly CommandHandler[] {
  return COMMANDS.map((spec) => ({
    commandType: spec.commandType,
    handle: async (envelope, context, tools) =>
      run(() => spec.handle(tools as ReportingCommandTools, context, envelope.payload as Payload, envelope.operationId)),
  }))
}
