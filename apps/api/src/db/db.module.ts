import { Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type pg from 'pg'
import { createPool } from '@cadenza/persistence'

/** 共享连接池注入令牌（auth/org 模块的仓储与命令总线共用；应用停机统一释放）。 */
export const PG_POOL = Symbol('PG_POOL')

/** 数据库连接与健康探测。连接串来自 ConfigService（已经 validateEnv 校验/回落）。 */
@Injectable()
export class DbHealthService implements OnApplicationShutdown {
  private readonly pool: pg.Pool

  constructor(@Inject(PG_POOL) pool: pg.Pool) {
    this.pool = pool
  }

  /** SELECT 1 探活：成功 'ok'，失败 'error'（不抛错，由 /health 决定响应码）。 */
  async ping(): Promise<'ok' | 'error'> {
    try {
      await this.pool.query('SELECT 1')
      return 'ok'
    } catch {
      return 'error'
    }
  }

  async onApplicationShutdown(): Promise<void> {
    // 池由 PG_POOL 提供方在应用停机时统一释放（见 onApplicationShutdown 钩子）
  }
}

@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService): pg.Pool => {
        const url = config.get<string>('DATABASE_URL')
        if (typeof url !== 'string' || url.length === 0) {
          throw new Error('DATABASE_URL 缺失：ConfigModule 校验未生效')
        }
        return createPool(url)
      },
    },
    {
      provide: 'PG_POOL_SHUTDOWN',
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool) => ({
        onApplicationShutdown: async (): Promise<void> => {
          await pool.end()
        },
      }),
    },
    DbHealthService,
  ],
  exports: [PG_POOL, DbHealthService],
})
export class DbModule {}
