import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { ERROR_CODES } from '@cadenza/contracts'
import { PERMISSIONS_KEY, PLANT_PARAM_KEY, type AuthContextRequest } from './decorators'

/**
 * 全局范围守卫（OA-23/24/25/26）：
 * - 岗位许可检查（路由声明的许可任一不满足 → 403 ERR_FORBIDDEN_SCOPE）；
 * - 显式工厂参数越范围 → 403（列表隐式过滤由查询服务按数据范围执行，口径一致 OA-25）；
 * - 按钮显隐等体验层不参与判定（OA-24）。
 */
@Injectable()
export class ScopeGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    const plantParam = this.reflector.getAllAndOverride<string>(PLANT_PARAM_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if ((required === undefined || required.length === 0) && plantParam === undefined) return true

    const request = context.switchToHttp().getRequest<
      AuthContextRequest & {
        query: Record<string, unknown>
        body?: unknown
      }
    >()
    const auth = request.authContext
    if (auth === undefined) return true // 无会话场景由 AuthGuard 兜底（@Public 路由通常无许可要求）

    if (required !== undefined && required.length > 0) {
      const held = new Set(auth.permissions)
      const satisfied = required.some((permission) => held.has(permission))
      if (!satisfied) {
        throw new ForbiddenException({
          code: ERROR_CODES.FORBIDDEN_SCOPE,
          message: `缺少操作许可：${required.join(' 或 ')}`,
          details: { required },
        })
      }
    }

    if (plantParam !== undefined) {
      const raw =
        request.query?.[plantParam] ??
        (typeof request.body === 'object' && request.body !== null
          ? (request.body as Record<string, unknown>)[plantParam]
          : undefined)
      if (typeof raw === 'string' && raw.length > 0) {
        const inScope = auth.dataScope.enterpriseWide || auth.dataScope.plantIds.includes(raw)
        if (!inScope) {
          throw new ForbiddenException({
            code: ERROR_CODES.FORBIDDEN_SCOPE,
            message: '目标工厂不在授权数据范围内',
            details: { plantId: raw },
          })
        }
      }
    }
    return true
  }
}
