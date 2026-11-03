import { useCallback, useState } from 'react'
import { Button, Message, t as $t } from '@cadenza/ui'
import { loadSession } from '../../api'

/**
 * IM 绑定码面板（P4 五内部接缝补齐轮 2026-10-30，接缝 5 的 web 签发入口：
 * 登录用户 → 生成一次性绑定码 → IM 端凭码绑定身份，带有效期与撤销，IM-03）。
 *
 * - 只消费接入层端点（AR-04：/aiquery/im/binding-codes；用户令牌 + aiquery.use，
 *   服务端终校）；绑定码不是授权——每次查询仍实时重验（IM-03/AQ-AUTH-01）；
 * - 明文码仅签发应答显示一次（服务端只存 sha-256 摘要）；单活动码语义：
 *   新签发自动撤销此前 issued 码；
 * - 挂载于问数页（apps/web/src/p4/pages/AiQueryPage.tsx）；无自动加载——
 *   用户点按才发请求（不干扰既有页面测试与降级态）。
 */

const env = import.meta.env as Record<string, string | undefined>
const BASE_URL = env.VITE_API_BASE_URL ?? 'http://127.0.0.1:3001'

export interface ImBindingCodeIssued {
  id: string
  code: string
  expiresAt: string
  status: 'issued'
}

export interface ImBindingCodeRow {
  id: string
  status: 'issued' | 'used' | 'revoked' | 'expired'
  issuedAt: string
  expiresAt: string
  usedAt: string | null
  usedChannel: string | null
  usedPlatformUserId: string | null
  revokedAt: string | null
}

interface ApiErrorShape {
  code?: string
  message?: string
}

async function callBindingCodesApi<T>(path: string, method: 'GET' | 'POST'): Promise<T> {
  const token = loadSession()?.token ?? null
  // jsdom 域无 AbortSignal.timeout（先例 p3/client.ts abortSignalOf 同因）：能力探测降级去信号
  const timeoutSignalCtor = globalThis.AbortSignal
  const signal = timeoutSignalCtor && typeof timeoutSignalCtor.timeout === 'function' ? timeoutSignalCtor.timeout(10_000) : undefined
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      ...(token !== null ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: method === 'POST' ? '{}' : undefined,
    signal,
  })
  const parsed = (await response.json().catch(() => null)) as unknown
  if (!response.ok) {
    const err = (parsed ?? {}) as ApiErrorShape
    const error = new Error(err.message ?? `请求失败（HTTP ${String(response.status)}）`) as Error & ApiErrorShape
    error.code = err.code
    throw error
  }
  return parsed as T
}

export function issueImBindingCode(): Promise<ImBindingCodeIssued> {
  return callBindingCodesApi<ImBindingCodeIssued>('/aiquery/im/binding-codes', 'POST')
}

export function listImBindingCodes(): Promise<{ items: ImBindingCodeRow[]; total: number }> {
  return callBindingCodesApi<{ items: ImBindingCodeRow[]; total: number }>('/aiquery/im/binding-codes', 'GET')
}

export function revokeImBindingCode(id: string): Promise<{ id: string; status: 'revoked' }> {
  return callBindingCodesApi<{ id: string; status: 'revoked' }>(`/aiquery/im/binding-codes/${encodeURIComponent(id)}/revoke`, 'POST')
}

const STATUS_LABELS: Record<ImBindingCodeRow['status'], string> = {
  issued: '待使用',
  used: '已使用',
  revoked: '已撤销',
  expired: '已过期',
}

function formatTime(iso: string | null): string {
  if (iso === null) return '—'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

export function ImBindingCodePanel() {
  const [busy, setBusy] = useState(false)
  const [issued, setIssued] = useState<ImBindingCodeIssued | null>(null)
  const [rows, setRows] = useState<ImBindingCodeRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const generate = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await issueImBindingCode()
      setIssued(result)
      setRows(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [busy])

  const refresh = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await listImBindingCodes()
      setRows(result.items)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [busy])

  const revoke = useCallback(
    async (id: string) => {
      if (busy) return
      setBusy(true)
      setError(null)
      try {
        await revokeImBindingCode(id)
        const result = await listImBindingCodes()
        setRows(result.items)
        setIssued((prev) => (prev !== null && prev.id === id ? null : prev))
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [busy],
  )

  return (
    <section data-testid="im-binding-code-panel" style={{ marginTop: 24, borderTop: '1px solid var(--cz-color-border, #e5e7eb)', paddingTop: 12 }}>
      <h3 style={{ fontSize: 14, margin: '0 0 4px' }}>{$t('IM 渠道绑定码（一次性，有效期与撤销）')}</h3>
      <p style={{ fontSize: 12, color: 'var(--cz-color-text-secondary, #6b7280)', margin: '0 0 8px' }}>
        {$t('生成后请在有效期内到 IM 个人会话发送该绑定码完成身份绑定。绑定只建立对应关系，不等于授权——每次查询仍按你的账号权限实时校验（IM-03/AQ-AUTH-01）。')}
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="primary" loading={busy} onClick={() => void generate()} data-testid="im-binding-code-issue">
          {$t('生成绑定码')}
        </Button>
        <Button variant="secondary" loading={busy} onClick={() => void refresh()} data-testid="im-binding-code-refresh">
          {$t('查看绑定码状态')}
        </Button>
      </div>
      {error !== null ? (
        <div style={{ marginTop: 8 }}>
          <Message kind="error" title={$t('绑定码操作失败')} detail={error} />
        </div>
      ) : null}
      {issued !== null ? (
        <div data-testid="im-binding-code-issued" style={{ marginTop: 8, padding: 8, border: '1px dashed var(--cz-color-border, #e5e7eb)', borderRadius: 8 }}>
          <div>
            {$t('绑定码：')}<code data-testid="im-binding-code-value" style={{ fontSize: 16, letterSpacing: 2 }}>{issued.code}</code>
          </div>
          <div style={{ fontSize: 12, color: 'var(--cz-color-text-secondary, #6b7280)' }}>
            {$t('有效期至 {p0}（明文码仅此一次显示，服务端只存摘要）', { p0: formatTime(issued.expiresAt) })}
          </div>
        </div>
      ) : null}
      {rows !== null ? (
        <div data-testid="im-binding-code-list" style={{ marginTop: 8 }}>
          {rows.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--cz-color-text-secondary, #6b7280)' }}>{$t('暂无绑定码记录')}</div>
          ) : (
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>{$t('签发时间')}</th>
                  <th style={{ textAlign: 'left' }}>{$t('状态')}</th>
                  <th style={{ textAlign: 'left' }}>{$t('过期时间')}</th>
                  <th style={{ textAlign: 'left' }}>{$t('使用渠道/平台身份')}</th>
                  <th style={{ textAlign: 'left' }}>{$t('操作')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} data-testid="im-binding-code-row">
                    <td>{formatTime(row.issuedAt)}</td>
                    <td>{STATUS_LABELS[row.status]}</td>
                    <td>{formatTime(row.expiresAt)}</td>
                    <td>
                      {row.usedChannel === null ? '—' : `${row.usedChannel}${row.usedPlatformUserId === null ? '' : ` / ${row.usedPlatformUserId}`}`}
                    </td>
                    <td>
                      {row.status === 'issued' ? (
                        <Button variant="secondary" loading={busy} onClick={() => void revoke(row.id)}>
                          {$t('撤销')}
                        </Button>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}
    </section>
  )
}
