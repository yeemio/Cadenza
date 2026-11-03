import { Message, PageContainer, t as $t, tx as $tx } from '@cadenza/ui'
import { FormEvent, useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { createSapReconciliation, listSapReconciliation } from '../group-api'
import { GROUP_POST, GROUP_READ, usePermissions } from '../permissions'
import { useAuth } from '../auth'

/**
 * SAP 双账/对账专用入口（GAP-RECON-UI）。
 * 已接 GET/POST /sap/reconciliation（含 G-B02 classification / byClassification）。
 * ≠ 成本对账 CostReportsPage CE-16（/cost/reports、/cost/recon-items）；
 * ≠ SIM fixture sap_reconciliation.csv 冒充产品 PASS；
 * ≠ 外协/发运/采购 sync 冒充关闭。
 * 入口可达 ≠ 业务数量闭环；勿写「已关闭 GAP-RECON-UI」。
 */

/** G-B02 分类 + 入口兼用态中文 */
const CLASSIFICATION_ZH: Record<string, string> = {
  OPEN: '待核对',
  MATCH: '相符',
  DIFF: '差异',
  OUTCOME_UNKNOWN: '结果未知',
  QUARANTINED: '隔离',
  CLASSIFICATION_DIFFERENCE: '分类差异',
  QUALITY_STATUS_DIFFERENCE: '质量状态差异',
}

/** 筛选下拉（全部 + 四分类 + 兼用态） */
const CLASSIFICATION_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: '全部类别' },
  { value: 'MATCH', label: '相符' },
  { value: 'CLASSIFICATION_DIFFERENCE', label: '分类差异' },
  { value: 'QUALITY_STATUS_DIFFERENCE', label: '质量状态差异' },
  { value: 'OUTCOME_UNKNOWN', label: '结果未知' },
  { value: 'DIFF', label: '差异' },
  { value: 'OPEN', label: '待核对' },
  { value: 'QUARANTINED', label: '隔离' },
]

const CLASSIFICATION_CREATE_OPTIONS = CLASSIFICATION_FILTER_OPTIONS.filter((o) => o.value !== '')

function classificationLabel(raw: unknown): string {
  const s = String(raw ?? '')
  return $tx(CLASSIFICATION_ZH[s]) ?? (s || '—')
}

export function SapReconciliationPage() {
  const { has } = usePermissions()
  const { session } = useAuth()
  const canRead = has(GROUP_READ)
  const canPost = has(GROUP_POST)
  const plantId = session?.user.plantId || ''

  const [items, setItems] = useState<Record<string, unknown>[]>([])
  const [total, setTotal] = useState(0)
  const [byClassification, setByClassification] = useState<Record<string, number>>({})
  const [filterClassification, setFilterClassification] = useState('')
  const [actualConnection, setActualConnection] = useState<boolean | null>(null)
  const [boundary, setBoundary] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [postMsg, setPostMsg] = useState<string | null>(null)
  const [postErr, setPostErr] = useState<string | null>(null)
  const [posting, setPosting] = useState(false)

  const [formObjectCode, setFormObjectCode] = useState('')
  const [formTitle, setFormTitle] = useState('')
  const [formReason, setFormReason] = useState('')
  const [formMomQty, setFormMomQty] = useState('')
  const [formSapQty, setFormSapQty] = useState('')
  const [formDiffQty, setFormDiffQty] = useState('')
  const [formClassification, setFormClassification] = useState('CLASSIFICATION_DIFFERENCE')

  const reload = useCallback(() => {
    if (!canRead) {
      setLoading(false)
      return
    }
    setLoading(true)
    // 列表不强制会话 plantId：企业范围账号需看到跨厂差异；创建仍用会话 plantId
    listSapReconciliation({
      page: 1,
      pageSize: 20,
      classification: filterClassification || undefined,
    })
      .then((r) => {
        setItems(r.items)
        setTotal(r.total)
        setByClassification(r.byClassification ?? {})
        setActualConnection(r.actual_connection ?? null)
        setBoundary(typeof r.boundary === 'string' ? r.boundary : null)
        setError(null)
      })
      .catch((e) => setError(e instanceof Error ? e.message : $t('加载失败')))
      .finally(() => setLoading(false))
  }, [canRead, filterClassification])

  useEffect(() => {
    reload()
  }, [reload])

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    setPostMsg(null)
    setPostErr(null)
    if (!canPost) {
      setPostErr($t('当前账号缺少 group.post，无法创建差异项'))
      return
    }
    if (!plantId) {
      setPostErr($t('当前会话无 plantId，无法创建'))
      return
    }
    setPosting(true)
    try {
      const result = await createSapReconciliation({
        plantId,
        objectCode: formObjectCode.trim(),
        title: formTitle.trim(),
        reason: formReason.trim(),
        momQty: formMomQty.trim() || undefined,
        sapQty: formSapQty.trim() || undefined,
        diffQty: formDiffQty.trim() || undefined,
        matchStatus: formClassification || undefined,
        classification: formClassification || undefined,
      })
      setPostMsg(
        $t('已提交（{p0}）：{p1}', { p0: result.status, p1: String(result.data?.reconNo ?? result.operationId) }),
      )
      setFormObjectCode('')
      setFormTitle('')
      setFormReason('')
      setFormMomQty('')
      setFormSapQty('')
      setFormDiffQty('')
      reload()
    } catch (err) {
      setPostErr(err instanceof Error ? err.message : $t('创建失败'))
    } finally {
      setPosting(false)
    }
  }

  const byClassEntries = Object.entries(byClassification).sort((a, b) => b[1] - a[1])

  return (
    <PageContainer
      title={$t('双账对账')}
      description={$t('SAP 双账 / 对账台账（MOM 执行量 vs SAP 商业量差异）；已接 GET/POST /sap/reconciliation（含分类）')}
    >
      <Message kind="info" title={$t('边界说明（禁止冒充）')}>
        <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
          <li>
            <strong>≠</strong> {$t('成本对账 CE-16：')}
            <Link to="/cost/reports">/cost/reports</Link>{$t('（')}
            <code>GET /cost/recon-items</code>{$t('）不得冒充本页。')}
          </li>
          <li>
            <strong>≠</strong> {$t('SIM fixture：')}<code>sap_reconciliation.csv</code> {$t('不得直导为产品事实。')}
          </li>
          <li>
            <strong>≠</strong> {$t('外协任务、发运 sync、采购 sync、转换 sync-retry 等域内模拟回传。')}
          </li>
          <li>
            {$t('入口可达 ≠ 业务数量闭环；actual_connection=')}
            {actualConnection === null ? '—' : String(actualConnection)}
            {boundary ? $t('；{p0}', { p0: boundary }) : ''}
          </li>
        </ul>
      </Message>

      {!canRead && (
        <Message kind="warning" title={$t('无 group.read 许可')}>
          {$t('当前账号缺少 group.read，无法加载双账差异列表。')}
        </Message>
      )}
      {error && (
        <Message kind="error" title={$t('加载失败')}>
          {error}
        </Message>
      )}

      {canRead && !error && (
        <div
          style={{
            marginTop: 16,
            padding: 16,
            border: '1px solid var(--cz-color-border)',
            borderRadius: 8,
          }}
          role="status"
          data-testid="sap-recon-list"
        >
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 12,
              alignItems: 'center',
              marginBottom: 12,
            }}
          >
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }} data-testid="sap-recon-class-filter">
              <span>{$t('按分类筛选')}</span>
              <select
                value={filterClassification}
                onChange={(e) => setFilterClassification(e.target.value)}
                aria-label={$t('按分类筛选')}
              >
                {CLASSIFICATION_FILTER_OPTIONS.map((o) => ({ ...o, label: $tx(o.label) })).map((o) => ({ ...o, label: $tx(o.label) })).map((o) => (
                  <option key={o.value || 'ALL'} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={() => reload()} disabled={loading}>
              {loading ? $t('刷新中…') : $t('刷新')}
            </button>
          </div>

          {byClassEntries.length > 0 && (
            <div
              data-testid="sap-recon-by-classification"
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 8,
                marginBottom: 12,
                fontSize: 13,
                color: 'var(--cz-color-text-secondary)',
              }}
            >
              <span>{$t('分类汇总：')}</span>
              {byClassEntries.map(([k, n]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setFilterClassification(k)}
                  style={{
                    border: '1px solid var(--cz-color-border)',
                    borderRadius: 999,
                    padding: '2px 10px',
                    background:
                      filterClassification === k ? 'var(--cz-color-bg-muted, #f3f4f6)' : 'transparent',
                    cursor: 'pointer',
                  }}
                  title={$t('筛选 {p0}', { p0: k })}
                >
                  {classificationLabel(k)}{$t('（')}{n}{$t('）')}
                </button>
              ))}
            </div>
          )}

          {loading ? (
            <div style={{ textAlign: 'center', color: 'var(--cz-color-text-secondary)' }}>{$t('加载中…')}</div>
          ) : total === 0 ? (
            <div
              className="cz-table__empty"
              style={{
                padding: 24,
                textAlign: 'center',
                color: 'var(--cz-color-text-secondary)',
                border: '1px dashed var(--cz-color-border)',
                borderRadius: 8,
              }}
            >
              {filterClassification
                ? $t('当前分类「{p0}」暂无记录（GET /sap/reconciliation?classification=…）', { p0: classificationLabel(filterClassification) })
                : $t('暂无双账差异记录（已接 GET /sap/reconciliation）')}
            </div>
          ) : (
            <>
              <div style={{ marginBottom: 8, color: 'var(--cz-color-text-secondary)' }}>
                {$t('共')} {total} {$t('条')}
                {filterClassification
                  ? $t('（筛选：{p0}）', { p0: classificationLabel(filterClassification) })
                  : ''}
                {$t('（来源 GET /sap/reconciliation）')}
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table className="cz-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', padding: '8px 6px' }}>{$t('对账单号')}</th>
                      <th style={{ textAlign: 'left', padding: '8px 6px' }}>{$t('对象编码')}</th>
                      <th style={{ textAlign: 'left', padding: '8px 6px' }}>{$t('标题')}</th>
                      <th style={{ textAlign: 'left', padding: '8px 6px' }}>{$t('分类')}</th>
                      <th style={{ textAlign: 'left', padding: '8px 6px' }}>{$t('核对状态')}</th>
                      <th style={{ textAlign: 'right', padding: '8px 6px' }}>{$t('MOM 量')}</th>
                      <th style={{ textAlign: 'right', padding: '8px 6px' }}>{$t('SAP 量')}</th>
                      <th style={{ textAlign: 'right', padding: '8px 6px' }}>{$t('差异量')}</th>
                      <th style={{ textAlign: 'left', padding: '8px 6px' }}>{$t('原因')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it) => {
                      const cls = it.classification ?? it.matchStatus
                      return (
                        <tr key={String(it.id)}>
                          <td style={{ padding: '8px 6px' }}>{String(it.reconNo ?? it.id)}</td>
                          <td style={{ padding: '8px 6px' }}>{String(it.objectCode ?? '—')}</td>
                          <td style={{ padding: '8px 6px' }}>{String(it.title ?? '—')}</td>
                          <td style={{ padding: '8px 6px' }} data-testid="sap-recon-class-cell">
                            {classificationLabel(cls)}
                          </td>
                          <td style={{ padding: '8px 6px' }}>
                            {classificationLabel(it.matchStatus ?? cls)}
                          </td>
                          <td style={{ padding: '8px 6px', textAlign: 'right' }}>
                            {it.momQty == null ? '—' : String(it.momQty)}
                          </td>
                          <td style={{ padding: '8px 6px', textAlign: 'right' }}>
                            {it.sapQty == null ? '—' : String(it.sapQty)}
                          </td>
                          <td style={{ padding: '8px 6px', textAlign: 'right' }}>
                            {it.diffQty == null ? '—' : String(it.diffQty)}
                          </td>
                          <td style={{ padding: '8px 6px' }}>{String(it.reason ?? '—')}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      <div style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 16, margin: '0 0 8px' }}>{$t('登记差异项')}</h2>
        {!canPost && (
          <Message kind="warning" title={$t('无 group.post 许可')}>
            {$t('当前账号缺少 group.post，无法 POST /sap/reconciliation。')}
          </Message>
        )}
        {postErr && (
          <Message kind="error" title={$t('提交失败')}>
            {postErr}
          </Message>
        )}
        {postMsg && (
          <Message kind="success" title={$t('提交成功')}>
            {postMsg}
          </Message>
        )}
        {canPost && (
          <form
            onSubmit={onCreate}
            data-testid="sap-recon-create"
            style={{
              display: 'grid',
              gap: 10,
              maxWidth: 560,
              padding: 16,
              border: '1px solid var(--cz-color-border)',
              borderRadius: 8,
            }}
          >
            <label style={{ display: 'grid', gap: 4 }}>
              <span>{$t('对象编码（必填）')}</span>
              <input
                value={formObjectCode}
                onChange={(e) => setFormObjectCode(e.target.value)}
                required
                placeholder={$t('例如 OBJ-…')}
              />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span>{$t('标题（必填）')}</span>
              <input
                value={formTitle}
                onChange={(e) => setFormTitle(e.target.value)}
                required
                placeholder={$t('差异说明标题')}
              />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span>{$t('原因（必填）')}</span>
              <input
                value={formReason}
                onChange={(e) => setFormReason(e.target.value)}
                required
                placeholder={$t('登记原因')}
              />
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              <label style={{ display: 'grid', gap: 4 }}>
                <span>{$t('MOM 量')}</span>
                <input value={formMomQty} onChange={(e) => setFormMomQty(e.target.value)} />
              </label>
              <label style={{ display: 'grid', gap: 4 }}>
                <span>{$t('SAP 量')}</span>
                <input value={formSapQty} onChange={(e) => setFormSapQty(e.target.value)} />
              </label>
              <label style={{ display: 'grid', gap: 4 }}>
                <span>{$t('差异量')}</span>
                <input value={formDiffQty} onChange={(e) => setFormDiffQty(e.target.value)} />
              </label>
            </div>
            <label style={{ display: 'grid', gap: 4 }}>
              <span>{$t('分类 / 核对状态')}</span>
              <select
                value={formClassification}
                onChange={(e) => setFormClassification(e.target.value)}
                data-testid="sap-recon-create-class"
              >
                {CLASSIFICATION_CREATE_OPTIONS.map((o) => ({ ...o, label: $tx(o.label) })).map((o) => ({ ...o, label: $tx(o.label) })).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <div style={{ color: 'var(--cz-color-text-secondary)', fontSize: 12 }}>
              {$t('工厂 plantId：')}{plantId || $t('（会话未带）')}{$t('；走 POST /sap/reconciliation')}
            </div>
            <button type="submit" disabled={posting || !plantId}>
              {posting ? $t('提交中…') : $t('提交差异项')}
            </button>
          </form>
        )}
      </div>
    </PageContainer>
  )
}
