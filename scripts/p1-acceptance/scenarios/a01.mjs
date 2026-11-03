/**
 * A01 组织/权限/主数据（P1 验收）：
 * - admin 通过真实命令建工作中心/设备/仓库/库位/货架（masterdata 命令总线）；
 * - 料品/单位直落 SQL 模拟 U9 同步（MD-01：本系统无维护入口）；
 * - hfadmin01（合肥厂范围）跨厂读 403 + 列表按数据范围过滤 + 相同外部编码两厂隔离。
 */
import {
  must,
  httpStep,
  sqlStep,
  sql,
  sqlOne,
  q,
} from '../lib.mjs'

export async function run(run) {
  run.setScenario('A01')
  const s = run.state

  // ---- 种子组织节点 id 解析（SQL 只读） ----
  const nodes = Object.fromEntries(
    sql(`SELECT code, id FROM org_node WHERE status = 'active' AND code IN ('ENT-HD','PLNT-SZ','PLNT-HF','DEPT-SZ-JZ','DEPT-SZ-WL','DEPT-HF-JZ')`).map((r) => [r[0], r[1]]),
  )
  s.nodes = nodes
  must(run, '种子组织节点齐全（ENT-HD/PLNT-SZ/PLNT-HF/DEPT-SZ-JZ/DEPT-SZ-WL/DEPT-HF-JZ）',
    Object.keys(nodes).length === 6, JSON.stringify(nodes))
  s.entId = nodes['ENT-HD']
  s.szPlantId = nodes['PLNT-SZ']
  s.hfPlantId = nodes['PLNT-HF']

  const hfUser = sqlOne(`SELECT id FROM user_account WHERE login_name = 'hfadmin01'`)
  s.hfUserId = hfUser
  must(run, 'hfadmin01 种子账号存在', Boolean(hfUser), `userId=${hfUser}`)

  // ---- 1) admin 建工作中心（MD-17） ----
  const wc = await httpStep(run, 'admin 建工作中心 WC-P1-JZ（POST /masterdata/work-centers）',
    'POST', '/masterdata/work-centers',
    { code: 'WC-P1-JZ', name: 'P1验收绞制工作中心', deptId: nodes['DEPT-SZ-JZ'], operationId: `${s.run}-a01-wc`, reason: 'P1 验收主数据准备' },
    [200, 201])
  s.wcId = wc.body?.data?.workCenterId ?? null
  must(run, '工作中心创建成功且返回 id', Boolean(s.wcId), `wcId=${s.wcId}`)

  // ---- 2) admin 建设备 ×2（MD-09/13） ----
  s.equipment = {}
  for (const [code, name] of [['EQ-P1-01', 'P1验收绞制一号机'], ['EQ-P1-02', 'P1验收绞制二号机']]) {
    const res = await httpStep(run, `admin 建设备 ${code}（POST /masterdata/equipment）`,
      'POST', '/masterdata/equipment',
      { code, name, deptId: nodes['DEPT-SZ-JZ'], workCenterId: s.wcId, equipmentStatus: 1, capacity: '6000', operationId: `${s.run}-a01-eq-${code}`, reason: 'P1 验收主数据准备' },
      [200, 201])
    const id = res.body?.data?.equipmentId ?? null
    s.equipment[code] = { id, qrCode: res.body?.data?.equipmentQrCode ?? null }
    must(run, `设备 ${code} 创建成功且返回 id/二维码`, Boolean(id), JSON.stringify(res.body?.data))
  }

  // ---- 3) admin 建仓库（MD-22/23/24：物流部→仓库、车间→线边仓） ----
  s.wh = {}
  const warehouses = [
    { code: '9101', name: 'P1苏州物流成品仓', dept: 'DEPT-SZ-WL', type: 'WAREHOUSE', materialTypes: [1, 3], key: 'sz9101' },
    { code: '9102', name: 'P1苏州绞制线边仓', dept: 'DEPT-SZ-JZ', type: 'LINE_SIDE', materialTypes: [1, 2, 3], key: 'sz9102' },
    { code: '9103', name: 'P1苏州原料仓', dept: 'DEPT-SZ-WL', type: 'WAREHOUSE', materialTypes: [1, 3], key: 'sz9103' },
    { code: '9190', name: 'P1苏州在途专用仓', dept: 'DEPT-SZ-WL', type: 'WAREHOUSE', materialTypes: [1, 3], key: 'sz9190' },
    // 合肥隔离反证：与苏州 9102 同编码、不同厂（同厂内唯一、跨厂隔离）
    { code: '9102', name: 'P1合肥线边仓', dept: 'DEPT-HF-JZ', type: 'LINE_SIDE', materialTypes: [1, 2, 3], key: 'hf9102' },
  ]
  for (const w of warehouses) {
    const res = await httpStep(run, `admin 建仓库 ${w.key}（code=${w.code} ${w.type}）`,
      'POST', '/masterdata/warehouses',
      { code: w.code, name: w.name, deptId: nodes[w.dept], warehouseType: w.type, materialTypes: w.materialTypes, operationId: `${s.run}-a01-wh-${w.key}`, reason: 'P1 验收主数据准备' },
      [200, 201])
    s.wh[w.key] = res.body?.data?.warehouseId ?? null
    must(run, `仓库 ${w.key}（${w.code}/${w.type}）创建成功`, Boolean(s.wh[w.key]), `id=${s.wh[w.key]}`)
  }

  // ---- 4) 货架（MD-30/31：自动生成 6 位货架库位） ----
  const rack = await httpStep(run, 'admin 在 9101 建货架 01（2 区域 × 2 层 → 4 个 RACK 库位）',
    'POST', '/masterdata/racks',
    { warehouseId: s.wh.sz9101, code: '01', zones: 2, layers: 2, operationId: `${s.run}-a01-rack`, reason: 'P1 验收主数据准备' },
    [200, 201])
  must(run, '货架创建成功且生成 4 个库位', rack.body?.data?.generatedLocations === 4, JSON.stringify(rack.body?.data))

  // ---- 5) 普通库位（MD-28：8 位 = 仓库码 4 + 库位码 4） ----
  s.loc = {}
  const locations = [
    { warehouse: 'sz9101', code: '91010101' },
    { warehouse: 'sz9102', code: '91020101' },
    { warehouse: 'sz9103', code: '91030101' },
    { warehouse: 'sz9190', code: '91900101' },
    // 合肥隔离反证：与苏州同编码库位
    { warehouse: 'hf9102', code: '91020101' },
  ]
  for (const l of locations) {
    const res = await httpStep(run, `admin 建普通库位 ${l.code}（仓库 ${l.warehouse}）`,
      'POST', '/masterdata/locations',
      { warehouseId: s.wh[l.warehouse], code: l.code, operationId: `${s.run}-a01-loc-${l.warehouse}-${l.code}`, reason: 'P1 验收主数据准备' },
      [200, 201])
    s.loc[l.warehouse] = { ...(s.loc[l.warehouse] ?? {}), [l.code]: res.body?.data?.locationId ?? null }
    must(run, `库位 ${l.code}@${l.warehouse} 创建成功`, Boolean(res.body?.data?.locationId), JSON.stringify(res.body?.data))
  }

  // 货架库位 id 回读（自动生成行）
  const rackLocs = sql(`SELECT code, id FROM storage_location WHERE warehouse_id = ${q(s.wh.sz9101)} AND location_kind = 'RACK' AND status = 'active' ORDER BY code`)
  for (const [code, id] of rackLocs) s.loc[code] = id
  must(run, '货架库位 010101/010102/010201/010202 已生成', rackLocs.length === 4, rackLocs.map((r) => r[0]).join(','))

  // ---- 6) 料品：直落 SQL 模拟 U9 同步（MD-01：本系统无新增入口） ----
  const materials = [
    { code: 'MAT-P1-RAW', name: 'P1验收-铜杆（需检）', type: 1, qc: 1 },
    { code: 'MAT-P1-EXP', name: 'P1验收-免检辅材', type: 1, qc: 0 },
    { code: 'MAT-P1-FIN', name: 'P1验收-成品缆', type: 3, qc: 0 },
  ]
  s.mat = {}
  for (const m of materials) {
    const id = sqlOne(
      `INSERT INTO material (org_scope_id, code, name, material_type, base_uom, qc_flag, source_system, created_by)
       VALUES (${q(s.entId)}, ${q(m.code)}, ${q(m.name)}, ${m.type}, 'M', ${m.qc}, 'U9', 'p1-acceptance')
       ON CONFLICT (org_scope_id, code) WHERE status = 'active' DO UPDATE SET updated_at = now() RETURNING id`,
    )
    s.mat[m.code] = id
    must(run, `料品 ${m.code}（type=${m.type} qc_flag=${m.qc}）模拟 U9 同步落库`, Boolean(id), `id=${id}`)
  }

  // ---- 7) 权限：先取「缺许可 403」反证，再由 admin 真实授权 ----
  const beforeGrantCheck = await httpStep(run, 'hfadmin01 读主数据（授权前——缺岗位许可 403）',
    'GET', `/masterdata/equipment?plantId=${s.hfPlantId}`, undefined, 403, { user: 'hfadmin01' })
  must(run, '缺许可 403 且 code=ERR_FORBIDDEN_SCOPE', beforeGrantCheck.body?.code === 'ERR_FORBIDDEN_SCOPE', JSON.stringify(beforeGrantCheck.body))

  const grant = await httpStep(run, 'admin 给 hfadmin01 授 masterdata.read（合肥厂范围，POST /org/grants）',
    'POST', '/org/grants',
    {
      principalType: 'user', principalId: s.hfUserId, scopeType: 'plant', scopeObjectId: s.hfPlantId,
      permissions: ['masterdata.read'], reason: 'P1 验收：合肥厂管理员主数据只读授权',
      operationId: `${s.run}-a01-grant`,
    },
    [200, 201])
  must(run, '授权命令成功', Boolean(grant.body?.data?.grantId), JSON.stringify(grant.body?.data))
  s.ops = { ...(s.ops ?? {}), 'org.grant.grant': `${s.run}-a01-grant` }

  // ---- 8) hfadmin01 跨厂读 403（授权后：显式工厂参数越范围 / 写路径二道防线） ----
  const crossRead = await httpStep(run, 'hfadmin01 越范围读苏州仓库（授权后——显式工厂参数越范围 403）',
    'GET', `/masterdata/warehouses?plantId=${s.szPlantId}`, undefined, 403, { user: 'hfadmin01' })
  must(run, '跨厂读 403 且提示目标工厂不在授权数据范围', crossRead.body?.code === 'ERR_FORBIDDEN_SCOPE' && String(crossRead.body?.message ?? '').includes('不在授权数据范围'), JSON.stringify(crossRead.body))

  const crossWrite = await httpStep(run, 'hfadmin01 跨厂建仓（苏州物流部——服务端范围二道防线 403）',
    'POST', '/masterdata/warehouses',
    { code: '9199', name: 'hfadmin越权仓', deptId: nodes['DEPT-SZ-WL'], warehouseType: 'WAREHOUSE', materialTypes: [1], operationId: `${s.run}-a01-cross-write` },
    403, { user: 'hfadmin01' })
  must(run, '跨厂写 403（OA-24 二道防线）', crossWrite.body?.code === 'ERR_FORBIDDEN_SCOPE', JSON.stringify(crossWrite.body))

  // ---- 9) 列表按数据范围过滤 + 相同外部编码两厂隔离 ----
  const hfList = await httpStep(run, 'hfadmin01 无过滤列仓库（服务端按厂范围收敛）',
    'GET', '/masterdata/warehouses?page=1&pageSize=50', undefined, 200, { user: 'hfadmin01' })
  const hfRows = hfList.body?.items ?? []
  const allInHf = hfRows.length > 0 && hfRows.every((r) => r.plantId === s.hfPlantId)
  const hfHas9102 = hfRows.some((r) => r.code === '9102')
  must(run, `hfadmin01 仓库列表仅含合肥厂（${hfRows.length} 行，含 9102）`,
    allInHf && hfHas9102, `rows=${JSON.stringify(hfRows.map((r) => `${r.code}@${r.plantId === s.hfPlantId ? 'HF' : 'SZ'}`))}`)

  const hfLocList = await httpStep(run, 'hfadmin01 无过滤列库位（同口径过滤）',
    'GET', '/masterdata/locations?page=1&pageSize=50', undefined, 200, { user: 'hfadmin01' })
  const hfLocs = hfLocList.body?.items ?? []
  must(run, `hfadmin01 库位列表仅含合肥厂（${hfLocs.length} 行，含同码 91020101）`,
    hfLocs.length > 0 && hfLocs.every((r) => r.plantId === s.hfPlantId) && hfLocs.some((r) => r.code === '91020101'),
    `rows=${JSON.stringify(hfLocs.map((r) => r.code))}`)

  const adminList = await httpStep(run, 'admin（企业范围）列仓库：两厂同码 9102 并存（隔离不串数据）',
    'GET', '/masterdata/warehouses?page=1&pageSize=50', undefined, 200)
  const adminRows = adminList.body?.items ?? []
  const both9102 = adminRows.filter((r) => r.code === '9102')
  must(run, '苏州 9102 与合肥 9102 同时可见且厂不同（相同外部编码正确隔离）',
    both9102.length === 2 && new Set(both9102.map((r) => r.plantId)).size === 2,
    `9102 rows=${JSON.stringify(both9102.map((r) => r.plantId === s.szPlantId ? 'SZ' : 'HF'))}`)

  // ---- 10) 库表对账：主数据行数与归属 ----
  sqlStep(run, 'SQL 对账：本 run 建立的主数据行（仓库/库位/设备/工作中心）',
    `SELECT 'warehouse', count(*) FROM warehouse WHERE status='active' AND created_by='admin'
     UNION ALL SELECT 'storage_location', count(*) FROM storage_location WHERE status='active'
     UNION ALL SELECT 'equipment', count(*) FROM equipment WHERE status='active' AND code LIKE 'EQ-P1-%'`)
  const plantOfWh = sql(`SELECT plant_id, count(*) FROM warehouse WHERE code IN ('9101','9102','9103','9190') AND status='active' GROUP BY plant_id ORDER BY plant_id`)
  must(run, '9102 两行分属两厂（SQL 直读）', plantOfWh.length === 2 && Number(plantOfWh[0][1]) + Number(plantOfWh[1][1]) === 5,
    plantOfWh.map((r) => r.join(':')).join(' ; '))

  run.saveState()
  return run
}
