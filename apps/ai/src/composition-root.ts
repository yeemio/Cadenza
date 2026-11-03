/**
 * apps/ai 组合根（dsh-edge.md DS-17）：
 * 装配 ModelClientPort（首版=MockModelClient）、ToolDescriptor→受控查询客户端（§4）、
 * SessionStorePort（本地文件实现，独立数据目录）、RuntimeProfile（env 配置）。
 *
 * mock 场景文件（AI_MOCK_SCENARIO_FILE，JSON 纯数据）可注入模型脚本与查询信封脚本
 * （DS-13/DS-21：mock 响应可脚本化，按测试注入；测试驱动独立进程时使用）。
 * 真实 DSH 模型/真实内部 HTTP 接线 = SITE_PENDING / L0 整合（DS-25、AR-22）。
 */
import { readFileSync } from 'node:fs'
import {
  DEFAULT_RUNTIME_PROFILE,
  MockModelClient,
  withProfileOverrides,
} from '../../../packages/integrations/dsh'
import type { ModelClientPort, RuntimeProfile } from '../../../packages/integrations/dsh'
import type { MockModelStep } from '../../../packages/integrations/dsh'
import { loadConfig } from './config'
import type { AiRuntimeConfig } from './config'
import {
  HttpControlledQueryClient,
  MockControlledQueryClient,
} from './controlled-query-client'
import type { CapabilitiesResponse, ControlledQueryClient, MockQueryScriptEntry } from './controlled-query-client'
import { TurnOrchestrator } from './orchestrator'
import { TenantLimitsService } from './limits'
import { FileSessionStore } from './session-store-fs'
import { HttpSessionEventSink, NoopSessionEventSink, type SessionEventSink } from './session-event-sink'
import { TurnRegistry } from './turn-registry'

/** mock 场景文件形状（全部纯数据，JSON 可序列化）。 */
export interface MockScenarioFile {
  modelSteps?: MockModelStep[]
  queryScript?: MockQueryScriptEntry[]
  capabilities?: CapabilitiesResponse
}

export interface AiRuntime {
  config: AiRuntimeConfig
  profile: RuntimeProfile
  model: ModelClientPort
  queryClient: ControlledQueryClient
  store: FileSessionStore
  registry: TurnRegistry
  limits: TenantLimitsService
  orchestrator: TurnOrchestrator
}

export interface CreateAiRuntimeOptions {
  /** 缺省按进程 env 装载（AI_* 变量；AR-07 fail-fast 检测 DATABASE_URL）。 */
  env?: NodeJS.ProcessEnv
  /** 测试直注入：模型/查询客户端/档案/数据目录/时间基准/事件转发 sink。 */
  profile?: RuntimeProfile
  model?: ModelClientPort
  queryClient?: ControlledQueryClient
  dataDir?: string
  now?: () => Date
  /** 接缝 4 事件转发 sink 直注入（缺省按 config.sessionEventSinkUrl 装配）。 */
  eventSink?: SessionEventSink
}

function readScenario(path: string): MockScenarioFile {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as MockScenarioFile
  return raw
}

export function createAiRuntime(options: CreateAiRuntimeOptions = {}): AiRuntime {
  const config = loadConfig(options.env ?? process.env)
  const profile = options.profile ?? withProfileOverrides(config.profile, {})
  const effectiveConfig: AiRuntimeConfig = { ...config, dataDir: options.dataDir ?? config.dataDir }

  let model: ModelClientPort
  let queryClient: ControlledQueryClient
  const scenario =
    options.model === undefined || options.queryClient === undefined
      ? effectiveConfig.mockScenarioFile !== null
        ? readScenario(effectiveConfig.mockScenarioFile)
        : ({} as MockScenarioFile)
      : ({} as MockScenarioFile)

  if (options.model !== undefined) {
    model = options.model
  } else {
    model = new MockModelClient({ steps: scenario.modelSteps ?? [] })
  }

  if (options.queryClient !== undefined) {
    queryClient = options.queryClient
  } else if (effectiveConfig.controlledQueryMode === 'http') {
    // L0 整合（AR-22）后接通真实内部接口；认证=部署内部服务令牌（不构成权限来源，§4）
    queryClient = new HttpControlledQueryClient(
      effectiveConfig.controlledQueryBaseUrl,
      effectiveConfig.internalQueryToken,
      profile.retry,
    )
  } else {
    queryClient = new MockControlledQueryClient(scenario.queryScript ?? [], {
      capabilities: scenario.capabilities?.capabilities ?? [],
      unreadyTopics: scenario.capabilities?.unreadyTopics ?? [],
    })
  }

  // 接缝 4：会话事件转发 sink（config 装配：URL 未配置=本地承载；测试可直注入）
  const eventSink =
    options.eventSink ??
    (effectiveConfig.sessionEventSinkUrl !== null
      ? new HttpSessionEventSink(effectiveConfig.sessionEventSinkUrl, effectiveConfig.internalQueryToken)
      : new NoopSessionEventSink())
  const store = new FileSessionStore(effectiveConfig.dataDir, eventSink)
  const registry = new TurnRegistry()
  const limits = new TenantLimitsService(profile)
  const orchestrator = new TurnOrchestrator({
    model,
    queryClient,
    store,
    limits,
    registry,
    profile,
    now: options.now,
  })
  return { config: effectiveConfig, profile, model, queryClient, store, registry, limits, orchestrator }
}

export { DEFAULT_RUNTIME_PROFILE }
