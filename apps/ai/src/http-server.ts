/**
 * apps/ai 公开运行接口 HTTP 面（dsh-edge.md DS-03/DS-23）。
 *
 * 仅两组 HTTP 面：
 *  - 公开运行接口（/ai-runtime/sessions|turns|turns/:id/cancel）：仅接受接入层转发，
 *    内部服务凭据认证（Bearer AI_RUNTIME_INTERNAL_TOKEN；凭据不构成权限来源）；
 *  - 健康接口（GET /ai-runtime/health）：无鉴权，探测与 UI「暂不可用」判定源（AR-11），
 *    返回 runtime 声明（DS-14）。
 * 不暴露通用终端/任意文件访问/自由网络访问/动态插件安装（DS-03）。
 * 无生产数据库依赖：本文件不 import 任何 pg/SQL 面（AR-R2）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import { DSH_RUNTIME_DECLARATION } from '../../../packages/integrations/dsh'
import type { SessionChannel } from '../../../packages/integrations/dsh'
import type { TurnResponse } from './orchestrator'
import type { TurnOrchestrator } from './orchestrator'
import type { TurnRegistry } from './turn-registry'
import type { FileSessionStore } from './session-store-fs'
import { isValidSessionId } from './session-store-fs'

const MAX_BODY_BYTES = 1_024 * 1_024
const CHANNELS: readonly SessionChannel[] = ['web', 'pda', 'wecom', 'feishu', 'mock']
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export interface HttpServerDeps {
  orchestrator: TurnOrchestrator
  store: FileSessionStore
  registry: TurnRegistry
  internalToken: string
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(payload)
}

function tokenEquals(received: string | undefined, expected: string): boolean {
  if (received === undefined) return false
  const left = createHash('sha256').update(received).digest()
  const right = createHash('sha256').update(expected).digest()
  return timingSafeEqual(left, right)
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body-too-large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          reject(new Error('body-not-object'))
          return
        }
        resolve(parsed as Record<string, unknown>)
      } catch {
        reject(new Error('body-invalid-json'))
      }
    })
    req.on('error', () => reject(new Error('body-read-error')))
  })
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`missing-field:${field}`)
  }
  return value
}

export function createHttpServer(deps: HttpServerDeps): Server {
  return createServer((req, res) => {
    void handle(deps, req, res)
  })
}

async function handle(deps: HttpServerDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const pathname = url.pathname
  const method = req.method ?? 'GET'

  try {
    // 健康接口：无鉴权探测（AR-11 降级判定源；含 runtime 声明 DS-14）
    if (method === 'GET' && pathname === '/ai-runtime/health') {
      sendJson(res, 200, { status: 'ok', runtime: DSH_RUNTIME_DECLARATION })
      return
    }

    // 其余端点一律内部服务令牌认证（DS-03：仅接受接入层转发）
    const authorization = req.headers['authorization']
    const bearer = authorization !== undefined && authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : undefined
    if (!tokenEquals(bearer, deps.internalToken)) {
      sendJson(res, 401, { code: 'ERR_AI_RUNTIME_UNAUTHORIZED', message: '缺少或错误的内部服务令牌' })
      return
    }

    if (method === 'POST' && pathname === '/ai-runtime/sessions') {
      await handleRegisterSession(deps, req, res)
      return
    }
    if (method === 'POST' && pathname === '/ai-runtime/turns') {
      await handleTurn(deps, req, res)
      return
    }
    const cancelMatch = /^\/ai-runtime\/turns\/([A-Za-z0-9_-]+)\/cancel$/.exec(pathname)
    if (method === 'POST' && cancelMatch !== null) {
      const decision = deps.registry.requestCancel(cancelMatch[1] as string)
      sendJson(res, 200, { status: 'cancelled', decision })
      return
    }
    sendJson(res, 404, { code: 'ERR_NOT_FOUND', message: `无此路由：${method} ${pathname}` })
  } catch (error) {
    sendJson(res, 500, {
      code: 'ERR_AI_RUNTIME_INTERNAL',
      message: error instanceof Error ? error.message : '内部错误',
    })
  }
}

async function handleRegisterSession(deps: HttpServerDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req).catch((error: Error) => {
    sendJson(res, 400, { code: 'ERR_BAD_REQUEST', message: error.message })
    return null
  })
  if (body === null) return
  try {
    const sessionId = requireString(body, 'sessionId')
    const enterpriseId = requireString(body, 'enterpriseId')
    const userId = requireString(body, 'userId')
    const channel = requireString(body, 'channel')
    if (!isValidSessionId(sessionId)) {
      sendJson(res, 400, { code: 'ERR_BAD_REQUEST', message: 'sessionId 格式非法' })
      return
    }
    if (!(CHANNELS as readonly string[]).includes(channel)) {
      sendJson(res, 400, { code: 'ERR_BAD_REQUEST', message: `channel 非法：${channel}` })
      return
    }
    const record = await deps.store.registerSession({
      sessionId,
      enterpriseId,
      userId,
      channel: channel as SessionChannel,
      conversationRef: typeof body['conversationRef'] === 'string' ? body['conversationRef'] : null,
    })
    sendJson(res, 201, { sessionId: record.sessionId, status: record.status })
  } catch (error) {
    sendJson(res, 400, { code: 'ERR_BAD_REQUEST', message: error instanceof Error ? error.message : '参数非法' })
  }
}

async function handleTurn(deps: HttpServerDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req).catch((error: Error) => {
    sendJson(res, 400, { code: 'ERR_BAD_REQUEST', message: error.message })
    return null
  })
  if (body === null) return
  try {
    const requestId = requireString(body, 'requestId')
    const sessionId = requireString(body, 'sessionId')
    const userMessage = requireString(body, 'userMessage')
    if (!REQUEST_ID_PATTERN.test(requestId) || !isValidSessionId(sessionId)) {
      sendJson(res, 400, { code: 'ERR_BAD_REQUEST', message: 'requestId/sessionId 格式非法' })
      return
    }
    const timeBasis =
      typeof body['timeBasis'] === 'object' && body['timeBasis'] !== null && (body['timeBasis'] as { timeZone?: unknown }).timeZone === 'Asia/Shanghai'
        ? { timeZone: 'Asia/Shanghai' as const }
        : undefined
    const response: TurnResponse = await deps.orchestrator.runTurn({
      requestId,
      sessionId,
      userMessage,
      timeBasis,
    })
    sendJson(res, 200, response)
  } catch (error) {
    sendJson(res, 400, { code: 'ERR_BAD_REQUEST', message: error instanceof Error ? error.message : '参数非法' })
  }
}
