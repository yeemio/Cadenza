import { useCallback, useEffect, useState } from 'react'
import { Badge, Button, Input, Message, Modal, PageContainer, Table, Textarea, t as $t } from '@cadenza/ui'
import {
  BATCH_QUALITY_STATUS_LABELS,
  IQC_CODE_CONCLUSION_LABELS,
  IQC_SCOPE_LABELS,
  type IqcBatchViewDto,
} from '../../../../../packages/ui/src/api/p2'
import { p2Api } from '../api'
import { DISPOSITION_POST, DISPOSITION_READ, useP2Permissions } from '../permissions'
import { useP2ActionState } from '../shared'

/**
 * 采购质检结论版本链页（T18，QD-11～18）：
 * - 版本链 append-only＋当前生效指针：同码首检→（至多一次）复检，历史版本可查（QD-S2）；
 * - 批量写入仅对当前生效质检行仍为待质检的码（QD-11）；免检码不可提交结论（QD-12）；
 * - 判定备注必填（≤200 非纯空白，QD-13）；复检仅一次（QD-14）；
 * - 已退货批次硬拦截（QD-17）；复检仍不合格不自动转合格（QD-18，终态处置待裁）。
 * PDA 单码结论入口见 /p2/iqc-code。
 */
export function IqcVersionPage() {
  const { has } = useP2Permissions()
  const canRead = has(DISPOSITION_READ)
  const canPost = has(DISPOSITION_POST)
  const [batchNo, setBatchNo] = useState('LOT-20261027-05')
  const [batch, setBatch] = useState<IqcBatchViewDto | null>(null)
  const [loadError, setLoadError] = useState<{ title: string; detail?: string } | null>(null)
  const [judgeOpen, setJudgeOpen] = useState(false)
  const [remark, setRemark] = useState('')
  const [autoLoaded, setAutoLoaded] = useState(false)
  const action = useP2ActionState()

  const load = useCallback(async () => {
    try {
      setBatch(await p2Api.getIqcBatch(batchNo))
      setLoadError(null)
    } catch (err) {
      setBatch(null)
      setLoadError({ title: $t('批次不存在或不在授权数据范围内'), detail: err instanceof Error ? err.message : undefined })
    }
  }, [batchNo])

  // 挂载即按默认批次号带出版本链（输入变化不自动重查，手动点查询批次）
  useEffect(() => {
    if (!autoLoaded) {
      setAutoLoaded(true)
      void load()
    }
  }, [autoLoaded, load])

  const doBatchWrite = useCallback(async () => {
    if (!batch) return
    await action.run(
      () =>
        p2Api.iqcBatchWrite({
          batchNo: batch.batchNo,
          codeResults: batch.codes.filter((c) => c.currentConclusion === 'pending_inspection').map((c) => ({ code: c.code, conclusion: 'qualified' as const })),
        }),
      $t('批量写入已提交（仅待质检码，QD-11）'),
    )
    await load()
  }, [action, batch, load])

  const doRecheck = useCallback(async () => {
    if (!batch) return
    await action.run(() => p2Api.iqcRecheck({ batchNo: batch.batchNo }), $t('复检已发起（仅一次，QD-14）'))
    await load()
  }, [action, batch, load])

  const submitJudge = useCallback(async () => {
    if (!batch) return
    const ok = await action.run(() => p2Api.iqcJudge({ batchNo: batch.batchNo, judgement: 'unqualified', remark }), $t('批次判定已提交（QD-13）'))
    if (ok) {
      setJudgeOpen(false)
      setRemark('')
      await load()
    }
  }, [action, batch, load, remark])

  if (!canRead) {
    return (
      <PageContainer title={$t('采购质检版本链')} description={$t('结论版本链与批次判定（quality-disposition 合同 QD-11～18）')}>
        <Message kind="warning" title={$t('没有处置域查询许可（disposition.read）')}>
          <p style={{ margin: '4px 0 0' }}>{$t('请在授权管理中为当前角色配置 disposition.read 后刷新。')}</p>
        </Message>
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('采购质检版本链')}
      description={$t('结论 append-only＋当前生效指针（QD-S2）；批次状态按各码当前生效结论汇总（QD-15，可重算投影）')}
      actions={
        <span style={{ display: 'inline-flex', gap: 6 }}>
          <Input style={{ width: 190 }} placeholder={$t('批次号')} value={batchNo} onChange={(e) => setBatchNo(e.target.value)} />
          <Button size="sm" onClick={() => void load()}>
            {$t('查询批次')}
          </Button>
        </span>
      }
    >
      {loadError ? <Message kind="error" title={loadError.title} detail={loadError.detail} /> : null}
      {action.actionError ? <Message kind="error" title={action.actionError.title} detail={action.actionError.detail} /> : null}
      {action.actionSuccess ? <Message kind="success" title={action.actionSuccess} /> : null}
      {batch ? (
        <>
          <p style={{ fontSize: 13.5 }}>
            {$t('批次')} <b>{batch.batchNo}</b> {$t('｜质检状态')}{' '}
            <Badge tone={batch.qualityStatus === 'all_qualified' ? 'success' : batch.qualityStatus === 'inspecting' ? 'warning' : 'danger'}>
              {BATCH_QUALITY_STATUS_LABELS[batch.qualityStatus]}
            </Badge>
            {batch.returned ? <Badge tone="danger">{$t('已退货（QD-17 硬拦截）')}</Badge> : null}
          </p>
          <div style={{ display: 'inline-flex', gap: 8, marginBottom: 10 }}>
            {canPost ? (
              <>
                <Button size="sm" onClick={() => void doBatchWrite()}>
                  {$t('批量写入合格（QD-11，仅待质检码）')}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setJudgeOpen(true)}>
                  {$t('批次判定（QD-13）')}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => void doRecheck()}>
                  {$t('发起复检（QD-14，仅一次）')}
                </Button>
              </>
            ) : null}
          </div>
          <h4>{$t('码级当前生效结论')}</h4>
          <Table
            columns={[
              { key: 'code', title: $t('码') },
              {
                key: 'currentConclusion',
                title: $t('当前生效结论'),
                render: (c) => (
                  <Badge tone={c.currentConclusion === 'qualified' ? 'success' : c.currentConclusion === 'unqualified' ? 'danger' : 'warning'}>
                    {IQC_CODE_CONCLUSION_LABELS[c.currentConclusion]}
                  </Badge>
                ),
              },
              { key: 'versionCount', title: $t('版本数') },
              { key: 'rechecked', title: $t('已复检（QD-14）'), render: (c) => (c.rechecked ? $t('是（复检行操作）') : $t('否')) },
            ]}
            rows={batch.codes}
            rowKey={(c) => c.code}
            emptyText={$t('无码')}
          />
          <h4 style={{ marginTop: 14 }}>{$t('版本链（历史可查，QD-S2）')}</h4>
          <Table
            columns={[
              { key: 'version', title: $t('版本（悬停显码）'), render: (v) => <span title={v.code ?? undefined}>{$t('第')} {v.version} {$t('版')}</span> },
              {
                key: 'scope',
                title: $t('范围'),
                render: (v) => <Badge tone={v.scope === 'recheck' ? 'warning' : 'info'}>{IQC_SCOPE_LABELS[v.scope]}</Badge>,
              },
              {
                key: 'conclusion',
                title: $t('结论'),
                render: (v) => <Badge tone={v.conclusion === 'qualified' ? 'success' : 'danger'}>{v.conclusion === 'qualified' ? $t('合格') : $t('不合格')}</Badge>,
              },
              { key: 'remark', title: $t('备注'), render: (v) => v.remark ?? '—' },
              { key: 'attachmentCount', title: $t('附件数') },
              { key: 'createdBy', title: $t('提交人') },
              { key: 'createdAt', title: $t('提交时间'), render: (v) => new Date(v.createdAt).toLocaleString('zh-CN') },
              { key: 'current', title: $t('当前生效'), render: (v) => (v.current ? <Badge tone="success">{$t('是')}</Badge> : <Badge>{$t('否')}</Badge>) },
            ]}
            rows={batch.versions}
            rowKey={(v) => v.id}
            emptyText={$t('暂无版本')}
          />
        </>
      ) : (
        <Message kind="info" title={$t('输入批次号查询版本链')} />
      )}
      <Modal
        open={judgeOpen}
        title={$t('批次判定 {p0}', { p0: batch?.batchNo ?? '' })}
        onClose={() => setJudgeOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setJudgeOpen(false)}>
              {$t('取消')}
            </Button>
            <Button loading={action.busy} disabled={remark.trim() === ''} onClick={() => void submitJudge()}>
              {$t('提交判定')}
            </Button>
          </>
        }
      >
        <p style={{ fontSize: 13.5, marginTop: 0 }}>{$t('判定备注必填（≤200 非纯空白，QD-13）；判定范围按批次当前状态限定。')}</p>
        <Textarea aria-label={$t('判定备注')} placeholder={$t('判定备注（必填，≤200）')} value={remark} onChange={(e) => setRemark(e.target.value)} style={{ width: '100%' }} />
      </Modal>
    </PageContainer>
  )
}
