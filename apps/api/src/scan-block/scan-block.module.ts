import { Module } from '@nestjs/common'
import type pg from 'pg'
import type { CommandBus, ScanBlockQueryService } from '@cadenza/application'
import { DbModule, PG_POOL } from '../db/db.module'
import { ScanBlockController } from './scan-block.controller'
import { buildScanBlockCommandBus, buildScanBlockQueryService } from './scan-block.composition'
import { SCAN_BLOCK_COMMAND_BUS, SCAN_BLOCK_QUERY_SERVICE } from './scan-block.tokens'

@Module({
  imports: [DbModule],
  controllers: [ScanBlockController],
  providers: [
    {
      provide: SCAN_BLOCK_COMMAND_BUS,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): CommandBus => buildScanBlockCommandBus(pool),
    },
    {
      provide: SCAN_BLOCK_QUERY_SERVICE,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): ScanBlockQueryService => buildScanBlockQueryService(pool),
    },
  ],
})
export class ScanBlockModule {}
