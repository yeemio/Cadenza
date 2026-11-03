import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { DbModule } from '../db/db.module'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'
import { AuthGuard } from './auth.guard'
import { ScopeGuard } from './scope.guard'

/**
 * 认证模块：全局 AuthGuard + ScopeGuard（注册顺序即执行顺序：先会话后范围）。
 */
@Module({
  imports: [DbModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: ScopeGuard },
  ],
  exports: [AuthService],
})
export class AuthModule {}
