import type pg from 'pg'
// L0 整合步（未执行前的 dist 相对导入桥接，同 shipping/purchase/quality 块先例）：
// application/persistence/domain 的包名入口（index.ts，共享文件不改动）未导出 aiquery 面，
// 此处引用已构建 dist（构建顺序由 workspace 拓扑保证）。L0 整合后在各包 index 追加导出
// aiquery-repositories/aiquery-service 与 domain './aiquery'，并把导入改包名导入。
import { AiQueryService } from '@cadenza/application'
import { createPgAiQueryRepositories, seedDefaultAiQueryCapabilities as seedDefaultAiQueryCapabilitiesImpl } from '@cadenza/persistence'

/**
 * aiquery 接入层装配（组合根）：
 * - 服务 = AiQueryService（application：确定性查询/权限重验/审计/信封）；
 * - 仓储 = persistence Pg 实现（只读白名单读面 + 0021 三表）+ SessionVerifier 同源 auth 四端口；
 * - AQ-C1 质检部门清单与 execute 超时上限（DS-20）经 env 注入（缺省：空清单 / 15s）。
 */
export interface AiQueryRuntimeOptions {
  qcDeptIds?: string[]
  /** DS-20：单次 execute 服务端耗时上限（ms；缺省 15000，可被 env AIQUERY_EXECUTE_TIMEOUT_MS 覆盖）。 */
  executeTimeoutMs?: number
  now?: () => Date
}

export function resolveAiQueryExecuteTimeoutMs(options?: AiQueryRuntimeOptions): number | undefined {
  if (options?.executeTimeoutMs !== undefined) return options.executeTimeoutMs
  const raw = process.env['AIQUERY_EXECUTE_TIMEOUT_MS']
  if (raw === undefined || raw === '') return undefined
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 ? n : undefined
}

export function buildAiQueryService(pool: pg.Pool, options: AiQueryRuntimeOptions = {}): AiQueryService {
  const repos = createPgAiQueryRepositories(pool)
  return new AiQueryService({
    repos,
    now: options.now ?? (() => new Date()),
    qcDeptIds: options.qcDeptIds,
    executeTimeoutMs: resolveAiQueryExecuteTimeoutMs(options),
  })
}

/**
 * 部署初始化 seed（AQ-REG-03：首版三能力注册行由部署初始化写入）：
 * 以 domain 冻结的三能力定义写入 0021 注册表（幂等，不覆盖管理动作启停）。
 * 实现收编于 @cadenza/persistence seed.ts（2026-10-29：dev 种子 db:seed 同源调用）。
 */
export const seedDefaultAiQueryCapabilities = seedDefaultAiQueryCapabilitiesImpl
