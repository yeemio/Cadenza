import type pg from 'pg'
import { createPool, migrateUp, migrations, seedOrgAuth } from '@cadenza/persistence'
import { createScryptPasswordHasher } from '@cadenza/application'
import { migration0015 } from '../../packages/persistence/src/migrations/0015-maintenance'

/**
 * maintenance 测试环境（P2-E / T19）：容器内独立数据库 cadenza_maintenance（与共享 dev 库
 * cadenza 及各线独立库隔离）。每轮先 DROP 再 CREATE；迁移 = 注册表（0001–0010）+
 * 本域 0015（**不注册**，程序式应用——L0 整合步统一注册；防御性去重防 L0 注册后撞
 * schema_migrations 主键，同 reporting 先例）。
 *
 * 夹具覆盖合同取证面：MT-01~06 设备档案（正常态设备×3）/备件余额（100KG 合格在库，
 * MT-11 消耗与不足）/MT-04 扫码码形（主档编码不带前缀，扫码带前缀）。
 * MT-11 修复（2026-10）增补三备件单元：合格 40＋活动预留 25（可用 15，IT-14 预留感知）、
 * 待检 30（质量不放行可用 0）、合格 20（整额扣尽 → IT-29 零余额关闭/单元耗尽）。
 * 工单/停机/计划/轮次/开工事实全部经真实命令链产生（不直落业务表）。
 */

export const MNT_TEST_DB_NAME = 'cadenza_maintenance'

export function mntDatabaseUrl(): string {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  return base.replace(/\/cadenza$/, `/${MNT_TEST_DB_NAME}`)
}

/** 重建测试库（每轮 DROP+CREATE；PG13+ WITH (FORCE)）。 */
export async function ensureMntTestDatabase(): Promise<void> {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  const adminUrl = base.replace(/\/cadenza$/, '/postgres')
  const admin = createPool(adminUrl, { max: 1 })
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${MNT_TEST_DB_NAME} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${MNT_TEST_DB_NAME}`)
  } finally {
    await admin.end()
  }
}

/** 应用迁移（0001–0010 注册表 + 0015 程序式）+ org 种子 + maintenance 授权。 */
export async function prepareMntTestDatabase(): Promise<pg.Pool> {
  await ensureMntTestDatabase()
  const pool = createPool(mntDatabaseUrl(), { max: 4 })
  const all = [...migrations]
  if (!all.some((m) => m.version === migration0015.version)) all.push(migration0015)
  await migrateUp(pool, all)
  await seedOrgAuth(pool, { passwordHasher: createScryptPasswordHasher() })
  await grantMntPermissions(pool)
  return pool
}

/**
 * 授予 maintenance 许可（幂等合并，不覆盖种子 org 权限）：
 * - sysadmin（华东企业范围）：maintenance.read/post（admin 账号，全链命令与查询）；
 * - plantadmin（合肥厂 plant 范围）：maintenance.read/post（SZ 工厂越权 403/命令
 *   二道防线 [A-S1] 证据——HTTP 层不拦 body.plantId，二道防线在命令处理器）；
 * - qc（华东企业范围）：maintenance.read（szqc01——只读不可命令证据）。
 */
export async function grantMntPermissions(pool: pg.Pool): Promise<void> {
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
       VALUES ($1, 'role', $2, $3, $4, $5, 'active', 'seed-mnt')
       ON CONFLICT (principal_type, principal_id, scope_type, scope_object_id) DO UPDATE SET
         permissions = (
           SELECT array_agg(DISTINCT p) FROM unnest(scope_grant.permissions || EXCLUDED.permissions) AS t(p)
         ),
         updated_at = now(),
         updated_by = 'seed-mnt'`,
      [role.rows[0]!.enterprise_id, role.rows[0]!.id, permissions, scopeType, scopeObject.rows[0]!.id],
    )
  }
  await grant('sysadmin', 'enterprise', 'ENT-HD', ['maintenance.read', 'maintenance.post'])
  await grant('plantadmin', 'plant', 'PLNT-HF', ['maintenance.read', 'maintenance.post'])
  await grant('qc', 'enterprise', 'ENT-HD', ['maintenance.read'])
}

// ---------------- 夹具 ----------------

export const MNT_OWNER_ID = '22222222-2222-4222-8222-222222222201'
export const MNT_OWNER_NAME = '华东电缆集团（自有）'
export const MNT_UOM_KG_ID = '33333333-3333-4333-8333-3333333333d1'
/** 备件余额初始量（MT-11 消耗/不足两分支：30.5 消耗后余 69.5；200 超量拒绝）。 */
export const MNT_SPARE_INITIAL_QTY = '100.0000'

export interface MntFixtures {
  enterpriseId: string
  szPlantId: string
  hfPlantId: string
  jzDeptId: string
  adminUserId: string
  /** 正常态设备（主链：建单→分派→处理→待复机→复机） */
  eq1Id: string
  eq1Code: string
  /** 正常态设备（取消语义链） */
  eq2Id: string
  eq2Code: string
  /** 正常态设备（异常上报链；扫码带前缀） */
  eq3Id: string
  eq3Code: string
  /** 正常态设备（MT-11 修复并发取证：与 eq2 并发两单扣同一备件单元） */
  eq4Id: string
  eq4Code: string
  /** 备件库存单元（KG 100 合格在库） */
  spareUnitId: string
  spareUnitNo: string
  spareLocationCode: string
  /** MT-11 修复夹具：合格 40 且带活动预留 25（可用 15——预留感知反证/合法扣减） */
  spareReservedUnitId: string
  /** MT-11 修复夹具：待检 30（IT-14 质量不放行 → 可用 0，不可用库存拒绝） */
  spareUnqualifiedUnitId: string
  /** MT-11 修复夹具：合格 20（整额扣尽 → IT-29 零余额关闭＋单元耗尽） */
  spareDrainUnitId: string
  /** MT-11 修复夹具：合格 30（并发两单各扣 20 → 恰一成功，IT-30-① 余量竞争） */
  spareConcurrentUnitId: string
}

/** 直落主数据与库存夹具（设备/工作中心/备件物料批次单元余额——工单域事实走命令链）。 */
export async function seedMntFixtures(pool: pg.Pool): Promise<MntFixtures> {
  const ent = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = 'ENT-HD'`)
  const enterpriseId = ent.rows[0]!.id
  const szPlantId = await mntNodeId(pool, 'PLNT-SZ')
  const hfPlantId = await mntNodeId(pool, 'PLNT-HF')
  const jzDeptId = await mntNodeId(pool, 'DEPT-SZ-JZ')
  const adminUser = await pool.query<{ id: string }>(`SELECT id FROM user_account WHERE login_name = 'admin'`)
  const adminUserId = adminUser.rows[0]!.id

  // 工作中心（0003）
  const wc = await pool.query<{ id: string }>(
    `INSERT INTO work_center (enterprise_id, plant_id, dept_id, code, name, created_by)
     VALUES ($1, $2, $3, 'WC-MNT-01', '维护测试工作中心', 'seed-mnt')
     ON CONFLICT (code) WHERE status = 'active' DO UPDATE SET updated_at = now() RETURNING id`,
    [enterpriseId, szPlantId, jzDeptId],
  )
  const workCenterId = wc.rows[0]!.id

  // 设备×3（0003；主档编码不带前缀——MD-15 生成严格归 T04，MT-04 扫码前缀在命令侧剥离）
  const insertEquipment = async (code: string, name: string): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO equipment (enterprise_id, plant_id, dept_id, work_center_id, code, name,
         equipment_status, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 1, 'active', 'seed-mnt')
       ON CONFLICT (code) WHERE status = 'active' DO UPDATE SET updated_at = now() RETURNING id`,
      [enterpriseId, szPlantId, jzDeptId, workCenterId, code, name],
    )
    return r.rows[0]!.id
  }
  const eq1Code = 'JC-MNT-01'
  const eq2Code = 'JC-MNT-02'
  const eq3Code = 'JC-MNT-03'
  const eq4Code = 'JC-MNT-04'
  const eq1Id = await insertEquipment(eq1Code, '绞制一号机（维护测试）')
  const eq2Id = await insertEquipment(eq2Code, '绞制二号机（维护测试）')
  const eq3Id = await insertEquipment(eq3Code, '绞制三号机（维护测试）')
  const eq4Id = await insertEquipment(eq4Code, '绞制四号机（维护测试）')

  // 备件物料（备件作为物料走同一库存域，MT-11）+ 仓库库位
  const material = await pool.query<{ id: string }>(
    `INSERT INTO material (org_scope_id, code, name, material_type, base_uom, qc_flag, spec, source_system, created_by)
     VALUES ($1, 'MAT-MNT-SPARE', '维护测试备件轴承', 1, 'KG', 1, '6204', 'U9', 'seed-mnt')
     ON CONFLICT (org_scope_id, code) WHERE status = 'active' DO UPDATE SET updated_at = now() RETURNING id`,
    [enterpriseId],
  )
  const spareMaterialId = material.rows[0]!.id
  const warehouse = await pool.query<{ id: string }>(
    `INSERT INTO warehouse (enterprise_id, plant_id, dept_id, code, name, warehouse_type, material_types, created_by)
     VALUES ($1, $2, $3, '9401', '维护测试备件仓', 'WAREHOUSE', ARRAY[1,2,3]::smallint[], 'seed-mnt')
     ON CONFLICT (plant_id, code) WHERE status = 'active' DO UPDATE SET updated_at = now() RETURNING id`,
    [enterpriseId, szPlantId, jzDeptId],
  )
  const location = await pool.query<{ id: string; code: string }>(
    `INSERT INTO storage_location (enterprise_id, plant_id, warehouse_id, location_kind, code, created_by)
     VALUES ($1, $2, $3, 'NORMAL', '94010101', 'seed-mnt')
     ON CONFLICT (plant_id, code) WHERE status = 'active' DO UPDATE SET updated_at = now() RETURNING id, code`,
    [enterpriseId, szPlantId, warehouse.rows[0]!.id],
  )
  const spareLocationId = location.rows[0]!.id
  const spareLocationCode = location.rows[0]!.code

  const lot = await pool.query<{ id: string }>(
    `INSERT INTO material_lot (lot_no, kind, material_id, material_code, plant_id, enterprise_id, created_by)
     VALUES ('LOT-MNT-SP1', 'purchase', $1, 'MAT-MNT-SPARE', $2, $3, 'seed-mnt') RETURNING id`,
    [spareMaterialId, szPlantId, enterpriseId],
  )
  const spareLotId = lot.rows[0]!.id

  // 备件单元＋余额夹具助手（同批次同库位；MT-11 修复 2026-10 增补预留/待检/扣尽三单元）
  const seedSpareUnit = async (
    unitNo: string,
    quantity: string,
    qualityStatus: 'qualified' | 'pending_inspection',
  ): Promise<string> => {
    const unit = await pool.query<{ id: string }>(
      `INSERT INTO inventory_unit (unit_no, material_id, material_code, lot_id, uom_id, uom_code, status,
         plant_id, enterprise_id, created_by)
       VALUES ($1, $2, 'MAT-MNT-SPARE', $3, $4, 'KG', 'in_stock', $5, $6, 'seed-mnt') RETURNING id`,
      [unitNo, spareMaterialId, spareLotId, MNT_UOM_KG_ID, szPlantId, enterpriseId],
    )
    const unitId = unit.rows[0]!.id
    await pool.query(
      `INSERT INTO stock_balance (unit_id, location_id, location_code, owner_id, owner_name, quantity,
         uom_id, uom_code, measurement_basis, quality_status, status, plant_id, enterprise_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, 'KG', 'nominal', $8, 'active', $9, $10, 'seed-mnt')`,
      [unitId, spareLocationId, spareLocationCode, MNT_OWNER_ID, MNT_OWNER_NAME, quantity, MNT_UOM_KG_ID, qualityStatus, szPlantId, enterpriseId],
    )
    return unitId
  }

  const spareUnitId = await seedSpareUnit('MNT-SP01', MNT_SPARE_INITIAL_QTY, 'qualified')
  // MT-11 修复夹具（预留感知 IT-14 / 质量不放行 / 扣尽关闭 IT-29）
  const spareReservedUnitId = await seedSpareUnit('MNT-SP02', '40.0000', 'qualified')
  await pool.query(
    `INSERT INTO reservation (unit_id, location_id, holder_type, holder_ref, quantity, uom_id, uom_code,
       measurement_basis, status, valid_until, plant_id, enterprise_id, created_by)
     VALUES ($1, $2, 'order', 'MT11-FIX-RESV', 25::numeric, $3, 'KG', 'nominal', 'active', now() + interval '1 day', $4, $5, 'seed-mnt')`,
    [spareReservedUnitId, spareLocationId, MNT_UOM_KG_ID, szPlantId, enterpriseId],
  )
  const spareUnqualifiedUnitId = await seedSpareUnit('MNT-SP03', '30.0000', 'pending_inspection')
  const spareDrainUnitId = await seedSpareUnit('MNT-SP04', '20.0000', 'qualified')
  const spareConcurrentUnitId = await seedSpareUnit('MNT-SP05', '30.0000', 'qualified')

  return {
    enterpriseId,
    szPlantId,
    hfPlantId,
    jzDeptId,
    adminUserId,
    eq1Id,
    eq1Code,
    eq2Id,
    eq2Code,
    eq3Id,
    eq3Code,
    eq4Id,
    eq4Code,
    spareUnitId,
    spareUnitNo: 'MNT-SP01',
    spareLocationCode,
    spareReservedUnitId,
    spareUnqualifiedUnitId,
    spareDrainUnitId,
    spareConcurrentUnitId,
  }
}

/** 取组织节点 id（按 code）。 */
export async function mntNodeId(pool: pg.Pool, code: string): Promise<string> {
  const r = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = $1`, [code])
  if (r.rowCount === 0) throw new Error(`测试节点缺失：${code}`)
  return r.rows[0]!.id
}
