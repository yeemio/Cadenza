#!/usr/bin/env node
/**
 * P2/P3/P4-A 全链联调验收 —— 运行入口（模式照抄 scripts/p1-acceptance/run.mjs）。
 *
 * 用法：
 *   node scripts/p2p3-acceptance/run.mjs                # 全链（单一 run 标签，顺序执行）
 *   node scripts/p2p3-acceptance/run.mjs --only a05,a09 # 只跑指定场景（共用最近一次 state）
 *   node scripts/p2p3-acceptance/run.mjs --tag P23ACC-R1
 *
 * 前置：
 *   - docker compose up -d（cadenza-dev-pg @55433）
 *   - pnpm db:migrate:up && pnpm db:seed   # 迁移 0001–0021 + 种子（seed 覆写已知副作用）
 *   - pnpm build                           # A12-OT 需 packages/edge/dist（模拟网关）
 *   - pnpm dev:api                         # api @3001
 *
 * 产出：scripts/p2p3-acceptance/out/evidence-<tag>.jsonl（逐项证据）+ state-<tag>.json（可分批续跑）。
 * 退出码：0=全部断言通过；1=存在失败/缺口（明细见 evidence 与 stdout）。
 */
import { Run, api, sql } from './lib.mjs'

const args = process.argv.slice(2)
const onlyIdx = args.indexOf('--only')
const tagIdx = args.indexOf('--tag')
const ONLY = onlyIdx >= 0 ? args[onlyIdx + 1]?.split(',').map((x) => x.trim()) : null
const TAG = tagIdx >= 0 ? args[tagIdx + 1] : `P23${Date.now().toString(36)}`

const SCENARIOS = [
  ['setup', (await import('./scenarios/setup.mjs')).run, 'S0 环境自足（组织/主数据/授权/订单/报工/工时）'],
  ['a05', (await import('./scenarios/a05.mjs')).run, 'A05 倒轴/分盘/分托/轴号修正（rework）'],
  ['a09', (await import('./scenarios/a09.mjs')).run, 'A09 两种形态转换（conversion）'],
  ['a10', (await import('./scenarios/a10.mjs')).run, 'A10 维护闭环 + 排产约束联证（maintenance/scheduling）'],
  ['a12-spc', (await import('./scenarios/a12-spc.mjs')).run, 'A12 SPC 控制限版本化（spc）'],
  ['a12-ot', (await import('./scenarios/a12-ot.mjs')).run, 'A12 OT 模拟采集→缓冲去重→工序关联（ot）'],
  ['a12-cost', (await import('./scenarios/a12-cost.mjs')).run, 'A12 成本归集分摊版本 + CA-12 工时主源（cost）'],
  ['a11', (await import('./scenarios/a11.mjs')).run, 'A11 恢复抽验（P2 域同 operationId 重放原结果）'],
  // —— 第二轮补齐（P23 未取证子项端到端场景；顺序约束：a12-cost-ext 须在 a12-ot-ext 前——
  //    后者引入第二报工会话，改变机时分摊会话分母）
  ['a13', (await import('./scenarios/a13.mjs')).run, 'A13 点检计划→执行→异常上报→维修工单→复机→排产恢复（maintenance MT-12 全链）'],
  ['a12-spc-ext', (await import('./scenarios/a12-spc-ext.mjs')).run, 'A12-SPC 扩展：失控处置闭环 + 失准圈定（spc PE-12/13/16～19）'],
  ['a12-cost-ext', (await import('./scenarios/a12-cost-ext.mjs')).run, 'A12-COST 扩展：表计→能源分摊→OEE 缺项（cost CE-S3/09/10/12）'],
  ['a12-ot-ext', (await import('./scenarios/a12-ot-ext.mjs')).run, 'A12-OT 扩展：会话其余两态 + 坏点/时钟偏差不参与判定（ot OT-13/20/21/22）'],
  ['a14', (await import('./scenarios/a14-cross.mjs')).run, 'A14 跨域抽验（csw 外协/reverse 盘点调整/disposition 让步/reporting 快照/aiquery AQ-C1）'],
]

async function main() {
  console.log(`P2/P3 全链联调验收（run=${TAG}，时间 ${new Date().toISOString()}）`)
  console.log(`前置检查：api /health …`)

  // 前置：api + db（P2/P3 要求 0001–0021 全部就位）
  let dbOk = false
  try {
    const health = await api('GET', '/health')
    if (health.status !== 200 || health.body?.db !== 'ok') {
      console.error(`api 不可用或 db 异常：${JSON.stringify(health.body)}`)
      process.exit(1)
    }
    console.log(`  api ok（db=${health.body.db}）`)
    const mig = sql(`SELECT string_agg(version, ',') FROM (SELECT version FROM schema_migrations ORDER BY version) m`)
    const versions = String(mig[0]?.[0] ?? '').split(',').filter(Boolean)
    const required = Array.from({ length: 21 }, (_, i) => String(i + 1).padStart(4, '0'))
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
  console.log(`\n证据：scripts/p2p3-acceptance/out/evidence-${TAG}.jsonl`)
  console.log(`状态：scripts/p2p3-acceptance/out/state-${TAG}.json`)
  process.exit(summary.failures > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(`运行异常：${error?.stack ?? error}`)
  process.exit(1)
})
