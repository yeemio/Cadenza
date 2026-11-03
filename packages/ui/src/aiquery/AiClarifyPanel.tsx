/**
 * 澄清选项面板（P4-UI 线新增；AQ-AMB-01/02/03——选项来自结构化 options[]，
 * 不由模型/前端编造〔DS-08〕；用户选择后带精确参数重发）。
 */

import type { AiClarifyOptionDto } from '../api/p4/types'
import { t, tx } from '../i18n'

const KIND_LABELS: Record<string, string> = {
  order_candidate: '订单候选',
  time_range: '时间范围',
  caliber: '口径选择',
}

/** 澄清面板：question 文案 + 结构化选项按钮（选择后由页面带 clarifyOptionId 重发）。 */
export function AiClarifyPanel({
  question,
  options,
  onSelect,
  disabled = false,
}: {
  question: string
  options: AiClarifyOptionDto[]
  onSelect: (option: AiClarifyOptionDto) => void
  disabled?: boolean
}) {
  return (
    <section
      data-testid="ai-clarify-panel"
      aria-label={t('澄清选项')}
      style={{ border: '1px solid var(--cz-color-border)', borderRadius: 8, padding: 14, background: 'var(--cz-color-bg-surface)', marginTop: 8 }}
    >
      <div style={{ fontSize: 13, marginBottom: 8 }}>{question}</div>
      <div style={{ display: 'grid', gap: 8 }}>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(option)}
            style={{
              textAlign: 'left',
              padding: '10px 12px',
              borderRadius: 6,
              border: '1px solid var(--cz-color-border)',
              background: 'var(--cz-color-bg)',
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.6 : 1,
            }}
          >
            <div style={{ fontSize: 14 }}>
              {option.kind ? <span style={{ fontSize: 12, color: 'var(--cz-color-text-secondary)', marginRight: 8 }}>[{tx(KIND_LABELS[option.kind]) ?? option.kind}]</span> : null}
              {option.label}
            </div>
            {option.detail ? (
              <div style={{ fontSize: 12, color: 'var(--cz-color-text-secondary)', marginTop: 4 }}>
                {Object.entries(option.detail)
                  .map(([key, value]) => `${key}：${value}`)
                  .join('｜')}
              </div>
            ) : null}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 12, color: 'var(--cz-color-text-secondary)', marginTop: 8 }}>
        {t('选项来自系统查询结果（结构化候选），选择后将按精确参数重新执行；不会替您自行择一作答。')}
      </div>
    </section>
  )
}
