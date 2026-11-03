import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Button, Message, PageContainer, Textarea, t as $t } from '@cadenza/ui'
import { apiMode, loadSession } from '../../api'
import {
  createAiQueryClient,
  formatAiQueryError,
  newAiRequestId,
  type AiAskTurnResponseDto,
  type AiClarifyOptionDto,
  type AiQueryClient,
  type AiUnavailableReasonDtoValue,
} from '../../../../../packages/ui/src/api/p4'
import { AiClarifyPanel, AiExplainNote, AiResultCard, AiUnavailableNotice } from '../../../../../packages/ui/src/aiquery'
import { ImBindingCodePanel } from '../binding/ImBindingCodePanel'
import { AIQUERY_USE, useP4Permissions } from '../permissions'

/**
 * 问数页（P4-UI 线新增，web 主入口）：
 * - 提问输入与上下文（会话轮次：本地会话状态经接入层 POST /aiquery/sessions 登记，AR-01）；
 * - 发起问数轮，呈现 DS-23 四态 outcome：answer（信封六段结果卡片）/ clarify（结构化选项，
 *   选择后带精确参数重发，AQ-AMB-01/02）/ unavailable（降级态+原因类别，AR-11）/ cancelled（取消确认，DS-11）；
 * - 健康探测经接入层代理面（不直连 apps/ai，AR-03/04）；不可用时入口降级、可重试，
 *   不影响其它生产功能区（AR-06/AR-11 故障隔离——本页状态自包含，不写共享状态）；
 * - 权限：入口需登录会话（路由挂载于 RequireAuth 内，[L0-整合标记] 见 mount.tsx）；
 *   无 aiquery.use 时显示无权限态并引导走业务页面（AQ-AUTH-02）。
 */

const env = import.meta.env as Record<string, string | undefined>

/** 问数客户端（经接入层；mock 模式走演示场景脚本——见 packages/ui/src/api/p4/mock.ts） */
export function createWebAiQueryClient(onUnauthorized: () => void): AiQueryClient {
  return createAiQueryClient({
    mode: apiMode,
    baseURL: env.VITE_API_BASE_URL ?? 'http://127.0.0.1:3001',
    getToken: () => loadSession()?.token ?? null,
    onUnauthorized,
  })
}

type HealthState =
  | { phase: 'probing' }
  | { phase: 'ok' }
  | { phase: 'down'; reason: AiUnavailableReasonDtoValue | null; message: string }

interface ErrorTurn {
  kind: 'error'
  title: string
  detail?: string
}

type TurnEntry =
  | { kind: 'user'; text: string }
  | { kind: 'ai'; resp: AiAskTurnResponseDto }
  | ErrorTurn

function statusDetailText(detail: Record<string, unknown> | null): string | null {
  if (!detail) return null
  const text = Object.entries(detail)
    .map(([k, v]) => `${k}=${typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}`)
    .join('；')
  return text ? $t('阶段细节：{p0}', { p0: text }) : null
}

export function AiQueryPage() {
  const { has } = useP4Permissions()
  const canUse = has(AIQUERY_USE)

  const [health, setHealth] = useState<HealthState>({ phase: 'probing' })
  const [turns, setTurns] = useState<TurnEntry[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [sessionOpening, setSessionOpening] = useState(false)

  const sessionRef = useRef<{ sessionId: string } | null>(null)
  const activeRequestIdRef = useRef<string | null>(null)
  const settledCancelledRef = useRef<Set<string>>(new Set())
  const lastQuestionRef = useRef<string>('')
  /** 待答复澄清轮的 requestId（AQ-AMB-04：澄清轮计入同一 requestId 的会话，延续不另开） */
  const pendingClarifyRequestIdRef = useRef<string | null>(null)
  const unauthorizedRef = useRef<(() => void) | null>(null)

  const aiClient = useMemo(() => createWebAiQueryClient(() => unauthorizedRef.current?.()), [])

  const probeHealth = useCallback(async () => {
    setHealth({ phase: 'probing' })
    const resp = await aiClient.health()
    if (resp.status === 'ok') {
      setHealth({ phase: 'ok' })
    } else {
      setHealth({ phase: 'down', reason: resp.reason, message: resp.message })
    }
  }, [aiClient])

  useEffect(() => {
    unauthorizedRef.current = () => setTurns((prev) => [
      ...prev,
      { kind: 'error', title: $t('登录会话已过期，请重新登录后继续'), detail: $t('AI 问数与生产业务共用同一登录会话（OA 同源）') },
    ])
    void probeHealth()
    return () => {
      unauthorizedRef.current = null
    }
  }, [probeHealth])

  const appendAiTurn = useCallback((resp: AiAskTurnResponseDto) => {
    // 取消终态以先到者为准（cancelTurn 回执与 askTurn 回执同形 cancelled，去重）
    if (resp.outcome === 'cancelled') {
      if (settledCancelledRef.current.has(resp.requestId)) return
      settledCancelledRef.current.add(resp.requestId)
    }
    // 澄清轮记待答复 requestId（AQ-AMB-04：答复延续同一 requestId）
    if (resp.outcome === 'clarify') pendingClarifyRequestIdRef.current = resp.requestId
    setTurns((prev) => [...prev, { kind: 'ai', resp }])
  }, [])

  const ask = useCallback(
    async (text: string, clarifyOption?: AiClarifyOptionDto) => {
      if (busy) return
      const question = clarifyOption ? $t('已选择：{p0}', { p0: clarifyOption.label }) : text.trim()
      if (!clarifyOption && !question) return
      lastQuestionRef.current = clarifyOption ? lastQuestionRef.current : question

      if (!sessionRef.current) {
        setSessionOpening(true)
        try {
          const session = await aiClient.openSession({ channel: 'web' })
          sessionRef.current = session
        } catch (err) {
          setSessionOpening(false)
          const { title, detail } = formatAiQueryError(err as { code?: string; message?: string; requestId?: string })
          setTurns((prev) => [...prev, { kind: 'user', text: question }, { kind: 'error', title, detail }])
          return
        }
        setSessionOpening(false)
      }

      const requestId =
        clarifyOption && pendingClarifyRequestIdRef.current
          ? pendingClarifyRequestIdRef.current
          : newAiRequestId()
      if (clarifyOption) pendingClarifyRequestIdRef.current = null
      activeRequestIdRef.current = requestId
      setBusy(true)
      setTurns((prev) => [...prev, { kind: 'user', text: question }])
      try {
        const resp = await aiClient.askTurn({
          requestId,
          sessionId: sessionRef.current.sessionId,
          userMessage: clarifyOption ? '' : question,
          clarifyOptionId: clarifyOption?.id ?? null,
        })
        appendAiTurn(resp)
      } catch (err) {
        const e = err as { code?: string; message?: string; requestId?: string }
        const { title, detail } = formatAiQueryError(e)
        const degraded = e.code === 'ERR_TIMEOUT' || e.code === 'ERR_NETWORK'
        if (degraded) {
          setTurns((prev) => [
            ...prev,
            { kind: 'ai', resp: { requestId, outcome: 'unavailable', message: title, envelope: null, options: null, unavailableReason: 'unreachable', statusDetail: null } },
          ])
        } else {
          setTurns((prev) => [...prev, { kind: 'error', title, detail }])
        }
      } finally {
        setBusy(false)
        activeRequestIdRef.current = null
      }
    },
    [aiClient, appendAiTurn, busy],
  )

  const cancelInFlight = useCallback(async () => {
    const requestId = activeRequestIdRef.current
    if (!requestId) return
    try {
      const resp = await aiClient.cancelTurn(requestId)
      if (resp.status === 'cancelled') {
        appendAiTurn({
          requestId,
          outcome: 'cancelled',
          message: $t('本轮已取消：取消后不再发起新的工具调用；已完成阶段以回执为准（DS-11）。'),
          envelope: null,
          options: null,
          unavailableReason: null,
          statusDetail: null,
        })
        setBusy(false)
        activeRequestIdRef.current = null
      }
    } catch (err) {
      const { title, detail } = formatAiQueryError(err as { code?: string; message?: string; requestId?: string })
      setTurns((prev) => [...prev, { kind: 'error', title, detail }])
    }
  }, [aiClient, appendAiTurn])

  let body: ReactNode
  if (!canUse) {
    body = (
      <Message kind="warning" title={$t('无 AI 问数权限（aiquery.use）')}>
        <div>
          {$t('未授予 AI 问数模块许可，暂不能使用问数入口；请联系管理员授权（AQ-AUTH-02）。授权前可继续在业务页面查询：')}
          <Link to="/production/orders">{$t('生产订单')}</Link>{$t('、')}<Link to="/inventory/balances">{$t('库存余额')}</Link>{$t('、')}
          <Link to="/quality/inspections">{$t('检验任务')}</Link>{$t('。其它生产功能区不受影响。')}
        </div>
      </Message>
    )
  } else {
    body = (
      <>
        {health.phase === 'probing' ? (
          <Message kind="info" title={$t('正在探测 AI 问数服务可用性…（经接入层代理面，AR-03）')} />
        ) : null}
        {health.phase === 'down' ? (
          <AiUnavailableNotice
            reason={health.reason}
            message={health.message}
            onRetry={() => void probeHealth()}
          />
        ) : null}
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 12 }}>
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={health.phase === 'down' ? $t('AI 问数暂不可用，恢复后可提问') : $t('例如：ORDER-AQ-1001 做到哪一步了？／这张订单缺哪些料？／最近一周哪些检验没通过？')}
            aria-label={$t('问数输入')}
            rows={2}
            disabled={busy || health.phase === 'down'}
            style={{ flex: 1 }}
          />
          <div style={{ display: 'grid', gap: 6 }}>
            <Button
              variant="primary"
              loading={busy || sessionOpening}
              disabled={health.phase === 'down' || (!input.trim() && !busy)}
              onClick={() => {
                const text = input
                setInput('')
                void ask(text)
              }}
            >
              {$t('发起问数')}
            </Button>
            {busy ? (
              <Button variant="secondary" onClick={() => void cancelInFlight()}>
                {$t('取消本轮')}
              </Button>
            ) : null}
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          {turns.map((turn, index) => {
            if (turn.kind === 'user') {
              return (
                <div key={index} style={{ textAlign: 'right', fontSize: 13, margin: '10px 0 2px' }}>
                  <span style={{ background: 'var(--cz-color-primary)', color: '#fff', borderRadius: 8, padding: '6px 10px', display: 'inline-block' }}>
                    {turn.text}
                  </span>
                </div>
              )
            }
            if (turn.kind === 'error') {
              return (
                <div key={index} style={{ marginTop: 8 }}>
                  <Message kind="error" title={turn.title} detail={turn.detail} />
                </div>
              )
            }
            const resp = turn.resp
            const isLastTurn = index === turns.length - 1
            if (resp.outcome === 'answer') {
              return (
                <div key={index}>
                  {resp.envelope ? (
                    <>
                      <AiExplainNote text={resp.message} />
                      <AiResultCard envelope={resp.envelope} />
                    </>
                  ) : (
                    <div style={{ marginTop: 8 }}>
                      <Message kind="info" title={resp.message} />
                    </div>
                  )}
                </div>
              )
            }
            if (resp.outcome === 'clarify') {
              return (
                <AiClarifyPanel
                  key={index}
                  question={resp.message}
                  options={resp.options ?? []}
                  disabled={busy || !isLastTurn}
                  onSelect={(option) => void ask('', option)}
                />
              )
            }
            if (resp.outcome === 'unavailable') {
              return (
                <div key={index}>
                  <AiUnavailableNotice
                    reason={resp.unavailableReason}
                    message={resp.message}
                    detail={statusDetailText(resp.statusDetail)}
                    onRetry={lastQuestionRef.current ? () => void ask(lastQuestionRef.current) : undefined}
                  />
                  {/* 超时/失败已取部分数据随附（完整性标注：未取全不构成完整总量，DS-09） */}
                  {resp.envelope ? <AiResultCard envelope={resp.envelope} /> : null}
                </div>
              )
            }
            return (
              <div key={index} style={{ marginTop: 8 }}>
                <Message kind="info" title={$t('本轮已取消')}>{resp.message}</Message>
              </div>
            )
          })}
        </div>
        {/* 接缝 5 web 签发入口（2026-10-30）：IM 绑定码面板（一次性/有效期/撤销；IM-03） */}
        <ImBindingCodePanel />
      </>
    )
  }

  return (
    <PageContainer
      title={$t('问数')}
      description={$t('向 AI 提问生产/质量/物料数据（只读，经受控查询；结果附来源、时间范围与完整性标注）')}
    >
      {body}
    </PageContainer>
  )
}
