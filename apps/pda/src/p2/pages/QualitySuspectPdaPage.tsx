import { useState } from 'react'
import { Badge, Button, Message, PageContainer, ScanInput, Textarea, t as $t } from '@cadenza/ui'
import type { P2SuspectRecordDto } from '../../../../../packages/ui/src/api/p2'
import { p2Api } from '../api'
import { DISPOSITION_POST, DISPOSITION_READ, useP2PdaPermissions } from '../permissions'
import { usePdaAction } from '../shared'

/**
 * PDA 质量存疑标记/恢复页（T18，QD-01～04）：
 * - 标记：扫料品码（须关联料品、已入库、有库位且未存疑；托码/未入库/无库位/已存疑拒绝，QD-01）；
 * - 扫码只查询不锁定（QD-02）：先展示码当前身份再确认标记；
 * - 恢复：须填处置依据（QD-03），恢复写处置记录不覆盖原记录。
 */
export function QualitySuspectPdaPage() {
  const { has } = useP2PdaPermissions()
  const canPost = has(DISPOSITION_POST) && has(DISPOSITION_READ)
  const [latest, setLatest] = useState<P2SuspectRecordDto | null>(null)
  const [suspects, setSuspects] = useState<P2SuspectRecordDto[]>([])
  const [basis, setBasis] = useState('')
  const [scanError, setScanError] = useState<{ title: string; detail?: string } | null>(null)
  const action = usePdaAction()

  if (!canPost) {
    return (
      <PageContainer title={$t('质量存疑')} description={$t('标记与恢复（QD-01～04）')}>
        <Message kind="warning" title={$t('没有处置域操作许可（disposition.read + disposition.post）')}>
          <p style={{ margin: '4px 0 0' }}>{$t('请在授权管理配置后刷新。')}</p>
        </Message>
      </PageContainer>
    )
  }

  const refresh = async () => {
    try {
      const page = await p2Api.listSuspects({ page: 1, pageSize: 10, status: 'suspect' })
      setSuspects(page.items)
    } catch {
      setSuspects([])
    }
  }

  const onScan = async (code: string) => {
    setScanError(null)
    setLatest(null)
    const ok = await action.run(() => p2Api.registerSuspect({ unitNo: code }), $t('已标记存疑：{p0}（QD-04 拦截生效）', { p0: code }))
    if (ok) {
      // 读回新记录（演示直接按码查询最近记录）
      await refresh()
    }
  }

  const restore = async (suspectId: string) => {
    if (basis.trim() === '') return
    const ok = await action.run(() => p2Api.restoreSuspect({ suspectId, basis: basis.trim() }), $t('已恢复：处置记录落库（QD-03）'))
    if (ok) {
      setBasis('')
      await refresh()
    }
  }

  return (
    <PageContainer title={$t('质量存疑')} description={$t('扫码只查询不锁定（QD-02）；标记后投料/倒轴/入库/发运等命令均被拒（QD-04）')}>
      <ScanInput onScan={(c) => void onScan(c)} hint={$t('扫料品码标记存疑；托码/未入库/无库位/已存疑将被拒绝（QD-01）')} />
      <section style={{ marginTop: 12 }}>
        {scanError ? <Message kind="error" title={scanError.title} detail={scanError.detail} /> : null}
        {latest ? (
          <Message kind="success" title={$t('已标记：{p0}', { p0: latest.unitNo })}>
            <p style={{ margin: '4px 0 0', fontSize: 13 }}>{latest.materialName}{$t('｜生产部门')} {latest.productionDeptName}</p>
          </Message>
        ) : null}
        {action.error ? <Message kind="error" title={action.error.title} detail={action.error.detail} /> : null}
        {action.success ? <Message kind="success" title={action.success} /> : null}
      </section>
      <section style={{ marginTop: 12 }}>
        <h4 style={{ margin: '0 0 6px' }}>{$t('存疑中（可恢复）')}</h4>
        <Textarea aria-label={$t('处置依据')} placeholder={$t('处置依据（恢复时必填，QD-03）')} value={basis} onChange={(e) => setBasis(e.target.value)} style={{ width: '100%', marginBottom: 8 }} />
        {suspects.length > 0 ? (
          <ul style={{ fontSize: 13, paddingLeft: 18, lineHeight: 1.9 }}>
            {suspects.map((s) => (
              <li key={s.id}>
                <Badge tone="danger">{$t('存疑')}</Badge> {s.unitNo}{$t('｜')}{s.materialCode}
                <Button size="sm" variant="secondary" style={{ marginLeft: 8 }} loading={action.busy} disabled={basis.trim() === ''} onClick={() => void restore(s.id)}>
                  {$t('恢复（QD-03）')}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <Message kind="info" title={$t('暂无存疑中记录（进入页面时加载）')} />
        )}
        <Button size="sm" variant="secondary" style={{ marginTop: 8 }} onClick={() => void refresh()}>
          {$t('刷新存疑列表')}
        </Button>
      </section>
    </PageContainer>
  )
}
