/**
 * IM 渠道回调通道鉴权（L0 整合轮 2026-10-29，挂载层中间件——P4-C 交付记录 §2-7/§6-1
 * 登记的「挂载时必须补通道鉴权」动作；真实企微/飞书接入前由本令牌承载，网关白名单可再叠加）。
 *
 * 策略：env IM_CALLBACK_TOKEN 未配置 → 一律 403（未配置=未开通通道，安全缺省，不暴露公网）；
 * 配置后要求 Authorization: Bearer 同值（sha256 定长后 timingSafeEqual，先例 apps/ai http-server）。
 * 仅在真实挂载组合（app.module）注册本中间件；测试自组装路径（Test.createTestingModule
 * 直挂 ImModule）不受影响，C 线交付测试行为不变。
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'

export function imCallbackTokenGuard(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env['IM_CALLBACK_TOKEN']
  if (expected === undefined || expected.length === 0) {
    res.status(403).json({
      code: 'ERR_IM_CALLBACK_NOT_CONFIGURED',
      message: 'IM 渠道回调通道令牌未配置，回调未开通（挂载安全缺省，配置 env IM_CALLBACK_TOKEN 后开放）',
      details: {},
    })
    return
  }
  const authorization = req.headers['authorization']
  const received =
    typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : ''
  const left = createHash('sha256').update(received).digest()
  const right = createHash('sha256').update(expected).digest()
  if (!timingSafeEqual(left, right)) {
    res.status(401).json({ code: 'ERR_IM_CALLBACK_UNAUTHORIZED', message: '缺少或错误的渠道回调通道令牌', details: {} })
    return
  }
  next()
}
