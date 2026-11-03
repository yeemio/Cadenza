import type pg from 'pg'
import { createPool, migrateUp, migrations, seedOrgAuth } from '@cadenza/persistence'
import { createScryptPasswordHasher } from '@cadenza/application'
import { migration0016 } from '../../packages/persistence/src/migrations/0016-reporting'

/**
 * reporting 测试环境（P2-F / T20）：容器内独立数据库 cadenza_reporting（与共享 dev 库
 * cadenza 及各线独立库隔离）。每轮先 DROP 再 CREATE；迁移 = 注册表（0001–0010）+
 * 本域 0016（**不注册**，程序式应用——L0 整合步统一注册；防御性去重防 L0 注册后撞
 * schema_migrations 主键，同 scheduling/spc 先例）。
 *
 * 夹具覆盖合同取证面：RP-01 两类汇总键（采购收货码多余额行聚合 / 生产码多订单工序分键）、
 * RP-03 英尺截取（304.8000M→1000.0000ft 精确 / 非米 null）、RP-04 入库状态推导与筛选、
 * RP-08~09 轴查询字典与采购来源报工 `-`、RP-12/13/16 报工口径、RP-18~21 快照与缺失分母、
 * RP-22 谱系正反向追溯。
 */

export const RPT_TEST_DB_NAME = 'cadenza_reporting'

export function rptDatabaseUrl(): string {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  return base.replace(/\/cadenza$/, `/${RPT_TEST_DB_NAME}`)
}

/** 重建测试库（每轮 DROP+CREATE；PG13+ WITH (FORCE)）。 */
export async function ensureRptTestDatabase(): Promise<void> {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  const adminUrl = base.replace(/\/cadenza$/, '/postgres')
  const admin = createPool(adminUrl, { max: 1 })
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${RPT_TEST_DB_NAME} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${RPT_TEST_DB_NAME}`)
  } finally {
    await admin.end()
  }
}

/** 应用迁移（0001–0010 注册表 + 0016 程序式）+ org 种子 + reporting 授权。 */
export async function prepareRptTestDatabase(): Promise<pg.Pool> {
  await ensureRptTestDatabase()
  const pool = createPool(rptDatabaseUrl(), { max: 4 })
  const all = [...migrations]
  if (!all.some((m) => m.version === migration0016.version)) all.push(migration0016)
  await migrateUp(pool, all)
  await seedOrgAuth(pool, { passwordHasher: createScryptPasswordHasher() })
  await grantRptPermissions(pool)
  return pool
}

/**
 * 授予 reporting 许可（幂等合并，不覆盖种子 org 权限）：
 * - sysadmin（华东企业范围）：reporting.read/post（admin 账号，重建/注册/查询全链）；
 * - plantadmin（合肥厂 plant 范围）：reporting.read/post（跨厂命令 [A-S1] 拒绝与列表
 *   服务端过滤证据——HTTP 层不拦 body.plantId，二道防线在命令处理器）；
 * - qc（华东企业范围）：reporting.read（szqc01——PDA 操作工只算自己参与的证据）。
 */
export async function grantRptPermissions(pool: pg.Pool): Promise<void> {
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
       VALUES ($1, 'role', $2, $3, $4, $5, 'active', 'seed-rpt')
       ON CONFLICT (principal_type, principal_id, scope_type, scope_object_id) DO UPDATE SET
         permissions = (
           SELECT array_agg(DISTINCT p) FROM unnest(scope_grant.permissions || EXCLUDED.permissions) AS t(p)
         ),
         updated_at = now(),
         updated_by = 'seed-rpt'`,
      [role.rows[0]!.enterprise_id, role.rows[0]!.id, permissions, scopeType, scopeObject.rows[0]!.id],
    )
  }
  await grant('sysadmin', 'enterprise', 'ENT-HD', ['reporting.read', 'reporting.post'])
  await grant('plantadmin', 'plant', 'PLNT-HF', ['reporting.read', 'reporting.post'])
  await grant('qc', 'enterprise', 'ENT-HD', ['reporting.read'])
}

// ---------------- 夹具 ----------------

export const RPT_OWNER_ID = '22222222-2222-4222-8222-222222222201'
export const RPT_OWNER_NAME = '华东电缆集团（自有）'
export const RPT_UOM_KG_ID = '33333333-3333-4333-8333-3333333333d1'
export const RPT_UOM_M_ID = '33333333-3333-4333-8333-3333333333d2'
export const RPT_RECEIPT_ID = '44444444-4444-4444-8444-444444440001'

/** 班次日（口径锚点：产出行/投料行自带 shift_date=2026-10-20）。 */
export const RPT_SHIFT_DATE = '2026-10-20'

export interface RptFixtures {
  enterpriseId: string
  szPlantId: string
  hfPlantId: string
  jzDeptId: string
  qcDeptId: string
  adminUserId: string
  qcUserId: string
  /** 采购轴（KG，两库位余额 300+200 → RP-01 同键聚合 500） */
  purchaseUnitId: string
  purchaseUnitNo: string
  purchaseLotId: string
  /** 冻结采购轴（legacy 冻结口径并存标注） */
  frozenUnitId: string
  frozenUnitNo: string
  /** 成品轴 1（M 100，线边仓报工 → 未入库；双订单分键） */
  finUnit1Id: string
  finUnit1No: string
  /** 成品轴 2（M 304.8，仓库报工 → 已入库；已销售/不合格隔离） */
  finUnit2Id: string
  finUnit2No: string
  customerSegmentId: string
  /** 在制轴（KG 80，无报工 → 不入库存统计投影） */
  wipUnitId: string
  wipUnitNo: string
  /** 免检成品轴（qc_flag=0 → 免检） */
  exemptUnitNo: string
  /** 报工单 id（R1 订单A工序10 已审核 / R2 订单C工序10 已审核 / R4 订单B工序10 已审核 / R3 草稿 / R5 提交待审 szqc01） */
  reportR1Id: string
  reportR2Id: string
  reportR3Id: string
  reportR4Id: string
  reportR5Id: string
  orderAId: string
  orderBId: string
  orderCId: string
}

/** 直落业务事实（reporting 只读投影——测试以 SQL 直插既有域表构造事实，不经过业务命令）。 */
export async function seedRptFixtures(pool: pg.Pool): Promise<RptFixtures> {
  const ent = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = 'ENT-HD'`)
  const enterpriseId = ent.rows[0]!.id
  const szPlantId = await rptNodeId(pool, 'PLNT-SZ')
  const hfPlantId = await rptNodeId(pool, 'PLNT-HF')
  const jzDeptId = await rptNodeId(pool, 'DEPT-SZ-JZ')
  const qcDeptId = await rptNodeId(pool, 'DEPT-SZ-QC')
  const adminUser = await pool.query<{ id: string }>(`SELECT id FROM user_account WHERE login_name = 'admin'`)
  const qcUser = await pool.query<{ id: string }>(`SELECT id FROM user_account WHERE login_name = 'szqc01'`)
  const adminUserId = adminUser.rows[0]!.id
  const qcUserId = qcUser.rows[0]!.id

  // 共享命令回执（流水/谱系/投料的 FK 锚点；0001 enterprise_id 为 text）
  await pool.query(
    `INSERT INTO command_receipt (id, enterprise_id, command_type, operation_id, payload_digest, status, result)
     VALUES ($1, $2, 'seed.rpt', 'seed-rpt-0001', 'seed', 'COMMITTED', '{}'::jsonb)`,
    [RPT_RECEIPT_ID, enterpriseId],
  )

  // ---- 主数据（0003）：铜杆（采购）/ 成品缆 / 免检缆 + 仓库与库位 ----
  const insertMaterial = async (code: string, name: string, materialType: number, baseUom: string, qcFlag: number): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO material (org_scope_id, code, name, material_type, base_uom, qc_flag, spec, source_system, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, '0.5mm', 'U9', 'seed-rpt')
       ON CONFLICT (org_scope_id, code) WHERE status = 'active' DO UPDATE SET updated_at = now(), updated_by = 'seed-rpt'
       RETURNING id`,
      [enterpriseId, code, name, materialType, baseUom, qcFlag],
    )
    return r.rows[0]!.id
  }
  const rodMaterialId = await insertMaterial('MAT-RPT-ROD', '报表测试铜杆', 1, 'KG', 1)
  const cuMaterialId = await insertMaterial('MAT-RPT-CU', '报表测试成品缆', 3, 'M', 1)
  const cuExemptMaterialId = await insertMaterial('MAT-RPT-CU-EX', '报表测试免检缆', 3, 'M', 0)

  const insertWarehouse = async (code: string, name: string, warehouseType: string): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO warehouse (enterprise_id, plant_id, dept_id, code, name, warehouse_type, material_types, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, ARRAY[1,2,3]::smallint[], 'seed-rpt')
       ON CONFLICT (plant_id, code) WHERE status = 'active' DO UPDATE SET updated_at = now(), updated_by = 'seed-rpt'
       RETURNING id`,
      [enterpriseId, szPlantId, jzDeptId, code, name, warehouseType],
    )
    return r.rows[0]!.id
  }
  const whNormalId = await insertWarehouse('9301', '报表测试普通仓', 'WAREHOUSE')
  const whLineSideId = await insertWarehouse('9302', '报表测试线边仓', 'LINE_SIDE')
  const insertLocation = async (code: string, warehouseId: string): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO storage_location (enterprise_id, plant_id, warehouse_id, location_kind, code, created_by)
       VALUES ($1, $2, $3, 'NORMAL', $4, 'seed-rpt')
       ON CONFLICT (plant_id, code) WHERE status = 'active' DO UPDATE SET updated_at = now(), updated_by = 'seed-rpt'
       RETURNING id`,
      [enterpriseId, szPlantId, warehouseId, code],
    )
    return r.rows[0]!.id
  }
  const locWhFinished = await insertLocation('93010101', whNormalId) // 成品入库位（F02 报工目标）
  const locWhReceive = await insertLocation('93010102', whNormalId) // 采购收货位
  const locWhExtra = await insertLocation('93010103', whNormalId) // 采购轴第二余额位
  const locLine1 = await insertLocation('93020101', whLineSideId) // 线边位 1（F01 报工目标）
  const locLine2 = await insertLocation('93020102', whLineSideId) // 线边位 2

  // ---- 工作中心 + 工序定义（订单工序 FK 锚点，0005） ----
  const wc = await pool.query<{ id: string }>(
    `INSERT INTO work_center (enterprise_id, plant_id, dept_id, code, name, created_by)
     VALUES ($1, $2, $3, 'WC-RPT-01', '报表测试工作中心', 'seed-rpt')
     ON CONFLICT (code) WHERE status = 'active' DO UPDATE SET updated_at = now() RETURNING id`,
    [enterpriseId, szPlantId, jzDeptId],
  )
  const workCenterId = wc.rows[0]!.id
  const opDef = async (code: string, name: string, deptId: string): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO operation_definition (enterprise_id, plant_id, dept_id, work_center_id,
         company_org_code, code, name, created_by)
       VALUES ($1, $2, $3, $4, 'ORG-RPT', $5, $6, 'seed-rpt')
       ON CONFLICT (company_org_code, code) WHERE status = 'active' DO UPDATE SET updated_at = now() RETURNING id`,
      [enterpriseId, szPlantId, deptId, workCenterId, code, name],
    )
    return r.rows[0]!.id
  }
  const opJsDefId = await opDef('OP-RPT-JS', '报表测试绞制', jzDeptId)
  const opQcDefId = await opDef('OP-RPT-QC', '报表测试检验', qcDeptId)

  // ---- 生产订单 + 工序（0005）：A 准时完成 / B 逾期完成 / C 在制（未完成） ----
  const insertOrder = async (
    orderNo: string,
    input: { deptId: string; plannedFinish: string; actualFinish: string | null; opDefId: string; opDeptId: string },
  ): Promise<{ orderId: string; operationId: string }> => {
    const order = await pool.query<{ id: string }>(
      `INSERT INTO production_order (enterprise_id, plant_id, order_no, material_id, production_dept_id,
         production_qty, uom, order_status, process_config_status, process_confirmed_at, actual_start_at,
         planned_finish_at, actual_finish_at, created_by)
       VALUES ($1, $2, $3, $4, $5, 1000, 'M', 'in_progress', 'configured', now(), now(), $6::timestamptz,
         $7::timestamptz, 'seed-rpt')
       RETURNING id`,
      [enterpriseId, szPlantId, orderNo, cuMaterialId, input.deptId, input.plannedFinish, input.actualFinish],
    )
    const op = await pool.query<{ id: string }>(
      `INSERT INTO order_operation (enterprise_id, plant_id, order_id, seq, operation_definition_id,
         operation_code, operation_name, core_multiple, offline_qty, work_center_id, work_center_code,
         work_center_name, uom, production_dept_id, created_by)
       VALUES ($1, $2, $3, 10, $4, 'OP-RPT-10', '报表测试绞制', 1, 1000, $5, 'WC-RPT-01', '报表测试工作中心',
         'M', $6, 'seed-rpt')
       RETURNING id`,
      [enterpriseId, szPlantId, order.rows[0]!.id, input.opDefId, workCenterId, input.opDeptId],
    )
    return { orderId: order.rows[0]!.id, operationId: op.rows[0]!.id }
  }
  const orderA = await insertOrder('PO-RPT-2401', {
    deptId: jzDeptId,
    plannedFinish: '2026-10-25 10:00:00+08',
    actualFinish: '2026-10-24 18:00:00+08',
    opDefId: opJsDefId,
    opDeptId: jzDeptId,
  })
  const orderB = await insertOrder('PO-RPT-2402', {
    deptId: jzDeptId,
    plannedFinish: '2026-10-25 10:00:00+08',
    actualFinish: '2026-10-26 09:00:00+08',
    opDefId: opJsDefId,
    opDeptId: jzDeptId,
  })
  const orderC = await insertOrder('PO-RPT-2403', {
    deptId: qcDeptId,
    plannedFinish: '2026-10-30 10:00:00+08',
    actualFinish: null,
    opDefId: opQcDefId,
    opDeptId: qcDeptId,
  })

  // ---- 库存事实（0004）：批次 / 单元 / 余额 / 流水 / 分段 / 客户分段 / 预留 / 谱系 ----
  const insertLot = async (lotNo: string, kind: 'purchase' | 'production', materialId: string, materialCode: string, supplierLotNo: string | null): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO material_lot (lot_no, kind, material_id, material_code, supplier_lot_no, plant_id, enterprise_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'seed-rpt') RETURNING id`,
      [lotNo, kind, materialId, materialCode, supplierLotNo, szPlantId, enterpriseId],
    )
    return r.rows[0]!.id
  }
  const rodCode = 'MAT-RPT-ROD'
  const cuCode = 'MAT-RPT-CU'
  const lotP1 = await insertLot('LOT-RPT-P1', 'purchase', rodMaterialId, rodCode, 'SUP-A')
  const lotP2 = await insertLot('LOT-RPT-P2', 'purchase', rodMaterialId, rodCode, 'SUP-B')
  const lotF1 = await insertLot('LOT-RPT-F1', 'production', cuMaterialId, cuCode, null)
  const lotF2 = await insertLot('LOT-RPT-F2', 'production', cuMaterialId, cuCode, null)
  const lotF3 = await insertLot('LOT-RPT-F3', 'production', cuMaterialId, cuCode, null)
  const lotF4 = await insertLot('LOT-RPT-F4', 'production', cuExemptMaterialId, 'MAT-RPT-CU-EX', null)

  const insertUnit = async (
    unitNo: string,
    materialId: string,
    materialCode: string,
    lotId: string,
    uomId: string,
    uomCode: string,
    status: string,
  ): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO inventory_unit (unit_no, material_id, material_code, lot_id, uom_id, uom_code, status, plant_id, enterprise_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'seed-rpt') RETURNING id`,
      [unitNo, materialId, materialCode, lotId, uomId, uomCode, status, szPlantId, enterpriseId],
    )
    return r.rows[0]!.id
  }
  const purchaseUnitNo = 'RPT-P01'
  const frozenUnitNo = 'RPT-P02'
  const finUnit1No = 'RPT-F01'
  const finUnit2No = 'RPT-F02'
  const wipUnitNo = 'RPT-F03'
  const exemptUnitNo = 'RPT-F04'
  const purchaseUnitId = await insertUnit(purchaseUnitNo, rodMaterialId, rodCode, lotP1, RPT_UOM_KG_ID, 'KG', 'in_stock')
  const frozenUnitId = await insertUnit(frozenUnitNo, rodMaterialId, rodCode, lotP2, RPT_UOM_KG_ID, 'KG', 'in_stock')
  const finUnit1Id = await insertUnit(finUnit1No, cuMaterialId, cuCode, lotF1, RPT_UOM_M_ID, 'M', 'in_stock')
  const finUnit2Id = await insertUnit(finUnit2No, cuMaterialId, cuCode, lotF2, RPT_UOM_M_ID, 'M', 'in_stock')
  const wipUnitId = await insertUnit(wipUnitNo, cuMaterialId, cuCode, lotF3, RPT_UOM_KG_ID, 'KG', 'in_production')
  const exemptUnitId = await insertUnit(exemptUnitNo, cuExemptMaterialId, 'MAT-RPT-CU-EX', lotF4, RPT_UOM_M_ID, 'M', 'in_stock')

  const insertBalance = async (
    unitId: string,
    locationId: string,
    locationCode: string,
    quantity: string,
    uomId: string,
    uomCode: string,
    legacyStatus: string | null,
  ): Promise<void> => {
    await pool.query(
      `INSERT INTO stock_balance (unit_id, location_id, location_code, owner_id, owner_name, quantity,
         uom_id, uom_code, measurement_basis, quality_status, legacy_status, status, plant_id, enterprise_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'nominal', 'qualified', $9, 'active', $10, $11, 'seed-rpt')`,
      [unitId, locationId, locationCode, RPT_OWNER_ID, RPT_OWNER_NAME, quantity, uomId, uomCode, legacyStatus, szPlantId, enterpriseId],
    )
  }
  // RP-01 采购收货码同键多余额行（两库位 300+200 → 聚合一条 500）
  await insertBalance(purchaseUnitId, locWhReceive, '93010102', '300.0000', RPT_UOM_KG_ID, 'KG', 'normal')
  await insertBalance(purchaseUnitId, locWhExtra, '93010103', '200.0000', RPT_UOM_KG_ID, 'KG', 'normal')
  // 冻结口径（RP-02 legacy 并存标注；RP-04 非正常 → 入库状态空）
  await insertBalance(frozenUnitId, locWhReceive, '93010102', '100.0000', RPT_UOM_KG_ID, 'KG', 'frozen')
  await insertBalance(finUnit1Id, locLine1, '93020101', '100.0000', RPT_UOM_M_ID, 'M', 'normal')
  await insertBalance(finUnit2Id, locWhFinished, '93010101', '304.8000', RPT_UOM_M_ID, 'M', 'normal')
  await insertBalance(wipUnitId, locLine1, '93020101', '80.0000', RPT_UOM_KG_ID, 'KG', 'normal')
  await insertBalance(exemptUnitId, locLine2, '93020102', '10.0000', RPT_UOM_M_ID, 'M', 'normal')

  // 流水（入库/出库展示列推导源 + RP-18 班次日并集源）
  const insertTransaction = async (
    unitId: string,
    lotId: string,
    movementKind: string,
    quantity: string,
    uomId: string,
    uomCode: string,
    businessTime: string,
    toLocationId: string | null,
    toCode: string | null,
    fromLocationId: string | null,
    fromCode: string | null,
  ): Promise<void> => {
    await pool.query(
      `INSERT INTO stock_transaction (command_receipt_id, line_no, movement_kind, unit_id, lot_id,
         from_location_id, from_location_code, to_location_id, to_location_code, from_owner_id, from_owner_name,
         to_owner_id, to_owner_name, quantity, uom_id, uom_code, measurement_basis, before_qty, after_qty,
         business_time, shift_date, plant_id, enterprise_id, created_by)
       VALUES ($1, (SELECT COALESCE(max(line_no),0)+1 FROM stock_transaction WHERE command_receipt_id = $1),
         $3, $2, $4,
         $5, $6, $7, $8, $9, $10, $9, $10, $11, $12, $13, 'nominal', $11, $11, $14::timestamptz, NULL,
         $15, $16, 'seed-rpt')`,
      [
        RPT_RECEIPT_ID,
        unitId,
        movementKind,
        lotId,
        fromLocationId,
        fromCode,
        toLocationId,
        toCode,
        RPT_OWNER_ID,
        RPT_OWNER_NAME,
        quantity,
        uomId,
        uomCode,
        businessTime,
        szPlantId,
        enterpriseId,
      ],
    )
  }
  await insertTransaction(purchaseUnitId, lotP1, 'receive', '500.0000', RPT_UOM_KG_ID, 'KG', '2026-10-10 09:00:00+08', locWhReceive, '93010102', null, null)
  await insertTransaction(purchaseUnitId, lotP1, 'issue', '30.0000', RPT_UOM_KG_ID, 'KG', '2026-10-15 14:00:00+08', null, null, locWhReceive, '93010102')
  await insertTransaction(finUnit1Id, lotF1, 'receive', '100.0000', RPT_UOM_M_ID, 'M', `${RPT_SHIFT_DATE} 16:00:00+08`, locLine1, '93020101', null, null)
  await insertTransaction(finUnit2Id, lotF2, 'receive', '304.8000', RPT_UOM_M_ID, 'M', '2026-10-19 10:00:00+08', locWhFinished, '93010101', null, null)

  // 轴段（段长展示列源）
  await pool.query(
    `INSERT INTO material_segment (unit_id, seq_no, kind, length_start, length_end, quantity, uom_id, uom_code,
       measurement_basis, plant_id, enterprise_id, created_by)
     VALUES ($1, 1, 'continuous', 0, 304.8000, 304.8000, $2, 'M', 'nominal', $3, $4, 'seed-rpt')`,
    [finUnit2Id, RPT_UOM_M_ID, szPlantId, enterpriseId],
  )

  // 客户分段（销售状态 + 客户轴号 + 谱系 customer_binding 目标）
  const customerSegment = await pool.query<{ id: string }>(
    `INSERT INTO customer_segment (unit_id, order_no, customer_ref, status, plant_id, enterprise_id, created_by)
     VALUES ($1, 'PO-RPT-2403', 'CUST-AX-001', 'allocated', $2, $3, 'seed-rpt') RETURNING id`,
    [finUnit2Id, szPlantId, enterpriseId],
  )
  const customerSegmentId = customerSegment.rows[0]!.id

  // 预留（锁定状态源）
  await pool.query(
    `INSERT INTO reservation (unit_id, location_id, holder_type, holder_ref, quantity, uom_id, uom_code,
       measurement_basis, status, valid_until, command_receipt_id, plant_id, enterprise_id, created_by)
     VALUES ($1, $2, 'manual', 'RPT-LOCK-01', 50, $3, 'M', 'nominal', 'active', now() + interval '30 days',
       $4, $5, $6, 'seed-rpt')`,
    [finUnit1Id, locLine1, RPT_UOM_M_ID, RPT_RECEIPT_ID, szPlantId, enterpriseId],
  )

  // 质量隔离（成品异常状态源；0009 quality_hold 无 plant/enterprise 列）
  await pool.query(
    `INSERT INTO quality_hold (inventory_unit_id, unit_no, hold_kind, status, raised_by, raised_at, created_by)
     VALUES ($1, $2, 'unqualified', 'active', 'seed-rpt', now(), 'seed-rpt')`,
    [finUnit2Id, finUnit2No],
  )

  // 谱系（RP-22 / IT-35 正反向）：批次→采购轴（receipt_origin）→ 消耗 → 成品轴 → 客户分段
  const insertEdge = async (
    fromType: string,
    fromId: string,
    toType: string,
    toId: string,
    edgeKind: string,
    quantity: string,
    uomId: string,
    uomCode: string,
  ): Promise<void> => {
    await pool.query(
      `INSERT INTO genealogy_edge (from_type, from_id, to_type, to_id, edge_kind, quantity, uom_id, uom_code,
         measurement_basis, command_receipt_id, business_time, plant_id, enterprise_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'nominal', $9, '2026-10-18 08:00:00+08', $10, $11, 'seed-rpt')`,
      [fromType, fromId, toType, toId, edgeKind, quantity, uomId, uomCode, RPT_RECEIPT_ID, szPlantId, enterpriseId],
    )
  }
  await insertEdge('material_lot', lotP1, 'inventory_unit', purchaseUnitId, 'receipt_origin', '500.0000', RPT_UOM_KG_ID, 'KG')
  await insertEdge('inventory_unit', purchaseUnitId, 'inventory_unit', finUnit2Id, 'consumption', '304.8000', RPT_UOM_M_ID, 'M')
  await insertEdge('inventory_unit', finUnit2Id, 'customer_segment', customerSegmentId, 'customer_binding', '304.8000', RPT_UOM_M_ID, 'M')

  // ---- 报工事实（0008）：会话 + 报工单 + 产出行 + 投料 ----
  interface ReportSeed {
    suffix: string
    orderId: string
    operationId: string
    operatorUserId: string
    operatorLogin: string
    status: 'draft' | 'submitted'
    reviewStatus: 'pending_review' | 'auto_approved' | 'manual_approved'
    shiftDate: string
    businessTime: string
    equipmentCode: string
    outputs: Array<{
      lineNo: number
      quantity: string
      qualifiedQty: string
      uomId: string
      uomCode: string
      stockUnitId: string | null
      targetLocationId: string
      targetLocationCode: string
    }>
  }
  const insertReport = async (seed: ReportSeed): Promise<string> => {
    const session = await pool.query<{ id: string }>(
      `INSERT INTO execution_session (enterprise_id, plant_id, order_id, source, operator_user_id,
         operator_login, shift_date, status, business_time, equipment_code, created_by)
       VALUES ($1, $2, $3, 'order', $4, $5, $6::date, 'submitted', $7::timestamptz, $8, 'seed-rpt')
       RETURNING id`,
      [enterpriseId, szPlantId, seed.orderId, seed.operatorUserId, seed.operatorLogin, seed.shiftDate, seed.businessTime, seed.equipmentCode],
    )
    const report = await pool.query<{ id: string }>(
      `INSERT INTO production_report (enterprise_id, plant_id, session_id, order_id, order_operation_id,
         operation_seq, source, status, review_status, operator_user_id, operator_login, business_time,
         shift_date, equipment_code, reviewed_at, reviewed_by, created_by)
       VALUES ($1, $2, $3, $4, $5, 10, 'order', $6, $7, $8, $9, $10::timestamptz, $11::date, $12,
         CASE WHEN $7 <> 'pending_review' THEN $10::timestamptz ELSE NULL END, 'seed-rpt', 'seed-rpt')
       RETURNING id`,
      [
        enterpriseId,
        szPlantId,
        session.rows[0]!.id,
        seed.orderId,
        seed.operationId,
        seed.status,
        seed.reviewStatus,
        seed.operatorUserId,
        seed.operatorLogin,
        seed.businessTime,
        seed.shiftDate,
        seed.equipmentCode,
      ],
    )
    for (const out of seed.outputs) {
      await pool.query(
        `INSERT INTO report_output (enterprise_id, plant_id, report_id, line_no, quantity, qualified_qty,
           uom_id, uom_code, stock_unit_id, target_location_id, target_location_code, owner_id, owner_name,
           measurement_basis, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'nominal', 'seed-rpt')`,
        [
          enterpriseId,
          szPlantId,
          report.rows[0]!.id,
          out.lineNo,
          out.quantity,
          out.qualifiedQty,
          out.uomId,
          out.uomCode,
          out.stockUnitId,
          out.targetLocationId,
          out.targetLocationCode,
          RPT_OWNER_ID,
          RPT_OWNER_NAME,
        ],
      )
    }
    return report.rows[0]!.id
  }

  // R1：订单 A 工序 10（绞制/JZ），已审核，产出挂 F01（100M 全合格）→ 线边仓
  const reportR1Id = await insertReport({
    suffix: 'R1',
    orderId: orderA.orderId,
    operationId: orderA.operationId,
    operatorUserId: adminUserId,
    operatorLogin: 'admin',
    status: 'submitted',
    reviewStatus: 'manual_approved',
    shiftDate: RPT_SHIFT_DATE,
    businessTime: `${RPT_SHIFT_DATE} 16:00:00+08`,
    equipmentCode: 'EQ-RPT-01',
    outputs: [
      { lineNo: 1, quantity: '100.0000', qualifiedQty: '100.0000', uomId: RPT_UOM_M_ID, uomCode: 'M', stockUnitId: finUnit1Id, targetLocationId: locLine1, targetLocationCode: '93020101' },
    ],
  })
  // R2：订单 C 工序 10（检验/QC），已审核，产出挂 F02（304.8M 合格 300，另班次日 10-19）
  const reportR2Id = await insertReport({
    suffix: 'R2',
    orderId: orderC.orderId,
    operationId: orderC.operationId,
    operatorUserId: adminUserId,
    operatorLogin: 'admin',
    status: 'submitted',
    reviewStatus: 'manual_approved',
    shiftDate: '2026-10-19',
    businessTime: '2026-10-19 10:00:00+08',
    equipmentCode: 'EQ-RPT-02',
    outputs: [
      { lineNo: 1, quantity: '304.8000', qualifiedQty: '300.0000', uomId: RPT_UOM_M_ID, uomCode: 'M', stockUnitId: finUnit2Id, targetLocationId: locWhFinished, targetLocationCode: '93010101' },
    ],
  })
  // R3：订单 A 工序 10 草稿（无库存单元）→ 草稿口径证据
  const reportR3Id = await insertReport({
    suffix: 'R3',
    orderId: orderA.orderId,
    operationId: orderA.operationId,
    operatorUserId: adminUserId,
    operatorLogin: 'admin',
    status: 'draft',
    reviewStatus: 'pending_review',
    shiftDate: '2026-10-21',
    businessTime: '2026-10-21 09:00:00+08',
    equipmentCode: 'EQ-RPT-01',
    outputs: [
      { lineNo: 1, quantity: '20.0000', qualifiedQty: '20.0000', uomId: RPT_UOM_M_ID, uomCode: 'M', stockUnitId: null, targetLocationId: locLine1, targetLocationCode: '93020101' },
    ],
  })
  // R4：订单 B 工序 10（绞制/JZ），自动审核，产出仍挂 F01 → RP-01 生产码同轴双订单分键
  const reportR4Id = await insertReport({
    suffix: 'R4',
    orderId: orderB.orderId,
    operationId: orderB.operationId,
    operatorUserId: adminUserId,
    operatorLogin: 'admin',
    status: 'submitted',
    reviewStatus: 'auto_approved',
    shiftDate: RPT_SHIFT_DATE,
    businessTime: `${RPT_SHIFT_DATE} 17:00:00+08`,
    equipmentCode: 'EQ-RPT-03',
    outputs: [
      { lineNo: 1, quantity: '150.0000', qualifiedQty: '150.0000', uomId: RPT_UOM_M_ID, uomCode: 'M', stockUnitId: finUnit1Id, targetLocationId: locLine2, targetLocationCode: '93020102' },
    ],
  })
  // R5：订单 A 工序 10，szqc01 提交待审（无库存单元）→ PDA 操作工只算自己证据
  const reportR5Id = await insertReport({
    suffix: 'R5',
    orderId: orderA.orderId,
    operationId: orderA.operationId,
    operatorUserId: qcUserId,
    operatorLogin: 'szqc01',
    status: 'submitted',
    reviewStatus: 'pending_review',
    shiftDate: RPT_SHIFT_DATE,
    businessTime: `${RPT_SHIFT_DATE} 18:00:00+08`,
    equipmentCode: 'EQ-RPT-01',
    outputs: [
      { lineNo: 1, quantity: '50.0000', qualifiedQty: '45.0000', uomId: RPT_UOM_M_ID, uomCode: 'M', stockUnitId: null, targetLocationId: locLine1, targetLocationCode: '93020101' },
    ],
  })

  // 投料（损耗指标分子源）：班次日 10-20 投料 500M（订单 A 工序 10）
  await pool.query(
    `INSERT INTO material_consumption (enterprise_id, plant_id, order_id, order_operation_id, operation_seq,
       feed_type, inventory_unit_id, unit_no, quantity, before_qty, after_qty, uom_id, uom_code,
       cross_order, operator_user_id, operator_login, business_time, shift_date, command_receipt_id, created_by)
     VALUES ($1, $2, $3, $4, 10, 'standalone', $5, $6, 500, 500, 0, $7, 'M', false, $8, 'admin',
       '2026-10-20 10:00:00+08', $9::date, $10, 'seed-rpt')`,
    [enterpriseId, szPlantId, orderA.orderId, orderA.operationId, purchaseUnitId, purchaseUnitNo, RPT_UOM_M_ID, adminUserId, RPT_SHIFT_DATE, RPT_RECEIPT_ID],
  )

  return {
    enterpriseId,
    szPlantId,
    hfPlantId,
    jzDeptId,
    qcDeptId,
    adminUserId,
    qcUserId,
    purchaseUnitId,
    purchaseUnitNo,
    purchaseLotId: lotP1,
    frozenUnitId,
    frozenUnitNo,
    finUnit1Id,
    finUnit1No,
    finUnit2Id,
    finUnit2No,
    customerSegmentId,
    wipUnitId,
    wipUnitNo,
    exemptUnitNo,
    reportR1Id,
    reportR2Id,
    reportR3Id,
    reportR4Id,
    reportR5Id,
    orderAId: orderA.orderId,
    orderBId: orderB.orderId,
    orderCId: orderC.orderId,
  }
}

/** 取组织节点 id（按 code）。 */
export async function rptNodeId(pool: pg.Pool, code: string): Promise<string> {
  const r = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = $1`, [code])
  if (r.rowCount === 0) throw new Error(`测试节点缺失：${code}`)
  return r.rows[0]!.id
}
