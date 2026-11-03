#!/usr/bin/env node
/**
 * P1 全链联调验收脚本 —— 共享库（真实 api @3001 + psql 直读 dev 库对账）。
 *
 * 运行方式见 run.mjs。本文件不依赖任何 npm 包（node >=24 自带 fetch）。
 * 范围约束：只读产品代码；数据写入仅经真实 api 命令或「模拟外部系统入站」的直落 SQL
 *（料品/单位等 U9 同步主数据——本系统无维护入口，MD-01 口径）。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, appendFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
export const OUT_DIR = join(HERE, 'out')

export const API_BASE = process.env.CADENZA_API_BASE ?? 'http://127.0.0.1:3001'
export const PG_CONTAINER = process.env.CADENZA_PG_CONTAINER ?? 'cadenza-dev-pg'
export const PG_DB = 'cadenza'

/** 固定演示单位（0004 口径：uom 无 FK；与 tests/api 既有夹具同值）。 */
export const UOM_M_ID = '33333333-3333-4333-8333-3333333333c1'
export const UOM_M = 'M'
export const OWNER_NAME = '华东电缆集团（自有）'

const PASSWORDS = {
  admin: 'CadAdmin001',
  hfadmin01: 'HfPlant0001',
  szqc01: 'SzQuality01',
}

// ---------------------------------------------------------------------------
// SQL（docker exec psql；查询作为 ARGV 传入，无 shell 注入面）
// ---------------------------------------------------------------------------

/** 执行 SQL，返回 string[][]（行×列；NULL→''）。 */
export function sql(query) {
  const r = spawnSync(
    'docker',
    ['exec', PG_CONTAINER, 'psql', '-U', 'postgres', '-d', PG_DB, '-tA', '-F', '\t', '-c', query],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  if (r.status !== 0) {
    throw new Error(`psql 失败（${r.status}）：${String(r.stderr).trim().slice(0, 500)}\nSQL: ${query.slice(0, 300)}`)
  }
  return String(r.stdout)
    .split('\n')
    .filter((line) => line.length > 0 && !line.startsWith('(') )
    .map((line) => line.split('\t'))
}

/** 单值 SQL（第一行第一列）。 */
export function sqlOne(query) {
  const rows = sql(query)
  if (rows.length === 0 || rows[0].length === 0) return null
  return rows[0][0]
}

/** SQL 字符串字面量转义。 */
export function q(v) {
  if (v === null || v === undefined) return 'NULL'
  return `'${String(v).replace(/'/g, "''")}'`
}

/**
 * 场景授权保障：admin 以真实 /org/grants 命令给 sysadmin 角色合并所需许可（幂等）。
 * dev 共享库可能被其它测试会话的 seedOrgAuth 重置回种子基线（合并行被 EXCLUDED 覆盖），
 * 场景入口自足补齐，不依赖 db:seed 的 dev 姿态授权时序。
 */
export async function ensureAdminPermissions(run, permissions) {
  const ids = sql(
    `SELECT ua.role_id, ua.enterprise_id FROM user_account ua WHERE ua.login_name = 'admin'`,
  )
  const roleId = ids[0]?.[0]
  const entId = ids[0]?.[1]
  if (!roleId || !entId) throw new Error('admin 账号或其角色缺失（种子未就绪）')
  const grant = await api('POST', '/org/grants', {
    principalType: 'role',
    principalId: roleId,
    scopeType: 'enterprise',
    scopeObjectId: entId,
    permissions,
    reason: `P1 验收（${run.run}）：sysadmin 域许可合并（场景自足保障，幂等）`,
    operationId: `${run.run}-ensure-${[...permissions].sort().join('+')}`,
  })
  if (grant.status !== 200 && grant.status !== 201) {
    throw new Error(`ensureAdminPermissions 授权失败 http=${grant.status} body=${JSON.stringify(grant.body)}`)
  }
  return grant.body?.data ?? null
}

// ---------------------------------------------------------------------------
// HTTP（真实 api）
// ---------------------------------------------------------------------------

const tokenCache = new Map()

export async function login(loginName) {
  if (tokenCache.has(loginName)) return tokenCache.get(loginName)
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginName, password: PASSWORDS[loginName], platform: 'WEB' }),
  })
  const body = await res.json().catch(() => null)
  if (res.status !== 200) throw new Error(`${loginName} 登录失败 http=${res.status} body=${JSON.stringify(body)}`)
  tokenCache.set(loginName, body.token)
  return body.token
}

function brief(body, limit = 300) {
  const s = JSON.stringify(body) ?? String(body)
  return s.length > limit ? `${s.slice(0, limit)}…` : s
}

/** 真实 api 调用。user 缺省 admin。返回 {status, body}。 */
export async function api(method, path, body, { user = 'admin', token, retry401 = true } = {}) {
  const t = token ?? (await login(user))
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  if (res.status === 401 && retry401 && !token) {
    tokenCache.delete(user)
    return api(method, path, body, { user, retry401: false })
  }
  return { status: res.status, body: json }
}

// ---------------------------------------------------------------------------
// 证据与断言
// ---------------------------------------------------------------------------

export class Run {
  constructor(runTag) {
    this.run = runTag
    this.state = {}
    this.results = [] // {scenario, step, kind, ok, detail}
    this.failures = []
    this.scenario = 'pre'
    this.evidencePath = join(OUT_DIR, `evidence-${runTag}.jsonl`)
    this.statePath = join(OUT_DIR, `state-${runTag}.json`)
    mkdirSync(OUT_DIR, { recursive: true })
    writeFileSync(this.evidencePath, '')
  }

  setScenario(name) {
    this.scenario = name
  }

  log(kind, step, ok, detail) {
    const row = { ts: new Date().toISOString(), run: this.run, scenario: this.scenario, step, kind, ok, detail }
    appendFileSync(this.evidencePath, `${JSON.stringify(row)}\n`)
    this.results.push(row)
    if (!ok) this.failures.push(`${this.scenario}/${step}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
    const mark = ok ? 'PASS' : 'FAIL'
    console.log(`  [${mark}] ${step} ${typeof detail === 'string' ? `— ${detail.slice(0, 220)}` : `— ${brief(detail, 200)}`}`)
    return ok
  }

  saveState() {
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2))
  }

  loadState(path) {
    if (existsSync(path)) this.state = JSON.parse(readFileSync(path, 'utf8'))
  }

  summary() {
    const byScenario = {}
    for (const r of this.results) {
      byScenario[r.scenario] ??= { pass: 0, fail: 0 }
      byScenario[r.scenario][r.ok ? 'pass' : 'fail'] += 1
    }
    return { run: this.run, total: this.results.length, failures: this.results.filter((r) => !r.ok).length, byScenario }
  }
}

/** 断言：失败记录证据并返回 false（不抛出——继续可继续部分，如实登记）。 */
export function must(run, step, cond, detail) {
  return run.log('assert', step, Boolean(cond), detail)
}

/** HTTP 步骤：记录请求/响应摘要；期望状态码。返回响应。 */
export async function httpStep(run, step, method, path, body, expect, opts = {}) {
  const res = await api(method, path, body, opts)
  const expectList = Array.isArray(expect) ? expect : [expect]
  const ok = expectList.includes(res.status)
  run.log('http', step, ok, `${method} ${path} → ${res.status}（期望 ${expectList.join('/')}） ${brief(res.body, 260)}`)
  return res
}

/** SQL 对账步骤：执行查询并记录。返回行。 */
export function sqlStep(run, step, query) {
  try {
    const rows = sql(query)
    run.log('sql', step, true, rows.map((r) => r.join(' | ')).join(' ;; ').slice(0, 400) || '(0 行)')
    return rows
  } catch (error) {
    run.log('sql', step, false, String(error.message ?? error))
    return []
  }
}

// ---------------------------------------------------------------------------
// 常用工具
// ---------------------------------------------------------------------------

/** 北京时区当日日期（与 execution 默认班次日历口径一致：UTC+8、零点白班起点）。 */
export function beijingToday() {
  return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10)
}

export function nowIso() {
  return new Date().toISOString()
}

/** 数字比较（十进制定点字符串 → number，容差 1e-6）。 */
export function num(v) {
  return Number(v)
}

export function eqQty(a, b) {
  return Math.abs(Number(a) - Number(b)) < 1e-6
}

/** 摘要对象（报告用）。 */
export function pick(obj, keys) {
  const out = {}
  for (const k of keys) out[k] = obj?.[k]
  return out
}
