/**
 * apps/ai 真进程 spawn 助手（DS-23 公开接口与故障隔离证明用）。
 *
 * - 起 `node apps/ai/dist/apps/ai/src/main.js`（先 apps/ai/build.sh）；
 * - 注入 mock 场景文件（DS-13：模型脚本+查询信封脚本+能力清单）；
 * - 子进程环境为干净构造（不含 DATABASE_URL 等生产凭据，AR-07；
 *   vitest 宿主进程可能被其他 spec 设置过 DATABASE_URL，不可继承）；
 * - 轮询 GET /ai-runtime/health 就绪（AR-11 探测源）。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import type { SessionEventRecord } from '../../packages/integrations/dsh'
import type { MockScenarioFile } from '../../apps/ai/src/composition-root'

const REPO_ROOT = resolve(__dirname, '../..')
export const AI_DIST_MAIN = join(REPO_ROOT, 'apps/ai/dist/apps/ai/src/main.js')
export const AI_TEST_TOKEN = 'test-internal-token-4f2a'

export interface HttpResult {
  status: number
  body: Record<string, unknown>
}

export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('无法获取空闲端口'))
        return
      }
      const port = address.port
      server.close(() => resolvePort(port))
    })
  })
}

async function requestJson(
  port: number,
  method: string,
  path: string,
  body: unknown,
  token: string | undefined,
): Promise<HttpResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token !== undefined) headers['Authorization'] = `Bearer ${token}`
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>
  return { status: response.status, body: parsed }
}

export interface SpawnedAiRuntime {
  port: number
  dataDir: string
  proc: ChildProcess
  scenarioFile: string
  get(path: string): Promise<HttpResult>
  post(path: string, body: unknown, token?: string): Promise<HttpResult>
  stop(): Promise<void>
  sessionEvents(sessionId: string): SessionEventRecord[]
}

export interface SpawnOptions {
  scenario: MockScenarioFile
  /** 额外 env（AI_TENANT_LIMITS 等；不可含 DATABASE_URL）。 */
  env?: Record<string, string>
  /** 预期启动失败（AR-07 fail-fast 证据）：不等健康就绪，等进程退出。 */
  expectStartupFailure?: boolean
}

export async function spawnAiRuntime(options: SpawnOptions): Promise<SpawnedAiRuntime> {
  if (!existsSync(AI_DIST_MAIN)) {
    throw new Error(`apps/ai 未构建（${AI_DIST_MAIN} 不存在）：先运行 apps/ai/build.sh`)
  }
  const port = await freePort()
  const dataDir = mkdtempSync(join(tmpdir(), 'ai-runtime-test-'))
  const scenarioFile = join(dataDir, 'scenario.json')
  writeFileSync(scenarioFile, JSON.stringify(options.scenario), 'utf8')

  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: process.env['HOME'] ?? '/tmp',
    AI_RUNTIME_PORT: String(port),
    AI_DATA_DIR: dataDir,
    AI_MOCK_SCENARIO_FILE: scenarioFile,
    AI_RUNTIME_INTERNAL_TOKEN: AI_TEST_TOKEN,
    AI_CONTROLLED_QUERY_MODE: 'mock',
    AI_SWEEP_INTERVAL_MS: '60000',
    ...(options.env ?? {}),
  }
  if (env['DATABASE_URL'] !== undefined) delete env['DATABASE_URL']
  if (options.env?.['DATABASE_URL'] !== undefined) {
    // 仅 AR-07 fail-fast 专用场景由调用方显式要求（expectStartupFailure）
    if (options.expectStartupFailure === true) env['DATABASE_URL'] = options.env['DATABASE_URL']
  }

  const proc = spawn(process.execPath, [AI_DIST_MAIN], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderrText = ''
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderrText += chunk.toString('utf8')
  })

  const spawned: SpawnedAiRuntime = {
    port,
    dataDir,
    proc,
    scenarioFile,
    get: (path) => requestJson(port, 'GET', path, undefined, undefined),
    post: (path, body, token = AI_TEST_TOKEN) => requestJson(port, 'POST', path, body, token),
    stop: () =>
      new Promise<void>((resolveStop) => {
        if (proc.exitCode !== null) {
          resolveStop()
          return
        }
        proc.once('exit', () => resolveStop())
        proc.kill('SIGTERM')
        setTimeout(() => {
          if (proc.exitCode === null) proc.kill('SIGKILL')
        }, 2_500).unref()
      }),
    sessionEvents: (sessionId) => {
      const path = join(dataDir, 'sessions', sessionId, 'events.jsonl')
      if (!existsSync(path)) return []
      return readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as SessionEventRecord)
    },
  }

  if (options.expectStartupFailure === true) {
    const code = await new Promise<number | null>((resolveExit) => {
      if (proc.exitCode !== null) resolveExit(proc.exitCode)
      else proc.once('exit', (exitCode) => resolveExit(exitCode))
    })
    if (code === 0) throw new Error(`预期启动失败但退出码为 0；stderr=${stderrText}`)
    if (!stderrText.includes('DATABASE_URL')) throw new Error(`stderr 未包含 DATABASE_URL 拒绝信息：${stderrText}`)
    return spawned
  }

  // 轮询健康就绪（最多 8s）
  const deadline = Date.now() + 8_000
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`apps/ai 启动即退出（code=${String(proc.exitCode)}）stderr=${stderrText}`)
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/ai-runtime/health`)
      if (response.status === 200) break
    } catch {
      // 尚未就绪
    }
    if (Date.now() > deadline) {
      await spawned.stop()
      throw new Error(`apps/ai 8s 内未就绪；stderr=${stderrText}`)
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  return spawned
}

/** 等待 apps/ai 端口真正不可达（停机证据断言用）。 */
export async function waitRefused(port: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${String(port)}/ai-runtime/health`, { signal: AbortSignal.timeout(500) })
    } catch {
      return true
    }
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, 80))
  }
}
