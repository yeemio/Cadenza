import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  UnauthorizedException,
} from '@nestjs/common'
import { ERROR_CODES, type AuthMeResponse, type LoginRequest } from '@cadenza/contracts'
import { AuthFlowError } from '@cadenza/application'
import { Public, CurrentAuth } from './decorators'
import { AuthService } from './auth.service'
import type { VerifiedAuthContext } from '@cadenza/application'

/** 认证入口：POST /auth/login、POST /auth/logout、GET /auth/me。 */
@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  /** 登录（公开路由；失败统一 401 ERR_AUTH_REQUIRED，不泄露账号存在性）。 */
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(@Body() body: unknown): Promise<{
    token: string
    tokenType: 'Bearer'
    expiresAt: string
    user: { userId: string; loginName: string }
  }> {
    const b = (body ?? {}) as Partial<LoginRequest>
    if (
      typeof b.loginName !== 'string' ||
      typeof b.password !== 'string' ||
      b.loginName.length === 0 ||
      b.password.length === 0
    ) {
      throw new BadRequestException({
        code: ERROR_CODES.BUSINESS_RULE,
        message: 'payload 需要 loginName/password（字符串）',
        details: {},
      })
    }
    if (b.platform !== undefined && b.platform !== 'WEB' && b.platform !== 'PDA') {
      throw new BadRequestException({
        code: ERROR_CODES.BUSINESS_RULE,
        message: 'platform 须为 WEB/PDA',
        details: {},
      })
    }
    try {
      const result = await this.auth.login({
        loginName: b.loginName,
        password: b.password,
        platform: b.platform,
      })
      return {
        token: result.token,
        tokenType: 'Bearer',
        expiresAt: result.expiresAt,
        user: { userId: result.user.userId, loginName: result.user.loginName },
      }
    } catch (error) {
      if (error instanceof AuthFlowError) {
        throw new UnauthorizedException({
          code: error.code,
          message: error.message,
          details: {},
        })
      }
      throw error
    }
  }

  /** 登出：撤销当前会话。 */
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  async logout(@CurrentAuth() auth: VerifiedAuthContext): Promise<{ ok: true; sessionId: string }> {
    await this.auth.logout(auth)
    return { ok: true, sessionId: auth.session.id }
  }

  /** 当前会话信息：用户 + 岗位许可 + 服务端计算的数据范围（OA-25）。 */
  @Get('me')
  async me(@CurrentAuth() auth: VerifiedAuthContext): Promise<AuthMeResponse> {
    const info = await this.auth.meInfo(auth)
    return {
      user: info.user,
      permissions: info.permissions,
      dataScope: info.dataScope,
      session: info.session,
    }
  }
}
