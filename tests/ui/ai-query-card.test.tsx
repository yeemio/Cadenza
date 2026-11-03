// @vitest-environment jsdom
/**
 * 问数结果卡片测试（P4-UI 线；信封六段呈现——AQ-REG-07/六段合同模板 §1）：
 * - 数字 DecimalString 原样 + 数量单位同现（PC-06；前端不做算术）；
 * - 完整性：truncated/totalKnown=false 不得显示为完整总量；freshness unknown 如实标注；
 * - AQ-C2 口径未定/单位不一致如实渲染，不给猜测数值（AQ-AMB-03/GAP-P4）；
 * - AQ-C3 时间范围回显（默认窗提示可修改）+ factColumns 与「解释非事实」视觉区分（DS-12）；
 * - 详情跳转走既有路由且 URL 不携带任何令牌/凭据参数（AR-04：链接可见≠内容可见）；
 * - 非数据态（ok_no_records/source_not_ready）不冒充数据。
 * 夹具：packages/ui/src/api/p4/mock.ts 导出的信封构造器（与真实 DTO 同形）。
 */
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import {
  mockMaterialShortageEnvelope,
  mockOrderProgressEnvelope,
  mockQualityEnvelope,
  type AiQueryEnvelopeDto,
} from '../../packages/ui/src/api/p4'
import { AiExplainNote, AiResultCard } from '../../packages/ui/src/aiquery'

function renderCard(envelope: AiQueryEnvelopeDto, detailLinks = true): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <AiResultCard envelope={envelope} detailLinks={detailLinks} />
    </MemoryRouter>,
  )
}

describe('AQ-C1 结果卡片（订单进度）', () => {
  it('五量 DecimalString 原样呈现 + 数量单位同现 + 排程完成度 + 审计锚', () => {
    renderCard(mockOrderProgressEnvelope('req-11111111-2222-4333-8444-555555555555', 'sess-1'))
    expect(screen.getByText('查询成功（有数据）')).toBeInTheDocument()
    // 五量原样（不做算术/格式化；订单合计与工序行均出现）
    expect(screen.getAllByText('80.0000 KM').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('30.0000 KM').length).toBeGreaterThanOrEqual(2)
    // 排程完成度（A3-4 标签）
    expect(screen.getByText('排程：部分排产')).toBeInTheDocument()
    // 未完成任务（GAP-P9：五量与排程事实判定）
    expect(screen.getByText('未完成')).toBeInTheDocument()
    // 审计锚（requestId 前 8 位 + 工具调用序）
    expect(screen.getByTestId('ai-result-card')).toHaveTextContent(/审计：req-1111… · 工具调用 #1/)
  })

  it('详情跳转走既有业务路由，URL 不携带令牌/凭据（AR-04：跳转后继续 OA 鉴权）', () => {
    renderCard(mockOrderProgressEnvelope('req-11111111-2222-4333-8444-555555555555', 'sess-1'))
    const link = screen.getByRole('link', { name: '查看订单详情' })
    expect(link).toHaveAttribute('href', '/production/orders/po-1001')
    expect(link.getAttribute('href')).not.toMatch(/token|ticket|auth|key/i)
    expect(screen.getByText('（既有业务页面，仍需登录与权限）')).toBeInTheDocument()
  })

  it('detailLinks=false（PDA）：不渲染路由链接，改为鉴权提示文案', () => {
    renderCard(mockOrderProgressEnvelope('req-1', 'sess-1'), false)
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('详情请在 Web 工作台查看（跳转后仍需鉴权）')).toBeInTheDocument()
  })
})

describe('完整性与时效（信封段④）', () => {
  it('truncated + totalKnown=false：如实标注，不得显示为完整总量', () => {
    renderCard(mockMaterialShortageEnvelope('req-2', 'sess-1'))
    expect(screen.getByTestId('ai-completeness')).toHaveTextContent('已取 3 行')
    expect(screen.getByTestId('ai-completeness')).toHaveTextContent('结果被截断')
    expect(screen.getByTestId('ai-completeness')).toHaveTextContent('总量未知（未取全，不构成完整总量）')
    // 不得出现「共 N 行」的完整总量口径
    expect(screen.queryByText(/共 \d+ 行/)).toBeNull()
  })

  it('freshness：各数据源更新时间或「未知」如实标注；来源表名可见', () => {
    renderCard(mockMaterialShortageEnvelope('req-2', 'sess-1'))
    const freshness = screen.getByTestId('ai-freshness')
    expect(freshness).toHaveTextContent('查询时间：2026-10-28T03:00:00.000Z（UTC）')
    expect(freshness).toHaveTextContent('来源表 stock_balance：更新于 2026-10-27T07:40:00.000Z')
    expect(freshness).toHaveTextContent('来源表 purchase_order_line：更新时间未知')
    expect(screen.getByText('manufacturing_bom_revision')).toBeInTheDocument()
  })
})

describe('AQ-C2 口径未定与单位不一致（AQ-AMB-03/GAP-P4）', () => {
  it('缺口列如实渲染「口径未定」，不给猜测数值；单位不一致行独立标注', () => {
    renderCard(mockMaterialShortageEnvelope('req-3', 'sess-1'))
    expect(screen.getByText('需求基数口径：未定（GAP-P4）')).toBeInTheDocument()
    expect(screen.getAllByText('口径未定').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('单位不一致未折算')).toBeInTheDocument()
    expect(screen.getByText(/单位不一致未折算（BOM KG／库存 KG／采购 PC）/)).toBeInTheDocument()
    // 附注（contextEcho.notes 呈现）
    expect(screen.getByText(/附注：BOM 基数口径未配置/)).toBeInTheDocument()
  })
})

describe('AQ-C3 时间范围回显与事实列区分', () => {
  it('默认时间窗回显 + 「可修改后重问」提示（AQ-AMB-02）', () => {
    renderCard(
      mockQualityEnvelope('req-4', 'sess-1', {
        from: '2026-10-21T16:00:00.000Z',
        to: '2026-10-28T16:00:00.000Z',
        defaultApplied: true,
      }),
    )
    expect(screen.getByText(/2026-10-21T16:00:00.000Z ～ 2026-10-28T16:00:00.000Z（UTC）/)).toBeInTheDocument()
    expect(screen.getByText(/按默认「最近 7 个自然日」执行，可修改后重问/)).toBeInTheDocument()
  })

  it('factColumns 提示 + 判定事实标签（让步处置/生效结论）；freshness totalKnown=true 显示总量', () => {
    renderCard(
      mockQualityEnvelope('req-4', 'sess-1', {
        from: '2026-10-21T16:00:00.000Z',
        to: '2026-10-28T16:00:00.000Z',
        defaultApplied: false,
      }),
    )
    expect(screen.getByTestId('ai-fact-columns')).toHaveTextContent('判定事实列：生效结论、检验状态、处置、隔离状态、业务时间')
    expect(screen.getByText(/不合格（v1・初检）/)).toBeInTheDocument()
    expect(screen.getByText(/让步放行（基于 v1）/)).toBeInTheDocument()
    expect(screen.getAllByText(/部分合格/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByTestId('ai-completeness')).toHaveTextContent('共 3 行')
    expect(screen.getByTestId('ai-completeness')).toHaveTextContent('第 1 页／每页 20 行')
  })

  it('AI 解释文字与事实列视觉区分（DS-12「解释非事实」标注）', () => {
    render(
      <MemoryRouter>
        <AiExplainNote text="该订单 2 道工序中 1 道未完成" />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('ai-explain-note')).toHaveTextContent('AI 解释（解释非事实，请以上述事实列为准）')
    expect(screen.getByTestId('ai-explain-note')).toHaveTextContent('该订单 2 道工序中 1 道未完成')
  })
})

describe('非数据态不冒充数据（AQ-REG-01/08）', () => {
  it('ok_no_records：无匹配订单如实呈现，不渲染假表格', () => {
    const envelope = mockOrderProgressEnvelope('req-5', 'sess-1', 'ORDER-AQ-9999')
    envelope.status = 'ok_no_records'
    envelope.statusLabel = '查询成功（无匹配记录）'
    envelope.data = { capabilityId: 'aq.order-progress', order: null, candidates: [] }
    renderCard(envelope)
    expect(screen.getByText('查询成功（无匹配记录）')).toBeInTheDocument()
    expect(screen.getByText('无匹配订单（多候选时将以澄清选项呈现；无匹配不冒充数据）。')).toBeInTheDocument()
  })

  it('source_not_ready：未就绪问法族可理解文案，无数据表', () => {
    const envelope = mockOrderProgressEnvelope('req-6', 'sess-1')
    envelope.status = 'source_not_ready'
    envelope.statusLabel = '数据源未就绪'
    envelope.message = '数据源未就绪：工时与经营统计无版本化口径读面 [AQ-REG-01]'
    envelope.data = null
    renderCard(envelope)
    expect(screen.getByText('数据源未就绪')).toBeInTheDocument()
    expect(screen.getByText(/\[AQ-REG-01\]/)).toBeInTheDocument()
  })
})
