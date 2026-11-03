/**
 * 问数结果卡片（P4-UI 线新增；信封六段结构化呈现——AQ-REG-07/六段合同模板 §1）。
 *
 * 呈现纪律（合同硬约束）：
 * - 数字一律 DecimalString **原样**呈现（AQ-REG-09；前端不做任何算术/格式化换算），数量+单位同现（PC-06）；
 * - 完整性：truncated/已取行数/总量可知性如实呈现——**totalKnown=false（未取全）不得显示为完整总量**；
 * - freshness：各数据源 updatedAt 或「未知」（unknown 如实标注，不估时间）；
 * - AQ-C2 缺口列口径未定 → 如实渲染 shortageNote（不给猜测数值，AQ-AMB-03/GAP-P4）；
 * - factColumns 提示：哪些列是判定事实；AI 解释文字与事实列**视觉区分**（DS-12「解释非事实」）；
 * - 详情跳转走既有业务页面路由并**继续走 OA 鉴权**（AR-04/OA-25：链接可见≠内容可见，
 *   不构造免登/免鉴权旁路 URL）——PDA 无对应路由时以 detailLinks='off' 降为文字提示。
 */

import type { CSSProperties, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Badge } from '../Badge'
import {
  DISPOSITION_KIND_LABELS,
  INSPECTION_STAGE_LABELS,
  INSPECTION_STATUS_LABELS,
  ORDER_SCHEDULING_STATUS_LABELS,
  PRODUCTION_ORDER_STATUS_LABELS,
  RESULT_KIND_LABELS,
  TEST_CONCLUSION_LABELS,
} from '../api/types'
import { t, tx } from '../i18n'
import type {
  AiFiveQuantitiesDto,
  AiMaterialShortageResultDto,
  AiOrderProgressResultDto,
  AiQualityResultDto,
  AiQueryEnvelopeDto,
} from '../api/p4/types'

const FIVE_QTY_COLUMNS: Array<{ key: keyof AiFiveQuantitiesDto; label: string }> = [
  { key: 'draftQty', label: '草稿量' },
  { key: 'submittedQty', label: '已提交待审' },
  { key: 'approvedQty', label: '审核通过' },
  { key: 'qualifiedQty', label: '合格量' },
  { key: 'stockedQty', label: '已入库' },
]

const TH: CSSProperties = { textAlign: 'left', padding: '6px 10px', borderBottom: '1px solid var(--cz-color-border)', fontSize: 12, color: 'var(--cz-color-text-secondary)', whiteSpace: 'nowrap' }
const TD: CSSProperties = { padding: '6px 10px', borderBottom: '1px solid var(--cz-color-border)', fontSize: 13, whiteSpace: 'nowrap' }

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--cz-color-text-secondary)', marginBottom: 4 }}>{title}</div>
      {children}
    </div>
  )
}

function labelOf(map: Record<string, string>, value: string | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return map[value] ?? value
}

function timeOf(iso: string | null | undefined): string {
  return iso ?? '—'
}

/** AI 解释文字块：与事实列视觉区分（DS-12；标注「解释非事实」）。 */
export function AiExplainNote({ text }: { text: string }) {
  return (
    <div
      data-testid="ai-explain-note"
      style={{
        marginTop: 8,
        padding: '8px 10px',
        border: '1px dashed var(--cz-color-border)',
        borderRadius: 6,
        background: 'var(--cz-color-bg-hover)',
        fontSize: 13,
        color: 'var(--cz-color-text-secondary)',
      }}
    >
      <span style={{ fontWeight: 600 }}>{t('AI 解释（解释非事实，请以上述事实列为准）：')}</span>
      {text}
    </div>
  )
}

/** 五量分立行（S02/A5-3：五列分立展示，禁混口径；DecimalString 原样）。 */
function FiveQtyCells({ quantities, uom }: { quantities: AiFiveQuantitiesDto; uom?: string | null }) {
  return (
    <>
      {FIVE_QTY_COLUMNS.map((col) => (
        <td key={col.key} style={TD}>
          {quantities[col.key]}
          {uom ? ` ${uom}` : ''}
        </td>
      ))}
    </>
  )
}

function OrderProgressView({ data, detailLinks }: { data: AiOrderProgressResultDto; detailLinks: boolean }) {
  if (!data.order) {
    return <div style={{ fontSize: 13 }}>{t('无匹配订单（多候选时将以澄清选项呈现；无匹配不冒充数据）。')}</div>
  }
  const o = data.order
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 13 }}>
        <strong>{o.orderNo}</strong>
        <Badge tone={o.orderStatus === 'in_progress' ? 'info' : 'default'}>{labelOf(PRODUCTION_ORDER_STATUS_LABELS, o.orderStatus)}</Badge>
        {o.suspended ? <Badge tone="warning">{t('挂起')}{o.suspendedReason ? `：${o.suspendedReason}` : ''}</Badge> : null}
        <Badge tone={o.schedulingStatus === 'fully_scheduled' ? 'success' : 'warning'}>
          {t('排程：')}{labelOf(ORDER_SCHEDULING_STATUS_LABELS, o.schedulingStatus)}
        </Badge>
        <span>{o.materialDesc}</span>
        <span>
          {t('计划产量')} {o.productionQty} {o.uom}
        </span>
        {detailLinks ? (
          <span>
            <Link to={`/production/orders/${o.orderId}`}>{t('查看订单详情')}</Link>
            <span style={{ fontSize: 12, color: 'var(--cz-color-text-secondary)' }}>{t('（既有业务页面，仍需登录与权限）')}</span>
          </span>
        ) : (
          <span style={{ fontSize: 12, color: 'var(--cz-color-text-secondary)' }}>{t('详情请在 Web 工作台查看（跳转后仍需鉴权）')}</span>
        )}
      </div>
      <Section title={t('订单级五量（合计；五列分立，禁混口径）')}>
        <table style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {FIVE_QTY_COLUMNS.map((c) => (
                <th key={c.key} style={TH}>{tx(c.label)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <FiveQtyCells quantities={o.totalQuantities} uom={o.uom} />
            </tr>
          </tbody>
        </table>
      </Section>
      <Section title={t('工序行（未完成判定=五量与排程事实；不依赖 execution_status）')}>
        <table style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={TH}>{t('序')}</th>
              <th style={TH}>{t('工序')}</th>
              <th style={TH}>{t('下线数量')}</th>
              <th style={TH}>{t('计划合计')}</th>
              <th style={TH}>{t('是否排完')}</th>
              {FIVE_QTY_COLUMNS.map((c) => (
                <th key={c.key} style={TH}>{tx(c.label)}</th>
              ))}
              <th style={TH}>{t('状态')}</th>
            </tr>
          </thead>
          <tbody>
            {o.operations.map((op) => (
              <tr key={op.orderOperationId}>
                <td style={TD}>{op.seq}</td>
                <td style={TD}>{op.operationName}</td>
                <td style={TD}>{op.offlineQty} {op.uom}</td>
                <td style={TD}>{op.scheduledQty} {op.uom}</td>
                <td style={TD}>{op.fullyScheduled ? t('已排完') : t('未排完')}</td>
                <FiveQtyCells quantities={op.quantities} uom={op.uom} />
                <td style={TD}>
                  {op.incomplete ? <Badge tone="warning">{t('未完成')}</Badge> : <Badge tone="success">{t('无待完成')}</Badge>}
                  <div style={{ fontSize: 12, color: 'var(--cz-color-text-secondary)', whiteSpace: 'normal', maxWidth: 320 }}>{op.readyReason}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </div>
  )
}

function MaterialShortageView({ data }: { data: AiMaterialShortageResultDto }) {
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 13 }}>
        <strong>{data.orderNo ?? '—'}</strong>
        <span>{t('BOM 版本：')}{data.bomRevisionId ? `v${data.bomRevisionVersion ?? '?'}` : t('未冻结')}</span>
        <Badge tone={data.requirementBase === null ? 'warning' : 'default'}>
          {t('需求基数口径：')}{data.requirementBase === null ? t('未定（GAP-P4）') : data.requirementBase === 'per_unit' ? '单件用量×计划产量' : '订单总量'}
        </Badge>
      </div>
      <Section title={t('料品并排（BOM 需求 vs 可用量 vs 采购在途；缺口列口径未定时如实标注，不给猜测数值）')}>
        <table style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={TH}>{t('料品编码')}</th>
              <th style={TH}>{t('名称/规格')}</th>
              <th style={TH}>{t('BOM 数量')}</th>
              <th style={TH}>{t('毛量')}</th>
              <th style={TH}>{t('预留')}</th>
              <th style={TH}>{t('可用量')}</th>
              <th style={TH}>{t('采购在途')}</th>
              <th style={TH}>{t('缺口')}</th>
              <th style={TH}>{t('关联采购行')}</th>
            </tr>
          </thead>
          <tbody>
            {data.lines.map((line) => (
              <tr key={line.materialId}>
                <td style={TD}>{line.materialCode}</td>
                <td style={{ ...TD, whiteSpace: 'normal', maxWidth: 220 }}>
                  {line.materialName ?? '—'}
                  {line.spec ? ` / ${line.spec}` : ''}
                </td>
                <td style={TD}>{line.bomQuantity} {line.uom}</td>
                <td style={TD}>{line.availability.grossQty} {line.uom}</td>
                <td style={TD}>{line.availability.reservedQty} {line.uom}</td>
                <td style={TD}>{line.availability.availableQty} {line.uom}</td>
                <td style={TD}>{line.inTransitQty} {line.uom}</td>
                <td style={TD}>
                  {line.shortageQty !== null ? (
                    `${line.shortageQty} ${line.uom}`
                  ) : (
                    <Badge tone={line.uomMismatch ? 'warning' : 'default'}>{line.shortageNote ?? '口径未定'}</Badge>
                  )}
                  {line.uomMismatch ? (
                    <div style={{ fontSize: 12, color: 'var(--cz-color-text-secondary)' }}>
                      {t('单位不一致未折算（BOM')} {line.uomSources.bom}{t('／库存')} {line.uomSources.stock ?? '—'}{t('／采购')} {line.uomSources.purchase ?? '—'}）
                    </div>
                  ) : null}
                </td>
                <td style={{ ...TD, whiteSpace: 'normal', maxWidth: 260 }}>
                  {line.purchaseLines.length === 0 ? (
                    '—'
                  ) : (
                    line.purchaseLines.map((pl) => (
                      <div key={pl.lineId}>
                        {pl.orderNo}#{pl.lineNo} {pl.statusLabel} {t('在途')} {pl.inTransitQty} {pl.uomCode}
                        {pl.plannedReceiptDate ? t('（约定 {p0}）', { p0: pl.plannedReceiptDate }) : ''}
                        {pl.latestBatchInspectionStatusLabel ? t(' · 批检：{p0}', { p0: pl.latestBatchInspectionStatusLabel }) : ''}
                      </div>
                    ))
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </div>
  )
}

function QualityResultView({ data, detailLinks }: { data: AiQualityResultDto; detailLinks: boolean }) {
  return (
    <div>
      <Section title={t('实际生效时间范围（服务端回显，AQ-AMB-02）')}>
        <div style={{ fontSize: 13 }}>
          {timeOf(data.timeRange.from)} ～ {timeOf(data.timeRange.to)}（UTC）
          {data.timeRange.defaultApplied ? (
            <span style={{ color: 'var(--cz-color-text-secondary)' }}>{t('｜未指定时间范围，按默认「最近 7 个自然日」执行，可修改后重问')}</span>
          ) : null}
        </div>
      </Section>
      <Section title={t('检验单（过程/成品）——判定/状态/处置事实列')}>
        <table style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={TH}>{t('检验单号')}</th>
              <th style={TH}>{t('阶段')}</th>
              <th style={TH}>{t('检验状态')}</th>
              <th style={TH}>{t('生效结论')}</th>
              <th style={TH}>{t('处置')}</th>
              <th style={TH}>{t('隔离')}</th>
              <th style={TH}>{t('料品')}</th>
              <th style={TH}>{t('数量')}</th>
              <th style={TH}>{t('业务时间')}</th>
              <th style={TH}>{t('详情')}</th>
            </tr>
          </thead>
          <tbody>
            {data.inspectionOrders.map((row) => (
              <tr key={row.id}>
                <td style={TD}>{row.orderNo}</td>
                <td style={TD}>{labelOf(INSPECTION_STAGE_LABELS, row.inspectionStage)}</td>
                <td style={TD}>{labelOf(INSPECTION_STATUS_LABELS, row.status) !== '—' ? labelOf(INSPECTION_STATUS_LABELS, row.status) : row.statusLabel}</td>
                <td style={TD}>
                  {row.effectiveConclusion
                    ? `${labelOf(TEST_CONCLUSION_LABELS, row.effectiveConclusion.conclusion)}（v${row.effectiveConclusion.version}・${labelOf(RESULT_KIND_LABELS, row.effectiveConclusion.resultKind)}）`
                    : t('未出结论')}
                </td>
                <td style={TD}>
                  {row.latestDisposition
                    ? t('{p0}（基于 v{p1}）', { p0: labelOf(DISPOSITION_KIND_LABELS, row.latestDisposition.dispositionKind), p1: row.latestDisposition.basedOnVersion })
                    : '—'}
                </td>
                <td style={TD}>{row.activeHold ? row.activeHold.holdKindLabel : '—'}</td>
                <td style={TD}>{row.materialCode}</td>
                <td style={TD}>{row.quantity} {row.uomCode}</td>
                <td style={TD}>{timeOf(row.businessTime)}</td>
                <td style={TD}>
                  {detailLinks ? (
                    <Link to={`/quality/inspections/${row.id}`}>{t('详情')}</Link>
                  ) : (
                    <span style={{ fontSize: 12, color: 'var(--cz-color-text-secondary)' }}>{t('Web 端查看')}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section title={t('来料批次——收货与批检事实列')}>
        <table style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={TH}>{t('批次号')}</th>
              <th style={TH}>{t('采购单')}</th>
              <th style={TH}>{t('料品')}</th>
              <th style={TH}>{t('批检状态')}</th>
              <th style={TH}>{t('存放')}</th>
              <th style={TH}>{t('收货数量')}</th>
              <th style={TH}>{t('确认时间')}</th>
              <th style={TH}>{t('明细质量汇总')}</th>
            </tr>
          </thead>
          <tbody>
            {data.purchaseBatches.map((row) => (
              <tr key={row.id}>
                <td style={TD}>{row.batchNo}</td>
                <td style={TD}>{row.orderNo}#{row.lineNo}</td>
                <td style={TD}>{row.materialCode}</td>
                <td style={TD}>{row.inspectionStatusLabel}</td>
                <td style={TD}>{row.storageStatus === 'stored' ? t('在库') : t('已退回')}</td>
                <td style={TD}>{row.receivedQty} {row.uomCode}</td>
                <td style={TD}>{timeOf(row.confirmTime)}</td>
                <td style={{ ...TD, whiteSpace: 'normal' }}>
                  {row.detailQualitySummary.map((s) => `${s.qualityStatusLabel}×${s.count}`).join('、') || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </div>
  )
}

/**
 * 信封六段结果卡片：
 * ①状态（status/statusLabel/message+审计锚）③数据结果（三能力视图）
 * ④完整性与时效 ②上下文回显（时间范围/数据范围/附注）+ 来源引用 + factColumns 提示。
 */
export function AiResultCard({ envelope, detailLinks = true }: { envelope: AiQueryEnvelopeDto; detailLinks?: boolean }) {
  const { status, statusLabel, message, data, completeness, freshness, contextEcho, auditRef } = envelope
  const tone = status === 'ok_with_data' ? 'success' : status === 'ok_no_records' ? 'info' : 'warning'
  return (
    <section
      data-testid="ai-result-card"
      aria-label={t('问数结果卡片')}
      style={{ border: '1px solid var(--cz-color-border)', borderRadius: 8, padding: 14, background: 'var(--cz-color-bg-surface)', marginTop: 8 }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Badge tone={tone}>{statusLabel}</Badge>
        <span style={{ fontSize: 13 }}>{message}</span>
        <span style={{ fontSize: 12, color: 'var(--cz-color-text-secondary)' }}>
          {t('审计：')}{auditRef.requestId.slice(0, 8)}{t('… · 工具调用 #')}{auditRef.toolCallSeq}
        </span>
      </div>

      {data?.capabilityId === 'aq.order-progress' ? <OrderProgressView data={data} detailLinks={detailLinks} /> : null}
      {data?.capabilityId === 'aq.material-shortage' ? <MaterialShortageView data={data} /> : null}
      {data?.capabilityId === 'aq.quality' ? <QualityResultView data={data} detailLinks={detailLinks} /> : null}

      <Section title={t('完整性与时效（未取全不得总结为完整总量）')}>
        <div data-testid="ai-completeness" style={{ fontSize: 13 }}>
          {t('已取')} {completeness.fetchedRows} {t('行')}
          {completeness.truncated ? t('；结果被截断') : ''}
          {completeness.totalKnown ? t('；共 {p0} 行', { p0: completeness.total ?? '?' }) : t('；总量未知（未取全，不构成完整总量）')}
          {completeness.page ? t('；第 {p0} 页／每页 {p1} 行', { p0: completeness.page.page, p1: completeness.page.pageSize }) : ''}
        </div>
        <div data-testid="ai-freshness" style={{ fontSize: 13, marginTop: 4 }}>
          {t('查询时间：')}{freshness.queriedAt}（UTC）
          {freshness.sources.map((s) => (
            <span key={s.source} style={{ marginLeft: 10 }}>
              {t('· 来源表')} {s.source}：{s.updatedAt === 'unknown' ? t('更新时间未知') : t('更新于 {p0}', { p0: s.updatedAt })}
            </span>
          ))}
        </div>
      </Section>

      <Section title={t('来源（来源表名＋业务键引用）')}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 12 }}>
          {freshness.sources.map((s) => (
            <Badge key={s.source} tone="default">{s.source}</Badge>
          ))}
        </div>
      </Section>

      <Section title={t('执行上下文回显（服务端实际生效）')}>
        <div style={{ fontSize: 12, color: 'var(--cz-color-text-secondary)', display: 'grid', gap: 2 }}>
          <span>
            {t('数据范围：')}{contextEcho.dataScope.enterpriseWide ? t('企业范围') : t('授权厂区 {p0} 家', { p0: contextEcho.dataScope.plantIds.length })}
            {t('｜能力：')}{contextEcho.capabilityId} v{contextEcho.capabilityVersion}
          </span>
          {contextEcho.factColumns.length > 0 ? (
            <span data-testid="ai-fact-columns">{t('判定事实列：')}{contextEcho.factColumns.join('、')}{t('（AI 解释文字非事实，已视觉区分）')}</span>
          ) : null}
          {contextEcho.notes.map((note) => (
            <span key={note}>{t('附注：')}{note}</span>
          ))}
        </div>
      </Section>
    </section>
  )
}
