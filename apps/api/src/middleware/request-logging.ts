import type { NextFunction, Request, Response } from 'express'

/**
 * 请求日志与 request_id：
 * - 优先透传上游 x-request-id，否则生成 UUID；
 * - 响应头回写 x-request-id；
 * - finish 时输出一行 method path status duration。
 */
export function requestLoggingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers['x-request-id']
  const requestId =
    typeof incoming === 'string' && incoming.length > 0 ? incoming : crypto.randomUUID()
  res.setHeader('x-request-id', requestId)
  const startAt = Date.now()
  res.on('finish', () => {
    console.log(
      `[api] request_id=${requestId} ${req.method} ${req.originalUrl} ${String(res.statusCode)} ${String(Date.now() - startAt)}ms`,
    )
  })
  next()
}
