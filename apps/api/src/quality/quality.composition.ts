import type pg from 'pg'
import type { CommandBus, CommandTools, OutboxIntent } from '@cadenza/application'
import { computeActorAuthorization } from '@cadenza/application'
import {
  PgAuditWriter,
  PgAuthSessionRepository,
  PgCommandBus,
  PgOrgNodeRepository,
  PgRoleRepository,
  PgScopeGrantRepository,
  PgUserAccountRepository,
  type CommandToolsFactory,
  type SqlClient,
} from '@cadenza/persistence'
import {
  PgBarcodeRepository,
  PgCarrierRepository,
  PgCommandReceiptRefRepository,
  PgGenealogyRepository,
  PgInventoryUnitRepository,
  PgMaterialLotRepository,
  PgMaterialSegmentRepository,
  PgReservationRepository,
  PgStockBalanceRepository,
  PgStockTransactionRepository,
} from '@cadenza/persistence'
// L0 整合步（Wave5）：application/persistence/domain index 已导出 quality 面；改包名导入。
import {
  createQualityCommandHandlers,
  QualityQueryService,
  type ExecutionEventPort,
  type ExecutionEventRecord,
  type QualityCommandTools,
} from '@cadenza/application'
import { createPgQualityRepositories } from '@cadenza/persistence'

/**
 * quality 域命令总线装配（组合根，同 purchase.composition 模式）：
 * - 处理器来自 application（quality-handlers：任务生成/实测提交/放行/让步/存疑登记与恢复）；
 * - 事务工具集 = org 基础 + inventory 仓储（库存质量投影同事务消费）+ quality 仓储 +
 *   ExecutionEventPort（检验任务生成消费执行块提交事件——L0 整合接线，测试内存实现；
 *   缺省空实现：无事件源时不生成任务）+ Outbox 收集器（同事务写 0001 outbox）。
 */
export function buildQualityCommandBus(pool: pg.Pool, events: ExecutionEventPort = { fetchEvents: async () => [] }): CommandBus {
  const handlers = createQualityCommandHandlers()

  const toolsFactory: CommandToolsFactory = (client, _context, now): CommandTools => {
    const org = new PgOrgNodeRepository(client)
    const users = new PgUserAccountRepository(client)
    const grants = new PgScopeGrantRepository(client)
    const tools: QualityCommandTools = {
      org,
      users,
      roles: new PgRoleRepository(client),
      grants,
      sessions: new PgAuthSessionRepository(client),
      audit: new PgAuditWriter(client),
      now,
      actorPermissions: async () =>
        (await computeActorAuthorization({ users, grants, org }, _context.actorUserId)).permissions,
      actorDataScope: async () =>
        (await computeActorAuthorization({ users, grants, org }, _context.actorUserId)).dataScope,
      inv: {
        receipts: new PgCommandReceiptRefRepository(client),
        lots: new PgMaterialLotRepository(client),
        units: new PgInventoryUnitRepository(client),
        segments: new PgMaterialSegmentRepository(client),
        balances: new PgStockBalanceRepository(client),
        transactions: new PgStockTransactionRepository(client),
        reservations: new PgReservationRepository(client),
        barcodes: new PgBarcodeRepository(client),
        carriers: new PgCarrierRepository(client),
        genealogy: new PgGenealogyRepository(client),
      },
      outbox: {
        collect(intent: OutboxIntent): void {
          // 同事务写 outbox（SA §4.2 / DM §6）：pg 客户端连接内查询 FIFO 入队，
          // 本 INSERT 先于命令总线的 COMMIT 执行；失败即中止事务。
          void insertOutbox(client, intent).catch(() => undefined)
        },
      },
      qa: createPgQualityRepositories(client),
      events,
    }
    return tools
  }

  return new PgCommandBus(pool, handlers, toolsFactory, () => new Date())
}

async function insertOutbox(client: SqlClient, intent: OutboxIntent): Promise<void> {
  await client.query(
    `INSERT INTO outbox (aggregate_type, aggregate_id, task_kind, status, payload)
     VALUES ($1, $2, $3, 'PENDING', $4::jsonb)`,
    [intent.aggregateType, intent.aggregateId, intent.taskKind, JSON.stringify(intent.payload)],
  )
}

/** 查询服务装配（池连接，只读）。 */
export function buildQualityQueryService(pool: pg.Pool): QualityQueryService {
  const qa = createPgQualityRepositories(pool)
  return new QualityQueryService({
    inspectionOrders: qa.inspectionOrders,
    testResults: qa.testResults,
    dispositions: qa.dispositions,
    holds: qa.holds,
  })
}

// ---------------- ExecutionEventPort 真实接线（L0 整合步 Wave5） ----------------

interface ReportEventRow {
  report_id: string
  plant_id: string
  business_time: Date | string
  operation_seq: number
  output_id: string
  quantity: string
  uom_id: string
  uom_code: string
  production_order_no: string
  production_dept_id: string | null
  production_dept_name: string | null
  material_id: string
  material_code: string | null
  material_type: number | null
  unit_no: string | null
  last_seq: number | null
}

/** numeric 出参规范化（与 persistence 仓储同口径："10.0000" → "10"）。 */
function trimDecimal(value: string): string {
  if (!value.includes('.')) return value
  return value.replace(/0+$/, '').replace(/\.$/, '')
}

/**
 * 报工确认事件源（production_report × report_output，只读投影）：
 * - 事件 = 审核通过的已提交报工的每条产出行（status='submitted' 且 review_status ∈
 *   {auto_approved, manual_approved}——「报工确认」= 审核通过，[底稿 A6-4]）；
 * - eventId=报工单 id（同单多产出行 eventId 重复；eventId 仅错误文案引用，不参与幂等）；
 * - payload.sourceRef=产出行 id（行级幂等键：quality.findBySource / warehousing.findBySource
 *   以 sourceRef 去重，多产出行单若以报工单 id 为键会吞行）；
 * - inspectionStage 按域规则 resolveLastNonQcOperation 口径：报末道非质检工序=finished，
 *   其余=process（质检判定=生产部门 ∉ qcDeptIds，缺省空清单=无质检工序；全质检订单无末道
 *   非质检工序 → process）；
 * - specCode/specVersion 不编造（quality.inspection.generate 以命令载荷 default* 兜底）；
 *   palletCode 无执行域来源，不映射；
 * - finished_inspection_released 事件源（质量放行侧）不在本端口——待质量域放行事实接线。
 */
export class PgExecutionEventPort implements ExecutionEventPort {
  /**
   * @param client 池连接或事务客户端（只读查询）
   * @param qcDeptIds 质检部门 id 清单（inspectionStage 判定；缺省空=末道工序即 finished）
   */
  constructor(
    private readonly client: SqlClient,
    private readonly qcDeptIds: string[] = [],
  ) {}

  async fetchEvents(input: { types?: string[]; plantId?: string }): Promise<ExecutionEventRecord[]> {
    if (input.types !== undefined && input.types.length > 0 && !input.types.includes('work_report_confirmed')) {
      return [] // 本端口仅供给报工确认事件
    }
    const r = await this.client.query(
      `SELECT pr.id AS report_id,
              pr.plant_id::text AS plant_id,
              pr.business_time,
              pr.operation_seq,
              ro.id AS output_id,
              ro.quantity::text AS quantity,
              ro.uom_id::text AS uom_id,
              ro.uom_code,
              po.order_no AS production_order_no,
              po.production_dept_id::text AS production_dept_id,
              dn.name AS production_dept_name,
              po.material_id::text AS material_id,
              coalesce(m.code, po.material_snapshot->>'code') AS material_code,
              m.material_type,
              iu.unit_no,
              last_op.last_seq
       FROM production_report pr
       JOIN report_output ro ON ro.report_id = pr.id
       JOIN production_order po ON po.id = pr.order_id
       LEFT JOIN material m ON m.id = po.material_id
       LEFT JOIN org_node dn ON dn.id = po.production_dept_id
       LEFT JOIN inventory_unit iu ON iu.id = ro.stock_unit_id
       LEFT JOIN LATERAL (
         SELECT max(oo.seq) AS last_seq
         FROM order_operation oo
         WHERE oo.order_id = pr.order_id
           AND oo.production_dept_id <> ALL($2::uuid[])
       ) last_op ON true
       WHERE pr.status = 'submitted'
         AND pr.review_status IN ('auto_approved', 'manual_approved')
         AND ($1::uuid IS NULL OR pr.plant_id = $1::uuid)
       ORDER BY pr.business_time, ro.line_no`,
      [input.plantId ?? null, this.qcDeptIds],
    )
    return (r.rows as unknown as ReportEventRow[]).map((row): ExecutionEventRecord => {
      const occurredAt =
        row.business_time instanceof Date ? row.business_time.toISOString() : String(row.business_time)
      return {
        eventId: row.report_id,
        eventType: 'work_report_confirmed',
        occurredAt,
        plantId: row.plant_id,
        payload: {
          sourceRef: row.output_id,
          unitNo: row.unit_no ?? undefined,
          materialId: row.material_id,
          materialCode: row.material_code ?? '',
          materialType: row.material_type,
          quantity: trimDecimal(row.quantity),
          uomId: row.uom_id,
          uomCode: row.uom_code,
          productionOrderNo: row.production_order_no,
          productionDeptId: row.production_dept_id ?? undefined,
          productionDeptName: row.production_dept_name ?? undefined,
          inspectionStage:
            row.last_seq !== null && row.operation_seq === row.last_seq ? 'finished' : 'process',
        },
      }
    })
  }
}
