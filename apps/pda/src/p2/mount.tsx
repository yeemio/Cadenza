import type { ReactElement } from 'react'
import { ReelSplitPdaPage } from './pages/ReelSplitPdaPage'
import { PalletTaskPdaPage } from './pages/PalletTaskPdaPage'
import { AxisCorrectionPdaPage } from './pages/AxisCorrectionPdaPage'
import { AxisRetirePdaPage } from './pages/AxisRetirePdaPage'
import { OrderConversionScanPdaPage } from './pages/OrderConversionScanPdaPage'
import { ReverseMovePdaPage } from './pages/ReverseMovePdaPage'
import { ReverseTransferOutPdaPage } from './pages/ReverseTransferOutPdaPage'
import { ReverseTransferInPdaPage } from './pages/ReverseTransferInPdaPage'
import { QualitySuspectPdaPage } from './pages/QualitySuspectPdaPage'
import { FinishedDefectPdaPage } from './pages/FinishedDefectPdaPage'
import { IqcCodePdaPage } from './pages/IqcCodePdaPage'
import { EquipmentExceptionPdaPage } from './pages/EquipmentExceptionPdaPage'
import { EquipmentStartPdaPage } from './pages/EquipmentStartPdaPage'
import { PdaCumulativePdaPage } from './pages/PdaCumulativePdaPage'

/**
 * [L0-整合标记] P2-UI 六域入口挂载点（PDA）。
 *
 * 零共享文件纪律（先例：apps/pda/src/p4/mount.tsx）：不修改 App.tsx / PdaLayout.tsx。L0 整合时：
 * 1. 路由（App.tsx 受保护 Route 树内追加）：
 *    {P2_PDA_ROUTES.map((r) => (
 *      <Route key={r.path} path={r.path} element={r.element} />
 *    ))}
 * 2. 底部导航（PdaLayout.tsx TABS 追加，或按许可显隐 PC-10）：P2_PDA_NAV_TABS 建议聚合为一个
 *    「P2 作业」入口页（14 页较多，建议入口列表页而非平铺 Tab；L0 裁定布局）。
 */
export interface P2PdaRouteDef {
  path: string
  element: ReactElement
}

/** P2 PDA 路由（p2/...，与既有路由不冲突）。 */
export const P2_PDA_ROUTES: P2PdaRouteDef[] = [
  // T15 rework-split
  { path: 'p2/reel-split', element: <ReelSplitPdaPage /> },
  { path: 'p2/pallet-task', element: <PalletTaskPdaPage /> },
  { path: 'p2/axis-correction', element: <AxisCorrectionPdaPage /> },
  { path: 'p2/axis-retire', element: <AxisRetirePdaPage /> },
  // T16 form-conversion（PDA 扫码面）
  { path: 'p2/conversion-scan', element: <OrderConversionScanPdaPage /> },
  // T17 warehouse-reverse
  { path: 'p2/move', element: <ReverseMovePdaPage /> },
  { path: 'p2/transfer-out', element: <ReverseTransferOutPdaPage /> },
  { path: 'p2/transfer-in', element: <ReverseTransferInPdaPage /> },
  // T18 quality-disposition
  { path: 'p2/suspect', element: <QualitySuspectPdaPage /> },
  { path: 'p2/defect', element: <FinishedDefectPdaPage /> },
  { path: 'p2/iqc-code', element: <IqcCodePdaPage /> },
  // T19 maintenance
  { path: 'p2/equipment-exception', element: <EquipmentExceptionPdaPage /> },
  { path: 'p2/equipment-start', element: <EquipmentStartPdaPage /> },
  // T20 reporting
  { path: 'p2/cumulative', element: <PdaCumulativePdaPage /> },
]

/** 底部导航 Tab（形状与 PdaLayout TABS 条目一致；permission 控显隐）。 */
export const P2_PDA_NAV_TABS: Array<{ to: string; label: string; icon: string; permission?: string }> = [
  { to: '/p2/reel-split', label: '倒轴', icon: '↻', permission: 'rework.post' },
  { to: '/p2/pallet-task', label: '分托', icon: '▤', permission: 'rework.post' },
  { to: '/p2/move', label: '移库', icon: '⇄', permission: 'reverse.post' },
  { to: '/p2/transfer-out', label: '调出', icon: '→', permission: 'reverse.post' },
  { to: '/p2/transfer-in', label: '调入', icon: '←', permission: 'reverse.post' },
  { to: '/p2/suspect', label: '存疑', icon: '!', permission: 'disposition.post' },
  { to: '/p2/equipment-exception', label: '设备异常', icon: '⚙', permission: 'maintenance.post' },
  { to: '/p2/cumulative', label: '累计', icon: 'Σ', permission: 'reporting.read' },
]
