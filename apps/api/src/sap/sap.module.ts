import { Module } from '@nestjs/common'
import type pg from 'pg'
import type { CommandBus, SapReconDerivationQueryService, SapReconQueryService } from '@cadenza/application'
import { DbModule, PG_POOL } from '../db/db.module'
import { SapController } from './sap.controller'
import {
  buildSapReconCommandBus,
  buildSapReconDerivationService,
  buildSapReconQueryService,
} from './sap.composition'
import { SAP_RECON_COMMAND_BUS, SAP_RECON_DERIVATION_SERVICE, SAP_RECON_QUERY_SERVICE } from './sap.tokens'

@Module({
  imports: [DbModule],
  controllers: [SapController],
  providers: [
    {
      provide: SAP_RECON_COMMAND_BUS,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): CommandBus => buildSapReconCommandBus(pool),
    },
    {
      provide: SAP_RECON_QUERY_SERVICE,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): SapReconQueryService => buildSapReconQueryService(pool),
    },
    {
      provide: SAP_RECON_DERIVATION_SERVICE,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): SapReconDerivationQueryService => buildSapReconDerivationService(pool),
    },
  ],
})
export class SapModule {}
