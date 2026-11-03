import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common'
import { DbHealthService } from '../db/db.module'
import { Public } from '../auth/decorators'

/**
 * GET /health —— 存活与数据库探活。
 * db ok → 200 { status:'ok', db:'ok', checkedAt }；db 不可用 → 503（全局过滤器统一错误形状）。
 */
@Public()
@Controller('health')
export class HealthController {
  constructor(@Inject(DbHealthService) private readonly dbHealth: DbHealthService) {}

  @Get()
  async health(): Promise<{ status: 'ok'; db: 'ok'; checkedAt: string }> {
    const db = await this.dbHealth.ping()
    if (db !== 'ok') {
      throw new ServiceUnavailableException({
        code: 'ERR_DB_UNAVAILABLE',
        message: '数据库不可用',
        details: { db },
      })
    }
    return { status: 'ok', db: 'ok', checkedAt: new Date().toISOString() }
  }
}
