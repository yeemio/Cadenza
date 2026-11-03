import type pg from 'pg'
import { createPool, migrateUp, migrations, seedOrgAuth } from '@cadenza/persistence'
import { createScryptPasswordHasher } from '@cadenza/application'
import { migration0015 } from '../../packages/persistence/src/migrations/0015-maintenance'
import { migration0016 } from '../../packages/persistence/src/migrations/0016-reporting'
import { migration0017 } from '../../packages/persistence/src/migrations/0017-ot-collection'
import { migration0020 } from '../../packages/persistence/src/migrations/0020-cost-energy'

/**
 * cost 测试环境（P3-D / T24）：容器内独立数据库 cadenza_p3d（与共享 dev 库及各线独立库隔离）。
 * 每轮先 DROP 再 CREATE；迁移 = 注册表（0001–0010）+ 0015（维护：停机/备件）+ 0016（班次快照）+
 * 0017（OT 采集）+ 本域 0020（**不注册**，程序式应用——L0 整合步统一注册；防御性去重防
 * L0 注册后撞 schema_migrations 主键，同 maintenance 先例）。
 *
 * 夹具为 CE-05 唯一来源映射的全链事实（匿名演示数据 CE-20：假料品/假价格/假读数）：
 * 0005 订单+BOM、0008 报工/工时/消耗、0003 设备（GAP-S1 文本标准速度）、0017 OT 样本、
 * 0015 停机/备件、0016 班次快照、0002 班次日历。
 */

export const COST_TEST_DB_NAME = 'cadenza_p3d'

export function costDatabaseUrl(): string {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  return base.replace(/\/cadenza$/, `/${COST_TEST_DB_NAME}`)
}

/** 重建测试库（每轮 DROP+CREATE；PG13+ WITH (FORCE)）。 */
export async function ensureCostTestDatabase(): Promise<void> {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  const adminUrl = base.replace(/\/cadenza$/, '/postgres')
  const admin = createPool(adminUrl, { max: 1 })
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${COST_TEST_DB_NAME} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${COST_TEST_DB_NAME}`)
  } finally {
    await admin.end()
  }
}

/** 应用迁移（0001–0010 注册表 + 0015/0016/0017 程序式 + 0020）+ org 种子 + cost 授权。 */
export async function prepareCostTestDatabase(): Promise<pg.Pool> {
  await ensureCostTestDatabase()
  const pool = createPool(costDatabaseUrl(), { max: 4 })
  const all = [...migrations]
  for (const extra of [migration0015, migration0016, migration0017, migration0020]) {
    if (!all.some((m) => m.version === extra.version)) all.push(extra)
  }
  await migrateUp(pool, all)
  await seedOrgAuth(pool, { passwordHasher: createScryptPasswordHasher() })
  await grantCostPermissions(pool)
  return pool
}

/**
 * 授予 cost 许可（幂等合并，不覆盖种子 org 权限）：
 * - sysadmin（华东企业范围）：cost.read/post（admin 全链命令与查询）；
 * - plantadmin（合肥厂 plant 范围）：cost.read（跨厂 403/列表过滤证据）；
 * - foreman（苏州车间主任）：无 cost 许可（许可缺失 403 证据）。
 */
export async function grantCostPermissions(pool: pg.Pool): Promise<void> {
  const grant = async (
    roleAlias: string,
    scopeType: 'enterprise' | 'plant',
    scopeCode: string,
    permissions: string[],
  ): Promise<void> => {
    const role = await pool.query<{ id: string; enterprise_id: string }>(
      `SELECT r.id, r.enterprise_id FROM role r JOIN org_node e ON e.id = r.enterprise_id
       WHERE e.code = 'ENT-HD' AND r.alias = $1`,
      [roleAlias],
    )
    if (role.rowCount === 0) throw new Error(`种子角色缺失：${roleAlias}`)
    const scopeObject = await pool.query<{ id: string }>(
      `SELECT id FROM org_node WHERE code = $1 AND enterprise_id = $2`,
      [scopeCode, role.rows[0]!.enterprise_id],
    )
    if (scopeObject.rowCount === 0) throw new Error(`种子范围对象缺失：${scopeCode}`)
    await pool.query(
      `INSERT INTO scope_grant (enterprise_id, principal_type, principal_id, permissions,
         scope_type, scope_object_id, status, created_by)
       VALUES ($1, 'role', $2, $3, $4, $5, 'active', 'seed-cst')
       ON CONFLICT (principal_type, principal_id, scope_type, scope_object_id) DO UPDATE SET
         permissions = (
           SELECT array_agg(DISTINCT p) FROM unnest(scope_grant.permissions || EXCLUDED.permissions) AS t(p)
         ),
         updated_at = now(),
         updated_by = 'seed-cst'`,
      [role.rows[0]!.enterprise_id, role.rows[0]!.id, permissions, scopeType, scopeObject.rows[0]!.id],
    )
  }
  await grant('sysadmin', 'enterprise', 'ENT-HD', ['cost.read', 'cost.post'])
  await grant('plantadmin', 'plant', 'PLNT-HF', ['cost.read'])
}

// ---------------- 夹具 ----------------

export const CST_OWNER_ID = '22222222-2222-4222-8222-222222222201'
export const CST_OWNER_NAME = '华东电缆集团（自有）'
export const CST_UOM_KG_ID = '33333333-3333-4333-8333-3333333333d1'

/** 业务班次（苏州厂；CE-S4 归集锚引用）。 */
export const CST_SHIFT_DATE = '2026-10-26'
export const CST_SHIFT_START = '2026-10-26T08:00:00Z'
export const CST_SHIFT_CUTOFF = '2026-10-26T16:00:00Z'
export const CST_SHIFT_END = '2026-10-26T16:00:00Z'

export interface CostFixtures {
  enterpriseId: string
  szPlantId: string
  hfPlantId: string
  jzDeptId: string
  adminUserId: string
  /** 铜杆料（BOM 子料，价格版本覆盖） */
  copperMaterialId: string
  /** 成品缆料（订单产品料；价格版本**不**覆盖 → 缺价标注证据） */
  finMaterialId: string
  /** 备件料（价格版本覆盖；备件消耗计价） */
  spareMaterialId: string
  productFamilyId: string
  bomRevisionId: string
  /** 主设备（OT speed 运行采样 + OT 表计点位绑定；std_rate_text 非数值 → GAP-S1） */
  eq1Id: string
  eq1Code: string
  /** 次设备（数值标准速度 200 + 停机 60 分 → OEE 齐备分支） */
  eq2Id: string
  eq2Code: string
  shiftCalendarId: string
  orderId: string
  orderNo: string
  op1Id: string
  op2Id: string
  /** 铜杆消耗单元（inventory_unit，实耗事实挂接） */
  copperUnitId: string
  copperUnitNo: string
  /** 备件单元（spare_part_usage 挂接） */
  spareUnitId: string
  spareUnitNo: string
  /** OT 运行点位（speed 语义） */
  otSpeedPointId: string
  otSpeedDeviceSerial: string
  /** OT 表计点位（other 语义；表计 OT 采样来源） */
  otMeterPointId: string
  otMeterDeviceSerial: string
  /** 消耗/报工/工时事实的 command_receipt id（源单据回算锚） */
  factReceiptId: string
  /** 报工产出事实 id（损耗/在制变化） */
  outputFactId: string
  /** 工时事实 id */
  laborFactId: string
  /** 消耗事实 id */
  consumptionFactId: string
  /** 备件消耗事实 id */
  spareFactId: string
  /** 第二订单（eq2 无表计运行 1h → CE-09 覆盖不足估算分支；无 BOM → 估算缺项 CE-03） */
  order2Id: string
  order2No: string
  op3Id: string
  /** 第二订单产出事实（OEE 质量率分子分母与能源估算份额） */
  output2FactId: string
}

/** 直落全链事实夹具（匿名演示数据 CE-20）。 */
export async function seedCostFixtures(pool: pg.Pool): Promise<CostFixtures> {
  const ent = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = 'ENT-HD'`)
  const enterpriseId = ent.rows[0]!.id
  const szPlantId = await costNodeId(pool, 'PLNT-SZ')
  const hfPlantId = await costNodeId(pool, 'PLNT-HF')
  const jzDeptId = await costNodeId(pool, 'DEPT-SZ-JZ')
  const adminUserId = (await pool.query<{ id: string }>(`SELECT id FROM user_account WHERE login_name = 'admin'`)).rows[0]!.id

  // ---- 主数据：工作中心/设备/料品/产品族 ----
  const wc = await pool.query<{ id: string }>(
    `INSERT INTO work_center (enterprise_id, plant_id, dept_id, code, name, created_by)
     VALUES ($1,$2,$3,'WC-CST-01','成本测试工作中心','seed-cst')
     ON CONFLICT (code) WHERE status = 'active' DO UPDATE SET updated_at = now() RETURNING id`,
    [enterpriseId, szPlantId, jzDeptId],
  )
  const workCenterId = wc.rows[0]!.id
  const insertEquipment = async (code: string, name: string, stdRateText: string | null): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO equipment (enterprise_id, plant_id, dept_id, work_center_id, code, name, std_rate_text, equipment_status, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,1,'active','seed-cst')
       ON CONFLICT (code) WHERE status = 'active' DO UPDATE SET std_rate_text = EXCLUDED.std_rate_text, updated_at = now() RETURNING id`,
      [enterpriseId, szPlantId, jzDeptId, workCenterId, code, name, stdRateText],
    )
    return r.rows[0]!.id
  }
  const eq1Code = 'JC-CST-01'
  const eq2Code = 'JC-CST-02'
  const eq1Id = await insertEquipment(eq1Code, '成本演示-绞制一号机', '约200米/分') // GAP-S1：文本非数值
  const eq2Id = await insertEquipment(eq2Code, '成本演示-绞制二号机', '200.0000') // 数值（OEE 齐备分支）

  const insertMaterial = async (code: string, name: string, materialType: number): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO material (org_scope_id, code, name, material_type, base_uom, qc_flag, source_system, created_by)
       VALUES ($1,$2,$3,$4,'KG',0,'U9','seed-cst')
       ON CONFLICT (org_scope_id, code) WHERE status = 'active' DO UPDATE SET updated_at = now() RETURNING id`,
      [enterpriseId, code, name, materialType],
    )
    return r.rows[0]!.id
  }
  const copperMaterialId = await insertMaterial('MAT-CST-COPPER', '成本演示-铜杆', 1)
  const finMaterialId = await insertMaterial('MAT-CST-FIN', '成本演示-成品缆', 3)
  const spareMaterialId = await insertMaterial('MAT-CST-SPARE', '成本演示-备件轴承', 2)

  const pf = await pool.query<{ id: string }>(
    `INSERT INTO product_family (enterprise_id, plant_id, code, name, created_by)
     VALUES ($1,$2,'PF-CST','成本演示产品族','seed-cst')
     ON CONFLICT (plant_id, code) WHERE status = 'active' DO UPDATE SET updated_at = now() RETURNING id`,
    [enterpriseId, szPlantId],
  )
  const productFamilyId = pf.rows[0]!.id

  // ---- 班次日历（CE-S4）+ 班次快照（CE-19 锚消费 0016）----
  const sc = await pool.query<{ id: string }>(
    `INSERT INTO shift_calendar (plant_id, code, name, start_time, end_time, created_by)
     VALUES ($1,'SH-CST-A','成本演示白班','08:00','16:00','seed-cst') RETURNING id`,
    [szPlantId],
  )
  const shiftCalendarId = sc.rows[0]!.id
  await pool.query(
    `INSERT INTO shift_snapshot (plant_id, shift_date, metric_key, metric_version, caliber_version,
       numerator_value, denominator_value, value, uom_code, status, source_rows, computed_by, enterprise_id, created_by)
     VALUES ($1,$2,'demo.metric.output',1,'v1',1000,1000,1000,'M','ok',1,'seed-cst',$3,'seed-cst')`,
    [szPlantId, CST_SHIFT_DATE, enterpriseId],
  )

  // ---- BOM 已发布版本（理论量来源 CE-07）----
  const bom = await pool.query<{ id: string }>(
    `INSERT INTO manufacturing_bom_revision (enterprise_id, plant_id, product_family_id, material_id, version,
       status, lines, published_at, published_by, created_by)
     VALUES ($1,$2,$3,$4,1,'published',$5::jsonb, now(),'seed-cst','seed-cst') RETURNING id`,
    [
      enterpriseId, szPlantId, productFamilyId, finMaterialId,
      JSON.stringify([{ materialId: copperMaterialId, materialCode: 'MAT-CST-COPPER', quantity: '1.5000', uom: 'KG' }]),
    ],
  )
  const bomRevisionId = bom.rows[0]!.id

  // ---- 生产订单 + 两道工序 ----
  const orderNo = `PO-CST-${Date.now().toString(36).toUpperCase()}`
  const order = await pool.query<{ id: string }>(
    `INSERT INTO production_order (enterprise_id, plant_id, order_no, material_id, product_family_id,
       production_dept_id, production_qty, uom, order_status, process_config_status, bom_revision_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,100,'M','in_progress','configured',$7,'seed-cst') RETURNING id`,
    [enterpriseId, szPlantId, orderNo, finMaterialId, productFamilyId, jzDeptId, bomRevisionId],
  )
  const orderId = order.rows[0]!.id
  const insertOp = async (seq: number, code: string, name: string): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO order_operation (enterprise_id, plant_id, order_id, seq, operation_definition_id,
         operation_code, operation_name, core_multiple, offline_qty, work_center_id, work_center_code,
         work_center_name, uom, production_dept_id, bom_revision_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,1,0,$8,'WC-CST-01','成本测试工作中心','M',$9,$10,'seed-cst') RETURNING id`,
      [enterpriseId, szPlantId, orderId, seq, await opDefId(pool, enterpriseId, szPlantId, jzDeptId, workCenterId, seq), code, name, workCenterId, jzDeptId, bomRevisionId],
    )
    return r.rows[0]!.id
  }
  const op1Id = await insertOp(1, 'OP-CST-10', '成本演示-绞制')
  const op2Id = await insertOp(2, 'OP-CST-20', '成本演示-成缆')

  // ---- 事实 command_receipt（源单据回算锚 CE-15）----
  const factReceipt = await pool.query<{ id: string }>(
    `INSERT INTO command_receipt (enterprise_id, command_type, operation_id, payload_digest, status, result)
     VALUES ($1,'execution.report.submit','seed-cst-facts','seed-cst','COMMITTED','{}'::jsonb) RETURNING id`,
    [enterpriseId],
  )
  const factReceiptId = factReceipt.rows[0]!.id

  // ---- 0008 报工会话（订单-设备占用关系：eq1 主链）----
  const insertSession = async (operationId: string, equipmentCode: string): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO execution_session (enterprise_id, plant_id, order_id, source, order_operation_id,
         equipment_code, operator_user_id, operator_login, shift_date, status, business_time, created_by)
       VALUES ($1,$2,$3,'workbench',$4,$5,$6,'admin',$7,'submitted',$8,'seed-cst') RETURNING id`,
      [enterpriseId, szPlantId, orderId, operationId, equipmentCode, adminUserId, CST_SHIFT_DATE, `${CST_SHIFT_DATE}T09:00:00Z`],
    )
    return r.rows[0]!.id
  }
  await insertSession(op1Id, eq1Code)
  await insertSession(op2Id, eq1Code)

  // ---- 0008 报工单（submitted）+ 产出行（合格 95/100 → 损耗 5；stock_unit_id 可空=在制）----
  const report = await pool.query<{ id: string }>(
    `INSERT INTO production_report (enterprise_id, plant_id, session_id, order_id, order_operation_id,
       operation_seq, source, status, review_status, operator_user_id, operator_login, business_time, shift_date, equipment_code, created_by)
     VALUES ($1,$2,(SELECT id FROM execution_session WHERE order_id = $3 AND order_operation_id = $4 LIMIT 1),
       $3,$4,1,'workbench','submitted','auto_approved',$5,'admin',$6,$7,$8,'seed-cst') RETURNING id`,
    [enterpriseId, szPlantId, orderId, op1Id, adminUserId, `${CST_SHIFT_DATE}T10:00:00Z`, CST_SHIFT_DATE, eq1Code],
  )
  const output = await pool.query<{ id: string }>(
    `INSERT INTO report_output (enterprise_id, plant_id, report_id, line_no, quantity, qualified_qty,
       uom_id, uom_code, target_location_id, target_location_code, owner_id, owner_name, measurement_basis, created_by)
     VALUES ($1,$2,$3,1,100.0000,95.0000,$4,'M','00000000-0000-4000-8000-0000000000c1','LINE-SIDE',$5,$6,'nominal','seed-cst') RETURNING id`,
    [enterpriseId, szPlantId, report.rows[0]!.id, CST_UOM_KG_ID, CST_OWNER_ID, CST_OWNER_NAME],
  )
  const outputFactId = output.rows[0]!.id

  // ---- 0008 工时（CA-12 主源：8h 报工）----
  const labor = await pool.query<{ id: string }>(
    `INSERT INTO labor_record (enterprise_id, plant_id, order_id, order_operation_id, report_id,
       operator_user_id, operator_login, hours, business_time, shift_date, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,'admin',8.00,$7,$8,'seed-cst') RETURNING id`,
    [enterpriseId, szPlantId, orderId, op1Id, report.rows[0]!.id, adminUserId, `${CST_SHIFT_DATE}T10:00:00Z`, CST_SHIFT_DATE],
  )
  const laborFactId = labor.rows[0]!.id

  // ---- 0004 铜杆单元 + 0008 消耗实耗 130（理论 150 → 损耗分列）----
  const copperUnitNo = `U-CST-COP-${Date.now().toString(36).toUpperCase()}`
  const copperUnit = await pool.query<{ id: string }>(
    `INSERT INTO inventory_unit (unit_no, material_id, material_code, lot_id, uom_id, uom_code, trace_mode,
       status, plant_id, enterprise_id, created_by)
     VALUES ($1,$2,'MAT-CST-COPPER',$3,$4,'KG','quantity','in_production',$5,$6,'seed-cst') RETURNING id`,
    [
      copperUnitNo, copperMaterialId,
      (await pool.query<{ id: string }>(
        `INSERT INTO material_lot (lot_no, kind, material_id, material_code, plant_id, enterprise_id, created_by)
         VALUES ($1,'purchase',$2,'MAT-CST-COPPER',$3,$4,'seed-cst') RETURNING id`,
        [`L-CST-${Date.now().toString(36).toUpperCase()}`, copperMaterialId, szPlantId, enterpriseId],
      )).rows[0]!.id,
      CST_UOM_KG_ID, szPlantId, enterpriseId,
    ],
  )
  const copperUnitId = copperUnit.rows[0]!.id
  const consumption = await pool.query<{ id: string }>(
    `INSERT INTO material_consumption (enterprise_id, plant_id, order_id, order_operation_id, operation_seq,
       report_id, feed_type, inventory_unit_id, unit_no, quantity, before_qty, after_qty, uom_id, uom_code,
       operator_user_id, operator_login, business_time, shift_date, command_receipt_id, created_by)
     VALUES ($1,$2,$3,$4,1,$5,'report',$6,$7,130.0000,200.0000,70.0000,$8,'KG',$9,'admin',$10,$11,$12,'seed-cst') RETURNING id`,
    [enterpriseId, szPlantId, orderId, op1Id, report.rows[0]!.id, copperUnitId, copperUnitNo, CST_UOM_KG_ID, adminUserId, `${CST_SHIFT_DATE}T10:00:00Z`, CST_SHIFT_DATE, factReceiptId],
  )
  const consumptionFactId = consumption.rows[0]!.id

  // ---- 0015 备件消耗（eq1；经 maintenance_order + stock_transaction）----
  const spareUnitNo = `U-CST-SPR-${Date.now().toString(36).toUpperCase()}`
  const spareUnit = await pool.query<{ id: string }>(
    `INSERT INTO inventory_unit (unit_no, material_id, material_code, lot_id, uom_id, uom_code, trace_mode,
       status, plant_id, enterprise_id, created_by)
     VALUES ($1,$2,'MAT-CST-SPARE',$3,$4,'PCS','quantity','in_stock',$5,$6,'seed-cst') RETURNING id`,
    [
      spareUnitNo, spareMaterialId,
      (await pool.query<{ id: string }>(
        `INSERT INTO material_lot (lot_no, kind, material_id, material_code, plant_id, enterprise_id, created_by)
         VALUES ($1,'purchase',$2,'MAT-CST-SPARE',$3,$4,'seed-cst') RETURNING id`,
        [`L-CST-S-${Date.now().toString(36).toUpperCase()}`, spareMaterialId, szPlantId, enterpriseId],
      )).rows[0]!.id,
      '33333333-3333-4333-8333-3333333333e1', szPlantId, enterpriseId,
    ],
  )
  const spareUnitId = spareUnit.rows[0]!.id
  const mntOrder = await pool.query<{ id: string }>(
    `INSERT INTO maintenance_order (enterprise_id, plant_id, equipment_id, order_no, source, status,
       description, reporter, result, responsible, closed_at, created_by)
     VALUES ($1,$2,$3,$4,'web_manual','closed','成本演示-换轴承','admin','已更换','admin', now(),'seed-cst') RETURNING id`,
    [enterpriseId, szPlantId, eq1Id, `MO-CST-${Date.now().toString(36).toUpperCase()}`],
  )
  const spareTx = await pool.query<{ id: string }>(
    `INSERT INTO stock_transaction (command_receipt_id, line_no, movement_kind, unit_id, quantity,
       uom_id, uom_code, measurement_basis, before_qty, after_qty, ref_type, reason, business_time,
       shift_date, plant_id, enterprise_id, created_by)
     VALUES ($1,1,'issue',$2,2.0000,$3,'PCS','nominal',10.0000,8.0000,'maintenance_order',$4,$5,$6,$7,$8,'seed-cst') RETURNING id`,
    [factReceiptId, spareUnitId, '33333333-3333-4333-8333-3333333333e1', mntOrder.rows[0]!.id, `${CST_SHIFT_DATE}T11:00:00Z`, CST_SHIFT_DATE, szPlantId, enterpriseId],
  )
  const spareUsage = await pool.query<{ id: string }>(
    `INSERT INTO spare_part_usage (enterprise_id, plant_id, order_id, unit_id, unit_no, material_code,
       stock_transaction_id, quantity, before_quantity, after_quantity, uom_id, uom_code, created_at, created_by)
     VALUES ($1,$2,$3,$4,$5,'MAT-CST-SPARE',$6,2.0000,10.0000,8.0000,$7,'PCS','2026-10-26T11:00:00Z','seed-cst') RETURNING id`,
    [enterpriseId, szPlantId, mntOrder.rows[0]!.id, spareUnitId, spareUnitNo, spareTx.rows[0]!.id, '33333333-3333-4333-8333-3333333333e1'],
  )
  const spareFactId = spareUsage.rows[0]!.id

  // ---- 0015 停机（eq2：60 分 → OEE 可用率分支）----
  await pool.query(
    `INSERT INTO downtime_event (enterprise_id, plant_id, equipment_id, start_at, end_at, reason, created_by)
     VALUES ($1,$2,$3,$4,$5,'成本演示-换刀','seed-cst')`,
    [enterpriseId, szPlantId, eq2Id, `${CST_SHIFT_DATE}T09:00:00Z`, `${CST_SHIFT_DATE}T10:00:00Z`],
  )

  // ---- 0017 OT：设备绑定 + speed 点位（eq1 运行 2 小时=120 采样×60s；eq2 运行 1 小时=60 采样×60s）+ 表计点位（累计读数）----
  // ot_point.uom_id 有 FK（inventory_unit 无 FK 可用裸 UUID，先例不同）：先插真实 uom 行
  await pool.query(
    `INSERT INTO uom (id, code, name, is_custom, created_by)
     VALUES ($1,'KG','千克(成本演示)',false,'seed-cst'), ($2,'PCS','件(成本演示)',false,'seed-cst'), ($3,'KWH','千瓦时(成本演示)',false,'seed-cst')
     ON CONFLICT (code) WHERE status = 'active' AND NOT is_custom DO UPDATE SET updated_at = now()`,
    [CST_UOM_KG_ID, '33333333-3333-4333-8333-3333333333e1', '33333333-3333-4333-8333-3333333333f1'],
  )
  const otSpeedDeviceSerial = `OT-CST-SPD-${Date.now().toString(36).toUpperCase()}`
  const otMeterDeviceSerial = `OT-CST-MTR-${Date.now().toString(36).toUpperCase()}`
  const otSpeed2DeviceSerial = `OT-CST-SP2-${Date.now().toString(36).toUpperCase()}`
  await pool.query(
    `INSERT INTO ot_device (device_serial, enterprise_id, plant_id, equipment_id, bound_by, bound_at, created_by)
     VALUES ($1,$2,$3,$4,'seed-cst', now(),'seed-cst')`,
    [otSpeedDeviceSerial, enterpriseId, szPlantId, eq1Id],
  )
  await pool.query(
    `INSERT INTO ot_device (device_serial, enterprise_id, plant_id, equipment_id, bound_by, bound_at, created_by)
     VALUES ($1,$2,$3,$4,'seed-cst', now(),'seed-cst')`,
    [otMeterDeviceSerial, enterpriseId, szPlantId, eq1Id],
  )
  await pool.query(
    `INSERT INTO ot_device (device_serial, enterprise_id, plant_id, equipment_id, bound_by, bound_at, created_by)
     VALUES ($1,$2,$3,$4,'seed-cst', now(),'seed-cst')`,
    [otSpeed2DeviceSerial, enterpriseId, szPlantId, eq2Id],
  )
  const speedPoint = await pool.query<{ id: string }>(
    `INSERT INTO ot_point (enterprise_id, plant_id, device_serial, point_code, semantic, uom_id, uom_code,
       sample_rate_seconds, participates_in_business, created_by)
     VALUES ($1,$2,$3,'P-SPD-01','speed',$4,'M/S',60,false,'seed-cst') RETURNING id`,
    [enterpriseId, szPlantId, otSpeedDeviceSerial, CST_UOM_KG_ID],
  )
  const otSpeedPointId = speedPoint.rows[0]!.id
  await pool.query(
    `INSERT INTO ot_point (enterprise_id, plant_id, device_serial, point_code, semantic, uom_id, uom_code,
       sample_rate_seconds, participates_in_business, created_by)
     VALUES ($1,$2,$3,'P-SPD-02','speed',$4,'M/S',60,false,'seed-cst')`,
    [enterpriseId, szPlantId, otSpeed2DeviceSerial, CST_UOM_KG_ID],
  )
  const meterPoint = await pool.query<{ id: string }>(
    `INSERT INTO ot_point (enterprise_id, plant_id, device_serial, point_code, semantic, uom_id, uom_code,
       sample_rate_seconds, participates_in_business, created_by)
     VALUES ($1,$2,$3,'P-MTR-01','other',$4,'KWH',60,false,'seed-cst') RETURNING id`,
    [enterpriseId, szPlantId, otMeterDeviceSerial, CST_UOM_KG_ID],
  )
  const otMeterPointId = meterPoint.rows[0]!.id

  // speed>0 优良采样：eq1 每小时整点起 3600 秒×2 小时（每 60s 一采×60s 采样率=运行 2h；CA-12 参考源）
  const speedRows: unknown[][] = []
  for (let hour = 0; hour < 2; hour += 1) {
    for (let sec = 0; sec < 3600; sec += 60) {
      const t = new Date(Date.parse(`${CST_SHIFT_DATE}T08:00:00Z`) + (hour * 3600 + sec) * 1000).toISOString()
      speedRows.push([
        otSpeedDeviceSerial, 'P-SPD-01', `seed-spd-${hour}-${sec}`, hour * 3600 + sec + 1, t, t,
        'GW-CST', 120.0, 'M/S', 'good', enterpriseId, szPlantId, t, 'seed-cst',
      ])
    }
  }
  await bulkInsertOtSamples(pool, speedRows)
  // eq2 运行 1 小时（60 采样×60s；无表计 → CE-09 覆盖不足估算分支的未覆盖机时）
  const speed2Rows: unknown[][] = []
  for (let sec = 0; sec < 3600; sec += 60) {
    const t = new Date(Date.parse(`${CST_SHIFT_DATE}T08:00:00Z`) + sec * 1000).toISOString()
    speed2Rows.push([
      otSpeed2DeviceSerial, 'P-SPD-02', `seed-sp2-${sec}`, sec + 1, t, t,
      'GW-CST', 180.0, 'M/S', 'good', enterpriseId, szPlantId, t, 'seed-cst',
    ])
  }
  await bulkInsertOtSamples(pool, speed2Rows)
  // 表计累计读数样本：08:00=1000 → 16:00=1150（用量 150 KWH，OT 来源实测）
  await pool.query(
    `INSERT INTO ot_sample (device_serial, point_code, event_id, gateway_seq, event_time, received_at,
       gateway_code, raw_value, raw_unit, quality_level, enterprise_id, plant_id, business_time, created_by)
     VALUES ($1,'P-MTR-01','seed-mtr-1',1,$2,$2,'GW-CST',1000.000000,'KWH','good',$3,$4,$2,'seed-cst'),
            ($1,'P-MTR-01','seed-mtr-2',2,$5,$5,'GW-CST',1150.000000,'KWH','good',$3,$4,$5,'seed-cst')`,
    [otMeterDeviceSerial, `${CST_SHIFT_DATE}T08:00:00Z`, enterpriseId, szPlantId, `${CST_SHIFT_DATE}T15:30:00Z`],
  )

  // ---- 第二订单（无 BOM 绑定 → 估算缺项 CE-03；eq2 运行 1h 且无表计 → CE-09 覆盖不足估算分支）----
  const order2No = `PO-CST2-${Date.now().toString(36).toUpperCase()}`
  const order2 = await pool.query<{ id: string }>(
    `INSERT INTO production_order (enterprise_id, plant_id, order_no, material_id, product_family_id,
       production_dept_id, production_qty, uom, order_status, process_config_status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,100,'M','in_progress','unconfigured','seed-cst') RETURNING id`,
    [enterpriseId, szPlantId, order2No, finMaterialId, productFamilyId, jzDeptId],
  )
  const order2Id = order2.rows[0]!.id
  const op3 = await pool.query<{ id: string }>(
    `INSERT INTO order_operation (enterprise_id, plant_id, order_id, seq, operation_definition_id,
       operation_code, operation_name, core_multiple, offline_qty, work_center_id, work_center_code,
       work_center_name, uom, production_dept_id, created_by)
     VALUES ($1,$2,$3,1,$4,'OP-CST-30','成本演示-复绕',1,0,$5,'WC-CST-01','成本测试工作中心','M',$6,'seed-cst') RETURNING id`,
    [enterpriseId, szPlantId, order2Id, await opDefId(pool, enterpriseId, szPlantId, jzDeptId, workCenterId, 3), workCenterId, jzDeptId],
  )
  const op3Id = op3.rows[0]!.id
  await pool.query(
    `INSERT INTO execution_session (enterprise_id, plant_id, order_id, source, order_operation_id,
       equipment_code, operator_user_id, operator_login, shift_date, status, business_time, created_by)
     VALUES ($1,$2,$3,'workbench',$4,$5,$6,'admin',$7,'submitted',$8,'seed-cst')`,
    [enterpriseId, szPlantId, order2Id, op3Id, eq2Code, adminUserId, CST_SHIFT_DATE, `${CST_SHIFT_DATE}T09:30:00Z`],
  )
  const report2 = await pool.query<{ id: string }>(
    `INSERT INTO production_report (enterprise_id, plant_id, session_id, order_id, order_operation_id,
       operation_seq, source, status, review_status, operator_user_id, operator_login, business_time, shift_date, equipment_code, created_by)
     VALUES ($1,$2,(SELECT id FROM execution_session WHERE order_id = $3 LIMIT 1),
       $3,$4,1,'workbench','submitted','auto_approved',$5,'admin',$6,$7,$8,'seed-cst') RETURNING id`,
    [enterpriseId, szPlantId, order2Id, op3Id, adminUserId, `${CST_SHIFT_DATE}T14:00:00Z`, CST_SHIFT_DATE, eq2Code],
  )
  const output2 = await pool.query<{ id: string }>(
    `INSERT INTO report_output (enterprise_id, plant_id, report_id, line_no, quantity, qualified_qty,
       uom_id, uom_code, target_location_id, target_location_code, owner_id, owner_name, measurement_basis, created_by)
     VALUES ($1,$2,$3,1,1400.0000,1330.0000,$4,'M','00000000-0000-4000-8000-0000000000c1','LINE-SIDE',$5,$6,'nominal','seed-cst') RETURNING id`,
    [enterpriseId, szPlantId, report2.rows[0]!.id, CST_UOM_KG_ID, CST_OWNER_ID, CST_OWNER_NAME],
  )
  const output2FactId = output2.rows[0]!.id

  return {
    enterpriseId,
    szPlantId,
    hfPlantId,
    jzDeptId,
    adminUserId,
    copperMaterialId,
    finMaterialId,
    spareMaterialId,
    productFamilyId,
    bomRevisionId,
    eq1Id,
    eq1Code,
    eq2Id,
    eq2Code,
    shiftCalendarId,
    orderId,
    orderNo,
    op1Id,
    op2Id,
    copperUnitId,
    copperUnitNo,
    spareUnitId,
    spareUnitNo,
    otSpeedPointId,
    otSpeedDeviceSerial,
    otMeterPointId,
    otMeterDeviceSerial,
    factReceiptId,
    outputFactId,
    laborFactId,
    consumptionFactId,
    spareFactId,
    order2Id,
    order2No,
    op3Id,
    output2FactId,
  }
}

/** 工序主数据（operation_definition；同厂同码幂等）。 */
async function opDefId(
  pool: pg.Pool,
  enterpriseId: string,
  plantId: string,
  deptId: string,
  workCenterId: string,
  seq: number,
): Promise<string> {
  const code = `OPD-CST-${seq}0`
  const r = await pool.query<{ id: string }>(
    `INSERT INTO operation_definition (enterprise_id, plant_id, dept_id, work_center_id, company_org_code,
       code, name, created_by)
     VALUES ($1,$2,$3,$4,'ENT-HD',$5,$6,'seed-cst')
     ON CONFLICT (dept_id, name) WHERE status = 'active' DO UPDATE SET updated_at = now() RETURNING id`,
    [enterpriseId, plantId, deptId, workCenterId, code, `成本演示工序-${seq}`],
  )
  return r.rows[0]!.id
}

/** OT 样本分批插入（行=14 列全值；每批 40 行内避免超参数上限）。 */
async function bulkInsertOtSamples(pool: pg.Pool, rows: unknown[][]): Promise<void> {
  for (let i = 0; i < rows.length; i += 40) {
    const batch = rows.slice(i, i + 40)
    const values: unknown[] = []
    const tuples = batch.map((row) => {
      const placeholders = row.map((v) => {
        values.push(v)
        return `$${values.length}`
      })
      return `(${placeholders.join(',')})`
    })
    await pool.query(
      `INSERT INTO ot_sample (device_serial, point_code, event_id, gateway_seq, event_time, received_at,
         gateway_code, raw_value, raw_unit, quality_level, enterprise_id, plant_id, business_time, created_by)
       VALUES ${tuples.join(',')}`,
      values,
    )
  }
}

/** 取组织节点 id（按 code）。 */
export async function costNodeId(pool: pg.Pool, code: string): Promise<string> {
  const r = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = $1`, [code])
  if (r.rowCount === 0) throw new Error(`测试节点缺失：${code}`)
  return r.rows[0]!.id
}
