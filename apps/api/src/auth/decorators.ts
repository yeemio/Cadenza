import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common'
import type { VerifiedAuthContext } from '@cadenza/application'

/** 路由元数据键 */
export const IS_PUBLIC_KEY = 'cadenza:isPublic'
export const PERMISSIONS_KEY = 'cadenza:requiredPermissions'
export const PLANT_PARAM_KEY = 'cadenza:plantParam'

/** 公开路由（/health、/auth/login、/demo 等）：跳过会话校验。 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true)

/**
 * 岗位操作许可（OA-23 第一元）：六类入口同一检查（OA-24）。
 * 多个许可为“任一满足”。
 */
export const RequirePermission = (...permissions: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSIONS_KEY, permissions)

/**
 * 显式工厂参数名：ScopeGuard 校验该参数值是否在授权数据范围内（越范围 403 ERR_FORBIDDEN_SCOPE，OA-24/25）。
 */
export const PlantParam = (paramName: string): MethodDecorator & ClassDecorator =>
  SetMetadata(PLANT_PARAM_KEY, paramName)

export interface AuthContextRequest {
  authContext?: VerifiedAuthContext
}

/** 取当前请求的授权上下文（AuthGuard 注入；@Public 路由上为 undefined）。 */
export const CurrentAuth = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): VerifiedAuthContext | undefined => {
    const request = ctx.switchToHttp().getRequest<AuthContextRequest>()
    return request.authContext
  },
)
