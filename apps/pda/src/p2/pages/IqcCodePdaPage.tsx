import { useState } from 'react'
import { Badge, Button, Input, Message, PageContainer, ScanInput, Select, t as $t } from '@cadenza/ui'
import type { IqcBatchViewDto } from '../../../../../packages/ui/src/api/p2'
import { p2Api } from '../api'
import { DISPOSITION_POST, DISPOSITION_READ, useP2PdaPermissions } from '../permissions'
import { usePdaAction } from '../shared'

/**
 * PDA 采购质检单码结论页（T18，QD-12～14）：
 * - 单码结论追加历史、版本化切换（首检/复检 scope，QD-12）；
 * - 免检码不可提交；已有复检记录须操作复检行（首检不可再改，QD-12）；
 * - 复检仅一次（QD-14）；附件 ≤3；已退货批次硬拦截（QD-17）。
 */
export function IqcCodePdaPage() {
  const { has } = useP2PdaPermissions()
  const canPost = has(DISPOSITION_POST) && has(DISPOSITION_READ)
  const [batchNo, setBatchNo] = useState('LOT-20261027-05')
  const [batch, setBatch] = useState<IqcBatchViewDto | null>(null)
  const [code, setCode] = useState('')
  const [conclusion, setConclusion] = useState<'qualified' | 'unqualified'>('qualified')
  const [scope, setScope] = useState<'first' | 'recheck'>('first')
  const [batchErr, setBatchErr] = useState<string | undefined>(undefined)
  const action = usePdaAction()

  if (!canPost) {
    return (
      <PageContainer title={$t('质检单码结论')} description={$t('单码首检/复检（QD-12～14）')}>
        <Message kind="warning" title={$t('没有处置域操作许可（disposition.read + disposition.post）')}>
          <p style={{ margin: '4px 0 0' }}>{$t('请在授权管理配置后刷新。')}</p>
        </Message>
      </PageContainer>
    )
  }

  const load = async () => {
    try {
      setBatch(await p2Api.getIqcBatch(batchNo))
      action.clearFeedback()
    } catch (err) {
      setBatch(null)
      action.clearFeedback()
      setBatchErr(err instanceof Error ? err.message : undefined)
    }
  }

  const submit = async () => {
    if (!batch || !code.trim()) return
    const ok = await action.run(
      () => p2Api.iqcCodeConclusion({ batchNo: batch.batchNo, code: code.trim(), conclusion, scope, attachmentCount: 0 }),
      $t('结论已提交：{p0}（版本化切换，QD-12）', { p0: code }),
    )
    if (ok) {
      setCode('')
      await load()
    }
  }

  const currentCode = batch?.codes.find((c) => c.code === code.trim()) ?? null

  return (
    <PageContainer title={$t('质检单码结论')} description={$t('结论追加历史、版本化切换；免检码不可提交（QD-12）；复检仅一次（QD-14）')}>
      <div style={{ display: 'grid', gap: 6, marginBottom: 10 }}>
        <Input placeholder={$t('批次号')} value={batchNo} onChange={(e) => setBatchNo(e.target.value)} />
        <Button size="sm" variant="secondary" onClick={() => void load()}>
          {$t('查询批次')}
        </Button>
      </div>
      {batchErr ? <Message kind="error" title={$t('批次不存在或不在授权数据范围内')} detail={batchErr} /> : null}
      {batch ? (
        <>
          <section style={{ marginTop: 10 }}>
            <p style={{ margin: '0 0 4px', fontSize: 12.5 }}>{$t('码级当前生效结论（QD-S2）：')}</p>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.8 }}>
              {batch.codes.map((c) => (
                <li key={c.code}>
                  {c.code}{$t('：')}
                  <Badge tone={c.currentConclusion === 'qualified' ? 'success' : c.currentConclusion === 'unqualified' ? 'danger' : 'default'}>
                    {c.currentConclusion === 'pending_inspection' ? $t('待质检') : c.currentConclusion === 'qualified' ? $t('合格') : c.currentConclusion === 'unqualified' ? $t('不合格') : $t('免检')}
                  </Badge>
                  {$t('｜版本')} {c.versionCount}{$t('｜已复检')} {c.rechecked ? $t('是') : $t('否')}
                </li>
              ))}
            </ul>
          </section>
          <ScanInput onScan={(c) => setCode(c)} hint={$t('扫批次内码后提交结论（免检码将被拒绝）')} />
          <section style={{ marginTop: 10, display: 'grid', gap: 6 }}>
            <Input placeholder={$t('码（扫码带出）')} value={code} onChange={(e) => setCode(e.target.value)} />
            <Select
              aria-label={$t('结论')}
              value={conclusion}
              onChange={(e) => setConclusion(e.target.value as 'qualified' | 'unqualified')}
              options={[
                { value: 'qualified', label: $t('合格') },
                { value: 'unqualified', label: $t('不合格') },
              ]}
            />
            <Select
              aria-label={$t('范围')}
              value={scope}
              onChange={(e) => setScope(e.target.value as 'first' | 'recheck')}
              options={[
                { value: 'first', label: $t('首检') },
                { value: 'recheck', label: $t('复检（仅一次，QD-14）') },
              ]}
            />
            {currentCode ? (
              <p style={{ margin: 0, fontSize: 12.5 }}>
                {$t('所选码结论：')}
                <Badge tone={currentCode.currentConclusion === 'qualified' ? 'success' : currentCode.currentConclusion === 'unqualified' ? 'danger' : 'warning'}>
                  {currentCode.currentConclusion === 'pending_inspection' ? $t('待质检') : currentCode.currentConclusion === 'qualified' ? $t('合格') : currentCode.currentConclusion === 'unqualified' ? $t('不合格') : $t('免检')}
                </Badge>
                {$t('｜版本')} {currentCode.versionCount}{$t('｜已复检')} {currentCode.rechecked ? $t('是') : $t('否')}
              </p>
            ) : null}
            <Button loading={action.busy} disabled={code.trim() === ''} onClick={() => void submit()}>
              {$t('提交结论')}
            </Button>
          </section>
        </>
      ) : (
        <Message kind="info" title={$t('输入批次号查询后操作')} />
      )}
      <section style={{ marginTop: 12 }}>
        {action.error ? <Message kind="error" title={action.error.title} detail={action.error.detail} /> : null}
        {action.success ? <Message kind="success" title={action.success} /> : null}
      </section>
    </PageContainer>
  )
}
