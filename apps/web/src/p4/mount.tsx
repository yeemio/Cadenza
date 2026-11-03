import type { ReactElement } from 'react'
import { AiQueryPage } from './pages/AiQueryPage'

/**
 * [L0-整合标记] P4-UI 问数入口挂载点（web）。
 *
 * 零共享文件纪律（P2 包 §2 / AR-02 同则）：本线不修改 apps/web/src/App.tsx、
 * components/AppLayout.tsx 等既有文件。L0 整合时按下面形状接线（先例：P2-UI 决策同型）：
 *
 * 1. 路由（App.tsx 受保护 Route 树内、AppLayout 之下追加）：
 *    {P4_ROUTES.map((r) => (
 *      <Route key={r.path} path={r.path} element={r.element} />
 *    ))}
 *    —— 挂载于 RequireAuth 内：问数入口需登录会话（AR-04/AQ-AUTH-02）。
 * 2. 侧导航（AppLayout.tsx NAV_GROUPS 追加一组，组内条目按许可显隐 PC-10）：
 *    ...P4_NAV_GROUPS
 * 3. 真实 API 接线：接入层挂载 /aiquery/turns、/aiquery/turns/:requestId/cancel、
 *    /aiquery/health 用户面端点（apps/api aiquery 接入层转发 apps/ai，AR-22）；
 *    /aiquery/sessions 已由 P4-A 线实现。前端无需改动（客户端面已按合同形状冻结，
 *    见 packages/ui/src/api/p4/client.ts）。
 */

export interface P4RouteDef {
  path: string
  element: ReactElement
}

/** 问数路由（path 不与既有路由冲突；挂载于受保护树内）。 */
export const P4_ROUTES: P4RouteDef[] = [{ path: 'ai/query', element: <AiQueryPage /> }]

/** 侧导航分组（形状与 AppLayout NAV_GROUPS 条目一致；permission=aiquery.use 显隐，服务端守卫终校）。 */
export const P4_NAV_GROUPS: Array<{ title: string | null; permission?: string; items: Array<{ to: string; label: string }> }> = [
  {
    title: 'AI 问数',
    permission: 'aiquery.use',
    items: [{ to: '/ai/query', label: '问数' }],
  },
]
