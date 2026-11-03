/**
 * im 接入子模块（AR-02 原不挂载形态；L0 整合轮 2026-10-29 起随挂载组合根挂载 app.module.ts）。
 *
 * register(options) 组合根：边缘包实现（适配器/发送端口/绑定存储/处理记录/计数器——
 * @cadenza/im，经端口注入，apps/api 不直接 import 该包，见 im.ports.ts [L0-整合标记]）
 * + A/B 线接缝（缺省=im.mock-seams.ts 承载，可由 options.seams 覆盖）。
 * registerDbBacked(options)（2026-10-30）：挂载形态——五接缝经 PG 池以 im.real-seams.ts
 * 真实实现覆盖（P4 五内部接缝补齐）。
 */
import { DynamicModule, Module } from '@nestjs/common'
import type pg from 'pg'
import { DbModule, PG_POOL } from '../../db/db.module'
import { ImController } from './im.controller'
import { ImChannelEventService } from './im.channel-event.service'
import {
  MockAiAuditSendResultPort,
  MockAiQuerySessionPort,
  MockAiQueryTurnPort,
  MockBindingCodeVerifier,
  MockImAccessRecheckPort,
} from './im.mock-seams'
import type {
  AiAuditSendResultPort,
  AiQuerySessionPort,
  AiQueryTurnPort,
  ImAccessRecheckPort,
  ImBindingVerificationPort,
  ImChannelAdapterPort,
  ImChannelEventCountersPort,
  ImIdentityBindingPort,
  ImProcessingRecordStorePort,
  ImSendPort,
} from './im.ports'
import {
  AI_AUDIT_SEND_RESULT_PORT,
  AI_QUERY_SESSION_PORT,
  AI_QUERY_TURN_PORT,
  IM_ACCESS_RECHECK_PORT,
  IM_BINDING_VERIFICATION_PORT,
  IM_CHANNEL_ADAPTERS,
  IM_CHANNEL_EVENT_COUNTERS,
  IM_IDENTITY_BINDING_PORT,
  IM_PROCESSING_RECORD_STORE,
  IM_SEND_PORT,
} from './im.tokens'

export interface ImSeamOptions {
  /** A 线 ai_session 登记流（缺省 MockAiQuerySessionPort）。 */
  session?: AiQuerySessionPort
  /** 接入层问数轮→apps/ai 转发（缺省 MockAiQueryTurnPort）。 */
  turn?: AiQueryTurnPort
  /** A 线 ai_query_audit 发送结果回写（缺省 MockAiAuditSendResultPort）。 */
  audit?: AiAuditSendResultPort
  /** IM-08 发送前权限再检（缺省 MockImAccessRecheckPort）。 */
  recheck?: ImAccessRecheckPort
  /** IM-03 绑定码验证（缺省 MockBindingCodeVerifier）。 */
  verification?: ImBindingVerificationPort
}

export interface ImModuleOptions {
  /** 渠道适配器（至少 mock；企微/飞书为 SITE_PENDING 桩适配器）。 */
  adapters: ImChannelAdapterPort[]
  /** 出站发送端口（首版 mock 捕获型）。 */
  sender: ImSendPort
  /** 身份绑定端口（首版包内存储）。 */
  bindings: ImIdentityBindingPort
  /** 渠道事件处理记录存储（首版包内存储）。 */
  records: ImProcessingRecordStorePort
  /** 渠道事件可观测计数器。 */
  counters: ImChannelEventCountersPort
  /** A/B 线接缝覆盖（缺省全部为首版 mock 承载）。 */
  seams?: ImSeamOptions
}

@Module({})
export class ImModule {
  static register(options: ImModuleOptions): DynamicModule {
    const seams = {
      session: options.seams?.session ?? new MockAiQuerySessionPort(),
      turn: options.seams?.turn ?? new MockAiQueryTurnPort(),
      audit: options.seams?.audit ?? new MockAiAuditSendResultPort(),
      recheck: options.seams?.recheck ?? new MockImAccessRecheckPort(),
      verification: options.seams?.verification ?? new MockBindingCodeVerifier(),
    }
    return {
      module: ImModule,
      controllers: [ImController],
      providers: [
        { provide: IM_CHANNEL_ADAPTERS, useValue: options.adapters },
        { provide: IM_SEND_PORT, useValue: options.sender },
        { provide: IM_IDENTITY_BINDING_PORT, useValue: options.bindings },
        { provide: IM_PROCESSING_RECORD_STORE, useValue: options.records },
        { provide: IM_CHANNEL_EVENT_COUNTERS, useValue: options.counters },
        { provide: AI_QUERY_SESSION_PORT, useValue: seams.session },
        { provide: AI_QUERY_TURN_PORT, useValue: seams.turn },
        { provide: AI_AUDIT_SEND_RESULT_PORT, useValue: seams.audit },
        { provide: IM_ACCESS_RECHECK_PORT, useValue: seams.recheck },
        { provide: IM_BINDING_VERIFICATION_PORT, useValue: seams.verification },
        ImChannelEventService,
      ],
      exports: [
        IM_CHANNEL_ADAPTERS,
        IM_SEND_PORT,
        IM_IDENTITY_BINDING_PORT,
        IM_PROCESSING_RECORD_STORE,
        IM_CHANNEL_EVENT_COUNTERS,
        AI_QUERY_SESSION_PORT,
        AI_QUERY_TURN_PORT,
        AI_AUDIT_SEND_RESULT_PORT,
        IM_ACCESS_RECHECK_PORT,
        IM_BINDING_VERIFICATION_PORT,
      ],
    }
  }

  /**
   * DB 承载挂载形态（P4 五内部接缝补齐轮 2026-10-30）：渠道基础设施（适配器/发送端口/
   * 绑定存储/处理记录/计数器）沿用 options；五接缝经 seamsFromPool 以真实实现覆盖
   * （im.real-seams.ts——ai_session 落库/审计回写/SessionVerifier 重验/DS-23 转发/
   * 0030 一次性绑定码）。同 token 后注册者胜出（Nest providers 归一化语义）；
   * ImModule.register（mock 承载缺省）测试自组装路径行为不变。
   */
  static registerDbBacked(
    options: Omit<ImModuleOptions, 'seams'> & { seamsFromPool: (pool: pg.Pool) => ImSeamOptions },
  ): DynamicModule {
    const base = ImModule.register(options)
    let cached: ImSeamOptions | null = null
    const resolve = (pool: pg.Pool): ImSeamOptions => {
      if (cached === null) cached = options.seamsFromPool(pool)
      return cached
    }
    return {
      ...base,
      imports: [...(base.imports ?? []), DbModule],
      providers: [
        ...(base.providers ?? []),
        { provide: AI_QUERY_SESSION_PORT, inject: [PG_POOL], useFactory: (pool: pg.Pool) => resolve(pool).session },
        { provide: AI_QUERY_TURN_PORT, inject: [PG_POOL], useFactory: (pool: pg.Pool) => resolve(pool).turn },
        { provide: AI_AUDIT_SEND_RESULT_PORT, inject: [PG_POOL], useFactory: (pool: pg.Pool) => resolve(pool).audit },
        { provide: IM_ACCESS_RECHECK_PORT, inject: [PG_POOL], useFactory: (pool: pg.Pool) => resolve(pool).recheck },
        { provide: IM_BINDING_VERIFICATION_PORT, inject: [PG_POOL], useFactory: (pool: pg.Pool) => resolve(pool).verification },
      ],
    }
  }
}
