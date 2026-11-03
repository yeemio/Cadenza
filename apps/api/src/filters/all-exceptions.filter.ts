import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common'
import type { Response } from 'express'
import { ERROR_CODES } from '@cadenza/contracts'

/** HTTP 状态码 → 平台错误码（未映射的回落 ERR_BUSINESS_RULE / ERR_INTERNAL）。 */
const STATUS_TO_CODE: Record<number, string> = {
  [HttpStatus.UNAUTHORIZED]: ERROR_CODES.AUTH_REQUIRED,
  [HttpStatus.FORBIDDEN]: ERROR_CODES.FORBIDDEN_SCOPE,
  [HttpStatus.NOT_FOUND]: ERROR_CODES.NOT_FOUND,
  [HttpStatus.CONFLICT]: ERROR_CODES.VERSION_CONFLICT,
  [HttpStatus.PRECONDITION_FAILED]: ERROR_CODES.VERSION_CONFLICT,
  [HttpStatus.UNPROCESSABLE_ENTITY]: ERROR_CODES.BUSINESS_RULE,
}

interface ErrorBody {
  code: string
  message: string
  details: unknown
}

/**
 * 全局异常过滤器：一切错误响应统一形状 { code, message, details }。
 * - 业务侧抛 HttpException 时若 response 已是 {code,message,details} 原样透出；
 * - 否则按状态码映射平台错误码组装；
 * - 未知异常 → 500 ERR_INTERNAL，不泄露内部堆栈。
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp()
    const response = ctx.getResponse<Response>()

    if (exception instanceof HttpException) {
      const status = exception.getStatus()
      const body = exception.getResponse()
      const payload: ErrorBody =
        typeof body === 'object' &&
        body !== null &&
        'code' in body &&
        'message' in body &&
        'details' in body
          ? (body as ErrorBody)
          : {
              code: STATUS_TO_CODE[status] ?? ERROR_CODES.BUSINESS_RULE,
              message:
                typeof body === 'string'
                  ? body
                  : exception.message || `HTTP ${String(status)}`,
              details: {},
            }
      response.status(status).json(payload)
      return
    }

    console.error('[api] 未处理异常', exception)
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      code: 'ERR_INTERNAL',
      message: '服务器内部错误',
      details: {},
    } satisfies ErrorBody)
  }
}
