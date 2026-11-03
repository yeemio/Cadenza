import { randomUUID } from 'node:crypto'
import type { PasswordHasher } from '@cadenza/application'
import type pg from 'pg'
import { createScryptPasswordHasher } from '@cadenza/application'
import { AI_QUERY_CAPABILITY_SEEDS } from '@cadenza/domain'
import { seedAiQueryCapabilities, type AiCapabilitySeedInput } from './aiquery-repositories'

/**
 * P1-S2 演示种子（幂等：全部按自然键 UPSERT，重复执行收敛到同一状态，不产生重复行）。
 *
 * 结构：两企业三工厂（华东=苏州+合肥 两厂；南方=广州 一厂）。
 * WorkItem 原文"两企业两工厂"——多出的合肥厂用于提供"同企业跨工厂"的 403 演示
 * （用户 A 厂查 B 厂），见 delivery/L1/stage2/DELIVERY.md 说明。
 *
 * dev 凭据（占值，仅存 .env.example 注释与本文件，库中只落散列）：
 *   admin/CadAdmin001        华东 企业范围管理员
 *   szqc01/SzQuality01       苏州 质检员（plant 范围 + org.read）
 *   szws01/SzWorkshop01      苏州 车间主任（workshop 范围 + org.read）
 *   hfadmin01/HfPlant0001    合肥 厂区管理员（plant 范围 + org.admin）
 *   gzadmin01/GzPlant00001   南方 企业范围管理员
 *   disabled01/SzDisable01   苏州 质检员（禁用态，OA-16 登录拒绝演示）
 */

export interface SeedOptions {
  passwordHasher?: PasswordHasher
  /** 覆盖 seed 口令（dev 占值之外的场合） */
  passwordOverrides?: Record<string, string>
}

export interface SeedCounts {
  orgNodes: number
  roles: number
  users: number
  grants: number
  shifts: number
}

interface NodeSeed {
  kind: 'enterprise' | 'legal_entity' | 'plant' | 'department' | 'work_center'
  code: string
  name: string
  parentCode?: string
  plantCode?: string
  deptCategory?: number
}

const NODES: readonly NodeSeed[] = [
  { kind: 'enterprise', code: 'ENT-HD', name: '华东电缆集团' },
  { kind: 'legal_entity', code: 'LE-HDMIKE', name: '华东电缆制造有限公司', parentCode: 'ENT-HD' },
  { kind: 'plant', code: 'PLNT-SZ', name: '苏州线缆厂', parentCode: 'LE-HDMIKE', plantCode: 'SZ0001' },
  { kind: 'department', code: 'DEPT-SZ-JZ', name: '苏州厂-绞制车间部', parentCode: 'PLNT-SZ', deptCategory: 1 },
  { kind: 'work_center', code: 'WC-SZ-JZ-01', name: '苏州厂-绞制一线', parentCode: 'DEPT-SZ-JZ' },
  { kind: 'work_center', code: 'WC-SZ-JZ-02', name: '苏州厂-绞制二线', parentCode: 'DEPT-SZ-JZ' },
  { kind: 'department', code: 'DEPT-SZ-QC', name: '苏州厂-质量检验部', parentCode: 'PLNT-SZ', deptCategory: 2 },
  { kind: 'department', code: 'DEPT-SZ-WL', name: '苏州厂-物流部', parentCode: 'PLNT-SZ', deptCategory: 3 },
  { kind: 'plant', code: 'PLNT-HF', name: '合肥线缆厂', parentCode: 'LE-HDMIKE', plantCode: 'HF0001' },
  { kind: 'department', code: 'DEPT-HF-JZ', name: '合肥厂-绞制车间部', parentCode: 'PLNT-HF', deptCategory: 1 },
  { kind: 'work_center', code: 'WC-HF-JZ-01', name: '合肥厂-绞制一线', parentCode: 'DEPT-HF-JZ' },
  { kind: 'department', code: 'DEPT-HF-QC', name: '合肥厂-质量检验部', parentCode: 'PLNT-HF', deptCategory: 2 },
  { kind: 'enterprise', code: 'ENT-NF', name: '南方电缆集团' },
  { kind: 'legal_entity', code: 'LE-NFMIKE', name: '南方电缆制造有限公司', parentCode: 'ENT-NF' },
  { kind: 'plant', code: 'PLNT-GZ', name: '广州线缆厂', parentCode: 'LE-NFMIKE', plantCode: 'GZ0001' },
  { kind: 'department', code: 'DEPT-GZ-JZ', name: '广州厂-绞制车间部', parentCode: 'PLNT-GZ', deptCategory: 1 },
  { kind: 'work_center', code: 'WC-GZ-JZ-01', name: '广州厂-绞制一线', parentCode: 'DEPT-GZ-JZ' },
]

interface RoleSeed {
  enterpriseCode: string
  alias: string
  name: string
  sort: number
  isSystem: number
}

const ROLES: readonly RoleSeed[] = [
  { enterpriseCode: 'ENT-HD', alias: 'sysadmin', name: '系统管理员', sort: 1, isSystem: 2 },
  { enterpriseCode: 'ENT-HD', alias: 'foreman', name: '车间主任', sort: 2, isSystem: 1 },
  { enterpriseCode: 'ENT-HD', alias: 'qc', name: '质检员', sort: 3, isSystem: 1 },
  { enterpriseCode: 'ENT-HD', alias: 'plantadmin', name: '厂区管理员', sort: 4, isSystem: 1 },
  { enterpriseCode: 'ENT-NF', alias: 'sysadmin', name: '系统管理员', sort: 1, isSystem: 2 },
]

interface GrantSeed {
  enterpriseCode: string
  principalType: 'role' | 'user'
  principalKey: string
  scopeType: 'enterprise' | 'plant' | 'workshop'
  scopeObjectCode: string
  permissions: string[]
}

const GRANTS: readonly GrantSeed[] = [
  { enterpriseCode: 'ENT-HD', principalType: 'role', principalKey: 'sysadmin', scopeType: 'enterprise', scopeObjectCode: 'ENT-HD', permissions: ['org.read', 'org.admin', 'org.role.admin'] },
  { enterpriseCode: 'ENT-HD', principalType: 'role', principalKey: 'foreman', scopeType: 'workshop', scopeObjectCode: 'WC-SZ-JZ-01', permissions: ['org.read'] },
  { enterpriseCode: 'ENT-HD', principalType: 'role', principalKey: 'qc', scopeType: 'plant', scopeObjectCode: 'PLNT-SZ', permissions: ['org.read'] },
  { enterpriseCode: 'ENT-HD', principalType: 'role', principalKey: 'plantadmin', scopeType: 'plant', scopeObjectCode: 'PLNT-HF', permissions: ['org.read', 'org.admin'] },
  { enterpriseCode: 'ENT-NF', principalType: 'role', principalKey: 'sysadmin', scopeType: 'enterprise', scopeObjectCode: 'ENT-NF', permissions: ['org.read', 'org.admin', 'org.role.admin'] },
]

interface UserSeed {
  loginName: string
  password: string
  displayName: string
  enterpriseCode: string
  roleAlias: string
  deptCode: string
  workshopDeptCode?: string
  plantCode: string
  accountStatus: 'enabled' | 'disabled'
}

const USERS: readonly UserSeed[] = [
  { loginName: 'admin', password: 'CadAdmin001', displayName: '集团管理员', enterpriseCode: 'ENT-HD', roleAlias: 'sysadmin', deptCode: 'DEPT-SZ-QC', workshopDeptCode: 'DEPT-SZ-JZ', plantCode: 'PLNT-SZ', accountStatus: 'enabled' },
  { loginName: 'szqc01', password: 'SzQuality01', displayName: '苏州质检员甲', enterpriseCode: 'ENT-HD', roleAlias: 'qc', deptCode: 'DEPT-SZ-QC', workshopDeptCode: 'DEPT-SZ-JZ', plantCode: 'PLNT-SZ', accountStatus: 'enabled' },
  { loginName: 'szws01', password: 'SzWorkshop01', displayName: '苏州绞制车间主任', enterpriseCode: 'ENT-HD', roleAlias: 'foreman', deptCode: 'DEPT-SZ-JZ', plantCode: 'PLNT-SZ', accountStatus: 'enabled' },
  { loginName: 'hfadmin01', password: 'HfPlant0001', displayName: '合肥厂区管理员', enterpriseCode: 'ENT-HD', roleAlias: 'plantadmin', deptCode: 'DEPT-HF-JZ', plantCode: 'PLNT-HF', accountStatus: 'enabled' },
  { loginName: 'gzadmin01', password: 'GzPlant00001', displayName: '南方集团管理员', enterpriseCode: 'ENT-NF', roleAlias: 'sysadmin', deptCode: 'DEPT-GZ-JZ', plantCode: 'PLNT-GZ', accountStatus: 'enabled' },
  { loginName: 'disabled01', password: 'SzDisable01', displayName: '禁用演示账号', enterpriseCode: 'ENT-HD', roleAlias: 'qc', deptCode: 'DEPT-SZ-QC', workshopDeptCode: 'DEPT-SZ-JZ', plantCode: 'PLNT-SZ', accountStatus: 'disabled' },
]

interface ShiftSeed {
  plantCode: string
  code: string
  name: string
  startTime: string
  endTime: string
}

const SHIFTS: readonly ShiftSeed[] = [
  { plantCode: 'PLNT-SZ', code: 'S1', name: '早班', startTime: '08:00', endTime: '16:00' },
  { plantCode: 'PLNT-SZ', code: 'S2', name: '中班', startTime: '16:00', endTime: '00:00' },
  { plantCode: 'PLNT-HF', code: 'S1', name: '早班', startTime: '08:00', endTime: '16:00' },
  { plantCode: 'PLNT-GZ', code: 'S1', name: '早班', startTime: '08:00', endTime: '16:00' },
]

interface NodeInfo {
  id: string
  path: string
  depth: number
  enterpriseId: string
}

/** 幂等种子：按自然键 UPSERT；可重复执行（迁移 up 后多次运行收敛同一状态）。 */
export async function seedOrgAuth(pool: pg.Pool, options: SeedOptions = {}): Promise<SeedCounts> {
  const hasher = options.passwordHasher ?? createScryptPasswordHasher()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // ---- 组织树（按 code UPSERT；重跑收敛，path/depth 依据父行重建） ----
    const nodes = new Map<string, NodeInfo>()
    for (const seed of NODES) {
      const parent = seed.parentCode ? nodes.get(seed.parentCode) : undefined
      if (seed.parentCode && parent === undefined) {
        throw new Error(`种子顺序错误：${seed.code} 的父节点 ${seed.parentCode} 尚未插入`)
      }
      const id = randomUUID()
      const path = parent ? `${parent.path}${id}/` : `/${id}/`
      const depth = parent ? parent.depth + 1 : 0
      const enterpriseId = seed.kind === 'enterprise' ? id : parent!.enterpriseId
      const r = await client.query<NodeInfo>(
        `INSERT INTO org_node (id, kind, code, name, parent_id, parent_kind, path, depth,
           plant_code, dept_category, status, enterprise_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', $11, 'seed')
         ON CONFLICT (code) WHERE status = 'active' DO UPDATE SET
           name = EXCLUDED.name,
           plant_code = EXCLUDED.plant_code,
           dept_category = EXCLUDED.dept_category,
           updated_at = now(),
           updated_by = 'seed'
         RETURNING id, path, depth, enterprise_id AS "enterpriseId"`,
        [
          id,
          seed.kind,
          seed.code,
          seed.name,
          parent ? parent.id : null,
          parent ? (NODES.find((n) => n.code === seed.parentCode)!.kind as string) : null,
          path,
          depth,
          seed.plantCode ?? null,
          seed.deptCategory ?? null,
          enterpriseId,
        ],
      )
      nodes.set(seed.code, r.rows[0]!)
    }

    // ---- 角色（按 (enterprise, alias) UPSERT；OA-S3 部分唯一索引为冲突仲裁者） ----
    const roles = new Map<string, string>()
    for (const seed of ROLES) {
      const enterprise = nodes.get(seed.enterpriseCode)!
      const r = await client.query<{ id: string }>(
        `INSERT INTO role (enterprise_id, name, alias, sort, is_system, status, created_by)
         VALUES ($1, $2, $3, $4, $5, 'active', 'seed')
         ON CONFLICT (enterprise_id, alias) WHERE status = 'active' DO UPDATE SET
           name = EXCLUDED.name,
           sort = EXCLUDED.sort,
           is_system = EXCLUDED.is_system,
           updated_at = now(),
           updated_by = 'seed'
         RETURNING id`,
        [enterprise.enterpriseId, seed.name, seed.alias, seed.sort, seed.isSystem],
      )
      roles.set(`${seed.enterpriseCode}:${seed.alias}`, r.rows[0]!.id)
    }

    // ---- 用户（按 login_name UPSERT；重跑重置口令/锁定/禁用态为种子口径） ----
    for (const seed of USERS) {
      const enterprise = nodes.get(seed.enterpriseCode)!
      const dept = nodes.get(seed.deptCode)!
      const workshop = seed.workshopDeptCode ? nodes.get(seed.workshopDeptCode)! : null
      const role = roles.get(`${seed.enterpriseCode}:${seed.roleAlias}`)
      if (role === undefined) throw new Error(`种子角色缺失：${seed.roleAlias}`)
      const plant = nodes.get(seed.plantCode)!
      const password = options.passwordOverrides?.[seed.loginName] ?? seed.password
      const passwordHash = await hasher.hash(password)
      await client.query(
        `INSERT INTO user_account (enterprise_id, login_name, password_hash, display_name, dept_id,
           workshop_dept_id, role_id, login_platform, account_status, phone, plant_id,
           failed_login_count, locked_until, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'WEB', $8, NULL, $9, 0, NULL, 'active', 'seed')
         ON CONFLICT (login_name) DO UPDATE SET
           password_hash = EXCLUDED.password_hash,
           display_name = EXCLUDED.display_name,
           dept_id = EXCLUDED.dept_id,
           workshop_dept_id = EXCLUDED.workshop_dept_id,
           role_id = EXCLUDED.role_id,
           account_status = EXCLUDED.account_status,
           plant_id = EXCLUDED.plant_id,
           failed_login_count = 0,
           locked_until = NULL,
           status = 'active',
           updated_at = now(),
           updated_by = 'seed'`,
        [
          enterprise.enterpriseId,
          seed.loginName,
          passwordHash,
          seed.displayName,
          dept.id,
          workshop ? workshop.id : null,
          role,
          seed.accountStatus,
          plant.id,
        ],
      )
    }

    // ---- 授权（按 (principal, scope_type, scope_object_id) UPSERT，OA-22 至多一行） ----
    for (const seed of GRANTS) {
      const enterprise = nodes.get(seed.enterpriseCode)!
      const principalId = roles.get(`${seed.enterpriseCode}:${seed.principalKey}`)
      if (principalId === undefined) throw new Error(`种子授权主体缺失：${seed.principalKey}`)
      const scopeObject = nodes.get(seed.scopeObjectCode)!
      await client.query(
        `INSERT INTO scope_grant (enterprise_id, principal_type, principal_id, permissions,
           scope_type, scope_object_id, status, created_by)
         VALUES ($1, 'role', $2, $3, $4, $5, 'active', 'seed')
         ON CONFLICT (principal_type, principal_id, scope_type, scope_object_id) DO UPDATE SET
           permissions = EXCLUDED.permissions,
           status = 'active',
           updated_at = now(),
           updated_by = 'seed'`,
        [enterprise.enterpriseId, principalId, seed.permissions, seed.scopeType, scopeObject.id],
      )
    }

    // ---- 班次（最小占位） ----
    for (const seed of SHIFTS) {
      const plant = nodes.get(seed.plantCode)!
      await client.query(
        `INSERT INTO shift_calendar (plant_id, code, name, start_time, end_time, status, created_by)
         VALUES ($1, $2, $3, $4::time, $5::time, 'active', 'seed')
         ON CONFLICT (plant_id, code) DO UPDATE SET
           name = EXCLUDED.name,
           start_time = EXCLUDED.start_time,
           end_time = EXCLUDED.end_time,
           updated_at = now(),
           updated_by = 'seed'`,
        [plant.id, seed.code, seed.name, seed.startTime, seed.endTime],
      )
    }

    await client.query('COMMIT')

    const counts = await countSeedState(pool)
    return counts
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

export async function countSeedState(pool: pg.Pool): Promise<SeedCounts> {
  const r = await pool.query<{
    org_nodes: number
    roles: number
    users: number
    grants: number
    shifts: number
  }>(
    `SELECT
       (SELECT count(*) FROM org_node)::int AS org_nodes,
       (SELECT count(*) FROM role)::int AS roles,
       (SELECT count(*) FROM user_account)::int AS users,
       (SELECT count(*) FROM scope_grant)::int AS grants,
       (SELECT count(*) FROM shift_calendar)::int AS shifts`,
  )
  const row = r.rows[0]!
  return {
    orgNodes: row.org_nodes,
    roles: row.roles,
    users: row.users,
    grants: row.grants,
    shifts: row.shifts,
  }
}

/**
 * dev 姿态域许可（L0 整合步补齐）：给 sysadmin（华东企业范围）合并各业务域许可。
 * 幂等（ON CONFLICT 合并去重）。生产部署须按真实授权另行配置，不依赖本函数（dev 种子专用）。
 * 权限串以各 packages/domain/src/<域>/permissions.ts 为准：
 * scheduling.read/admin、execution.read/report/review/feed/labor、quality.read/post、
 * warehousing.read/post（Wave5 追加后四域）；
 * rework.read/post + rework.axis-correction.reassign/withdraw（rework 无 permissions.ts，
 * 以 controller REWORK_PERMISSIONS + AXIS_REASSIGN_PERMISSION 为准，GAP-F4 最小机制）、
 * conversion.read/post、reverse.read/post、disposition.read/post、maintenance.read/post、
 * reporting.read/post、aiquery.use/admin（P2/P4 批次 2026-10-28 追加七域）；
 * ot.read/post、csw.read/post/unfreeze、spc.read/post、cost.read/post（P3 四域批次
 * 2026-10-29 追加——ot/csw/spc/cost permissions.ts 实际值，csw.unfreeze 为 CS-11
 * 解冻具名权限）；
 * group.read/post（G 场景分配修订/缺料齐套/召回/供应商风险，2026-10-29）；
 * production.read/post（E09 投料竞争）、scan_block.read/post（E09 SCAN-BLOCK，2026-10-29）。
 */
export async function grantDevDomainPermissions(pool: pg.Pool): Promise<void> {
  await pool.query(
    `WITH r AS (
       SELECT ro.id, ro.enterprise_id FROM role ro
       JOIN org_node e ON e.id = ro.enterprise_id
       WHERE e.code = 'ENT-HD' AND ro.alias = 'sysadmin'
     ), o AS (
       SELECT id FROM org_node WHERE code = 'ENT-HD' AND enterprise_id = (SELECT enterprise_id FROM r)
     )
     INSERT INTO scope_grant (enterprise_id, principal_type, principal_id, permissions,
        scope_type, scope_object_id, status, created_by)
     SELECT (SELECT enterprise_id FROM r), 'role', (SELECT id FROM r),
            ARRAY['masterdata.read','masterdata.admin','inventory.read','inventory.post',
                  'process.read','process.admin','purchase.read','purchase.post',
                  'scheduling.read','scheduling.admin',
                  'execution.read','execution.report','execution.review','execution.feed','execution.labor',
                  'quality.read','quality.post','warehousing.read','warehousing.post',
                  'shipping.read','shipping.post',
                  'rework.read','rework.post',
                  'rework.axis-correction.reassign','rework.axis-correction.withdraw',
                  'conversion.read','conversion.post',
                  'reverse.read','reverse.post',
                  'disposition.read','disposition.post',
                  'maintenance.read','maintenance.post',
                  'reporting.read','reporting.post',
                  'aiquery.use','aiquery.admin',
                  'ot.read','ot.post',
                  'csw.read','csw.post','csw.unfreeze',
                  'spc.read','spc.post',
                  'cost.read','cost.post',
                  'group.read','group.post',
                  'production.read','production.post',
                  'scan_block.read','scan_block.post'],
            'enterprise', (SELECT id FROM o), 'active', 'seed-dev-domains'
     ON CONFLICT (principal_type, principal_id, scope_type, scope_object_id) DO UPDATE SET
       permissions = (
         SELECT array_agg(DISTINCT p) FROM unnest(scope_grant.permissions || EXCLUDED.permissions) AS t(p)
       ),
       updated_at = now(), updated_by = 'seed-dev-domains'`,
  )
}

/**
 * dev 种子版首版三能力注册（AQ-REG-03 部署初始化 seed 收编入 db:seed，2026-10-29）：
 * 以 domain 冻结的 AQ-C1/C2/C3 定义（AI_QUERY_CAPABILITY_SEEDS）写入 0021 注册表，
 * 幂等——(enterprise_id, capability_id, version) 冲突 DO NOTHING，不覆盖管理动作启停。
 * 与 apps/api/src/aiquery/aiquery.composition.ts 的 seedDefaultAiQueryCapabilities 同源
 * （后者 re-export 本实现；生产部署初始化仍经组合根，dev 库由 db:seed 承载）。
 */
export async function seedDefaultAiQueryCapabilities(pool: pg.Pool, enterpriseId: string): Promise<number> {
  return seedAiQueryCapabilities(pool, enterpriseId, AI_QUERY_CAPABILITY_SEEDS as readonly AiCapabilitySeedInput[])
}
