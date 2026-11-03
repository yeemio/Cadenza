import type { DecimalString } from '@cadenza/contracts'
import { createHash, randomBytes } from 'node:crypto'
import {
  addQty,
  subQty,
  BATCH_INSPECTION_STATUS_LABELS,
  ORDER_LINE_STATUS_LABELS,
  computeAvailability,
  computeDataScope,
  computeFiveQuantities,
  computeOperationReadiness,
  projectOperationScheduling,
  projectOrderSchedulingStatus,
  sumPlannedQty,
  unionPermissions,
} from '@cadenza/domain'
import {
  AIQUERY_PERMISSIONS,
  AI_QUERY_STATUS_LABELS,
  AI_QUERY_UNREADY_TOPICS,
  findUnreadyTopic,
  materialDesc,
  parseIncludePurchaseLines,
  parseOrderRef,
  parseQualityParams,
  computeShortageLine,
  isOperationIncomplete,
  type AiQueryStatus,
} from '@cadenza/domain'
import type {
  AiMaterialShortageResultDto,
  AiOrderProgressResultDto,
  AiQualityBatchRowDto,
  AiQualityInspectionRowDto,
  AiQualityResultDto,
  AiQueryCapabilitiesResponseDto,
  AiQueryCapabilityDto,
  AiQueryCompletenessDto,
  AiQueryContextEchoDto,
  AiQueryEnvelopeDto,
  AiQueryFreshnessDto,
  AiQueryFreshnessSourceDto,
} from '@cadenza/contracts'
import type {
  AiCapabilityRegistryRecord,
  AiImBindingCodeRecord,
  AiOrderRow,
  AiQueryAuditRecord,
  AiQueryRepositories,
  AiRuntimeEventRecord,
  AiSessionRecord,
  NewAiRuntimeEvent,
} from './aiquery-repositories'

/**
 * 受控问数服务（P4-A；capability-contract.md 机制总则 AQ-REG/AQ-AMB/AQ-AUTH + 三能力六段合同）。
 *
 * 职责边界（AR-01）：本服务只做确定性业务查询与口径计算——不调用模型、不产生任何生产
 * 写路径（AR-R1：读面端口 + 0021 审计/注册/会话三表）。每次 execute 按会话绑定的 userId
 * 实时重算授权上下文（AQ-AUTH-01，SessionVerifier 同源：user_account/role/scope_grant/
 * org_node，不信任 ai_session 建立时的快照）；请求体携带的执行上下文同名字段忽略并记审计
 * （AQ-REG-06）。结果一律六段信封（AQ-REG-07）；错误不得伪装成 ok_no_records
 * （DS-20/AQ-REG-10）；零值＝有效查询产物（AQ-REG-08）。
 */

/** 会话不存在/已失效（DS-18：404 ERR_AI_SESSION_NOT_FOUND）。 */
export class AiSessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`AI 会话不存在或已失效：${sessionId}`)
    this.name = 'AiSessionNotFoundError'
  }
}

/** execute 输入（DS-19 请求体声明字段 + 接入层提取的被忽略上下文字段）。 */
export interface AiExecuteInput {
  requestId: string
  toolCallSeq: number
  sessionId: string
  capabilityId: string
  capabilityVersion: number
  params: Record<string, unknown>
  /** 请求体携带的 tenant/user/scope 等执行上下文字段（已忽略并记审计，AQ-REG-06） */
  ignoredRequestFields?: string[]
}

export interface AiQueryServiceDeps {
  repos: AiQueryRepositories
  now(): Date
  /** AQ-C1 就绪/质检工序判定（execution 同源注入；缺省空清单=无质检工序口径）。 */
  qcDeptIds?: string[]
  /** DS-20：单次 execute 服务端耗时上限（ms；缺省 15000）。 */
  executeTimeoutMs?: number
}

/** 请求体/params 中属执行上下文的字段名（一律以服务端绑定为准，AQ-REG-06/AQ-AUTH-04）。 */
const CONTEXT_FIELD_KEYS: readonly string[] = [
  'tenantId',
  'tenant',
  'enterpriseId',
  'userId',
  'user',
  'scope',
  'dataScope',
  'channel',
  'requestId',
  'sessionId',
  'toolCallSeq',
]

/** 审计脱敏白名单（AQ-S2：params 只存过滤参数与对象引用，不存聊天正文）。 */
const AUDIT_FILTER_KEYS: readonly string[] = [
  'orderRef',
  'includePurchaseLines',
  'objectScope',
  'timeRange',
  'conclusions',
  'inspectionStages',
  'orderNoLike',
  'page',
  'plantId',
]

/** 候选清单上限（AQ-AMB-01：多候选呈现选项，超限截断标注）。 */
const CANDIDATE_LIMIT = 20

/** AQ-C2 最大查询范围（§3：单订单 BOM 行 ≤ 500、每料品关联采购行 ≤ 200）。 */
const C2_MAX_BOM_LINES = 500
const C2_MAX_PURCHASE_LINES_PER_MATERIAL = 200

/** 接缝 5：绑定码缺省有效期（秒，10 分钟）与码形（8 位去混淆字母表，XXXX-XXXX）。 */
const IM_BINDING_CODE_TTL_SECONDS = 600
const BINDING_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

function generateBindingCode(): string {
  const bytes = randomBytes(8)
  const chars = Array.from(bytes, (b) => BINDING_CODE_ALPHABET[b % BINDING_CODE_ALPHABET.length] ?? '')
  return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}`
}

/** 用户输入归一（去空白/大写）后取 sha-256 摘要（hex）——明文码不落库。 */
function normalizeBindingCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, '')
}

function bindingCodeHash(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex')
}

interface RecomputedAuth {
  user: { id: string; loginName: string; enterpriseId: string }
  permissions: string[]
  dataScope: { enterpriseWide: boolean; plantIds: string[] }
}

/** runCapability 统一出射（信封六段的数据/完整性与附注组装原料）。 */
interface CapabilityOutcome {
  status: AiQueryStatus
  message: string
  data: AiQueryEnvelopeDto['data']
  completeness: AiQueryCompletenessDto
  freshness: AiQueryFreshnessDto
  effectiveFilters: Record<string, unknown>
  notes: string[]
  rowCount: number
  truncated: boolean
}

/** AQ-AUTH-01 实时重算不通过（用户禁用/撤权/角色停用）→ execute 立即 no_permission。 */
class NoPermissionSignal extends Error {}

export class AiQueryService {
  constructor(private readonly deps: AiQueryServiceDeps) {}

  private get repos(): AiQueryRepositories {
    return this.deps.repos
  }

  private now(): Date {
    return this.deps.now()
  }

  private get qcDeptIds(): string[] {
    return this.deps.qcDeptIds ?? []
  }

  private timeoutMs(): number {
    return this.deps.executeTimeoutMs ?? 15_000
  }

  // -----------------------------------------------------------------------
  // 会话登记（AQ-S3/AR-01：接入层会话归属；只存身份绑定与审计锚点）
  // -----------------------------------------------------------------------

  async openSession(input: {
    enterpriseId: string
    userId: string
    channel: AiSessionRecord['channel']
    conversationRef?: string | null
  }): Promise<AiSessionRecord> {
    return this.repos.sessions.insert(input)
  }

  /** 会话归属查询（用户面轮次端点用；不存在/非 open → AiSessionNotFoundError，DS-18 语义）。 */
  async findOpenSession(sessionId: string): Promise<AiSessionRecord> {
    const session = await this.repos.sessions.findById(sessionId)
    if (session === null || session.status !== 'open') throw new AiSessionNotFoundError(sessionId)
    return session
  }

  /** 能力当前 enabled 版本（澄清确认轮的精确重发用；无 enabled 版本 → null）。 */
  async findEnabledVersion(enterpriseId: string, capabilityId: string): Promise<number | null> {
    const enabled = await this.repos.registry.listEnabled(enterpriseId)
    return enabled.find((row) => row.capabilityId === capabilityId)?.version ?? null
  }

  /** 接缝 5 辅助：dev 预置绑定码的 login_name → userId 解析（无此用户返回 null）。 */
  async findUserByLoginName(loginName: string): Promise<{ id: string; enterpriseId: string } | null> {
    const user = await this.repos.auth.users.findByLoginName(loginName)
    return user === null ? null : { id: user.id, enterpriseId: user.enterpriseId }
  }

  /** 该 requestId 已落的最高 toolCallSeq（AR-15 审计链延续：澄清确认轮取 next= max+1）。 */
  async maxToolCallSeq(requestId: string): Promise<number> {
    const rows = await this.repos.audit.listByRequestId(requestId)
    return rows.reduce((max, row) => Math.max(max, row.toolCallSeq), 0)
  }

  // -----------------------------------------------------------------------
  // P4 五内部接缝服务面（2026-10-30；PM 增量单 §4：mock 外部渠道/模型下证明真实内部数据链）
  // -----------------------------------------------------------------------

  /**
   * 接缝 1（查询会话落库/IM-12）：im 渠道 ai_session 四元划分键（租户/用户/渠道/会话目标）
   * 持久化登记——同键 open 会话复用同一行（落库，重启可查），无则按 user 派生租户新建。
   */
  async ensureImSession(input: {
    userId: string
    channel: AiSessionRecord['channel']
    conversationRef: string | null
  }): Promise<AiSessionRecord> {
    const existing = await this.repos.sessions.findOpenByTriple(input.userId, input.channel, input.conversationRef)
    if (existing !== null) {
      await this.repos.sessions.touch(existing.id)
      return existing
    }
    const user = await this.repos.auth.users.findById(input.userId)
    if (user === null) {
      throw new Error(`[接缝1] ai_session 登记失败：绑定用户不存在 userId=${input.userId}`)
    }
    return this.repos.sessions.insert({
      enterpriseId: user.enterpriseId,
      userId: input.userId,
      channel: input.channel,
      conversationRef: input.conversationRef,
    })
  }

  /**
   * 接缝 3（发送前权限重验/IM-08/IM-13/AQ-AUTH-01）：按 userId 以 SessionVerifier 同口径
   * 实时重算授权上下文（不信任任何缓存许可）；禁用/撤权/角色停用/缺 aiquery.use → denied。
   */
  async recheckUserAccess(userId: string, requestId: string): Promise<{ allowed: true } | { allowed: false; reason: string }> {
    let auth: RecomputedAuth
    try {
      auth = await this.recomputeAuthByUserId(userId)
    } catch (error) {
      if (error instanceof NoPermissionSignal) return { allowed: false, reason: error.message }
      throw error
    }
    if (!auth.permissions.includes(AIQUERY_PERMISSIONS.USE)) {
      return {
        allowed: false,
        reason: `[AQ-AUTH-02] 缺少模块许可 ${AIQUERY_PERMISSIONS.USE}（发送前实时重验不通过）`,
      }
    }
    // Only server-written audit rows identify the capabilities and scope of this answer.
    const rows = await this.repos.audit.listByRequestId(requestId)
    for (const row of rows) {
      if (row.userId !== userId || row.enterpriseId !== auth.user.enterpriseId) {
        return { allowed: false, reason: '回答审计归属不匹配' }
      }
      if (row.resultStatus !== 'ok_with_data' && row.resultStatus !== 'ok_no_records') continue
      if (row.capabilityId === null || row.capabilityVersion === null) {
        return { allowed: false, reason: '回答缺少可信能力锚点' }
      }
      const capability = await this.repos.registry.find(row.enterpriseId, row.capabilityId, row.capabilityVersion)
      if (capability === null || this.missingPermissions(capability, auth).length > 0) {
        return { allowed: false, reason: '回答所需业务许可已撤销' }
      }
      const scope = row.params['deliveryScope'] as { enterpriseWide?: unknown; plantIds?: unknown } | undefined
      if (scope === undefined || typeof scope.enterpriseWide !== 'boolean' || !Array.isArray(scope.plantIds)) {
        return { allowed: false, reason: '回答缺少可信数据范围锚点' }
      }
      if (!auth.dataScope.enterpriseWide && (scope.enterpriseWide || scope.plantIds.some((id) => typeof id !== 'string' || !auth.dataScope.plantIds.includes(id)))) {
        return { allowed: false, reason: '回答查询范围已超出当前授权工厂范围' }
      }
    }
    return { allowed: true }
  }

  /** 接缝 2（发送审计/AQ-S2）：问数回答发送结果回写该 requestId 全部审计行（返回更新行数）。 */
  async recordSendResult(requestId: string, sentResultStatus: AiQueryAuditRecord['sentResultStatus']): Promise<number> {
    return this.repos.audit.recordSendResult(requestId, sentResultStatus)
  }

  /** 接缝 4：仅保留运行事件锚点与状态，完整正文留在 apps/ai 独立目录。 */
  async appendRuntimeEvent(
    input: Omit<NewAiRuntimeEvent, 'enterpriseId' | 'userId'>,
  ): Promise<AiRuntimeEventRecord> {
    // 企业/用户归属按 ai_session 锚点补全（best-effort：找不到时落 null，不拒绝归档）
    const session = await this.repos.sessions.findById(input.sessionId)
    return this.repos.runtimeEvents.append({
      ...input,
      event: runtimeEventState(input.kind, input.event),
      enterpriseId: session?.enterpriseId ?? null,
      userId: session?.userId ?? null,
    })
  }

  async listRuntimeEvents(sessionId: string): Promise<AiRuntimeEventRecord[]> {
    return this.repos.runtimeEvents.listBySession(sessionId)
  }

  /**
   * 接缝 5（网页签发绑定码/IM-03）：登录用户签发一次性绑定码——单活动码语义（签发即撤销
   * 该用户此前 issued 码）；只落 sha-256 摘要，明文码仅在签发应答出现一次（不落库）。
   */
  async issueImBindingCode(input: {
    enterpriseId: string
    userId: string
    ttlSeconds?: number
  }): Promise<{ id: string; code: string; expiresAt: string }> {
    const ttl = input.ttlSeconds ?? IM_BINDING_CODE_TTL_SECONDS
    const expiresAt = new Date(this.now().getTime() + ttl * 1_000)
    await this.repos.bindingCodes.revokeIssuedByUser(input.userId)
    let lastError: unknown = null
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const code = generateBindingCode()
      try {
        const row = await this.repos.bindingCodes.insert({
          enterpriseId: input.enterpriseId,
          userId: input.userId,
          codeHash: bindingCodeHash(normalizeBindingCode(code)),
          expiresAt: expiresAt.toISOString(),
        })
        return { id: row.id, code, expiresAt: row.expiresAt }
      } catch (error) {
        lastError = error // 摘要碰撞（唯一索引）→ 换码重试
      }
    }
    throw lastError instanceof Error ? lastError : new Error('[接缝5] 绑定码签发失败（摘要碰撞重试耗尽）')
  }

  /** 接缝 5（凭码绑定/一次性核销）：issued 且未过期才核销为 used；无效/已用/撤销/过期 → null。 */
  async claimImBindingCode(
    code: string,
    usedChannel?: string | null,
    usedPlatformUserId?: string | null,
  ): Promise<{ userId: string; enterpriseId: string } | null> {
    const row = await this.repos.bindingCodes.claimByCodeHash(
      bindingCodeHash(normalizeBindingCode(code)),
      usedChannel,
      usedPlatformUserId,
    )
    return row === null ? null : { userId: row.userId, enterpriseId: row.enterpriseId }
  }

  /** 接缝 5（撤销）：按行撤销（须属该用户且仍 issued）。 */
  async revokeImBindingCode(id: string, userId: string): Promise<boolean> {
    return this.repos.bindingCodes.revokeById(id, userId)
  }

  /** 接缝 5（状态查询）：当前用户绑定码清单（不回显明文码；issued 且已过期按 expired 展示）。 */
  async listImBindingCodes(userId: string): Promise<Array<Omit<AiImBindingCodeRecord, 'codeHash'>>> {
    const rows = await this.repos.bindingCodes.listByUser(userId)
    const nowMs = this.now().getTime()
    return rows.map((row) => ({
      id: row.id,
      enterpriseId: row.enterpriseId,
      userId: row.userId,
      status: row.status === 'issued' && Date.parse(row.expiresAt) <= nowMs ? ('expired' as const) : row.status,
      issuedAt: row.issuedAt,
      expiresAt: row.expiresAt,
      usedAt: row.usedAt,
      usedChannel: row.usedChannel,
      usedPlatformUserId: row.usedPlatformUserId,
      revokedAt: row.revokedAt,
    }))
  }

  // -----------------------------------------------------------------------
  // 能力枚举（AQ-REG-05/DS-18：仅许可预检通过的 enabled 能力 + 未就绪问法族固定清单）
  // -----------------------------------------------------------------------

  async listCapabilities(sessionId: string): Promise<AiQueryCapabilitiesResponseDto> {
    const session = await this.repos.sessions.findById(sessionId)
    if (session === null || session.status !== 'open') throw new AiSessionNotFoundError(sessionId)
    const auth = await this.recomputeAuth(session)
    const enabled = await this.repos.registry.listEnabled(session.enterpriseId)
    const capabilities: AiQueryCapabilityDto[] = []
    for (const row of enabled) {
      // 许可两层（AQ-AUTH-02）：aiquery.use + 能力所需域读权限全部满足才可见（预检失败对模型不可见）
      if (this.missingPermissions(row, auth).length > 0) continue
      capabilities.push({
        capabilityId: row.capabilityId,
        version: row.version,
        displayName: row.definition.displayName,
        description: row.definition.description,
        inputSchema: row.definition.inputSchema,
      })
    }
    return {
      capabilities,
      // §8 未就绪问法族固定清单（source_not_ready，扩充走注册表/合同修订）
      unreadyTopics: AI_QUERY_UNREADY_TOPICS.map((t) => ({
        capabilityId: t.capabilityId,
        topic: t.topic,
        message: t.message,
      })),
    }
  }

  // -----------------------------------------------------------------------
  // execute（DS-19：七状态机 AQ-REG-07 + 审计 AQ-S2 + 幂等 DS-22）
  // -----------------------------------------------------------------------

  async execute(input: AiExecuteInput): Promise<AiQueryEnvelopeDto> {
    const startedAt = this.now()
    const session = await this.repos.sessions.findById(input.sessionId)
    if (session === null || session.status !== 'open') throw new AiSessionNotFoundError(input.sessionId)

    // AQ-REG-06：请求体/params 携带的执行上下文同名字段忽略并记审计（不可由模型替换）
    const ignored = new Set<string>(input.ignoredRequestFields ?? [])
    for (const key of CONTEXT_FIELD_KEYS) {
      if (input.params[key] !== undefined) ignored.add(key)
    }

    const echoOf =
      (auth: { user: { id: string }; dataScope: { enterpriseWide: boolean; plantIds: string[] } } | null) =>
      (capabilityId: string, capabilityVersion: number, effectiveFilters: Record<string, unknown>, notes: string[]): AiQueryContextEchoDto => ({
        requestId: input.requestId,
        toolCallSeq: input.toolCallSeq,
        sessionId: session.id,
        userId: auth === null ? session.userId : auth.user.id,
        enterpriseId: session.enterpriseId,
        channel: session.channel,
        dataScope:
          auth === null
            ? { enterpriseWide: false, plantIds: [] }
            : { enterpriseWide: auth.dataScope.enterpriseWide, plantIds: auth.dataScope.plantIds },
        capabilityId,
        capabilityVersion,
        effectiveFilters,
        ignoredRequestFields: [...ignored],
        factColumns: [],
        notes,
      })

    const replay = await this.repos.audit.findByRequestAndSeq(input.requestId, input.toolCallSeq)

    const finish = async (
      auth: { user: { id: string }; dataScope: { enterpriseWide: boolean; plantIds: string[] } } | null,
      status: AiQueryStatus,
      message: string,
      data: AiQueryEnvelopeDto['data'],
      completeness: AiQueryCompletenessDto,
      freshness: AiQueryFreshnessDto,
      contextEcho: AiQueryContextEchoDto,
      rowCount = 0,
      truncated = false,
    ): Promise<AiQueryEnvelopeDto> => {
      const envelope: AiQueryEnvelopeDto = {
        status,
        statusLabel: AI_QUERY_STATUS_LABELS[status],
        message,
        data,
        completeness,
        freshness,
        contextEcho,
        auditRef: { requestId: input.requestId, toolCallSeq: input.toolCallSeq },
      }
      if (replay === null) {
        // AQ-S2：非重放才落新审计行（UNIQUE (request_id, tool_call_seq)）
        await this.writeAudit(session, input, status, rowCount, truncated, startedAt, [...ignored], contextEcho.dataScope)
      } else {
        envelope.contextEcho = {
          ...envelope.contextEcho,
          notes: [
            ...envelope.contextEcho.notes,
            '幂等重放：该 (requestId, toolCallSeq) 已有审计行，本次返回既有审计结果关联的查询，不重复落审计（DS-22）',
          ],
        }
      }
      return envelope
    }

    const emptyCompleteness: AiQueryCompletenessDto = { truncated: false, fetchedRows: 0, totalKnown: true, total: 0, page: null }
    const baseFreshness = (): AiQueryFreshnessDto => ({ queriedAt: startedAt.toISOString(), sources: [] })

    // ---- AQ-AUTH-01：每次执行按会话绑定 userId 实时重算（不信任 ai_session 建立时快照） ----
    let auth: RecomputedAuth
    try {
      auth = await this.recomputeAuth(session)
    } catch (error) {
      if (error instanceof NoPermissionSignal) {
        return finish(
          null,
          'no_permission',
          `${error.message}（撤权/禁用后下一次 execute 立即 no_permission，AQ-AUTH-01）`,
          null,
          emptyCompleteness,
          baseFreshness(),
          echoOf(null)(input.capabilityId, input.capabilityVersion, {}, ['授权上下文实时重算不通过：数据范围未授予']),
        )
      }
      throw error
    }

    // ---- 模块许可（AQ-AUTH-02 第一层）：aiquery.use ----
    if (!auth.permissions.includes(AIQUERY_PERMISSIONS.USE)) {
      return finish(
        auth,
        'no_permission',
        `[AQ-AUTH-02] 缺少模块许可 ${AIQUERY_PERMISSIONS.USE}：无法执行问数查询`,
        null,
        emptyCompleteness,
        baseFreshness(),
        echoOf(auth)(input.capabilityId, input.capabilityVersion, {}, []),
      )
    }

    // ---- AQ-REG-01：未就绪问法族 → source_not_ready（不得以空数据冒充） ----
    const unready = findUnreadyTopic(input.capabilityId)
    if (unready !== null) {
      return finish(
        auth,
        'source_not_ready',
        `[AQ-REG-01] ${unready.message}`,
        null,
        emptyCompleteness,
        baseFreshness(),
        echoOf(auth)(unready.capabilityId, input.capabilityVersion, { topic: unready.topic }, []),
      )
    }

    // ---- AQ-REG-01/04：注册表解析（未注册/已停用 → not_supported） ----
    const registryRow = await this.repos.registry.find(session.enterpriseId, input.capabilityId, input.capabilityVersion)
    if (registryRow === null) {
      return finish(
        auth,
        'not_supported',
        `[AQ-REG-01] 该问数能力未注册：${input.capabilityId} v${String(input.capabilityVersion)}（企业内无此能力版本）`,
        null,
        emptyCompleteness,
        baseFreshness(),
        echoOf(auth)(input.capabilityId, input.capabilityVersion, {}, []),
      )
    }
    if (registryRow.status !== 'enabled') {
      return finish(
        auth,
        'not_supported',
        `[AQ-REG-04] 该问数能力版本已停用：${registryRow.capabilityId} v${String(registryRow.version)}（存量会话只可继续读取既有结果，不可新发起）`,
        null,
        emptyCompleteness,
        baseFreshness(),
        echoOf(auth)(input.capabilityId, input.capabilityVersion, {}, []),
      )
    }

    // ---- AQ-AUTH-02 第二层：能力所需域读权限全部满足 ----
    const missing = this.missingPermissions(registryRow, auth)
    if (missing.length > 0) {
      return finish(
        auth,
        'no_permission',
        `[AQ-AUTH-02] 缺少执行能力 ${registryRow.capabilityId} 所需许可：${missing.join('、')}`,
        null,
        emptyCompleteness,
        baseFreshness(),
        echoOf(auth)(registryRow.capabilityId, registryRow.version, { missingPermissions: missing }, []),
      )
    }

    // ---- AQ-AUTH-03：数据范围贯穿；params.plantId 只能缩小（越范围 → no_permission） ----
    const notes: string[] = []
    let plantIds: string[] | null = auth.dataScope.enterpriseWide ? null : auth.dataScope.plantIds
    const requestedPlantId = typeof input.params['plantId'] === 'string' ? (input.params['plantId'] as string) : null
    if (requestedPlantId !== null && requestedPlantId !== '') {
      if (plantIds !== null && !plantIds.includes(requestedPlantId)) {
        return finish(
          auth,
          'no_permission',
          `[AQ-AUTH-03] 请求的工厂 ${requestedPlantId} 不在授权数据范围内（AI 只能缩小授权范围，不能扩大）`,
          null,
          emptyCompleteness,
          baseFreshness(),
          echoOf(auth)(registryRow.capabilityId, registryRow.version, { requestedPlantId }, []),
        )
      }
      plantIds = [requestedPlantId]
      notes.push(`已按请求参数收窄到单厂：${requestedPlantId}（与授权范围取交集，AI 只能缩小授权范围）`)
    }

    // ---- 参数解析 + 查询执行（超时合同 DS-20/AQ-REG-10；错误不得伪装成 ok_no_records） ----
    try {
      const outcome = await this.withTimeout(this.runCapability(registryRow, input, session, plantIds, notes, startedAt))
      if (outcome.timedOut) {
        return finish(
          auth,
          'timeout',
          `[AQ-REG-10] 查询超时（阶段：query；服务端单次执行上限 ${String(this.timeoutMs())}ms），已停止本次查询，未取全不得总结为完整总量`,
          null,
          { truncated: false, fetchedRows: 0, totalKnown: false, total: null, page: null },
          baseFreshness(),
          echoOf(auth)(registryRow.capabilityId, registryRow.version, { timedOut: true }, [...notes, '阶段：query']),
        )
      }
      const built = outcome.value
      return finish(
        auth,
        built.status,
        built.message,
        built.data,
        built.completeness,
        built.freshness,
        echoOf(auth)(registryRow.capabilityId, registryRow.version, built.effectiveFilters, [...notes, ...built.notes]),
        built.rowCount,
        built.truncated,
      )
    } catch (error) {
      if (error instanceof AiSessionNotFoundError) throw error
      if (error instanceof Error && error.name === 'AiQueryRuleViolation') {
        // 语义非法（AQ-C1-1/AQ-C3-1 等）：failed 带规则码提示（不得以空数据冒充）
        return finish(
          auth,
          'failed',
          error.message,
          null,
          emptyCompleteness,
          baseFreshness(),
          echoOf(auth)(registryRow.capabilityId, registryRow.version, {}, [...notes]),
        )
      }
      return finish(
        auth,
        'failed',
        `[AQ-REG-10] 查询失败（阶段：query）：${error instanceof Error ? error.message : String(error)}`,
        null,
        emptyCompleteness,
        baseFreshness(),
        echoOf(auth)(registryRow.capabilityId, registryRow.version, {}, [...notes, '阶段：query']),
      )
    }
  }

  // -----------------------------------------------------------------------
  // 内部：授权重算（AQ-AUTH-01，SessionVerifier 同源）
  // -----------------------------------------------------------------------

  private async recomputeAuth(session: AiSessionRecord): Promise<RecomputedAuth> {
    return this.recomputeAuthByUserId(session.userId)
  }

  /** AQ-AUTH-01 实时重算（按 userId；接缝 3 发送前再检与 execute 同一口径）。 */
  private async recomputeAuthByUserId(userId: string): Promise<RecomputedAuth> {
    const { users, roles, grants, org } = this.repos.auth
    const user = await users.findById(userId)
    if (user === null || user.status === 'retired' || user.accountStatus === 'disabled') {
      throw new NoPermissionSignal(`[AQ-AUTH-01] 会话绑定用户已禁用/注销或不存在（实时重算不通过）：userId=${userId}`)
    }
    const [role, grantRows, nodes] = await Promise.all([
      roles.findById(user.roleId),
      grants.listActiveByPrincipals([
        { principalType: 'role', principalId: user.roleId },
        { principalType: 'user', principalId: user.id },
      ]),
      org.listActiveByEnterprise(user.enterpriseId),
    ])
    if (role === null || role.status === 'retired') {
      throw new NoPermissionSignal(`[AQ-AUTH-01] 会话绑定用户角色已停用或不存在：roleId=${user.roleId}`)
    }
    const grantLikes = grantRows.map((g) => ({
      principalType: g.principalType,
      principalId: g.principalId,
      permissions: g.permissions,
      scopeType: g.scopeType,
      scopeObjectId: g.scopeObjectId,
    }))
    const dataScope = computeDataScope(
      grantLikes,
      nodes.map((n) => ({ id: n.id, parentId: n.parentId, kind: n.kind, path: n.path, status: n.status })),
    )
    return {
      user: { id: user.id, loginName: user.loginName, enterpriseId: user.enterpriseId },
      permissions: unionPermissions(grantLikes),
      dataScope: { enterpriseWide: dataScope.enterpriseWide, plantIds: dataScope.plantIds },
    }
  }

  private missingPermissions(row: AiCapabilityRegistryRecord, auth: RecomputedAuth): string[] {
    return row.definition.requiredPermissions.filter((p) => !auth.permissions.includes(p))
  }

  private async withTimeout<T>(work: Promise<T>): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), this.timeoutMs())
    })
    try {
      return await Promise.race([work.then((value) => ({ timedOut: false as const, value })), timeoutPromise])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private async writeAudit(
    session: AiSessionRecord,
    input: AiExecuteInput,
    status: AiQueryStatus,
    rowCount: number,
    truncated: boolean,
    startedAt: Date,
    ignoredRequestFields: string[],
    authorizedScope: { enterpriseWide: boolean; plantIds: string[] },
  ): Promise<AiQueryAuditRecord> {
    const durationMs = Math.max(0, this.now().getTime() - startedAt.getTime())
    // AQ-S2 脱敏载荷：只存过滤参数与对象引用（白名单键），不存聊天正文
    const filters: Record<string, unknown> = {}
    const droppedParamKeys: string[] = []
    for (const [key, value] of Object.entries(input.params)) {
      if (AUDIT_FILTER_KEYS.includes(key)) filters[key] = value
      else droppedParamKeys.push(key)
    }
    return this.repos.audit.insert({
      requestId: input.requestId,
      toolCallSeq: input.toolCallSeq,
      sessionId: session.id,
      capabilityId: input.capabilityId,
      capabilityVersion: input.capabilityVersion,
      userId: session.userId,
      enterpriseId: session.enterpriseId,
      channel: session.channel,
      params: {
        filters, ignoredRequestFields, droppedParamKeys,
        deliveryScope: typeof filters['plantId'] === 'string' &&
          (authorizedScope.enterpriseWide || authorizedScope.plantIds.includes(filters['plantId']))
          ? { enterpriseWide: false, plantIds: [filters['plantId']] }
          : authorizedScope,
      },
      resultStatus: status,
      rowCount,
      truncated,
      durationMs,
      // AR-16：A 线不知模型侧信息——用量未知如实标记 unknown，不估数（persistence 落 'unknown'）
      modelInfo: undefined,
    })
  }

  // -----------------------------------------------------------------------
  // 三能力执行（AQ-C1/C2/C3）
  // -----------------------------------------------------------------------

  private async runCapability(
    registryRow: AiCapabilityRegistryRecord,
    input: AiExecuteInput,
    session: AiSessionRecord,
    plantIds: string[] | null,
    notes: string[],
    startedAt: Date,
  ): Promise<CapabilityOutcome> {
    switch (registryRow.capabilityId) {
      case 'aq.order-progress':
        return this.runOrderProgress(input, session, plantIds, startedAt)
      case 'aq.material-shortage':
        return this.runMaterialShortage(registryRow, input, session, plantIds, startedAt)
      case 'aq.quality':
        return this.runQuality(input, session, plantIds, notes, startedAt)
      default:
        // 注册行与执行体对齐由部署初始化保证（AQ-REG-03 seed）；未对齐视为查询失败
        throw new Error(`能力执行体未实现：${registryRow.capabilityId}`)
    }
  }

  /** 订单定位（AQ-AMB-01：精确唯一命中直接执行；模糊/销售单号多命中返回候选清单）。 */
  private async resolveOrder(
    enterpriseId: string,
    orderRef: { kind: 'orderId' | 'orderNo' | 'orderNoLike' | 'salesOrderNo'; value: string },
    plantIds: string[] | null,
  ): Promise<{ order: AiOrderRow | null; candidates: AiOrderRow[] }> {
    if (orderRef.kind === 'orderId') {
      const order = await this.repos.reads.findOrderById(orderRef.value, enterpriseId)
      return { order: this.inScopeOrder(order, plantIds), candidates: [] }
    }
    if (orderRef.kind === 'orderNo') {
      const order = await this.repos.reads.findOrderByOrderNo(enterpriseId, orderRef.value)
      return { order: this.inScopeOrder(order, plantIds), candidates: [] }
    }
    const rows =
      orderRef.kind === 'orderNoLike'
        ? await this.repos.reads.listOrdersByOrderNoLike({
            enterpriseId,
            pattern: orderRef.value,
            plantIds,
            limit: CANDIDATE_LIMIT + 1,
          })
        : await this.repos.reads.listOrdersBySalesOrderNo({
            enterpriseId,
            salesOrderNo: orderRef.value,
            plantIds,
            limit: CANDIDATE_LIMIT + 1,
          })
    if (rows.length <= 1) return { order: rows[0] ?? null, candidates: [] }
    return { order: null, candidates: rows }
  }

  /** 纵深防御（OA-25 同则 process-queries）：对象厂不在数据范围按不存在处理。 */
  private inScopeOrder(order: AiOrderRow | null, plantIds: string[] | null): AiOrderRow | null {
    if (order === null) return null
    if (plantIds !== null && !plantIds.includes(order.plantId)) return null
    return order
  }

  private toCandidates(rows: AiOrderRow[]): {
    candidates: Array<{ orderId: string; orderNo: string; plantId: string; orderStatus: string; materialDesc: string; createdAt: string }>
    truncated: boolean
    total: number | null
    note: string | null
  } {
    const truncated = rows.length > CANDIDATE_LIMIT
    return {
      candidates: rows.slice(0, CANDIDATE_LIMIT).map((o) => ({
        orderId: o.orderId,
        orderNo: o.orderNo,
        plantId: o.plantId,
        orderStatus: o.orderStatus,
        materialDesc: materialDesc(o.materialSnapshot),
        createdAt: o.createdAt,
      })),
      truncated,
      total: truncated ? null : rows.length,
      note: truncated
        ? `命中订单较多，仅列前 ${String(CANDIDATE_LIMIT)} 个候选（AQ-AMB-01）；请提供更长单号片段或精确单号`
        : null,
    }
  }

  private candidateOutcome(
    data: AiQueryEnvelopeDto['data'],
    rows: AiOrderRow[],
    orderRef: unknown,
    startedAt: Date,
  ): CapabilityOutcome {
    const { candidates, truncated, total, note } = this.toCandidates(rows)
    return {
      status: 'ok_with_data',
      message:
        note !== null
          ? `[AQ-AMB-01] 单号命中多个订单，请确认具体订单：${note}`
          : '[AQ-AMB-01] 单号命中多个订单，请确认具体订单（未自行择一作答，AI 呈现选项待确认后带精确 orderId/orderNo 重新执行）',
      data,
      completeness: { truncated, fetchedRows: candidates.length, totalKnown: !truncated, total, page: null },
      freshness: { queriedAt: startedAt.toISOString(), sources: [] },
      effectiveFilters: { orderRef },
      notes: note !== null ? [note] : [],
      rowCount: candidates.length,
      truncated,
    }
  }

  // ---- AQ-C1 订单进度（§2） ----

  private async runOrderProgress(
    input: AiExecuteInput,
    session: AiSessionRecord,
    plantIds: string[] | null,
    startedAt: Date,
  ): Promise<CapabilityOutcome> {
    const orderRef = parseOrderRef(input.params)
    const { order, candidates } = await this.resolveOrder(session.enterpriseId, orderRef, plantIds)

    if (order === null && candidates.length === 0) {
      return {
        status: 'ok_no_records',
        message: '[AQ-REG-08] 过滤条件有效但无匹配对象：未找到该生产订单（或不在授权数据范围内）',
        data: { capabilityId: 'aq.order-progress', order: null, candidates: [] },
        completeness: { truncated: false, fetchedRows: 0, totalKnown: true, total: 0, page: null },
        freshness: { queriedAt: startedAt.toISOString(), sources: [] },
        effectiveFilters: { orderRef },
        notes: [],
        rowCount: 0,
        truncated: false,
      }
    }
    if (order === null) {
      return this.candidateOutcome(
        { capabilityId: 'aq.order-progress', order: null, candidates: this.toCandidates(candidates).candidates },
        candidates,
        orderRef,
        startedAt,
      )
    }

    // ---- 唯一命中：单订单视图（五量/排程/未完成任务，全部仓内真实读面） ----
    const operations = await this.repos.reads.listCurrentOperations(order.orderId, order.currentSettingsVersion)
    const allSlots = await this.repos.reads.listSlotsByOrder(order.orderId)
    const reports = await this.repos.reads.listReportsByOrder(order.orderId)
    const outputs = await this.repos.reads.listOutputsByOrder(order.orderId)

    const opIds = new Set(operations.map((o) => o.orderOperationId))
    const slots = allSlots.filter((s) => opIds.has(s.orderOperationId))
    const slotsByOp = new Map<string, typeof slots>()
    for (const s of slots) {
      const list = slotsByOp.get(s.orderOperationId) ?? []
      list.push(s)
      slotsByOp.set(s.orderOperationId, list)
    }
    const outputsByReport = new Map<string, typeof outputs>()
    for (const o of outputs) {
      const list = outputsByReport.get(o.reportId) ?? []
      list.push(o)
      outputsByReport.set(o.reportId, list)
    }

    // 就绪判定输入（execution-queries.orderQuantities 同口径）
    const readinessOps = operations.map((o) => ({
      seq: o.seq,
      isQc: this.qcDeptIds.includes(o.productionDeptId),
      productionDeptId: o.productionDeptId,
    }))
    const reportFacts = reports
      .filter((r) => r.status === 'submitted' && r.reviewCancelledAt === null)
      .map((r) => ({ seq: r.operationSeq, submitted: true, hasOutput: (outputsByReport.get(r.id)?.length ?? 0) > 0 }))
    const toInput = (r: (typeof reports)[number]) => ({
      status: r.status,
      reviewStatus: r.reviewStatus,
      outputs: (outputsByReport.get(r.id) ?? []).map((o) => ({
        quantity: o.quantity,
        qualifiedQty: o.qualifiedQty,
        stockUnitId: o.stockUnitId,
      })),
      uomId: order.uom,
    })

    const operationDtos: Array<NonNullable<AiOrderProgressResultDto['order']>['operations'][number]> = []
    for (const op of operations) {
      const quantities = computeFiveQuantities(reports.filter((r) => r.orderOperationId === op.orderOperationId).map(toInput))
      const opSlots = slotsByOp.get(op.orderOperationId) ?? []
      const scheduledQty = sumPlannedQty(opSlots.map((s) => s.plannedQty))
      const projection = projectOperationScheduling({ offlineQty: op.offlineQty, plannedQty: scheduledQty })
      const verdict = computeOperationReadiness({
        operations: readinessOps,
        reports: reportFacts,
        targetSeq: op.seq,
        actorDeptIds: null,
      })
      operationDtos.push({
        orderOperationId: op.orderOperationId,
        seq: op.seq,
        operationName: op.operationName,
        offlineQty: op.offlineQty,
        uom: op.uom,
        quantities: {
          draftQty: quantities.draft,
          submittedQty: quantities.submitted,
          approvedQty: quantities.approved,
          qualifiedQty: quantities.qualified,
          stockedQty: quantities.stocked,
        },
        scheduledQty: projection.scheduledQty,
        fullyScheduled: projection.fullyScheduled,
        ready: verdict.ready,
        readyReason: verdict.reason,
        // 未完成判定=五量与排程事实（execution_status 无置位路径，GAP-P9，不以该列宣称已/未执行）
        incomplete: isOperationIncomplete({ fullyScheduled: projection.fullyScheduled, approvedQty: quantities.approved }),
      })
    }
    const total = computeFiveQuantities(reports.map(toInput))
    const schedulingStatus = projectOrderSchedulingStatus(
      operations.map((op) => ({
        offlineQty: op.offlineQty,
        plannedQty: sumPlannedQty((slotsByOp.get(op.orderOperationId) ?? []).map((s) => s.plannedQty)),
      })),
    )

    const data: AiOrderProgressResultDto = {
      capabilityId: 'aq.order-progress',
      order: {
        orderId: order.orderId,
        plantId: order.plantId,
        orderNo: order.orderNo,
        orderType: order.orderType,
        salesContractNo: order.salesContractNo,
        salesOrderNo: order.salesOrderNo,
        lineNo: order.lineNo,
        materialDesc: materialDesc(order.materialSnapshot),
        productionQty: order.productionQty,
        uom: order.uom,
        orderStatus: order.orderStatus,
        suspended: order.suspended,
        suspendedReason: order.suspendedReason,
        processConfigStatus: order.processConfigStatus,
        bomRevisionId: order.bomRevisionId,
        routeRevisionId: order.routeRevisionId,
        actualStartAt: order.actualStartAt,
        plannedStartAt: order.plannedStartAt,
        plannedFinishAt: order.plannedFinishAt,
        businessClosedAt: order.businessClosedAt,
        erpClosedAt: order.erpClosedAt,
        totalQuantities: {
          draftQty: total.draft,
          submittedQty: total.submitted,
          approvedQty: total.approved,
          qualifiedQty: total.qualified,
          stockedQty: total.stocked,
        },
        schedulingStatus,
        operations: operationDtos,
      },
      candidates: [],
    }
    return {
      // 零值＝有效查询产物（AQ-REG-08）：订单存在即 ok_with_data，五量全 0 也是有效结果
      status: 'ok_with_data',
      message: `查询成功：订单 ${order.orderNo} 当前进度（${String(operations.length)} 道当前版本工序，其中未完成 ${String(operationDtos.filter((o) => o.incomplete).length)} 道）`,
      data,
      completeness: { truncated: false, fetchedRows: operations.length, totalKnown: true, total: operations.length, page: null },
      freshness: {
        queriedAt: startedAt.toISOString(),
        sources: [
          { source: 'production_order', updatedAt: order.updatedAt },
          { source: 'order_operation', updatedAt: maxUpdatedAt(operations.map((o) => o.updatedAt)) },
          { source: 'schedule_slot', updatedAt: maxUpdatedAt(slots.map((s) => s.updatedAt)) },
          { source: 'production_report', updatedAt: maxUpdatedAt(reports.map((r) => r.updatedAt)) },
          { source: 'report_output', updatedAt: maxUpdatedAt(outputs.map((o) => o.updatedAt)) },
        ],
      },
      effectiveFilters: { orderRef, orderId: order.orderId },
      notes: [],
      rowCount: operations.length,
      truncated: false,
    }
  }

  // ---- AQ-C2 物料缺口（§3） ----

  private async runMaterialShortage(
    registryRow: AiCapabilityRegistryRecord,
    input: AiExecuteInput,
    session: AiSessionRecord,
    plantIds: string[] | null,
    startedAt: Date,
  ): Promise<CapabilityOutcome> {
    const orderRef = parseOrderRef(input.params)
    const includePurchaseLines = parseIncludePurchaseLines(input.params)
    const requirementBase = readRequirementBase(registryRow)
    const { order, candidates } = await this.resolveOrder(session.enterpriseId, orderRef, plantIds)

    const noRecords = (message: string, extraNotes: string[] = [], bom: { id: string; version: number } | null = null): CapabilityOutcome => ({
      status: 'ok_no_records',
      message,
      data: {
        capabilityId: 'aq.material-shortage',
        orderId: order?.orderId ?? null,
        orderNo: order?.orderNo ?? null,
        bomRevisionId: bom?.id ?? null,
        bomRevisionVersion: bom?.version ?? null,
        requirementBase,
        lines: [],
        candidates: [],
      },
      completeness: { truncated: false, fetchedRows: 0, totalKnown: true, total: 0, page: null },
      freshness: { queriedAt: startedAt.toISOString(), sources: order === null ? [] : [{ source: 'production_order', updatedAt: order.updatedAt }] },
      effectiveFilters: { orderRef, includePurchaseLines, requirementBase },
      notes: extraNotes,
      rowCount: 0,
      truncated: false,
    })

    if (order === null && candidates.length === 0) {
      return noRecords('[AQ-REG-08] 过滤条件有效但无匹配对象：未找到该生产订单（或不在授权数据范围内）')
    }
    if (order === null) {
      return this.candidateOutcome(
        {
          capabilityId: 'aq.material-shortage',
          orderId: null,
          orderNo: null,
          bomRevisionId: null,
          bomRevisionVersion: null,
          requirementBase,
          lines: [],
          candidates: this.toCandidates(candidates).candidates,
        },
        candidates,
        orderRef,
        startedAt,
      )
    }
    if (order.bomRevisionId === null) {
      // §3：未冻结 BOM → ok_no_records + 附注，不视为缺料为零
      return noRecords('[AQ-REG-08] 该订单未冻结 BOM 版本：无 BOM 需求行可比对（不视为缺料为零）', ['该订单未冻结 BOM 版本'])
    }
    const bom = await this.repos.reads.findBomRevision(order.bomRevisionId)
    if (bom === null) {
      return noRecords('[AQ-REG-08] 订单引用的 BOM 版本不存在（或不可见）')
    }

    // BOM 行 ≤ 500（超限截断并标 truncated）
    const bomLines = bom.lines.slice(0, C2_MAX_BOM_LINES)
    const bomTruncated = bom.lines.length > C2_MAX_BOM_LINES
    const materialCodes = [...new Set(bomLines.map((l) => l.materialCode))]
    const [balances, purchaseLines] = await Promise.all([
      materialCodes.length > 0
        ? this.repos.reads.listBalancesByMaterialCodes({ enterpriseId: session.enterpriseId, plantIds, materialCodes })
        : Promise.resolve([]),
      materialCodes.length > 0 && includePurchaseLines
        ? this.repos.reads.listPurchaseLinesByMaterialCodes({ enterpriseId: session.enterpriseId, plantIds, materialCodes })
        : Promise.resolve([]),
    ])

    // 可用量（IT-14：合格 ∧ 减有效预留；同料品跨余额行汇总；多 uom 混杂按单位不一致处理）
    const unitIds = [...new Set(balances.map((b) => b.unitId))]
    const reservations = unitIds.length > 0 ? await this.repos.reads.listActiveReservationsByUnitIds(unitIds) : []
    const reservationsByUnit = new Map<string, typeof reservations>()
    for (const r of reservations) {
      const list = reservationsByUnit.get(r.unitId) ?? []
      list.push(r)
      reservationsByUnit.set(r.unitId, list)
    }
    const nowIso = startedAt.toISOString()
    const availabilityByMaterial = new Map<
      string,
      { grossQty: DecimalString; reservedQty: DecimalString; availableQty: DecimalString; uoms: Set<string> }
    >()
    for (const b of balances) {
      const availability = computeAvailability({
        grossQty: b.quantity,
        qualityStatus: b.qualityStatus as 'qualified' | 'pending_inspection' | 'unqualified' | 'suspect',
        activeReservations: (reservationsByUnit.get(b.unitId) ?? []).map((r) => ({
          status: r.status,
          quantity: r.quantity,
          validUntil: r.validUntil,
        })),
        now: nowIso,
      })
      const current = availabilityByMaterial.get(b.materialCode) ?? {
        grossQty: '0.0000',
        reservedQty: '0.0000',
        availableQty: '0.0000',
        uoms: new Set<string>(),
      }
      current.uoms.add(b.uomCode)
      availabilityByMaterial.set(b.materialCode, {
        grossQty: addQty(current.grossQty, availability.gross),
        reservedQty: addQty(current.reservedQty, availability.reserved),
        availableQty: addQty(current.availableQty, availability.available),
        uoms: current.uoms,
      })
    }

    // 采购在途（IF-08 行状态轴：0 已开立/1 待收货/2 部分收货 且 erp_closed=false；在途=planned−received）
    const purchaseByMaterial = new Map<string, typeof purchaseLines>()
    for (const line of purchaseLines) {
      if (line.status !== 0 && line.status !== 1 && line.status !== 2) continue
      if (line.erpClosed) continue
      const list = purchaseByMaterial.get(line.materialCode) ?? []
      list.push(line)
      purchaseByMaterial.set(line.materialCode, list)
    }

    let purchaseTruncated = false
    const lineDtos: AiMaterialShortageResultDto['lines'] = []
    for (const bomLine of bomLines) {
      const materialPurchaseLines = purchaseByMaterial.get(bomLine.materialCode) ?? []
      if (materialPurchaseLines.length > C2_MAX_PURCHASE_LINES_PER_MATERIAL) purchaseTruncated = true
      const inTransitLines = materialPurchaseLines.slice(0, C2_MAX_PURCHASE_LINES_PER_MATERIAL)
      let inTransitQty: DecimalString = '0.0000'
      for (const line of inTransitLines) {
        inTransitQty = addQty(inTransitQty, subQty(line.plannedQty, line.receivedQty))
      }
      const availability = availabilityByMaterial.get(bomLine.materialCode)
      const stockUoms = availability?.uoms ?? new Set<string>()
      const stockUom = stockUoms.size === 1 ? [...stockUoms][0]! : null
      const purchaseUom = inTransitLines[0]?.uomCode ?? null
      const shortage = computeShortageLine({
        bomQuantity: bomLine.quantity,
        productionQty: order.productionQty,
        requirementBase,
        availableQty: availability?.availableQty ?? '0.0000',
        inTransitQty,
        uomSources: { bom: bomLine.uom, stock: stockUom, purchase: purchaseUom },
      })
      // 库存侧自身多 uom 混杂同样视为单位不一致（不折算、不汇总结论）
      const uomMismatch = shortage.uomMismatch || stockUoms.size > 1
      const shortageQty = uomMismatch ? null : shortage.shortageQty
      const requiredQty = uomMismatch ? null : shortage.requiredQty
      const shortageNote = uomMismatch
        ? '单位不一致未折算（BOM/库存/采购三源单位不同，首版无跨源自动换算，不做汇总结论）'
        : shortage.shortageNote
      const snapshotLine = inTransitLines[0] ?? purchaseLines.find((p) => p.materialCode === bomLine.materialCode)
      lineDtos.push({
        materialId: bomLine.materialId,
        materialCode: bomLine.materialCode,
        materialName: snapshotLine?.materialName ?? null,
        spec: snapshotLine?.spec ?? null,
        model: snapshotLine?.model ?? null,
        color: snapshotLine?.color ?? null,
        bomQuantity: bomLine.quantity,
        uom: bomLine.uom,
        requirementBase,
        requiredQty,
        availability: {
          grossQty: availability?.grossQty ?? '0.0000',
          reservedQty: availability?.reservedQty ?? '0.0000',
          availableQty: availability?.availableQty ?? '0.0000',
        },
        inTransitQty,
        shortageQty,
        shortageNote,
        uomMismatch,
        uomSources: { bom: bomLine.uom, stock: stockUom, purchase: purchaseUom },
        purchaseLines: includePurchaseLines
          ? inTransitLines.map((line) => ({
              lineId: line.lineId,
              orderNo: line.orderNo,
              lineNo: line.lineNo,
              status: line.status,
              statusLabel: ORDER_LINE_STATUS_LABELS[line.status as 0 | 1 | 2 | 3 | 4 | 5] ?? String(line.status),
              plannedQty: line.plannedQty,
              receivedQty: line.receivedQty,
              inTransitQty: subQty(line.plannedQty, line.receivedQty),
              erpClosed: line.erpClosed,
              plannedReceiptDate: line.plannedReceiptDate,
              firstArrivalDate: line.firstArrivalDate,
              lastArrivalDate: line.lastArrivalDate,
              uomCode: line.uomCode,
              latestBatchInspectionStatus: line.latestBatchInspectionStatus,
              latestBatchInspectionStatusLabel:
                line.latestBatchInspectionStatus !== null
                  ? (BATCH_INSPECTION_STATUS_LABELS[
                      line.latestBatchInspectionStatus as keyof typeof BATCH_INSPECTION_STATUS_LABELS
                    ] ?? line.latestBatchInspectionStatus)
                  : null,
            }))
          : [],
      })
    }

    const outcomeNotes: string[] = []
    if (requirementBase === null) {
      outcomeNotes.push('缺口数值列首版固定「口径未定」标注（requirementBase 未配置，BOM 行基数语义未冻结，GAP-P4/AQ-AMB-03）')
    }
    if (bomTruncated || purchaseTruncated) {
      outcomeNotes.push('结果超出最大查询范围已截断（BOM 行 ≤ 500 / 每料品采购行 ≤ 200），未取全不得总结为完整总量')
    }

    const data: AiMaterialShortageResultDto = {
      capabilityId: 'aq.material-shortage',
      orderId: order.orderId,
      orderNo: order.orderNo,
      bomRevisionId: bom.id,
      bomRevisionVersion: bom.version,
      requirementBase,
      lines: lineDtos,
      candidates: [],
    }
    const truncated = bomTruncated || purchaseTruncated
    return {
      status: 'ok_with_data',
      message: `查询成功：订单 ${order.orderNo} BOM ${String(bomLines.length)} 行与可用量/采购在途并排（口径：${
        requirementBase === null ? '缺口数值口径未定' : requirementBase === 'per_unit' ? '单件用量 × 生产数量' : '订单总量'
      }）`,
      data,
      completeness: { truncated, fetchedRows: lineDtos.length, totalKnown: !truncated, total: truncated ? null : bom.lines.length, page: null },
      freshness: {
        queriedAt: startedAt.toISOString(),
        sources: [
          { source: 'production_order', updatedAt: order.updatedAt },
          { source: 'manufacturing_bom_revision', updatedAt: bom.updatedAt },
          { source: 'stock_balance', updatedAt: maxUpdatedAt(balances.map((b) => b.updatedAt)) },
          { source: 'purchase_order_line', updatedAt: maxUpdatedAt(purchaseLines.map((p) => p.updatedAt)) },
        ],
      },
      effectiveFilters: { orderRef, orderId: order.orderId, includePurchaseLines, requirementBase, bomRevisionId: bom.id },
      notes: outcomeNotes,
      rowCount: lineDtos.length,
      truncated,
    }
  }

  // ---- AQ-C3 质量查询（§4：事实与原因推测分开） ----

  private async runQuality(
    input: AiExecuteInput,
    session: AiSessionRecord,
    plantIds: string[] | null,
    notes: string[],
    startedAt: Date,
  ): Promise<CapabilityOutcome> {
    const params = parseQualityParams(input.params, startedAt)
    if (params.timeRange.defaultApplied) {
      notes.push(
        `时间范围未显式给定：默认最近 7 个自然日（Asia/Shanghai）${params.timeRange.from} ～ ${params.timeRange.to}，可修改后重新查询（AQ-AMB-02）`,
      )
    }
    const page = await this.repos.reads.listQualityMergedPage({
      enterpriseId: session.enterpriseId,
      plantIds,
      objectScope: params.objectScope,
      timeRange: params.timeRange,
      conclusions: params.conclusions,
      inspectionStages: params.inspectionStages,
      orderNoLike: params.orderNoLike,
      page: params.page,
    })

    const inspectionIds = page.items.filter((i) => i.family === 'inspection_order').map((i) => i.id)
    const batchIds = page.items.filter((i) => i.family === 'purchase_batch').map((i) => i.id)
    const [inspectionRows, batchRows, effectiveResults, dispositions, detailSummary] = await Promise.all([
      inspectionIds.length > 0 ? this.repos.reads.listInspectionOrdersByIds(inspectionIds) : Promise.resolve([]),
      batchIds.length > 0 ? this.repos.reads.listBatchesByIds(batchIds) : Promise.resolve([]),
      inspectionIds.length > 0 ? this.repos.reads.listEffectiveResultsByOrderIds(inspectionIds) : Promise.resolve([]),
      inspectionIds.length > 0 ? this.repos.reads.listLatestDispositionsByOrderIds(inspectionIds) : Promise.resolve([]),
      batchIds.length > 0 ? this.repos.reads.listBatchDetailSummary(batchIds) : Promise.resolve([]),
    ])
    const unitIds = [...new Set(inspectionRows.map((o) => o.inventoryUnitId).filter((u): u is string => u !== null))]
    const holds = unitIds.length > 0 ? await this.repos.reads.listActiveHoldsByUnitIds(unitIds) : []
    const effectiveByOrder = new Map(effectiveResults.map((r) => [r.inspectionOrderId, r]))
    const dispositionByOrder = new Map(dispositions.map((d) => [d.inspectionOrderId, d]))
    const holdsByUnit = new Map(holds.map((h) => [h.inventoryUnitId, h]))
    const summaryByBatch = new Map<string, Array<{ qualityStatus: string; count: number }>>()
    for (const row of detailSummary) {
      const list = summaryByBatch.get(row.batchId) ?? []
      list.push({ qualityStatus: row.qualityStatus, count: row.count })
      summaryByBatch.set(row.batchId, list)
    }

    const inspectionDtos: AiQualityInspectionRowDto[] = inspectionRows.map((o) => {
      const effective = effectiveByOrder.get(o.id) ?? null
      const disposition = dispositionByOrder.get(o.id) ?? null
      const hold = o.inventoryUnitId !== null ? (holdsByUnit.get(o.inventoryUnitId) ?? null) : null
      return {
        family: 'inspection_order',
        id: o.id,
        orderNo: o.orderNo,
        sourceType: o.sourceType,
        inspectionStage: o.inspectionStage,
        specCode: o.specCode,
        specVersion: o.specVersion,
        unitNo: o.unitNo,
        materialCode: o.materialCode,
        quantity: o.quantity,
        uomCode: o.uomCode,
        productionOrderNo: o.productionOrderNo,
        productionDeptName: o.productionDeptName,
        plantId: o.plantId,
        status: o.status,
        statusLabel: QUALITY_ORDER_STATUS_LABELS[o.status] ?? o.status,
        businessTime: o.businessTime,
        effectiveConclusion:
          effective === null
            ? null
            : {
                version: effective.version,
                conclusion: effective.conclusion,
                resultKind: effective.resultKind,
                inspector: effective.inspector,
                inspectedAt: effective.inspectedAt,
              },
        latestDisposition:
          disposition === null
            ? null
            : {
                dispositionKind: disposition.dispositionKind,
                basedOnVersion: disposition.basedOnVersion,
                releasedBy: disposition.releasedBy,
                releasedAt: disposition.releasedAt,
                reason: disposition.reason,
              },
        activeHold:
          hold === null
            ? null
            : {
                holdKind: hold.holdKind,
                holdKindLabel: QUALITY_HOLD_KIND_LABELS[hold.holdKind] ?? hold.holdKind,
                raisedAt: hold.raisedAt,
              },
      }
    })
    const batchDtos: AiQualityBatchRowDto[] = batchRows.map((b) => ({
      family: 'purchase_batch',
      id: b.id,
      batchNo: b.batchNo,
      orderNo: b.orderNo,
      lineNo: b.lineNo,
      materialCode: b.materialCode,
      materialName: b.materialName,
      receivedQty: b.receivedQty,
      uomCode: b.uomCode,
      inspectionStatus: b.inspectionStatus,
      inspectionStatusLabel:
        BATCH_INSPECTION_STATUS_LABELS[b.inspectionStatus as keyof typeof BATCH_INSPECTION_STATUS_LABELS] ?? b.inspectionStatus,
      storageStatus: b.storageStatus,
      plantId: b.plantId,
      arrivalTime: b.arrivalTime,
      confirmTime: b.confirmTime,
      detailQualitySummary: (summaryByBatch.get(b.id) ?? []).map((s) => ({
        qualityStatus: s.qualityStatus,
        qualityStatusLabel: DETAIL_QUALITY_STATUS_LABELS[s.qualityStatus] ?? s.qualityStatus,
        count: s.count,
      })),
    }))

    const data: AiQualityResultDto = {
      capabilityId: 'aq.quality',
      timeRange: { from: params.timeRange.from, to: params.timeRange.to, defaultApplied: params.timeRange.defaultApplied },
      objectScope: params.objectScope,
      inspectionOrders: inspectionDtos,
      purchaseBatches: batchDtos,
    }
    const fetchedRows = inspectionDtos.length + batchDtos.length
    const effectiveFilters: Record<string, unknown> = {
      objectScope: params.objectScope,
      timeRange: params.timeRange,
      conclusions: params.conclusions,
      inspectionStages: params.inspectionStages,
      orderNoLike: params.orderNoLike,
      page: params.page,
    }
    const freshness: AiQueryFreshnessDto = { queriedAt: startedAt.toISOString(), sources: qualityFreshness(inspectionRows) }
    if (page.total === 0) {
      return {
        status: 'ok_no_records',
        message: '[AQ-REG-08] 过滤条件有效但无匹配对象：该时间范围内无符合条件的检验单/来料批次',
        data,
        completeness: { truncated: false, fetchedRows: 0, totalKnown: true, total: 0, page: params.page },
        freshness,
        effectiveFilters,
        notes,
        rowCount: 0,
        truncated: false,
      }
    }
    return {
      status: 'ok_with_data',
      message: `查询成功：时间范围内共 ${String(page.total)} 条检验对象（检验单 ${String(inspectionDtos.length)} + 来料批次 ${String(batchDtos.length)}，本页 ${String(fetchedRows)} 条）；结果只含判定/状态/处置事实，解释性文字由 AI 生成并标注为推测`,
      data,
      completeness: { truncated: false, fetchedRows, totalKnown: true, total: page.total, page: params.page },
      freshness,
      effectiveFilters,
      notes,
      rowCount: fetchedRows,
      truncated: false,
    }
  }
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 注册行口径参数 requirementBase（'per_unit'/'total'；未配置=null=口径未定，GAP-P4）。 */
function readRequirementBase(row: AiCapabilityRegistryRecord): 'per_unit' | 'total' | null {
  const raw = row.definition.caliberParams['requirementBase']
  return raw === 'per_unit' || raw === 'total' ? raw : null
}

function maxUpdatedAt(values: readonly string[]): string {
  if (values.length === 0) return 'unknown'
  return values.reduce((a, b) => (a >= b ? a : b))
}

function qualityFreshness(inspectionRows: ReadonlyArray<{ updatedAt: string }>): AiQueryFreshnessSourceDto[] {
  return [
    { source: 'quality_inspection_order', updatedAt: maxUpdatedAt(inspectionRows.map((o) => o.updatedAt)) },
    // 下列源读取列清单不含 updated_at（quality_test_result/quality_disposition/
    // purchase_receipt_batch/receipt_detail 白名单列），按 AQ-REG-07 如实标 unknown
    { source: 'quality_test_result', updatedAt: 'unknown' },
    { source: 'quality_disposition', updatedAt: 'unknown' },
    { source: 'quality_hold', updatedAt: 'unknown' },
    { source: 'purchase_receipt_batch', updatedAt: 'unknown' },
    { source: 'receipt_detail', updatedAt: 'unknown' },
  ]
}

const QUALITY_ORDER_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: '待检',
  in_progress: '检验中',
  concluded: '已出结论',
  cancelled: '已作废',
}

const QUALITY_HOLD_KIND_LABELS: Readonly<Record<string, string>> = {
  pending_inspection: '待检隔离',
  unqualified: '不合格隔离',
  suspect: '质量存疑',
}

const DETAIL_QUALITY_STATUS_LABELS: Readonly<Record<string, string>> = {
  exempt: '免检',
  pending_inspection: '待检',
  qualified: '合格',
  unqualified: '不合格',
  re_inspection: '复检中',
}

/** The business store receives fixed state values only; messages/params/results stay in apps/ai. */
function runtimeEventState(kind: AiRuntimeEventRecord['kind'], event: Record<string, unknown>): Record<string, unknown> {
  if (kind === 'turn_outcome' && typeof event['outcome'] === 'string' && ['answer', 'clarify', 'unavailable', 'cancelled'].includes(event['outcome'])) {
    return { outcome: event['outcome'] }
  }
  if (kind === 'tool_call') {
    const result = event['result'] as Record<string, unknown> | undefined
    const status = event['status'] ?? result?.['status']
    if (typeof status === 'string' && ['ok_with_data', 'ok_no_records', 'no_permission', 'not_supported', 'source_not_ready', 'timeout', 'failed'].includes(status)) return { status }
  }
  return {}
}
