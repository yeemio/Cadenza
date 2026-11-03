import { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge, Button, Input, Message, PageContainer, ScanInput, t as $t } from '@cadenza/ui'
import {
  formatP3Error,
  type CswOutsourcingTaskView,
  type CswOutsourcingUnitView,
} from '../../../../../packages/ui/src/api/p3'
import { createPdaP3Client } from '../client'
import { CSW_POST, CSW_READ, useP3PdaPermissions } from '../permissions'

/**
 * PDA 外协回厂接收页（CS-21 回厂段 + PC-03/05/09 扫码规范）：
 * 扫/输单元号 → 按已发送（在外加工）任务的单元行匹配任务（PC-04：先识别码类型与对象，
 * 错码立即清除旧对象 PC-05）→ 输入回厂数量（数量与单位同现 PC-06）→ 回厂接收命令
 * （外协在途减＋回厂目的增，两段各自原子）；回厂后默认全部必检（CS-22）。
 * 库存交接类命令必须服务端入账成功才算成功，不做离线假成功（PC-21）。
 */
export function OutsourcingReceivePage() {
  const { has } = useP3PdaPermissions()
  const canRead = has(CSW_READ)
  const canPost = has(CSW_POST)
  const client = useMemo(() => createPdaP3Client(), [])
  const [tasks, setTasks] = useState<CswOutsourcingTaskView[]>([])
  const [scanValue, setScanValue] = useState('')
  const [matched, setMatched] = useState<{ task: CswOutsourcingTaskView; unit: CswOutsourcingUnitView } | null>(null)
  const [quantity, setQuantity] = useState('')
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    if (!canRead) return
    client
      .cswListOutsourcingTasks({ page: 1, pageSize: 20, status: 'sent' })
      .then((page) => setTasks(page.items))
      .catch(() => setTasks([]))
  }, [canRead, client])

  useEffect(() => {
    load()
  }, [load])

  /** PC-04/05：先识别码类型与对象（单元码 → 已发送任务的单元行），错码立即清除不适用的旧对象 */
  const onScan = async (code: string) => {
    setScanValue(code)
    setError(null)
    setNotice(null)
    const trimmed = code.trim()
    if (trimmed === '') return
    // 识别单元码（演示约定 unit- 前缀；真实扫码→单元解析由 L0 整合对齐，见交付记录）
    if (!trimmed.startsWith('unit-')) {
      setMatched(null)
      setError({ title: $t('码 {p0} 未识别为库存单元码', { p0: trimmed }), detail: $t('请扫外协发送的单元码；上一码信息已清除') })
      return
    }
    // 逐任务取单元行匹配（先识别对象再校验任务，PC-04；不默认取第一条任务）
    setBusy(true)
    try {
      for (const task of tasks) {
        const detail = await client.cswOutsourcingDetail(task.id).catch(() => null)
        const unit = detail?.units.find((u) => u.unitId === trimmed) ?? null
        if (unit !== null && unit.status === 'sent') {
          setMatched({ task, unit })
          // 预填应回厂余量（发送量−已回厂量；数量与单位同现 PC-06）
          const remain = Number(unit.sentQty) - Number(unit.returnedQty)
          setQuantity(remain > 0 ? String(remain) : '')
          setBusy(false)
          return
        }
      }
      setMatched(null)
      setError({ title: $t('码 {p0} 未匹配到「已发送（在外加工）」任务的单元行', { p0: trimmed }), detail: $t('请确认任务状态或联系计划员；上一码信息已清除') })
    } finally {
      setBusy(false)
    }
  }

  const submitReceive = async () => {
    if (matched === null) return
    const qty = quantity.trim()
    if (qty === '' || Number(qty) <= 0) {
      setError({ title: $t('回厂数量必须为正数（数量与单位同现）') })
      return
    }
    setBusy(true)
    setError(null)
    try {
      await client.cswOutsourcingReceive({
        taskId: matched.task.id,
        lines: [{ unitId: matched.unit.unitId, quantity: qty }],
        reason: 'PDA 扫码回厂接收',
      })
      setNotice($t('已回厂接收 {p0} {p1}（外协在途减＋回厂目的增，两段各自原子 CS-21）；回厂后默认全部必检（CS-22）', { p0: qty, p1: matched.task.uom }))
      setMatched(null)
      setScanValue('')
      setQuantity('')
      load()
    } catch (err) {
      setError(formatP3Error(err as { code?: string; message?: string; requestId?: string }))
    } finally {
      setBusy(false)
    }
  }

  if (!canRead) {
    return (
      <PageContainer title={$t('外协接收')} description={$t('扫单元号回厂接收（CS-21 回厂段）')}>
        <Message kind="warning" title={$t('无外协权限（csw.read）')}>{$t('未授予外协域许可，请联系管理员授权。')}</Message>
      </PageContainer>
    )
  }

  return (
    <PageContainer title={$t('外协接收')} description={$t('扫单元号 → 匹配在外加工任务 → 回厂数量确认（服务端入账成功才算成功，PC-21）')}>
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {notice ? <Message kind="success" title={notice} /> : null}

      <ScanInput
        placeholder={$t('扫/输单元号（如 unit-1005-0001）')}
        hint={scanValue !== '' ? $t('当前识别：{p0}', { p0: scanValue }) : undefined}
        onScan={(code) => void onScan(code)}
        disabled={busy}
      />

      <div style={{ marginTop: 12 }}>
        {matched !== null ? (
          <div style={{ border: '1px solid var(--cz-color-border)', borderRadius: 8, padding: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>
              {matched.task.taskNo} {$t('｜')} {matched.task.orderNo}{$t('／')}{matched.task.operationName}
            </div>
            <div style={{ fontSize: 13, color: 'var(--cz-color-text-secondary)', margin: '4px 0 8px' }}>
              {$t('供应方：')}{matched.task.supplierName}{$t('；单元')} {matched.unit.unitNo ?? matched.unit.unitId}{$t('； 发送量')} {matched.task.sentQty} {matched.task.uom}{$t('（数量与单位同现，PC-06）')}
            </div>
            <Badge tone="info">{matched.task.statusLabel}</Badge>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <Input
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder={$t('回厂数量（{p0}）', { p0: matched.task.uom })}
                aria-label={$t('回厂数量')}
                inputMode="decimal"
                style={{ flex: 1 }}
              />
              <Button disabled={!canPost} loading={busy} onClick={() => void submitReceive()}>
                {$t('确认回厂')}
              </Button>
            </div>
            {!canPost ? <div style={{ fontSize: 12, color: 'var(--cz-color-text-secondary)', marginTop: 6 }}>{$t('无 csw.post 权限：仅可查看')}</div> : null}
          </div>
        ) : (
          <Message kind="info" title={$t('在外加工任务（等待回厂）')}>
            {tasks.length === 0 ? $t('暂无已发送任务') : tasks.map((t) => `${t.taskNo}（${t.sentQty} ${t.uom}）`).join('；')}
          </Message>
        )}
      </div>
    </PageContainer>
  )
}
