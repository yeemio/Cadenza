import type { ReactElement } from 'react'
import { OutsourcingReceivePage } from './pages/OutsourcingReceivePage'

/**
 * [L0-整合标记] P3-UI 域页面挂载点（PDA）。
 *
 * 零共享文件纪律：不修改 apps/pda/src/App.tsx、components/PdaLayout.tsx。L0 整合时：
 * 1. 路由（App.tsx 受保护 Route 树内追加）：
 *    {P3_PDA_ROUTES.map((r) => (
 *      <Route key={r.path} path={r.path} element={r.element} />
 *    ))}
 * 2. 底部导航（PdaLayout.tsx TABS 追加，按 csw.read 显隐 PC-10）：
 *    ...P3_PDA_NAV_TABS
 */

export interface P3PdaRouteDef {
  path: string
  element: ReactElement
}

/** P3 域路由（PDA）。 */
export const P3_PDA_ROUTES: P3PdaRouteDef[] = [{ path: 'outsourcing/receive', element: <OutsourcingReceivePage /> }]

/** 底部导航 Tab（形状与 PdaLayout TABS 条目一致）。 */
export const P3_PDA_NAV_TABS: Array<{ to: string; label: string; icon: string }> = [
  { to: '/outsourcing/receive', label: '外协接收', icon: '⇄' },
]
