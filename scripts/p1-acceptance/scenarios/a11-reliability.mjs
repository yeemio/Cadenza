/**
 * A11 可靠性三件 + A14 写路径范围索引（P1 REWORK 补差场景）：
 * ① 附件受权（shipping 照片端点）：有 shipping.post 许可上传/读取成功、无许可账号 403、
 *    跨厂（授予 shipping.read 后按数据范围过滤）404；
 * ② 配置恢复：脚本内 kill api + 重启（同 dev:api 产物）→ 会话仍有效（auth_session 持久化）、
 *    授权配置未失效（scope_grant 行数不变 + hfadmin01 合肥授权仍可用）、/health 恢复；
 * ③ 后台范围：构造厂内/越厂两条 outbox 测试行（run 标签可识别，非业务数据），经真实 worker
 *    （WORKER_ONCE + WORKER_SCOPE_PLANTS=苏州厂）单批处理——厂内行经 noop 通道外发
 *    （external_ref 落库），越厂行被范围过滤标记 FAILED+next_retry_at=NULL 不外发
 *    （隔离态不入常规重试，P1 §3.5 后台任务同样受控；真实外部接口 SITE_PENDING）。
 * A14：写路径范围证据做一次汇总索引引用（不重复断言，指向既有域测试与本 run 的 403/404 证据）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { must, httpStep, sqlStep, sqlOne, q, login, API_BASE, ensureAdminPermissions } from '../lib.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

export async function run(run) {
  run.setScenario('A11-RELY')
  const s = run.state
  const orderId = s.shipment.orderId

  // 授权自足：sysadmin 合并 shipping.read/post（真实 /org/grants 命令，幂等）
  await ensureAdminPermissions(run, ['shipping.read', 'shipping.post'])

  // ================= ① 附件受权（shipping 照片） =================
  const fileName = `packing-${s.run}.jpg`
  const attach = await httpStep(run, '附件上传：admin（有 shipping.post）POST /shipping/photos',
    'POST', '/shipping/photos',
    {
      plantId: s.szPlantId, shipmentOrderId: orderId,
      photos: [{ fileName, storageKey: `s3://cadenza-acceptance/${s.run}/${fileName}`, contentType: 'image/jpeg', sizeBytes: 20480 }],
      operationId: `${s.run}-a11r-photo`,
    },
    [200, 201])
  must(run, '受权上传成功（attached 1）', attach.body?.data?.attached?.length === 1, JSON.stringify(attach.body?.data))

  const detail = await httpStep(run, '附件读取：admin（有 shipping.read）GET /shipping/shipment-orders/:id',
    'GET', `/shipping/shipment-orders/${orderId}`, undefined, 200)
  const photoHit = (detail.body?.photos ?? []).some((ph) => ph.fileName === fileName)
  must(run, '受权读取成功（详情含刚上传附件）', photoHit, JSON.stringify((detail.body?.photos ?? []).map((p) => p.fileName)))

  const noPerm = await httpStep(run, '无许可账号：szqc01（仅 org.read）上传 → 403',
    'POST', '/shipping/photos',
    {
      plantId: s.szPlantId, shipmentOrderId: orderId,
      photos: [{ fileName: 'should-fail.jpg', storageKey: 's3://x/should-fail.jpg' }],
      operationId: `${s.run}-a11r-photo-noperm`,
    },
    403, { user: 'szqc01' })
  must(run, '无 shipping.post 许可 → 403 ERR_FORBIDDEN_SCOPE', noPerm.body?.code === 'ERR_FORBIDDEN_SCOPE', JSON.stringify(noPerm.body))

  // 跨厂 404：给 hfadmin01（合肥厂范围）授 shipping.read（真实 /org/grants 命令，同 a01 口径）
  const grant = await httpStep(run, 'admin 给 hfadmin01 授 shipping.read（合肥厂范围，POST /org/grants）',
    'POST', '/org/grants',
    {
      principalType: 'user', principalId: s.hfUserId, scopeType: 'plant', scopeObjectId: s.hfPlantId,
      permissions: ['shipping.read'], reason: 'P1 验收：A11 附件跨厂读越范围取证授权（合肥厂只读）',
      operationId: `${s.run}-a11r-grant`,
    },
    [200, 201])
  must(run, '授权命令成功', Boolean(grant.body?.data?.grantId), JSON.stringify(grant.body?.data))
  const crossRead = await httpStep(run, '跨厂读取：hfadmin01 读苏州发货单详情 → 404（数据范围过滤）',
    'GET', `/shipping/shipment-orders/${orderId}`, undefined, 404, { user: 'hfadmin01' })
  must(run, '跨厂附件/单据读取 404 ERR_NOT_FOUND（服务端数据范围收敛，不泄漏存在性）',
    crossRead.body?.code === 'ERR_NOT_FOUND', JSON.stringify(crossRead.body))

  // ================= ② 配置恢复（重启 api） =================
  const meBefore = await httpStep(run, '重启前：admin 会话信息（GET /auth/me）', 'GET', '/auth/me', undefined, 200)
  const adminLoginName = meBefore.body?.user?.loginName
  const grantsBefore = sqlOne('SELECT count(*) FROM scope_grant')
  const sessionsBefore = sqlOne(`SELECT count(*) FROM auth_session WHERE user_id = (SELECT id FROM user_account WHERE login_name = 'admin') AND revoked_at IS NULL AND expires_at > now()`)
  const adminToken = await login('admin') // 持有跨重启验证用的令牌（不随进程销毁）

  run.log('step', '重启 api：kill 当前进程 → 重启同产物（node --env-file-if-exists=.env apps/api/dist/main.js）', true,
    `kill+restart @ ${API_BASE}`)
  spawnSync('pkill', ['-f', 'apps/api/dist/main.js'], { encoding: 'utf8' })
  // 等端口释放（最多 10s）
  let portFree = false
  for (let i = 0; i < 20; i += 1) {
    const probe = await fetch(`${API_BASE}/health`).then((r) => r.status).catch(() => 0)
    if (probe === 0) { portFree = true; break }
    await new Promise((res) => setTimeout(res, 500))
  }
  must(run, '旧 api 进程已停止（端口不再应答）', portFree, 'pkill 后 /health 仍应答')

  const { openSync } = await import('node:fs')
  const apiLog = join(dirname(fileURLToPath(import.meta.url)), '..', 'out', `api-restart-${s.run}.log`)
  const { writeFileSync: wf } = await import('node:fs')
  wf(apiLog, `# restarted by a11-reliability ${new Date().toISOString()}\n`)
  const logFd = openSync(apiLog, 'a')
  const child = spawn('node', ['--env-file-if-exists=.env', 'apps/api/dist/main.js'], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  })
  child.unref()

  let healthy = false
  let healthBody = null
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${API_BASE}/health`)
      if (res.status === 200) {
        healthBody = await res.json().catch(() => null)
        if (healthBody?.db === 'ok') { healthy = true; break }
      }
    } catch { /* 启动中 */ }
    await new Promise((res) => setTimeout(res, 1000))
  }
  run.log('http', '重启后 /health 恢复（db=ok）', healthy, JSON.stringify(healthBody))
  must(run, 'api 重启后健康恢复（/health 200 db=ok）', healthy, JSON.stringify(healthBody))

  // 会话仍有效：跨重启同令牌可用（auth_session 持久化，非进程内存）
  const meRaw = await fetch(`${API_BASE}/auth/me`, { headers: { Authorization: `Bearer ${adminToken}` } })
  const meAfter = await meRaw.json().catch(() => null)
  run.log('http', '重启后同令牌 GET /auth/me', meRaw.status === 200,
    `${meRaw.status} ${JSON.stringify(meAfter?.user?.loginName ?? '')}`)
  must(run, '会话仍有效（同令牌可用、同账号）', meRaw.status === 200 && meAfter?.user?.loginName === adminLoginName,
    `status=${meRaw.status} login=${meAfter?.user?.loginName}`)

  // 配置未失效：scope_grant 行数不变 + hfadmin01 合肥授权（含 a01 的 masterdata.read 与本 run shipping.read）仍可用
  const grantsAfter = sqlOne('SELECT count(*) FROM scope_grant')
  const hfList = await httpStep(run, '重启后 hfadmin01 依授权列仓库（合肥厂范围）',
    'GET', '/masterdata/warehouses?page=1&pageSize=10', undefined, 200, { user: 'hfadmin01' })
  const hfRows = hfList.body?.items ?? hfList.body?.data?.items ?? []
  must(run, '配置未失效（scope_grant 行数不变 + 合肥授权行为仍可用）',
    Number(grantsBefore) === Number(grantsAfter) && Array.isArray(hfRows) && hfRows.length > 0,
    `grants ${grantsBefore}→${grantsAfter} hfRows=${hfRows.length}`)
  sqlStep(run, 'SQL：admin 未撤销未过期会话行（重启前后持久）',
    `SELECT count(*) FROM auth_session WHERE user_id = (SELECT id FROM user_account WHERE login_name = 'admin') AND revoked_at IS NULL AND expires_at > now()`)
  const sessionsAfter = sqlOne(`SELECT count(*) FROM auth_session WHERE user_id = (SELECT id FROM user_account WHERE login_name = 'admin') AND revoked_at IS NULL AND expires_at > now()`)
  must(run, '会话持久（重启后活动会话数不减）', Number(sessionsAfter) >= Number(sessionsBefore),
    `before=${sessionsBefore} after=${sessionsAfter}`)

  // ================= ③ 后台范围（worker + 越厂 outbox 行） =================
  // 构造两条测试行（run+时刻标签可识别；fixture 直落，非业务数据——业务 outbox 仅由真实命令产生）
  const nonce = `${s.run}-${Date.now().toString(36)}`
  const taskKind = `p1rework.scope-test.${nonce}`
  const inAgg = `${nonce}-in-sz`
  const outAgg = `${nonce}-out-hf`
  sqlOne(`INSERT INTO outbox (aggregate_type, aggregate_id, task_kind, status, payload)
          VALUES ('p1_rework_scope_test', '${inAgg}', '${taskKind}', 'PENDING',
                  '{"plantId":"${s.szPlantId}","note":"厂内（苏州）行——应正常外发"}'::jsonb)`)
  sqlOne(`INSERT INTO outbox (aggregate_type, aggregate_id, task_kind, status, payload)
          VALUES ('p1_rework_scope_test', '${outAgg}', '${taskKind}', 'PENDING',
                  '{"plantId":"${s.hfPlantId}","note":"越厂（合肥）行——应被范围过滤不外发"}'::jsonb)`)
  run.log('sql', '构造厂内/越厂 outbox 测试行（PENDING）', true, `task_kind=${taskKind}`)

  // 真实 worker 单批：范围=苏州厂；批上限放大确保覆盖积压+测试行
  const workerOut = spawnSync('node', ['--env-file-if-exists=.env', 'apps/worker/dist/main.js'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      WORKER_ONCE: '1',
      WORKER_BATCH_LIMIT: '500',
      WORKER_SCOPE_PLANTS: s.szPlantId,
      WORKER_INTERVAL_MS: '1000',
    },
  })
  const { writeFileSync } = await import('node:fs')
  const workerLogPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'out', `worker-once-${s.run}.log`)
  writeFileSync(workerLogPath, `${workerOut.stdout ?? ''}\n${workerOut.stderr ?? ''}`)
  run.log('step', '真实 worker 单批运行（WORKER_ONCE + SCOPE_PLANTS=苏州）', workerOut.status === 0,
    `exit=${workerOut.status} 输出留 out/worker-once-${s.run}.log`)

  const inRow = sqlStep(run, 'SQL：厂内行处理结果',
    `SELECT status, attempt_count, external_ref IS NOT NULL, next_retry_at IS NULL FROM outbox WHERE task_kind = ${q(taskKind)} AND aggregate_id = ${q(inAgg)}`)
  const outRow = sqlStep(run, 'SQL：越厂行处理结果',
    `SELECT status, attempt_count, external_ref IS NULL, next_retry_at IS NULL, last_error FROM outbox WHERE task_kind = ${q(taskKind)} AND aggregate_id = ${q(outAgg)}`)
  // psql 布尔输出为 t/f
  const bool = (v) => v === 't' || v === 'true'
  must(run, '厂内行：DISPATCHED（经 noop 通道外发，external_ref 落库）',
    inRow.length === 1 && inRow[0][0] === 'DISPATCHED' && inRow[0][1] === '1' && bool(inRow[0][2]) && bool(inRow[0][3]),
    JSON.stringify(inRow))
  must(run, '越厂行：FAILED+next_retry_at=NULL（范围过滤标记，不外发、不入常规重试）',
    outRow.length === 1 && outRow[0][0] === 'FAILED' && outRow[0][1] === '1' && bool(outRow[0][2]) &&
      bool(outRow[0][3]) && String(outRow[0][4] ?? '').includes('scope-skip'),
    JSON.stringify(outRow))

  // ================= A14 写路径范围：汇总索引引用 =================
  const a14Refs = [
    'scripts/p1-acceptance/scenarios/a01.mjs（跨厂写 403：hfadmin01 越范围建仓）',
    'tests/api/masterdata-api.spec.ts（写路径服务端范围二道防线）',
    'tests/api/inventory-api.spec.ts（跨厂 403/列表过滤）',
    `本 run：A11-RELY 无许可上传 403 / 跨厂读取 404 / worker 越厂行 scope-skip 不外发`,
  ]
  const filesOk = a14Refs.slice(0, 3).every((ref) => existsSync(join(REPO_ROOT, ref.split('（')[0])))
  run.log('index', 'A14 写路径范围证据索引（引用既有域测试与本 run 证据，不重复断言）', filesOk, a14Refs.join(' ; '))

  run.saveState()
  return run
}
