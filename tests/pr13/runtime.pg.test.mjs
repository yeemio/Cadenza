import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { REPO_ROOT } from '../../scripts/delivery/build/fixture-path.mjs'
import { createExclusiveDatabase } from '../../scripts/delivery/build/exclusive-pg.mjs'

// Run only after the exact candidate's cold build. No raw TS aliases or cached dist substitutions.
const require = createRequire(import.meta.url), children = []
const root = REPO_ROOT, directory = mkdtempSync(path.join(tmpdir(), 'cadenza-pr13-runtime-'))
const password = randomUUID()
let database, plantId
function child(entry, env) {
  const process = spawn(globalThis.process.execPath, [path.join(root, entry)], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const state = { process, output: '', error: null }
  process.stdout.on('data', (data) => { state.output += data })
  process.stderr.on('data', (data) => { state.output += data })
  process.on('error', (error) => { state.error = error.code })
  children.push(state); return state
}
async function ready(state, pattern) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const match = pattern.exec(state.output)
    if (match) return match
    if (state.error || state.process.exitCode !== null) throw new Error('Owned runtime child failed before readiness')
    await delay(50)
  }
  throw new Error('Owned runtime readiness timeout')
}
function baseEnv() {
  // No inherited service/model credentials or DATABASE_URL in the AI child.
  return { PATH: process.env.PATH, NODE_ENV: 'test', LANG: 'C.UTF-8' }
}
async function freePort() {
  const socket = createServer(); await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve))
  const port = socket.address().port; await new Promise((resolve) => socket.close(resolve)); return port
}
test.before(async () => {
  database = await createExclusiveDatabase('required')
  const persistence = require(path.join(root, 'packages/persistence/dist/index.js'))
  await persistence.migrateUp(database.pool, persistence.migrations)
  await persistence.seedOrgAuth(database.pool, { passwordOverrides: { admin: password } })
  plantId = (await database.pool.query("SELECT id FROM org_node WHERE code='PLNT-SZ'")).rows[0].id
})
test.after(async () => {
  for (const state of children) {
    if (state.process.exitCode === null && !state.error) {
      state.process.kill('SIGTERM')
      const deadline = Date.now() + 4000
      while (state.process.exitCode === null && state.process.signalCode === null && Date.now() < deadline) await delay(40)
      if (state.process.exitCode === null && state.process.signalCode === null) state.process.kill('SIGKILL')
    }
  }
  await database?.pool.end()
  // Fresh DB and runtime files are preserved, never a DROP/reset of existing evidence.
})
test('built API starts with AI offline and serves a real authenticated core read', { timeout: 30000 }, async () => {
  const port = await freePort()
  const state = child('apps/api/dist/main.js', { ...baseEnv(), DATABASE_URL: database.url, PORT: String(port), AI_RUNTIME_URL: 'http://127.0.0.1:9' })
  const match = await ready(state, /Cadenza API[^\n]*http:\/\/127\.0\.0\.1:(\d+)/)
  const url = 'http://127.0.0.1:' + match[1]
  const health = await fetch(url + '/health'); assert.equal(health.status, 200)
  assert.equal((await health.json()).db, 'ok')
  const login = await fetch(url + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginName: 'admin', password, platform: 'WEB' }) })
  assert.equal(login.status, 200)
  const auth = await login.json()
  const nodes = await fetch(url + '/org/nodes', { headers: { Authorization: 'Bearer ' + auth.token } })
  assert.equal(nodes.status, 200)
  const body = await nodes.json(); assert.ok(Array.isArray(body.items) && body.items.length > 0)
})
test('built worker completes an empty scoped batch against the same fresh database', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'apps/worker/dist/main.js')], { cwd: directory, encoding: 'utf8', timeout: 15000,
    env: { ...baseEnv(), DATABASE_URL: database.url, WORKER_CHANNEL: 'noop', WORKER_SCOPE_PLANTS: plantId, WORKER_ONCE: 'true' } })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /无到期任务/)
})
test('built AI starts in mock mode without database credentials or a real model call', { timeout: 30000 }, async () => {
  const port = await freePort()
  const state = child('apps/ai/dist/apps/ai/src/main.js', { ...baseEnv(), AI_RUNTIME_PORT: String(port),
    AI_RUNTIME_INTERNAL_TOKEN: randomUUID(), AI_CONTROLLED_QUERY_MODE: 'mock', AI_DATA_DIR: path.join(directory, 'ai') })
  await ready(state, /Cadenza AI[^\n]*已启动/)
  const response = await fetch('http://127.0.0.1:' + port + '/ai-runtime/health')
  assert.equal(response.status, 200)
})
