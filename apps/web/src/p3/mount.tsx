import type { ReactElement } from 'react'
import { CostEnergyPage } from './pages/CostEnergyPage'
import { CostReportsPage } from './pages/CostReportsPage'
import { OtFactsPage } from './pages/OtFactsPage'
import { OtMonitorPage } from './pages/OtMonitorPage'
import { OtSamplesPage } from './pages/OtSamplesPage'
import { OutsourcingTasksPage } from './pages/OutsourcingTasksPage'
import { SpcCalibrationPage } from './pages/SpcCalibrationPage'
import { SpcChartsPage } from './pages/SpcChartsPage'
import { SpcChangesPage } from './pages/SpcChangesPage'
import { SpcToolsPage } from './pages/SpcToolsPage'
import { COST_READ, CSW_READ, OT_READ, SPC_READ } from './permissions'

/**
 * [L0-整合标记] P3-UI 域页面挂载点（web）。
 *
 * 零共享文件纪律（P3 包 / P2 包 §2 同则）：本线不修改 apps/web/src/App.tsx、
 * components/AppLayout.tsx 等既有文件。L0 整合时按下面形状接线（先例：P4-UI mount.tsx）：
 *
 * 1. 路由（App.tsx 受保护 Route 树内、AppLayout 之下追加）：
 *    {P3_ROUTES.map((r) => (
 *      <Route key={r.path} path={r.path} element={r.element} />
 *    ))}
 *    —— 挂载于 RequireAuth 内（P3 域页面需登录会话；域内按许可再分层，PC-10）。
 * 2. 侧导航（AppLayout.tsx NAV_GROUPS 追加四组，组内条目按许可显隐 PC-10）：
 *    ...P3_NAV_GROUPS
 * 3. API 对齐：ot/spc/csw/cost 四域端点形状均已按 apps/api 落盘控制器对齐
 *    （cost 于 2026-10-28 落盘后由"按冻结合同先行"切换为对齐落盘 API）——L0 注册后
 *    统一复核字段漂移（见 delivery/P3/ui/DELIVERY.md 对账清单）。
 */

export interface P3RouteDef {
  path: string
  element: ReactElement
}

/** P3 域路由（path 不与既有路由冲突；挂载于受保护树内）。 */
export const P3_ROUTES: P3RouteDef[] = [
  { path: 'ot/monitor', element: <OtMonitorPage /> },
  { path: 'ot/samples', element: <OtSamplesPage /> },
  { path: 'ot/facts', element: <OtFactsPage /> },
  { path: 'spc/changes', element: <SpcChangesPage /> },
  { path: 'spc/charts', element: <SpcChartsPage /> },
  { path: 'spc/calibration', element: <SpcCalibrationPage /> },
  { path: 'spc/tools', element: <SpcToolsPage /> },
  { path: 'cost/reports', element: <CostReportsPage /> },
  { path: 'cost/energy', element: <CostEnergyPage /> },
  { path: 'outsourcing/tasks', element: <OutsourcingTasksPage /> },
]

/** 侧导航分组（形状与 AppLayout NAV_GROUPS 条目一致；按许可显隐，服务端守卫终校）。 */
export const P3_NAV_GROUPS: Array<{
  title: string | null
  permission?: string
  items: Array<{ to: string; label: string }>
}> = [
  {
    title: '采集与监控',
    permission: OT_READ,
    items: [
      { to: '/ot/monitor', label: '采集监控' },
      { to: '/ot/samples', label: '采集样本' },
      { to: '/ot/facts', label: '采集入账' },
    ],
  },
  {
    title: '工艺与计量',
    permission: SPC_READ,
    items: [
      { to: '/spc/changes', label: '工艺变更' },
      { to: '/spc/charts', label: 'SPC 控制图' },
      { to: '/spc/calibration', label: '计量校准' },
      { to: '/spc/tools', label: '工具寿命' },
    ],
  },
  {
    title: '成本与能源',
    permission: COST_READ,
    items: [
      { to: '/cost/reports', label: '成本报表' },
      { to: '/cost/energy', label: '能源单耗' },
    ],
  },
  {
    title: '外协管理',
    permission: CSW_READ,
    items: [{ to: '/outsourcing/tasks', label: '外协任务' }],
  },
]
