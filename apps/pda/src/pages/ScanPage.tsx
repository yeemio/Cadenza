import { Badge, Message, PageContainer, ScanInput, t as $t } from '@cadenza/ui'
import { useState } from 'react'

/**
 * 扫码输入演示页（PDA 框架层）：
 * - PC-03：页内"扫码"按钮与输入回车/扫码枪共用同一命令入口（ScanInput）；
 * - PC-04：成功、失败各只有一种反馈形态；
 * - PC-05：错码时立即清除上一码的旧对象，不残留；
 * - PC-09：空码不提交，错误后保持可继续操作。
 * 真实码类型字典与任务校验属后续域 WorkItem。
 */
interface ScanFeedback {
  kind: 'success' | 'error'
  code: string
  title: string
  detail?: string
}

export function ScanPage() {
  const [feedback, setFeedback] = useState<ScanFeedback | null>(null)
  const [scanCount, setScanCount] = useState(0)

  const onScan = (code: string) => {
    setScanCount((n) => n + 1)
    if (code.startsWith('MO-')) {
      // 演示：MO- 前缀识别为订单码
      setFeedback({
        kind: 'success',
        code,
        title: $t('识别成功：生产订单码'),
        detail: $t('订单号 {p0}；请进入对应任务执行操作（演示）', { p0: code }),
      })
    } else {
      // PC-05：错码/未识别 → 清除旧对象，只保留本次失败反馈
      setFeedback({
        kind: 'error',
        code,
        title: $t('未识别的码类型'),
        detail: $t('请扫描任务单/库位/物料上的条码；上一码信息已清除'),
      })
    }
  }

  return (
    <PageContainer title={$t('扫码')} description={$t('扫描条码开始操作（键盘楔入模式：扫码枪快速键入+回车自动捕获）')}>
      <ScanInput
        onScan={onScan}
        hint={$t('演示规则：MO- 开头视为订单码（成功）；其他码提示未识别并清除上一码。扫码按钮与侧键等同入口。')}
      />
      <section style={{ marginTop: 14, minHeight: 90 }}>
        {feedback ? (
          feedback.kind === 'success' ? (
            <Message kind="success" title={feedback.title} detail={feedback.detail} />
          ) : (
            <Message kind="error" title={feedback.title} detail={feedback.detail} />
          )
        ) : (
          <Message kind="info" title={$t('等待扫码')}>
            {$t('尚未扫描；可直接在输入框键入后回车，或使用扫码枪（无需聚焦输入框）。')}
          </Message>
        )}
        {feedback ? (
          <p style={{ fontSize: 12.5, color: 'var(--cz-color-text-secondary)', margin: '6px 0 0' }}>
            {$t('本次码值：')}<code>{feedback.code}</code>
          </p>
        ) : null}
      </section>
      <section style={{ marginTop: 18 }}>
        <span style={{ fontSize: 13, color: 'var(--cz-color-text-secondary)', display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          {$t('本机累计扫码次数')} <Badge tone="info">{scanCount}</Badge>
        </span>
      </section>
    </PageContainer>
  )
}
