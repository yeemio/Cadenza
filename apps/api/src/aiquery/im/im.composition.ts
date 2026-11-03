/**
 * im 接入子模块挂载组合根（L0 整合轮 2026-10-29 挂载；2026-10-30 P4 五内部接缝补齐轮
 * 升级为 DB 承载形态）。
 *
 * [L0-整合标记] 边缘包引用方式：`packages/integrations/im` 非 pnpm workspace 成员
 * （pnpm-workspace.yaml 只匹配 packages/* 一级目录，共享文件不改动），包名
 * `@cadenza/im` 不入 node_modules——此处经 dist 相对导入桥接（先例：aiquery.composition.ts
 * 整合前的 domain/application dist 桥）。运行时结构兼容由 im.ports.ts 结构化类型镜像
 * + typecheck 强制。后续 workspace 升格（P4 汇总 §2-8 可选项）时改为包名导入并删除本标记。
 *
 * 挂载组合（2026-10-30 起）：mock 双向通道 + 企微/飞书 SITE_PENDING 桩适配器 + 包内存储
 * （IM-05/GAP-P8）+ **五接缝真实承载**（im.real-seams.ts：ai_session 落库〔接缝1〕、
 * ai_query_audit 回写〔接缝2〕、SessionVerifier 同口径发送前重验〔接缝3〕、DS-23 转发
 * apps/ai〔接缝4〕、0030 一次性绑定码〔接缝5〕）；dev 预置绑定码（IM_MOCK_BINDING_CODES，
 * 兼容承载）注入真实核销器作回退。真实企微/飞书验签/凭据与真实模型仍为 SITE_PENDING
 * （IM-16/DS-25，GAP-P2/P1/P3）。
 */
import type pg from 'pg'
import { buildAiQueryService } from '../aiquery.composition'
import { AiRuntimeClient } from '../aiquery.runtime-client'
import { ImModule } from './im.module'
import { buildImRealSeams, parsePresetBindingCodes } from './im.real-seams'
import {
  FeishuImChannelAdapter,
  InMemoryImChannelEventCounters,
  InMemoryImIdentityBindingStore,
  InMemoryImProcessingRecordStore,
  MockChannelSender,
  MockImChannelAdapter,
  WecomImChannelAdapter,
} from '../../../../../packages/integrations/im/dist/index.js'

/** 挂载用 im 模块（app.module imports 直接引用；五接缝 DB 承载）。 */
export function buildImModule(): ReturnType<typeof ImModule.registerDbBacked> {
  return ImModule.registerDbBacked({
    adapters: [new MockImChannelAdapter(), new WecomImChannelAdapter(), new FeishuImChannelAdapter()],
    sender: new MockChannelSender(),
    bindings: new InMemoryImIdentityBindingStore(),
    records: new InMemoryImProcessingRecordStore(),
    counters: new InMemoryImChannelEventCounters(),
    seamsFromPool: (pool: pg.Pool) => {
      const service = buildAiQueryService(pool)
      return buildImRealSeams({
        service,
        runtime: new AiRuntimeClient(),
        // dev 预置绑定码回退（IM_MOCK_BINDING_CODES；值为 UUID 或 login_name）——
        // 网页端签发（接缝 5）为主路径，预置码仅演示兼容，不落 DB
        presets: parsePresetBindingCodes(process.env['IM_MOCK_BINDING_CODES']),
      })
    },
  })
}
