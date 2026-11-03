#!/usr/bin/env node
/**
 * R1 期初导入合并通道端到端证明（隔离库，PM final-reception-20261029 §3-R1 完成判据）。
 *
 * 在**新建独立临时库**（cadenza_dops_r1imp_*，白名单护栏，绝不碰 dev 主库 cadenza）证明：
 *   匿名样本 → 模板校验/拒绝清单（含 DO-09 历史空值待确认样例）→ 暂存 → 分层核对确认
 *   → 合并通道经产品命令面落账（inventory.receive-goods / inventory.issue-material /
 *   purchase.order-sync / process.order.receive）→ 重导/重并幂等（不多记）
 *   → 命令总线同 operationId 断点重放（业务事实不增）→ 三方对账数字一致
 *   （导入汇总 vs 业务落账 vs 拒绝/待确认）→ DO-13 四维对账 → 冻结点解除。
 *
 * 用法：
 *   node scripts/delivery/import/e2e-import-merge-proof.mjs [--admin-url URL] [--keep-db]
 *     [--evidence-root 目录]（默认 delivery/P3/delivery-ops/evidence/import-r1）
 *
 * 证据：每步编号日志 + workspace 报告 + THREE-WAY-RECON.md + 断言清单；任一断言失败退出非 0。
 */

import { appendFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  applyMigrations,
  assertDrillSafeDbName,
  createDatabase,
  databaseExists,
  dropDatabase,
  withPool,
} from '../lib/db.mjs'
import { verifyLedger } from '../lib/ledger.mjs'
import { nowIso } from '../lib/util.mjs'

const require = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const IMPORT_TOOL = path.join(REPO_ROOT, 'scripts/delivery/import/import-validate.mjs')
const MERGE_TOOL = path.join(REPO_ROOT, 'scripts/delivery/import/merge-staged.mjs')
const RECONCILE_TOOL = path.join(REPO_ROOT, 'scripts/delivery/import/reconcile-inventory.mjs')

// ============ 参数 ============

function parseArgs(argv) {
  const args = { keepDb: false }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]?.replace(/^--/, '')
    if (key === 'keep-db') args.keepDb = true
    else if (key === 'admin-url') { args.adminUrl = argv[i + 1]; i += 1 }
    else if (key === 'evidence-root') { args.evidenceRoot = argv[i + 1]; i += 1 }
  }
  args.adminUrl ??= 'postgres://postgres:cadenza_dev@127.0.0.1:55433/postgres'
  return args
}

// ============ 证据目录与步骤日志 ============

const ASSERTS = []
function assert(name, ok, detail = '') {
  ASSERTS.push({ name, ok, detail })
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`)
}

let stepNo = 0
let logFile = ''
let evidenceDir = ''

function appendLogSync(text) {
  appendFileSync(logFile, text.endsWith('\n') ? text : `${text}\n`)
}

async function step(title, fn) {
  stepNo += 1
  logFile = path.join(evidenceDir, `${String(stepNo).padStart(2, '0')}-${title}.log`)
  const header = `=== [${String(stepNo)}] ${title} @ ${nowIso()} ===\n`
  process.stdout.write(header)
  await writeFile(logFile, header, 'utf8')
  return fn()
}

/** 运行子进程工具（真实 CLI 调用），日志与退出码落证据。返回 { code, out }。 */
function runTool(script, toolArgs) {
  const r = spawnSync(process.execPath, [script, ...toolArgs], { cwd: REPO_ROOT, encoding: 'utf8' })
  const body = `$ ${path.basename(script)} ${toolArgs.join(' ')}\n${r.stdout ?? ''}${r.stderr ?? ''}\nexit=${String(r.status)}\n`
  process.stdout.write(body)
  appendLogSync(body)
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

async function runSql(pool, sql, params = []) {
  const r = await pool.query(sql, params)
  appendLogSync(`$ SQL: ${sql.replace(/\s+/g, ' ').slice(0, 260)}${params.length ? ` | ${JSON.stringify(params.map((p) => String(p).slice(0, 60)))}` : ''}\n→ ${String(r.rows.length)} 行\n`)
  return r
}

// ============ 匿名样本（与既有 evidence/import/samples 同口径：种子演示组织 + 匿名料品） ============

const SAMPLES = {
  'master-r1.csv': [
    '料品编码,料品名称,料品类型,基本单位,规格型号,电压,标准,客户,适用组织,备注',
    'MAT-R1-0001,匿名样本料-铜杆,1,千克,Φ8mm,,,匿名客户甲,华东电缆集团,R1 样本好行',
    'MAT-R1-0002,匿名样本料-绝缘料,3,千克,,,,,华东电缆集团,R1 样本好行（订单用）',
    ',缺编码坏行,1,千克,,,,,华东电缆集团,R1 坏行-必填缺失（应拒）',
  ].join('\n'),
  'inventory-r1.csv': [
    '料品编码,批次号,所属工厂,仓库编码,库位编码,数量,单位,质量状态,供应商批号,货主,备注',
    'MAT-R1-0001,LOT-R1-0001,苏州线缆厂,0101,01010001,120.5000,千克,qualified,SUP-R1,,R1 期初好行',
    'MAT-R1-0001,LOT-R1-0002,苏州线缆厂,0101,99999999,80.0000,千克,qualified,,,R1 坏行-未知库位（应拒）',
    'MAT-R1-0002,LOT-R1-0003,苏州线缆厂,0101,01010001,2e2,千克,qualified,,,R1 坏行-科学计数数量（应拒）',
  ].join('\n'),
  'open-orders-r1.csv': [
    '单据类型,单据编号,所属工厂,料品编码,数量,单位,交期,状态说明,备注',
    'purchase_open,PO-R1-0001,苏州线缆厂,MAT-R1-0002,200.0000,千克,2026-12-31,ERP 未结,R1 未结采购好行',
    'process_wip,MO-R1-0001,苏州线缆厂,MAT-R1-0001,500.0000,千克,2026-12-15,在制,R1 在制好行',
    'sales_open,SO-R1-0001,苏州线缆厂,MAT-R1-0002,60.0000,千克,2026-12-20,销售未发货,R1 未结销售（当前无命令面→合并待确认）',
    'broken_type,XX-R1-0001,苏州线缆厂,MAT-R1-0001,10.0000,千克,2026-12-31,坏行,R1 坏行-单据类型枚举（应拒）',
  ].join('\n'),
  'history-r1.csv': [
    '单据类型,单据编号,所属工厂,业务日期,料品编码,数量,单位,审核状态,审核人,备注',
    'receipt,HD-R1-0001,苏州线缆厂,2026-06-30,MAT-R1-0001,50.0000,千克,approved,旧系统管理员,R1 历史好行（approved→暂存→合并具名待确认）',
    'issue,HD-R1-0002,苏州线缆厂,2026-07-01,MAT-R1-0001,20.0000,千克,,,R1 历史空审核状态（DO-09→待业务确认，不入暂存）',
  ].join('\n'),
  'incr-inventory-r1.csv': [
    '料品编码,批次号,所属工厂,仓库编码,库位编码,变动数量,单位,质量状态,发生日期,来源单据号,备注',
    'MAT-R1-0001,LOT-R1-0001,苏州线缆厂,0101,01010001,-20.0000,千克,qualified,2026-11-02,MO-R1-USE-01,R1 增量扣减（先扣后收，保序验证唯一单元解析）',
    'MAT-R1-0001,LOT-R1-0001,苏州线缆厂,0101,01010001,30.0000,千克,qualified,2026-11-03,MO-R1-NEW-01,R1 增量收货',
  ].join('\n'),
}

/** 环境引导（幂等；与 deploy/demo/demo-bootstrap.sql 同模式：uom/仓库/库位主数据）。 */
const BOOTSTRAP_SQL = [
  `INSERT INTO uom (code, name, is_custom, status, created_by)
   SELECT 'KG', '千克', false, 'active', 'R1 证明引导'
   WHERE NOT EXISTS (SELECT 1 FROM uom WHERE code='KG' AND NOT is_custom AND status='active')`,
  `INSERT INTO warehouse (enterprise_id, plant_id, dept_id, code, name, warehouse_type, material_types, status, created_by)
   SELECT e.id, p.id, d.id, '0101', '演示原料仓', 'WAREHOUSE', '{1,2,3}', 'active', 'R1 证明引导'
   FROM org_node e, org_node p, org_node d
   WHERE e.code='ENT-HD' AND e.kind='enterprise'
     AND p.code='PLNT-SZ' AND p.kind='plant'
     AND d.code='DEPT-SZ-WL' AND d.kind='department'
     AND NOT EXISTS (SELECT 1 FROM warehouse WHERE code='0101' AND status='active')`,
  `INSERT INTO storage_location (enterprise_id, plant_id, warehouse_id, rack_id, location_kind, code, zone_code, status, created_by)
   SELECT e.id, p.id, w.id, NULL, 'NORMAL', '01010001', NULL, 'active', 'R1 证明引导'
   FROM org_node e, org_node p, warehouse w
   WHERE e.code='ENT-HD' AND e.kind='enterprise'
     AND p.code='PLNT-SZ' AND p.kind='plant'
     AND w.code='0101' AND w.status='active'
     AND NOT EXISTS (SELECT 1 FROM storage_location WHERE code='01010001' AND status='active')`,
]

// ============ 主流程 ============

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const stamp = nowIso().replace(/[:T]/g, '-').replace(/[^0-9a-zA-Z-]/g, '')
  const dbName = `cadenza_dops_r1imp_${stamp.replace(/-/g, '').slice(0, 14)}`
  assertDrillSafeDbName(dbName)
  // dbUrl：把维护连接的路径段（默认 /postgres）替换为临时库名——不对已指向维护库的 URL 复用
  // adminUrlOf（其语义是把"目标库 URL"换成维护库，输入已是维护库时会错拼路径）。
  const dbUrl = args.adminUrl.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`)
  evidenceDir = args.evidenceRoot
    ? path.resolve(args.evidenceRoot, stamp)
    : path.join(REPO_ROOT, 'delivery/P3/delivery-ops/evidence/import-r1', stamp)
  const workspace = path.join(evidenceDir, 'workspace')
  const samplesDir = path.join(evidenceDir, 'samples')
  await mkdir(path.join(workspace, 'runs'), { recursive: true })
  await mkdir(samplesDir, { recursive: true })
  for (const [name, body] of Object.entries(SAMPLES)) {
    await writeFile(path.join(samplesDir, name), `${body}\n`, 'utf8')
  }

  console.log(`[R1 端到端证明] 临时库 ${dbName}（cadenza_dops_* 白名单）；证据目录 ${evidenceDir}`)

  // 注意：模式旗标与其值（如 --confirm-layer 1）须相邻，通用旗标统一后置
  const imp = (mode, toolArgs) => runTool(IMPORT_TOOL, [mode, ...toolArgs, '--database-url', dbUrl, '--workspace', workspace])
  const mrg = (channel, extra = []) => runTool(MERGE_TOOL, [`--${channel}`, '--database-url', dbUrl, '--workspace', workspace, '--actor', 'admin', ...extra])
  const countLine = (out) => (out.match(/总 \d+ \/.*$/m) ?? [''])[0]

  // ---- 1. 隔离库准备：建库 → 全量迁移 → 种子 → 主数据引导 ----
  await step('create-db', async () => {
    assert('隔离库为白名单临时库（不碰 dev 主库 cadenza）', dbName.startsWith('cadenza_dops_'), dbName)
    if (await databaseExists(args.adminUrl, dbName)) await dropDatabase(args.adminUrl, dbName)
    await createDatabase(args.adminUrl, dbName)
    appendLogSync(`created ${dbName}\n`)
  })
  await step('migrate-and-seed', async () => {
    const applied = await applyMigrations(dbUrl)
    const persistence = require('@cadenza/persistence')
    await withPool(dbUrl, async (pool) => {
      await persistence.seedOrgAuth(pool)
      for (const sql of BOOTSTRAP_SQL) await pool.query(sql)
      const n = await pool.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'`)
      appendLogSync(`seed done; public tables: ${String(n.rows[0].n)}\n`)
    })
    assert('全量迁移 + 组织种子 + 主数据引导成功', true, `迁移 ${String(applied.length)} 个`)
  })

  // ---- 2. 导入链（校验→暂存→核对确认；拒绝清单含 DO-09 待确认样例） ----
  await step('import-master', async () => {
    const r = imp('--apply', ['--template', 'initial-01-master-data', '--file', path.join(samplesDir, 'master-r1.csv')])
    assert('第 1 层匿名样本：成功 2 / 拒 1（坏行进拒绝清单，不静默丢弃）', r.code === 1 && /成功 2 \/ 已存在不覆盖 0 \/ 历史已导跳过 0 \/ 待确认 0 \/ 拒绝 1/.test(r.out), countLine(r.out))
  })
  await step('merge-master-confirm-l1', async () => {
    const m = imp('--merge-master-data', [])
    const c = imp('--confirm-layer', ['1', '--confirmer', '业务核对人甲'])
    assert('主数据合并 + 第 1 层核对通过', /新增料品 2/.test(m.out) && /核对通过/.test(c.out), m.out.trim())
  })
  await step('layer2-refused-without-freeze', async () => {
    const r = imp('--apply', ['--template', 'initial-02-inventory', '--file', path.join(samplesDir, 'inventory-r1.csv')])
    assert('未设冻结点时期初库存导入被拒（DO-11）', r.code === 1 && /冻结点/.test(r.out), r.out.trim())
  })
  await step('set-freeze-apply-inventory-confirm-l2', async () => {
    const f = imp('--set-freeze', ['--operator', '切换操作人甲'])
    const r = imp('--apply', ['--template', 'initial-02-inventory', '--file', path.join(samplesDir, 'inventory-r1.csv')])
    const c = imp('--confirm-layer', ['2', '--confirmer', '业务核对人乙'])
    assert('冻结点下库存导入：成功 1 / 拒 2（未知库位、科学计数数量），第 2 层核对通过',
      /冻结点已设置/.test(f.out) && r.code === 1 && /成功 1 .* 拒绝 2/.test(r.out) && /核对通过/.test(c.out), countLine(r.out))
  })
  await step('apply-open-orders-confirm-l3', async () => {
    const r = imp('--apply', ['--template', 'initial-03-open-orders', '--file', path.join(samplesDir, 'open-orders-r1.csv')])
    const c = imp('--confirm-layer', ['3', '--confirmer', '业务核对人丙'])
    assert('第 3 层：成功 3 / 拒 1（单据类型枚举），核对通过',
      r.code === 1 && /成功 3 .* 拒绝 1/.test(r.out) && /核对通过/.test(c.out), countLine(r.out))
  })
  await step('apply-history-confirm-l4', async () => {
    const r = imp('--apply', ['--template', 'initial-04-historical-docs', '--file', path.join(samplesDir, 'history-r1.csv')])
    const c = imp('--confirm-layer', ['4', '--confirmer', '业务核对人丁'])
    assert('第 4 层：成功 1 / 待确认 1（DO-09 历史空审核状态→具名核对清单，不入暂存），核对通过',
      r.code === 1 && /成功 1 .* 待确认 1/.test(r.out) && /核对通过/.test(c.out), countLine(r.out))
  })

  // ---- 3. 合并通道（产品命令面落账） ----
  await step('merge-inventory-initial', async () => {
    const r = mrg('merge-inventory')
    assert('合并期初库存：落账 1（inventory.receive-goods 新批次/单元/余额/流水）',
      r.code === 0 && /落账 1 /.test(r.out), r.out.trim())
    await withPool(dbUrl, async (pool) => {
      const unit = await runSql(pool,
        `SELECT iu.unit_no, sb.quantity::text AS qty, st.ref_type, st.movement_kind
         FROM inventory_unit iu
         JOIN stock_balance sb ON sb.unit_id = iu.id
         JOIN material_lot ml ON ml.id = iu.lot_id
         JOIN stock_transaction st ON st.unit_id = iu.id
         WHERE iu.unit_no LIKE 'IMPU-%' AND ml.lot_no = 'LOT-R1-0001'`)
      assert('期初单元业务事实：IMPU 单元 120.5000，receive 流水 ref_type=delivery_import',
        unit.rows.length === 1 && unit.rows[0].qty === '120.5000' && unit.rows[0].ref_type === 'delivery_import',
        JSON.stringify(unit.rows))
    })
  })
  await step('merge-open-orders', async () => {
    const r = mrg('merge-open-orders')
    assert('合并未结订单：落账 2（purchase.order-sync + process.order.receive）/ 待确认 1（sales_open 无命令面）',
      r.code === 0 && /落账 2 \/ 待确认 1 /.test(r.out), r.out.trim())
    await withPool(dbUrl, async (pool) => {
      const po = await runSql(pool, `SELECT order_no FROM purchase_order WHERE source_system = 'DELIVERY-INIT'`)
      const mo = await runSql(pool, `SELECT order_no, order_status FROM production_order WHERE order_type = 'wip_initial'`)
      const pl = await runSql(pool,
        `SELECT count(*)::int AS n FROM purchase_order_line l JOIN purchase_order o ON o.id = l.purchase_order_id WHERE o.source_system = 'DELIVERY-INIT'`)
      assert('订单业务事实：采购订单 PO-R1-0001（含 1 行未结）+ 在制生产订单 MO-R1-0001（released）',
        po.rows.length === 1 && po.rows[0].order_no === 'PO-R1-0001' && pl.rows[0].n === 1
          && mo.rows.length === 1 && mo.rows[0].order_no === 'MO-R1-0001' && mo.rows[0].order_status === 'released',
        JSON.stringify({ po: po.rows, lines: pl.rows[0].n, mo: mo.rows }))
    })
  })
  await step('merge-history', async () => {
    const before = await withPool(dbUrl, (pool) => pool.query(`SELECT count(*)::int AS n FROM stock_transaction`))
    const r = mrg('merge-history')
    assert('合并历史单据：待确认 1（不投递记账命令；不以暂存成功冒充业务导入成功）',
      r.code === 0 && /待确认 1 /.test(r.out), r.out.trim())
    await withPool(dbUrl, async (pool) => {
      const after = await runSql(pool, `SELECT count(*)::int AS n FROM stock_transaction`)
      assert('历史单据合并未新增任何库存流水（重放将双计，通道不落账）',
        after.rows[0].n === before.rows[0].n, `流水 ${String(before.rows[0].n)} → ${String(after.rows[0].n)}`)
    })
  })
  await step('apply-and-merge-incremental', async () => {
    const r = imp('--apply', ['--template', 'incr-02-inventory-delta', '--file', path.join(samplesDir, 'incr-inventory-r1.csv')])
    assert('增量抽取导入（DO-12 增量模板）：成功 2', r.code === 0 && /成功 2 /.test(r.out), countLine(r.out))
    const m = mrg('merge-inventory')
    assert('合并增量：落账 2（−20 issue-material 唯一单元扣减 + 30 receive-goods）',
      m.code === 0 && /落账 2 /.test(m.out), m.out.trim())
    await withPool(dbUrl, async (pool) => {
      const bal = await runSql(pool,
        `SELECT iu.unit_no, sb.quantity::text AS qty FROM inventory_unit iu
         JOIN stock_balance sb ON sb.unit_id = iu.id AND sb.status = 'active'
         WHERE iu.unit_no LIKE 'IMPU-%' ORDER BY iu.unit_no`)
      const movements = await runSql(pool,
        `SELECT ref_type, movement_kind, count(*)::int AS n FROM stock_transaction WHERE ref_type LIKE 'delivery_import%' GROUP BY 1,2 ORDER BY 1`)
      assert('增量落账后余额：期初单元 120.5−20=100.5000、增量单元 30.0000',
        bal.rows.length === 2
          && bal.rows.some((b) => b.qty === '100.5000') && bal.rows.some((b) => b.qty === '30.0000'),
        JSON.stringify(bal.rows))
      assert('流水事实：delivery_import receive 1 + delivery_import_delta receive 1 + issue 1',
        movements.rows.length === 3
          && movements.rows.find((x) => x.ref_type === 'delivery_import')?.n === 1
          && movements.rows.filter((x) => x.ref_type === 'delivery_import_delta' && x.movement_kind === 'receive').length === 1
          && movements.rows.filter((x) => x.ref_type === 'delivery_import_delta' && x.movement_kind === 'issue').length === 1,
        JSON.stringify(movements.rows))
    })
  })

  // ---- 4. 幂等证明（重导/重并/总线断点重放：均不多记） ----
  await step('reimport-same-files', async () => {
    const m = imp('--apply', ['--template', 'initial-01-master-data', '--file', path.join(samplesDir, 'master-r1.csv')])
    const i = imp('--apply', ['--template', 'initial-02-inventory', '--file', path.join(samplesDir, 'inventory-r1.csv')])
    assert('同文件重导：主数据 成功 0/已存在不覆盖 2（DO-07 不覆盖）；库存 成功 0/历史已导跳过 1（DO-08 幂等）',
      /成功 0 .* 已存在不覆盖 2 .* 历史已导跳过 0/.test(m.out) && /成功 0 .* 历史已导跳过 1/.test(i.out),
      `${countLine(m.out)} | ${countLine(i.out)}`)
    await withPool(dbUrl, async (pool) => {
      const n = await runSql(pool, `SELECT count(*)::int AS n FROM material WHERE source_system = 'DELIVERY_IMPORT'`)
      assert('重导后业务料品数仍为 2（不多记）', n.rows[0].n === 2, `material=${String(n.rows[0].n)}`)
    })
  })
  await step('remerge-no-dispatch', async () => {
    const inv = mrg('merge-inventory')
    const ord = mrg('merge-open-orders')
    assert('重并：库存 本次待合并 0；订单 本次待合并 1（仅 sales_open 待确认行重复具名，落账 0）',
      /本次待合并 0 /.test(inv.out) && /本次待合并 1 \/ 落账 0 /.test(ord.out),
      `${(inv.out.match(/本次待合并.*$/m) ?? [''])[0]} | ${(ord.out.match(/本次待合并.*$/m) ?? [''])[0]}`)
    await withPool(dbUrl, async (pool) => {
      const u = await runSql(pool, `SELECT count(*)::int AS n FROM inventory_unit WHERE unit_no LIKE 'IMPU-%'`)
      const t = await runSql(pool, `SELECT count(*)::int AS n FROM stock_transaction WHERE ref_type LIKE 'delivery_import%'`)
      const po = await runSql(pool, `SELECT count(*)::int AS n FROM purchase_order WHERE source_system = 'DELIVERY-INIT'`)
      assert('重并后业务事实不增：IMPU 单元 2 / 导入流水 3 / 采购订单 1',
        u.rows[0].n === 2 && t.rows[0].n === 3 && po.rows[0].n === 1,
        `units=${String(u.rows[0].n)} tx=${String(t.rows[0].n)} po=${String(po.rows[0].n)}`)
    })
  })
  await step('bus-replay-after-crash', async () => {
    // 模拟"命令已提交但 merged_at 标记未写"的断点：清标记后重并，
    // 同 operationId 同载荷 → 命令总线回放原 COMMITTED 结果，业务事实不增。
    await withPool(dbUrl, async (pool) => {
      const st = await runSql(pool, `SELECT natural_key, merged_operation_id FROM delivery_stg_inventory WHERE kind = 'initial'`)
      const before = await runSql(pool, `SELECT count(*)::int AS n FROM stock_transaction WHERE ref_type = 'delivery_import'`)
      await runSql(pool, `UPDATE delivery_stg_inventory SET merged_at = NULL, merged_operation_id = NULL WHERE kind = 'initial'`)
      const r = mrg('merge-inventory')
      assert('断点重并：回放原结果（落账 1，operationId 同键）', r.code === 0 && /落账 1 /.test(r.out), r.out.trim())
      const after = await runSql(pool, `SELECT count(*)::int AS n FROM stock_transaction WHERE ref_type = 'delivery_import'`)
      const receipts = await runSql(pool,
        `SELECT count(*)::int AS n FROM command_receipt WHERE operation_id = $1`, [st.rows[0].merged_operation_id])
      const units = await runSql(pool, `SELECT count(*)::int AS n FROM inventory_unit WHERE unit_no LIKE 'IMPU-%'`)
      assert('总线幂等（operationId 语义）：同键回执 1 条、业务流水/单元不增（重放不多记）',
        receipts.rows[0].n === 1 && after.rows[0].n === before.rows[0].n && units.rows[0].n === 2,
        `receipts=${String(receipts.rows[0].n)} tx ${String(before.rows[0].n)}→${String(after.rows[0].n)} units=${String(units.rows[0].n)}`)
    })
  })

  // ---- 5. DO-13 四维对账（增量后源清单 vs 业务账：差异应被检出并交业务确认） ----
  await step('reconcile-four-dims', async () => {
    const outDir = path.join(evidenceDir, 'reconcile')
    const r = runTool(RECONCILE_TOOL, ['--source', path.join(samplesDir, 'inventory-r1.csv'), '--against-db', '--database-url', dbUrl, '--out', outDir])
    assert('DO-13：增量后源清单 vs 业务账——差异被检出（exit=1，差异交业务确认、不直接改账）',
      r.code === 1 && /差异 [1-9]/.test(r.out), (r.out.match(/对账完成.*$/m) ?? [''])[0])
  })

  // ---- 6. 三方对账数字（导入汇总 vs 业务落账 vs 拒绝/待确认） ----
  await step('three-way-reconciliation', async () => {
    await withPool(dbUrl, async (pool) => {
      const importByLayer = await runSql(pool, `
        SELECT r.layer,
               sum(r.total_rows)::int AS total, sum(r.success_rows)::int AS success,
               sum(r.rejected_rows)::int AS rejected, sum(r.review_rows)::int AS review,
               sum(r.skipped_imported_rows)::int AS skipped
        FROM delivery_import_run r GROUP BY r.layer ORDER BY r.layer`)
      const successKeys = await runSql(pool, `
        SELECT ru.layer, count(DISTINCT row.natural_key)::int AS success_keys
        FROM delivery_import_row row JOIN delivery_import_run ru ON ru.run_id = row.run_id
        WHERE row.status = 'success' GROUP BY ru.layer ORDER BY ru.layer`)
      const mergeByChannel = await runSql(pool, `
        SELECT mr.channel,
               count(DISTINCT CASE WHEN row.status = 'posted' THEN row.natural_key END)::int AS posted,
               count(DISTINCT CASE WHEN row.status = 'pending' THEN row.natural_key END)::int AS pending,
               count(DISTINCT CASE WHEN row.status = 'rejected' THEN row.natural_key END)::int AS rejected
        FROM delivery_merge_run mr JOIN delivery_merge_row row ON row.merge_run_id = mr.merge_run_id
        GROUP BY mr.channel`)
      const staged = await runSql(pool, `
        SELECT 'inventory' AS channel, count(*)::int AS total, count(merged_at)::int AS merged FROM delivery_stg_inventory
        UNION ALL SELECT 'open_orders', count(*), count(merged_at) FROM delivery_stg_open_order
        UNION ALL SELECT 'history', count(*), count(merged_at) FROM delivery_stg_historical_doc`)
      const biz = {
        material: (await runSql(pool, `SELECT count(*)::int AS n FROM material WHERE source_system = 'DELIVERY_IMPORT'`)).rows[0].n,
        impu_units: (await runSql(pool, `SELECT count(*)::int AS n FROM inventory_unit WHERE unit_no LIKE 'IMPU-%'`)).rows[0].n,
        import_tx: (await runSql(pool, `SELECT count(*)::int AS n FROM stock_transaction WHERE ref_type LIKE 'delivery_import%'`)).rows[0].n,
        purchase_orders: (await runSql(pool, `SELECT count(*)::int AS n FROM purchase_order WHERE source_system = 'DELIVERY-INIT'`)).rows[0].n,
        wip_orders: (await runSql(pool, `SELECT count(*)::int AS n FROM production_order WHERE order_type = 'wip_initial'`)).rows[0].n,
        history_facts: 0,
      }
      const rejectedKeys = (await runSql(pool,
        `SELECT count(DISTINCT natural_key)::int AS n FROM delivery_import_row WHERE status = 'rejected'`)).rows[0].n
      const reviewKeys = (await runSql(pool,
        `SELECT count(DISTINCT natural_key)::int AS n FROM delivery_import_row WHERE status = 'review'`)).rows[0].n
      const ledger = await verifyLedger(path.join(workspace, 'ledgers', 'rejections.ledger.jsonl'))
      const ledgerLines = ledger.ok ? ledger.count : -1
      const mergePendingKeys = (await runSql(pool,
        `SELECT count(DISTINCT natural_key)::int AS n FROM delivery_merge_row WHERE status = 'pending'`)).rows[0].n

      const g = (rows, key, field) => rows.find((r) => r[key] === field) ?? {}
      const sk = (layer) => g(successKeys.rows, 'layer', layer).success_keys ?? 0
      const mInv = g(mergeByChannel.rows, 'channel', 'inventory')
      const mOrd = g(mergeByChannel.rows, 'channel', 'open_orders')
      const mHist = g(mergeByChannel.rows, 'channel', 'history')

      const identities = [
        { name: 'L1 主数据：导入成功键 = 业务料品行', ok: sk(1) === biz.material && sk(1) === 2, detail: `${String(sk(1))} = ${String(biz.material)}` },
        { name: 'L2 库存：导入成功键（去重）= 合并落账（去重）+ 待确认 + 拒绝（无漏账）', ok: sk(2) === (mInv.posted ?? 0) + (mInv.pending ?? 0) + (mInv.rejected ?? 0) && sk(2) === 3 && (mInv.posted ?? 0) === 3, detail: `${String(sk(2))} = posted ${String(mInv.posted ?? 0)} + pending ${String(mInv.pending ?? 0)} + rejected ${String(mInv.rejected ?? 0)}` },
        { name: 'L2 业务事实：IMPU 单元 = 收货落账 2（1 期初 + 1 增量）；导入流水 = 3（receive×2 + issue×1）', ok: biz.impu_units === 2 && biz.import_tx === 3, detail: `units=${String(biz.impu_units)} tx=${String(biz.import_tx)}` },
        { name: 'L3 订单：导入成功键 = 落账 + 具名待确认（3 = 2 + 1）', ok: sk(3) === (mOrd.posted ?? 0) + (mOrd.pending ?? 0) && sk(3) === 3 && (mOrd.posted ?? 0) === 2, detail: `${String(sk(3))} = posted ${String(mOrd.posted ?? 0)} + pending ${String(mOrd.pending ?? 0)}` },
        { name: 'L3 业务事实：采购订单 1 + 在制订单 1 = 落账 2', ok: biz.purchase_orders === 1 && biz.wip_orders === 1, detail: `po=${String(biz.purchase_orders)} mo=${String(biz.wip_orders)}` },
        { name: 'L4 历史：导入成功键 = 合并具名待确认（1 = 1），业务落账 0（如实，不以暂存成功冒充）', ok: sk(4) === (mHist.pending ?? 0) + (mHist.posted ?? 0) + (mHist.rejected ?? 0) && sk(4) === 1 && (mHist.pending ?? 0) === 1 && biz.history_facts === 0, detail: `${String(sk(4))} = pending ${String(mHist.pending ?? 0)}` },
        { name: '拒绝/待确认：导入拒绝键 4 + DO-09 待确认键 1；哈希链账本完整（含重导复检行）', ok: rejectedKeys === 4 && reviewKeys === 1 && ledger.ok && ledgerLines === 8, detail: `rejected=${String(rejectedKeys)} review=${String(reviewKeys)} ledger=${String(ledgerLines)}` },
      ]
      for (const it of identities) assert(it.name, it.ok, it.detail)

      const lines = [
        '# 三方对账（R1：导入汇总 vs 业务落账 vs 拒绝/待确认）',
        '',
        `- 时间：${nowIso()}；库：${dbName}（隔离临时库，已随证明收尾删除）`,
        '',
        '## ① 导入汇总（delivery_import_run 累计，含重导运行）',
        '',
        '| 层 | 运行合计 总/成功/拒/待确认/已导跳过 | 去重成功键 |',
        '| --- | --- | --- |',
        ...importByLayer.rows.map((r) => `| 第 ${String(r.layer)} 层 | ${String(r.total)}/${String(r.success)}/${String(r.rejected)}/${String(r.review)}/${String(r.skipped)} | ${String(sk(r.layer))} |`),
        '',
        '## ② 业务落账（产品命令面事实行）',
        '',
        '| 面 | 数字 |',
        '| --- | --- |',
        `| 料品 material（DELIVERY_IMPORT） | ${String(biz.material)} |`,
        `| 期初/增量库存单元 IMPU-*（receive-goods 落账） | ${String(biz.impu_units)} |`,
        `| 导入来源库存流水（receive/issue） | ${String(biz.import_tx)} |`,
        `| 未结采购订单（order-sync 落账） | ${String(biz.purchase_orders)} |`,
        `| 在制生产订单（order.receive 落账） | ${String(biz.wip_orders)} |`,
        `| 历史单据业务落账 | ${String(biz.history_facts)}（全部具名待确认，不冒充） |`,
        '',
        '## ③ 合并通道与拒绝/待确认（delivery_merge_row 去重 + 拒绝清单账本）',
        '',
        '| 通道 | 落账 | 待确认 | 拒绝 | 暂存累计/已落账 |',
        '| --- | --- | --- | --- | --- |',
        `| inventory | ${String(mInv.posted ?? 0)} | ${String(mInv.pending ?? 0)} | ${String(mInv.rejected ?? 0)} | ${String(g(staged.rows, 'channel', 'inventory').total ?? 0)}/${String(g(staged.rows, 'channel', 'inventory').merged ?? 0)} |`,
        `| open_orders | ${String(mOrd.posted ?? 0)} | ${String(mOrd.pending ?? 0)} | ${String(mOrd.rejected ?? 0)} | ${String(g(staged.rows, 'channel', 'open_orders').total ?? 0)}/${String(g(staged.rows, 'channel', 'open_orders').merged ?? 0)} |`,
        `| history | ${String(mHist.posted ?? 0)} | ${String(mHist.pending ?? 0)} | ${String(mHist.rejected ?? 0)} | ${String(g(staged.rows, 'channel', 'history').total ?? 0)}/${String(g(staged.rows, 'channel', 'history').merged ?? 0)} |`,
        '',
        `导入拒绝键（去重）${String(rejectedKeys)}、DO-09 待确认键 ${String(reviewKeys)}、合并待确认键（去重）${String(mergePendingKeys)}；拒绝清单哈希链 ${ledger.ok ? `完整（${String(ledgerLines)} 行，含重导复检拒绝行）` : '损坏'}。`,
        '',
        '## 恒等式（三方数字一致）',
        '',
        ...identities.map((it) => `- ${it.ok ? 'PASS' : 'FAIL'}：${it.name}（${it.detail}）`),
      ]
      await writeFile(path.join(evidenceDir, 'THREE-WAY-RECON.md'), `${lines.join('\n')}\n`, 'utf8')
    })
  })

  // ---- 7. 冻结点解除（核对通过 + 批准人）与收尾 ----
  await step('release-freeze', async () => {
    const r = imp('--release-freeze', ['--approver', '恢复写入批准人甲'])
    assert('第 2 层已核对 → 批准人解除冻结点（DO-11/DO-S3）', /冻结点已解除/.test(r.out), r.out.trim())
    await withPool(dbUrl, async (pool) => {
      const st = await runSql(pool, `SELECT state FROM delivery_freeze_point ORDER BY id DESC LIMIT 1`)
      assert('冻结点状态=released', st.rows[0]?.state === 'released', JSON.stringify(st.rows))
    })
  })

  // ---- 8. 汇总与清理 ----
  const failed = ASSERTS.filter((a) => !a.ok)
  const summary = [
    `# R1 端到端证明汇总 ${stamp}`,
    '',
    `- 断言 ${String(ASSERTS.length)} 项：PASS ${String(ASSERTS.length - failed.length)} / FAIL ${String(failed.length)}`,
    `- 临时库 ${dbName}；${args.keepDb ? '保留（--keep-db）' : '已删除'}`,
    '',
    ...ASSERTS.map((a) => `- ${a.ok ? 'PASS' : 'FAIL'} ${a.name}${a.detail ? ` — ${a.detail}` : ''}`),
  ]
  await writeFile(path.join(evidenceDir, 'PROOF-SUMMARY.md'), `${summary.join('\n')}\n`, 'utf8')
  console.log(`\n[R1 证明结束] 断言 ${String(ASSERTS.length - failed.length)}/${String(ASSERTS.length)} 通过；证据：${evidenceDir}`)
  if (!args.keepDb) {
    await step('drop-db', async () => {
      await dropDatabase(args.adminUrl, dbName)
      appendLogSync(`dropped ${dbName}\n`)
    })
  }
  if (failed.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('R1 证明脚本失败：', error instanceof Error ? (error.stack ?? error.message) : error)
  process.exit(1)
})
