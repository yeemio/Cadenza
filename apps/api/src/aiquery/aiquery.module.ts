import { Module } from '@nestjs/common'
import type pg from 'pg'
import { DbModule, PG_POOL } from '../db/db.module'
import { AiQueryController } from './aiquery.controller'
import { AiQueryTurnsController } from './aiquery.turns.controller'
import { AiImBindingCodeController } from './aiquery.binding-codes.controller'
import { AiRuntimeEventController } from './aiquery.runtime-events.controller'
import { buildAiQueryService } from './aiquery.composition'
import { AiRuntimeClient } from './aiquery.runtime-client'
import { AiTurnContext } from './aiquery.turn-context'
import { AIQUERY_INTERNAL_TOKEN, AIQUERY_RUNTIME_CLIENT, AIQUERY_SERVICE, AIQUERY_TURN_CONTEXT } from './aiquery.tokens'
import type { AiQueryService } from '@cadenza/application'

/**
 * aiquery 模块（P4-A 受控问数查询层接入；2026-10-28 L0 起挂载 app.module.ts）。
 *
 * - 内部服务令牌 env AIQUERY_INTERNAL_TOKEN（未配置时内部端点一律 401——安全缺省）；
 * - apps/ai 运行服务转发 env AI_RUNTIME_URL（缺省 http://127.0.0.1:4300）+
 *   AI_RUNTIME_INTERNAL_TOKEN + AI_RUNTIME_TURN_TIMEOUT_MS（缺省 25s，AR-12）；
 * - 2026-10-30 五内部接缝补齐轮：绑定码签发（接缝 5 用户面）与 apps/ai 运行事件留档
 *   （接缝 4 内部面）控制器挂载本模块。
 */
@Module({
  imports: [DbModule],
  controllers: [AiQueryController, AiQueryTurnsController, AiImBindingCodeController, AiRuntimeEventController],
  providers: [
    {
      provide: AIQUERY_INTERNAL_TOKEN,
      useFactory: (): string => process.env['AIQUERY_INTERNAL_TOKEN'] ?? '',
    },
    {
      provide: AIQUERY_TURN_CONTEXT,
      useFactory: (): AiTurnContext => new AiTurnContext(),
    },
    {
      provide: AIQUERY_RUNTIME_CLIENT,
      useFactory: (): AiRuntimeClient => new AiRuntimeClient(),
    },
    {
      provide: AIQUERY_SERVICE,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): AiQueryService => buildAiQueryService(pool),
    },
  ],
})
export class AiQueryModule {}
