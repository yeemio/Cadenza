/**
 * AI 不可用降级提示（P4-UI 线新增；AR-11/DS-24——显示「AI 问数暂不可用」+ 原因类别
 * unreachable/over_limit/starting，可重试；不静默空白、不超时悬挂）。
 * 仅作用于问数入口自身：不阻断页面其它生产功能区（AR-06/AR-11 故障隔离）。
 */

import { Badge } from '../Badge'
import { Button } from '../Button'
import { AI_UNAVAILABLE_REASON_LABELS, type AiUnavailableReasonDtoValue } from '../api/p4/types'
import { t } from '../i18n'

/** 降级横幅：入口级（健康探测失败）或轮次级（outcome=unavailable）。 */
export function AiUnavailableNotice({
  reason,
  message,
  detail,
  onRetry,
  retrying = false,
}: {
  reason: AiUnavailableReasonDtoValue | null
  message?: string
  /** 阶段细节附注（超时 scope/已用工具次数等；不作主文案） */
  detail?: string | null
  onRetry?: () => void
  retrying?: boolean
}) {
  return (
    <div
      data-testid="ai-unavailable-notice"
      role="alert"
      aria-label={t('AI 问数暂不可用')}
      style={{ border: '1px solid var(--cz-color-border)', borderRadius: 8, padding: 14, background: 'var(--cz-color-bg-surface)', marginTop: 8 }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Badge tone="warning">{t('AI 问数暂不可用')}</Badge>
        {reason !== null ? <Badge tone="default">{t('原因：')}{AI_UNAVAILABLE_REASON_LABELS[reason]}</Badge> : null}
      </div>
      {message ? <div style={{ fontSize: 13, marginTop: 6 }}>{message}</div> : null}
      {detail ? <div style={{ fontSize: 12, color: 'var(--cz-color-text-secondary)', marginTop: 4 }}>{detail}</div> : null}
      <div style={{ fontSize: 12, color: 'var(--cz-color-text-secondary)', marginTop: 6 }}>
        {t('生产业务（报工/质检/库存等）不受影响，可继续使用其它功能；可稍后重试或到对应业务页面查询。')}
      </div>
      {onRetry ? (
        <div style={{ marginTop: 8 }}>
          <Button size="sm" variant="secondary" loading={retrying} onClick={onRetry}>
            {t('重试')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
