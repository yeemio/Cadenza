import type { ReactElement } from 'react'
import { ReworkLedgerPage } from './pages/ReworkLedgerPage'
import { OrderConversionPage } from './pages/OrderConversionPage'
import { StockConversionPage } from './pages/StockConversionPage'
import { ReverseLedgerPage } from './pages/ReverseLedgerPage'
import { ReverseTransferPage } from './pages/ReverseTransferPage'
import { ReverseStocktakePage } from './pages/ReverseStocktakePage'
import { ReceiptCorrectionPage } from './pages/ReceiptCorrectionPage'
import { QualitySuspectPage } from './pages/QualitySuspectPage'
import { FinishedDefectPage } from './pages/FinishedDefectPage'
import { IqcVersionPage } from './pages/IqcVersionPage'
import { DispositionPage } from './pages/DispositionPage'
import { MaintenanceOrdersPage } from './pages/MaintenanceOrdersPage'
import { MaintenancePlansPage } from './pages/MaintenancePlansPage'
import { StockStatisticsPage } from './pages/StockStatisticsPage'
import { AxisQueryPage } from './pages/AxisQueryPage'
import { ReportSummaryPage } from './pages/ReportSummaryPage'
import { ShiftMetricsPage } from './pages/ShiftMetricsPage'

/**
 * [L0-整合标记] P2-UI 六域入口挂载点（web）。
 *
 * 零共享文件纪律（先例：apps/web/src/p4/mount.tsx）：本线不修改 App.tsx /
 * components/AppLayout.tsx 等既有文件。L0 整合时按下面形状接线：
 *
 * 1. 路由（App.tsx 受保护 Route 树内、AppLayout 之下追加）：
 *    {P2_ROUTES.map((r) => (
 *      <Route key={r.path} path={r.path} element={r.element} />
 *    ))}
 * 2. 侧导航（AppLayout.tsx NAV_GROUPS 追加，组内条目按许可显隐 PC-10）：
 *    ...P2_NAV_GROUPS
 * 3. 后端挂载：conversion/reverse/reporting 控制器已由 P2-B/C/F 线交付
 *    （未挂 app.module.ts）；rework/disposition/maintenance 按 packages/ui/src/api/p2
 *    路由形状实现后挂载（对账清单见 delivery/P2/ui/DELIVERY.md）。
 */

export interface P2RouteDef {
  path: string
  element: ReactElement
}

/** P2 路由（/p2/<域>/...，与既有路由不冲突；挂载于受保护树内）。 */
export const P2_ROUTES: P2RouteDef[] = [
  // T15 rework-split
  { path: 'p2/rework', element: <ReworkLedgerPage /> },
  // T16 form-conversion
  { path: 'p2/conversion/order', element: <OrderConversionPage /> },
  { path: 'p2/conversion/stock', element: <StockConversionPage /> },
  // T17 warehouse-reverse
  { path: 'p2/reverse/ledger', element: <ReverseLedgerPage /> },
  { path: 'p2/reverse/transfer', element: <ReverseTransferPage /> },
  { path: 'p2/reverse/stocktake', element: <ReverseStocktakePage /> },
  { path: 'p2/reverse/receipt', element: <ReceiptCorrectionPage /> },
  // T18 quality-disposition
  { path: 'p2/quality/suspect', element: <QualitySuspectPage /> },
  { path: 'p2/quality/defect', element: <FinishedDefectPage /> },
  { path: 'p2/quality/iqc', element: <IqcVersionPage /> },
  { path: 'p2/quality/disposition', element: <DispositionPage /> },
  // T19 maintenance
  { path: 'p2/maintenance/orders', element: <MaintenanceOrdersPage /> },
  { path: 'p2/maintenance/plans', element: <MaintenancePlansPage /> },
  // T20 reporting
  { path: 'p2/reporting/stock-stats', element: <StockStatisticsPage /> },
  { path: 'p2/reporting/axis-query', element: <AxisQueryPage /> },
  { path: 'p2/reporting/summary', element: <ReportSummaryPage /> },
  { path: 'p2/reporting/metrics', element: <ShiftMetricsPage /> },
]

/** 侧导航分组（形状与 AppLayout NAV_GROUPS 条目一致；permission 控组显隐，服务端守卫终校）。 */
export const P2_NAV_GROUPS: Array<{
  title: string | null
  permission?: string
  items: Array<{ to: string; label: string }>
}> = [
  {
    title: '倒轴与轴码治理',
    permission: 'rework.read',
    items: [{ to: '/p2/rework', label: '倒轴/分托/修正/退役台账' }],
  },
  {
    title: '形态转换',
    permission: 'conversion.read',
    items: [
      { to: '/p2/conversion/order', label: '订单转换' },
      { to: '/p2/conversion/stock', label: '库存转换' },
    ],
  },
  {
    title: '仓储逆向',
    permission: 'reverse.read',
    items: [
      { to: '/p2/reverse/ledger', label: '逆向台账' },
      { to: '/p2/reverse/transfer', label: '调拨出入库' },
      { to: '/p2/reverse/stocktake', label: '盘点与差异调整' },
      { to: '/p2/reverse/receipt', label: '采购批次纠正' },
    ],
  },
  {
    title: '质量处置',
    permission: 'disposition.read',
    items: [
      { to: '/p2/quality/suspect', label: '质量存疑' },
      { to: '/p2/quality/defect', label: '成品异常' },
      { to: '/p2/quality/iqc', label: '采购质检版本链' },
      { to: '/p2/quality/disposition', label: '处置决定' },
    ],
  },
  {
    title: '设备维护',
    permission: 'maintenance.read',
    items: [
      { to: '/p2/maintenance/orders', label: '维修工单' },
      { to: '/p2/maintenance/plans', label: '点检/保养计划' },
    ],
  },
  {
    title: '报表与指标',
    permission: 'reporting.read',
    items: [
      { to: '/p2/reporting/stock-stats', label: '库存统计' },
      { to: '/p2/reporting/axis-query', label: '轴查询' },
      { to: '/p2/reporting/summary', label: '报工口径汇总' },
      { to: '/p2/reporting/metrics', label: '指标与追溯' },
    ],
  },
]
