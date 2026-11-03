#!/usr/bin/env node
/**
 * reporting 域重建命令调用面（R2/R3 演练用，2026-10-29）。
 *
 * 复用既有产品命令面（HTTP API + 命令总线，不绕过权限/幂等/审计）：
 *   POST /auth/login → Bearer 会话；
 *   POST /reporting/metric-definition/register {metricKeys:['*']}  引导默认四族定义；
 *   POST /reporting/stock-stat/rebuild {}                          库存统计投影全量重建；
 *   POST /reporting/shift-snapshot/rebuild {plantId}               班次快照重算。
 * plantId 经只读 DB 查询按工厂编码解析（命令本身仍走 HTTP）。
 *
 * 用法：reporting-rebuild.mjs --api-url URL --database-url URL --plant-code PLNT-SZ
 *       [--login admin --password …] [--commands register,stock-stat,shift-snapshot]
 * 退出码：0＝所选命令全部 COMMITTED；1＝任一失败。
 */

import { withPool } from '../lib/db.mjs'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]?.replace(/^--/, '')
    if (!key) continue
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      args[key] = next
      i += 1
    } else {
      args[key] = ''
    }
  }
  return args
}

async function postJson(url, token, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text }
  }
  return { ok: response.ok, status: response.status, json }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const apiUrl = args['api-url']
  const databaseUrl = args['database-url']
  const plantCode = args['plant-code']
  const login = args['login'] ?? 'admin'
  const password = args['password'] ?? 'CadAdmin001'
  const commands = (args['commands'] ?? 'register,stock-stat,shift-snapshot').split(',').map((c) => c.trim()).filter(Boolean)
  if (!apiUrl || !databaseUrl || !plantCode) {
    console.error('用法：--api-url URL --database-url URL --plant-code CODE [--login admin] [--password …] [--commands …]')
    process.exit(2)
  }

  const plantId = await withPool(databaseUrl, async (pool) => {
    const r = await pool.query(
      `SELECT id::text AS id FROM org_node WHERE code = $1 AND kind = 'plant' AND status = 'active' LIMIT 1`,
      [plantCode])
    if (r.rows.length === 0) throw new Error(`工厂编码未找到：${plantCode}`)
    return r.rows[0].id
  })

  const loginRes = await postJson(`${apiUrl}/auth/login`, null, { loginName: login, password, platform: 'WEB' })
  if (!loginRes.ok || typeof loginRes.json.token !== 'string') {
    console.error(`登录失败：HTTP ${String(loginRes.status)} ${JSON.stringify(loginRes.json)}`)
    process.exit(1)
  }
  const token = loginRes.json.token
  console.log(`[rebuild] 登录 ${login}@${plantCode}（plantId=${plantId}）成功`)

  const failures = []
  if (commands.includes('register')) {
    const r = await postJson(`${apiUrl}/reporting/metric-definition/register`, token,
      { metricKeys: ['*'], reason: 'R2R3 演练：默认四族指标定义引导' })
    console.log(`[rebuild] reporting.metric-definition.register → ${JSON.stringify(r.json)}`)
    if (!r.ok || r.json.status !== 'COMMITTED') failures.push('metric-definition.register')
  }
  if (commands.includes('stock-stat')) {
    const r = await postJson(`${apiUrl}/reporting/stock-stat/rebuild`, token,
      { reason: 'R2R3 演练：库存统计投影全量重建' })
    console.log(`[rebuild] reporting.stock-stat.rebuild → ${JSON.stringify(r.json)}`)
    if (!r.ok || r.json.status !== 'COMMITTED') failures.push('stock-stat.rebuild')
  }
  if (commands.includes('shift-snapshot')) {
    const r = await postJson(`${apiUrl}/reporting/shift-snapshot/rebuild`, token,
      { plantId, reason: 'R2R3 演练：班次快照重算' })
    console.log(`[rebuild] reporting.shift-snapshot.rebuild → ${JSON.stringify(r.json)}`)
    if (!r.ok || r.json.status !== 'COMMITTED') failures.push('shift-snapshot.rebuild')
  }
  if (failures.length > 0) {
    console.error(`[rebuild] 失败命令：${failures.join(', ')}`)
    process.exit(1)
  }
  console.log(`[rebuild] 全部命令 COMMITTED（${commands.join(', ')}）`)
}

main().catch((error) => {
  console.error('reporting 重建调用失败：', error instanceof Error ? error.message : error)
  process.exit(1)
})
