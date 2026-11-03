#!/usr/bin/env node
/**
 * P1 全链联调验收 —— 运行入口。
 *
 * 用法：
 *   node scripts/p1-acceptance/run.mjs                # 全链 A01→A08→A11（单一 run 标签，顺序执行）
 *   node scripts/p1-acceptance/run.mjs --only a01,a02 # 只跑指定场景（共用最近一次 state）
 *   node scripts/p1-acceptance/run.mjs --tag mytag    # 指定 run 标签（默认 P1 + 时间戳）
 *
 * 前置：
 *   - docker compose up -d（cadenza-dev-pg @55433）
 *   - pnpm db:migrate:up && pnpm db:seed
 *   - pnpm dev:api（api @3001）
 *
 * 产出：scripts/p1-acceptance/out/evidence-<tag>.jsonl（逐项证据）+ state-<tag>.json（可分批续跑）。
 * 退出码：0=全部断言通过；1=存在失败/缺口（明细见 evidence 与 stdout）。
 */
import { Run, api, sql } from './lib.mjs'

const args = process.argv.slice(2)
const onlyIdx = args.indexOf('--only')
const tagIdx = args.indexOf('--tag')
const ONLY = onlyIdx >= 0 ? args[onlyIdx + 1]?.split(',').map((x) => x.trim()) : null
const TAG = tagIdx >= 0 ? args[tagIdx + 1] : `P1${Date.now().toString(36)}`

const SCENARIOS = [
  ['a01', (await import('./scenarios/a01.mjs')).run, 'A01 组织/权限/主数据'],
  ['a02', (await import('./scenarios/a02.mjs')).run, 'A02 采购主链'],
  ['a03', (await import('./scenarios/a03.mjs')).run, 'A03 工艺与排程'],
  ['a04', (await import('./scenarios/a04.mjs')).run, 'A04 报工与投料'],
  ['a04-concurrency', (await import('./scenarios/a04-concurrency.mjs')).run, 'A04 并发余额竞争（REWORK 补差）'],
  ['a06', (await import('./scenarios/a06.mjs')).run, 'A06 质量闭环'],
  ['a07', (await import('./scenarios/a07.mjs')).run, 'A07 移库/调拨'],
  ['a08', (await import('./scenarios/a08.mjs')).run, 'A08 装箱发运'],
  ['a11', (await import('./scenarios/a11.mjs')).run, 'A11 恢复与幂等'],
  ['a11-reliability', (await import('./scenarios/a11-reliability.mjs')).run, 'A11 附件受权/配置恢复/后台范围（REWORK 补差）'],
]

async function main() {
  console.log(`P1 全链联调验收（run=${TAG}，时间 ${new Date().toISOString()}）`)
  console.log(`前置检查：api /health …`)

  // 前置：api + db
  let dbOk = false
  try {
    const health = await api('GET', '/health')
    if (health.status !== 200 || health.body?.db !== 'ok') {
      console.error(`api 不可用或 db 异常：${JSON.stringify(health.body)}`)
      process.exit(1)
    }
    console.log(`  api ok（db=${health.body.db}）`)
    const mig = sql(`SELECT string_agg(version, ',') FROM (SELECT version FROM schema_migrations ORDER BY version) m`)
    // P1 要求 0001–0010 全部就位；0011+ 为 P2/P3 线迁移，允许并存（共享库随分线推进）
    const versions = String(mig[0]?.[0] ?? '').split(',').filter(Boolean)
    const required = Array.from({ length: 10 }, (_, i) => String(i + 1).padStart(4, '0'))
    dbOk = required.every((v) => versions.includes(v))
    console.log(`  schema_migrations=${mig[0]?.[0]}`)
    if (!dbOk) process.exit(1)
  } catch (error) {
    console.error(`前置检查失败：${error.message}`)
    process.exit(1)
  }

  const run = new Run(TAG)
  run.state = { run: TAG }

  // --only 模式：加载最近一次 state（按修改时间最新，分批续跑）
  if (ONLY) {
    const { readdirSync, readFileSync, existsSync, statSync } = await import('node:fs')
    const dir = new URL('.', import.meta.url).pathname + 'out'
    const states = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.startsWith('state-'))
          .map((f) => ({ f, m: statSync(`${dir}/${f}`).mtimeMs }))
          .sort((a, b) => b.m - a.m)
      : []
    if (states.length > 0) {
      const prev = JSON.parse(readFileSync(`${dir}/${states[0].f}`, 'utf8'))
      run.state = { ...prev, run: TAG }
      console.log(`续跑模式：从 ${states[0].f} 恢复 state（前次 run=${prev.run}）`)
    }
  }

  for (const [key, fn, label] of SCENARIOS) {
    if (ONLY && !ONLY.includes(key)) continue
    console.log(`\n===== ${label}（${key}）=====`)
    try {
      await fn(run)
    } catch (error) {
      run.log('error', `${key} 场景异常中断（登记为阻断点，继续可继续部分）`, false, String(error?.stack ?? error?.message ?? error).slice(0, 500))
    }
    run.saveState()
  }

  const summary = run.summary()
  console.log(`\n===== 汇总（run=${TAG}）=====`)
  for (const [sc, c] of Object.entries(summary.byScenario)) {
    console.log(`  ${sc}: PASS=${c.pass} FAIL=${c.fail}`)
  }
  console.log(`  合计：${summary.total} 项，失败 ${summary.failures} 项`)
  if (summary.failures > 0) {
    console.log('\n失败/缺口清单：')
    for (const f of run.failures) console.log(`  - ${f}`)
  }
  console.log(`\n证据：scripts/p1-acceptance/out/evidence-${TAG}.jsonl`)
  console.log(`状态：scripts/p1-acceptance/out/state-${TAG}.json`)
  process.exit(summary.failures > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(`运行异常：${error?.stack ?? error}`)
  process.exit(1)
})
