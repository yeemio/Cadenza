import { lazy, type ReactElement } from 'react'

const AiQueryPdaPage = lazy(() => import('./pages/AiQueryPdaPage').then((module) => ({ default: module.AiQueryPdaPage })))

/**
 * [L0-整合标记] P4-UI 问数入口挂载点（PDA 可选入口）。
 *
 * 零共享文件纪律：不修改 apps/pda/src/App.tsx、components/PdaLayout.tsx。L0 整合时：
 * 1. 路由（App.tsx 受保护 Route 树内追加）：
 *    {P4_PDA_ROUTES.map((r) => (
 *      <Route key={r.path} path={r.path} element={r.element} />
 *    ))}
 * 2. 底部导航（PdaLayout.tsx TABS 追加，或按许可显隐 PC-10）：
 *    ...P4_PDA_NAV_TABS（aiquery.use 无权限时建议不显示该 Tab）。
 */

export interface P4PdaRouteDef {
  path: string
  element: ReactElement
}

/** 问数路由（PDA）。 */
export const P4_PDA_ROUTES: P4PdaRouteDef[] = [{ path: 'ai/query', element: <AiQueryPdaPage /> }]

/** 底部导航 Tab（形状与 PdaLayout TABS 条目一致）。 */
export const P4_PDA_NAV_TABS: Array<{ to: string; label: string; icon: string }> = [
  { to: '/ai/query', label: '问数', icon: '◎' },
]
