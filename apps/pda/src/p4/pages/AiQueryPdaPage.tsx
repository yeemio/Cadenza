import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Message, Textarea, t as $t } from '@cadenza/ui'
import { apiMode, loadSession } from '../../api'
import {
  createAiQueryClient,
  formatAiQueryError,
  newAiRequestId,
  type AiAskTurnResponseDto,
  type AiClarifyOptionDto,
  type AiQueryClient,
} from '../../../../../packages/ui/src/api/p4'
import { AiClarifyPanel, AiExplainNote, AiResultCard, AiUnavailableNotice } from '../../../../../packages/ui/src/aiquery'
import { AIQUERY_USE, useP4Permissions } from '../permissions'

/**
 * 问数页（P4-UI 线新增，PDA 可选入口；LP P4-UI 行）：
 * 与 web 主入口同构（四态 outcome/澄清/降级/取消），差异：
 * - channel='pda'（会话登记渠道值域）；
 * - 结果卡片 detailLinks=false——PDA 无生产订单/检验详情路由，跳转改为文字提示
 *   「详情请在 Web 工作台查看（跳转后仍需鉴权）」（AR-04：不构造旁路 URL）。
 */

const env = import.meta.env as Record<string, string | undefined>

type TurnEntry =
  | { kind: 'user'; text: string }
  | { kind: 'ai'; resp: AiAskTurnResponseDto }
  | { kind: 'error'; title: string; detail?: string }

export function AiQueryPdaPage() {
  const { has } = useP4Permissions()
  const canUse = has(AIQUERY_USE)
  const [healthOk, setHealthOk] = useState<boolean | null>(null)
  const [turns, setTurns] = useState<TurnEntry[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const sessionRef = useRef<{ sessionId: string } | null>(null)
  const activeRequestIdRef = useRef<string | null>(null)
  const settledCancelledRef = useRef<Set<string>>(new Set())
  /** 待答复澄清轮的 requestId（AQ-AMB-04：澄清轮延续同一 requestId） */
  const pendingClarifyRequestIdRef = useRef<string | null>(null)

  const aiClient = useMemo<AiQueryClient>(
    () =>
      createAiQueryClient({
        mode: apiMode,
        baseURL: env.VITE_API_BASE_URL ?? 'http://127.0.0.1:3001',
        getToken: () => loadSession()?.token ?? null,
      }),
    [],
  )

  const probeHealth = useCallback(async () => {
    setHealthOk(null)
    const resp = await aiClient.health()
    setHealthOk(resp.status === 'ok')
  }, [aiClient])

  useEffect(() => {
    void probeHealth()
  }, [probeHealth])

  const appendAiTurn = useCallback((resp: AiAskTurnResponseDto) => {
    if (resp.outcome === 'cancelled') {
      if (settledCancelledRef.current.has(resp.requestId)) return
      settledCancelledRef.current.add(resp.requestId)
    }
    if (resp.outcome === 'clarify') pendingClarifyRequestIdRef.current = resp.requestId
    setTurns((prev) => [...prev, { kind: 'ai', resp }])
  }, [])

  const ask = useCallback(
    async (text: string, clarifyOption?: AiClarifyOptionDto) => {
      if (busy) return
      const question = clarifyOption ? $t('已选择：{p0}', { p0: clarifyOption.label }) : text.trim()
      if (!clarifyOption && !question) return
      if (!sessionRef.current) {
        try {
          sessionRef.current = await aiClient.openSession({ channel: 'pda' })
        } catch (err) {
          const { title, detail } = formatAiQueryError(err as { code?: string; message?: string })
          setTurns((prev) => [...prev, { kind: 'user', text: question }, { kind: 'error', title, detail }])
          return
        }
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
        appendAiTurn(
          await aiClient.askTurn({
            requestId,
            sessionId: sessionRef.current.sessionId,
            userMessage: clarifyOption ? '' : question,
            clarifyOptionId: clarifyOption?.id ?? null,
          }),
        )
      } catch (err) {
        const e = err as { code?: string; message?: string }
        const { title, detail } = formatAiQueryError(e)
        if (e.code === 'ERR_TIMEOUT' || e.code === 'ERR_NETWORK') {
          appendAiTurn({ requestId, outcome: 'unavailable', message: title, envelope: null, options: null, unavailableReason: 'unreachable', statusDetail: null })
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

  if (!canUse) {
    return (
      <Message kind="warning" title={$t('无 AI 问数权限（aiquery.use）')}>
        {$t('未授予 AI 问数模块许可，请联系管理员授权（AQ-AUTH-02）；本机其它现场功能不受影响。')}
      </Message>
    )
  }

  return (
    <div style={{ padding: 12 }}>
      <h2 style={{ fontSize: 16, margin: '0 0 8px' }}>{$t('问数')}</h2>
      {healthOk === null ? <Message kind="info" title={$t('正在探测 AI 问数服务可用性…')} /> : null}
      {healthOk === false ? (
        <AiUnavailableNotice reason={null} message={$t("AI 问数暂不可用（探测经接入层代理面）[AR-11]")} onRetry={() => void probeHealth()} />
      ) : null}
      <Textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        aria-label={$t('问数输入')}
        rows={2}
        disabled={busy || healthOk === false}
        placeholder={$t('例如：ORDER-AQ-1001 做到哪一步了？')}
        style={{ width: '100%', marginTop: 8, boxSizing: 'border-box' }}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <Button
          variant="primary"
          block
          loading={busy}
          disabled={healthOk === false || !input.trim()}
          onClick={() => {
            const text = input
            setInput('')
            void ask(text)
          }}
        >
          {$t('发起问数')}
        </Button>
        {busy ? (
          <Button
            variant="secondary"
            onClick={async () => {
              const requestId = activeRequestIdRef.current
              if (!requestId) return
              const resp = await aiClient.cancelTurn(requestId)
              if (resp.status === 'cancelled') {
                appendAiTurn({
                  requestId,
                  outcome: 'cancelled',
                  message: $t('本轮已取消：取消后不再发起新的工具调用（DS-11）。'),
                  envelope: null,
                  options: null,
                  unavailableReason: null,
                  statusDetail: null,
                })
                setBusy(false)
                activeRequestIdRef.current = null
              }
            }}
          >
            {$t('取消本轮')}
          </Button>
        ) : null}
      </div>
      <div>
        {turns.map((turn, index) => {
          if (turn.kind === 'user') {
            return (
              <div key={index} style={{ textAlign: 'right', fontSize: 13, margin: '10px 0 2px' }}>
                <span style={{ background: 'var(--cz-color-primary)', color: '#fff', borderRadius: 8, padding: '6px 10px', display: 'inline-block' }}>{turn.text}</span>
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
            return resp.envelope ? (
              <div key={index}>
                <AiExplainNote text={resp.message} />
                <AiResultCard envelope={resp.envelope} detailLinks={false} />
              </div>
            ) : (
              <div key={index} style={{ marginTop: 8 }}>
                <Message kind="info" title={resp.message} />
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
                <AiUnavailableNotice reason={resp.unavailableReason} message={resp.message} onRetry={() => void probeHealth()} />
                {resp.envelope ? <AiResultCard envelope={resp.envelope} detailLinks={false} /> : null}
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
    </div>
  )
}
