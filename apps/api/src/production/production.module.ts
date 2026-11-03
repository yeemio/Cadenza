import { Module } from '@nestjs/common'
import type pg from 'pg'
import type { CommandBus, ProductionQueryService } from '@cadenza/application'
import { DbModule, PG_POOL } from '../db/db.module'
import { ProductionController } from './production.controller'
import { buildProductionCommandBus, buildProductionQueryService } from './production.composition'
import { PRODUCTION_COMMAND_BUS, PRODUCTION_QUERY_SERVICE } from './production.tokens'

@Module({
  imports: [DbModule],
  controllers: [ProductionController],
  providers: [
    {
      provide: PRODUCTION_COMMAND_BUS,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): CommandBus => buildProductionCommandBus(pool),
    },
    {
      provide: PRODUCTION_QUERY_SERVICE,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): ProductionQueryService => buildProductionQueryService(pool),
    },
  ],
})
export class ProductionModule {}
