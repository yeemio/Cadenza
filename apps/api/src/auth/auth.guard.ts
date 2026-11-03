import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { ERROR_CODES } from '@cadenza/contracts'
import type { VerifiedAuthContext } from '@cadenza/application'
import { IS_PUBLIC_KEY, type AuthContextRequest } from './decorators'
import { AuthService } from './auth.service'

/**
 * 全局会话守卫（SA §8）：
 * - 无有效 Bearer 会话 → 401 ERR_AUTH_REQUIRED；
 * - 会话过期/撤销、用户禁用/注销同样 401；
 * - 通过后把服务端计算的授权上下文（用户/许可/数据范围，OA-23/25）挂到请求。
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic =
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    if (isPublic) return true

    const request = context.switchToHttp().getRequest<AuthContextRequest & { headers: Record<string, unknown> }>()
    const header = request.headers['authorization']
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException({
        code: ERROR_CODES.AUTH_REQUIRED,
        message: '未提供会话凭据（Authorization: Bearer <token>）',
        details: {},
      })
    }
    const token = header.slice('Bearer '.length).trim()
    const verified: VerifiedAuthContext | null = await this.auth.verifyToken(token)
    if (verified === null) {
      throw new UnauthorizedException({
        code: ERROR_CODES.AUTH_REQUIRED,
        message: '会话无效或已过期',
        details: {},
      })
    }
    request.authContext = verified
    return true
  }
}
