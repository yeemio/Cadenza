import { BusinessClock, LocaleSelect, MockBadge, Button, cn, t as $t, tx as $tx } from '@cadenza/ui'
import {
  Activity,
  ArrowLeftRight,
  Ban,
  Bot,
  Boxes,
  CalendarRange,
  CircleDot,
  ClipboardCheck,
  ClipboardList,
  Coins,
  Factory,
  Gauge,
  GitBranch,
  Hammer,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Network,
  Package,
  PackageCheck,
  PackageOpen,
  PackagePlus,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Repeat,
  ShoppingCart,
  TriangleAlert,
  Ruler,
  ScanBarcode,
  ScanSearch,
  Send,
  ShieldQuestion,
  ShieldAlert,
  ShieldCheck,
  Scale,
  Shuffle,
  Truck,
  Undo2,
  UsersRound,
  Warehouse,
  Workflow,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Navigate, NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../auth'
import { isMock } from '../api'
import { INVENTORY_READ, MASTERDATA_READ, PROCESS_READ, PURCHASE_READ, QUALITY_READ, SHIPPING_READ, WAREHOUSING_READ, usePermissions } from '../permissions'
import { P2_NAV_GROUPS } from '../p2/mount'
import { P3_NAV_GROUPS } from '../p3/mount'
import { P4_NAV_GROUPS } from '../p4/mount'

/** 未登录访问受保护路由 → 登录页，并记住来源（返回时回跳，PC-17 的最小实现） */
export function RequireAuth({ children }: { children?: ReactNode }) {
  const { session } = useAuth()
  const location = useLocation()
  if (!session) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }
  return <>{children ?? <Outlet />}</>
}

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  end?: boolean
}

/** 侧导航分组：组内条目按许可显隐（PC-10/PC-18：菜单名=页面标题；服务端守卫终校） */
const NAV_GROUPS: Array<{ title: string | null; items: NavItem[]; permission?: string }> = [
  {
    title: null,
    items: [
      { to: '/dashboard', label: '看板', icon: LayoutDashboard },
      { to: '/org/nodes', label: '机构管理', icon: Network },
      { to: '/org/users', label: '用户管理', icon: UsersRound },
      { to: '/org/roles', label: '角色管理', icon: ShieldCheck },
      { to: '/org/grants', label: '授权管理', icon: KeyRound },
    ],
  },
  {
    title: '主数据',
    permission: MASTERDATA_READ,
    items: [
      { to: '/masterdata/materials', label: '料品管理', icon: Package },
      { to: '/masterdata/equipment', label: '设备管理', icon: Wrench },
      { to: '/masterdata/warehouses', label: '仓库管理', icon: Warehouse },
      { to: '/masterdata/work-centers', label: '工作中心', icon: Workflow },
    ],
  },
  {
    title: '库存查询',
    permission: INVENTORY_READ,
    items: [
      { to: '/inventory/balances', label: '库存余额', icon: Boxes },
      { to: '/inventory/barcode', label: '条码解析', icon: ScanBarcode },
      { to: '/inventory/units', label: '单元详情', icon: ScanSearch },
    ],
  },
  {
    title: '生产管理',
    permission: PROCESS_READ,
    items: [
      { to: '/production/orders', label: '生产订单', icon: ClipboardList },
      { to: '/production/scheduling', label: '生产排程', icon: CalendarRange },
      { to: '/production/workbench', label: '报工工作台', icon: Hammer },
      { to: '/production/feeding', label: '投料', icon: PackagePlus },
    ],
  },
  {
    title: '质量管理',
    permission: QUALITY_READ,
    items: [
      { to: '/quality/inspections', label: '检验任务', icon: ClipboardCheck },
      { to: '/quality/holds', label: '存疑与隔离', icon: ShieldAlert },
    ],
  },
  {
    title: '仓储管理',
    permission: WAREHOUSING_READ,
    items: [
      { to: '/warehousing/putaway', label: '入库任务', icon: PackageOpen },
      { to: '/warehousing/moves', label: '移库', icon: ArrowLeftRight },
      { to: '/warehousing/transfers', label: '调拨', icon: Repeat },
    ],
  },
  {
    title: '发运管理',
    permission: SHIPPING_READ,
    items: [
      { to: '/shipping/orders', label: '发货单列表', icon: Truck },
      { to: '/shipping/packing', label: '备货工作台', icon: PackageCheck },
      { to: '/shipping/outbound', label: '出库确认', icon: Send },
    ],
  },
  {
    title: '采购管理',
    permission: PURCHASE_READ,
    items: [
      { to: '/purchase/orders', label: '采购订单/同步', icon: ShoppingCart },
    ],
  },
  {
    title: '集团计划',
    items: [
      { to: '/group/allocation-revision', label: '分配修订', icon: RefreshCw },
      { to: '/group/shortage-kitting', label: '缺料/齐套', icon: TriangleAlert },
      { to: '/group/vendor-risk', label: '供应商风险', icon: ShieldQuestion },
      { to: '/group/rework-scrap-recall', label: '返工/报废/召回', icon: Shuffle },
      { to: '/sap/reconciliation', label: '双账对账', icon: Scale },
    ],
  },
  {
    title: '异常与拦截',
    items: [
      { to: '/production/correct-clear', label: '轴号修正/清码', icon: ScanSearch },
      { to: '/production/feed-race-plan', label: '投料竞争/计划部分', icon: GitBranch },
      { to: '/quality/return-restore', label: '退料/退货/恢复', icon: Undo2 },
      { to: '/scan-block', label: '扫描拦截', icon: Ban },
    ],
  },
]

/**
 * L0 整合接线（2026-10-29）：P3/P4 挂载点导航组并入。mount 侧条目形状最小依赖（不带图标），
 * 此处按路由映射 Lucide 图标（组级 permission 由上方 flatMap 的 has() 过滤承载，PC-10）。
 */
/** P2/P3/P4 mount 侧条目不带图标；此处按路由映射 Lucide（缺省 CircleDot）。 */
const P234_NAV_ICONS: Record<string, LucideIcon> = {
  '/p2/rework': Shuffle,
  '/p2/conversion/order': Repeat,
  '/p2/conversion/stock': Boxes,
  '/p2/reverse/ledger': ArrowLeftRight,
  '/p2/reverse/transfer': ArrowLeftRight,
  '/p2/reverse/stocktake': ClipboardList,
  '/p2/reverse/receipt': PackageCheck,
  '/p2/quality/suspect': ShieldAlert,
  '/p2/quality/defect': ShieldAlert,
  '/p2/quality/iqc': ClipboardCheck,
  '/p2/quality/disposition': ClipboardCheck,
  '/p2/maintenance/orders': Wrench,
  '/p2/maintenance/plans': CalendarRange,
  '/p2/reporting/stock-stats': Boxes,
  '/p2/reporting/axis-query': ScanSearch,
  '/p2/reporting/summary': ClipboardList,
  '/p2/reporting/metrics': Gauge,
  '/ot/monitor': Activity,
  '/ot/samples': Gauge,
  '/ot/facts': ClipboardList,
  '/spc/changes': Shuffle,
  '/spc/charts': CircleDot,
  '/spc/calibration': Ruler,
  '/spc/tools': Wrench,
  '/cost/reports': Coins,
  '/cost/energy': Zap,
  '/outsourcing/tasks': ArrowLeftRight,
  '/ai/query': Bot,
}

const NAV_GROUPS_WITH_P34: Array<{ title: string | null; items: NavItem[]; permission?: string }> = [
  ...NAV_GROUPS,
  ...[...P2_NAV_GROUPS, ...P3_NAV_GROUPS, ...P4_NAV_GROUPS].map((group) => ({
    ...group,
    items: group.items.map((item) => ({ ...item, icon: P234_NAV_ICONS[item.to] ?? CircleDot })),
  })),
]

/**
 * 管理工作台布局（UI 现代化版）：可收窄侧导航（图标 + lucide）+ 顶栏上下文/用户区 + 内容区。
 * MockBadge 仅在 mock 演示模式渲染（live 模式不显示"演示数据"标识——2026-10-28 修复）。
 */
export function AppLayout() {
  const { session, logout } = useAuth()
  const { has } = usePermissions()
  const [collapsed, setCollapsed] = useState(false)
  const scopeLabel = session?.dataScope.enterpriseWide
    ? $t('企业范围')
    : $t('厂区范围（{p0} 厂）', { p0: session?.dataScope.plantIds.length ?? 0 })
  return (
    <div className="flex min-h-screen bg-background">
      <aside
        className={cn(
          'sticky top-0 flex h-screen shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-200',
          collapsed ? 'w-[3.75rem]' : 'w-52',
        )}
        aria-label={$t('主导航面板')}
      >
        <div className="flex h-14 items-center gap-2.5 border-b border-sidebar-border px-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-xs">
            <Factory className="size-4.5" aria-hidden />
          </span>
          {!collapsed ? (
            <span className="min-w-0 leading-tight">
              <strong className="block truncate text-[15px] font-semibold text-foreground">Cadenza</strong>
              <span className="block truncate text-[11.5px] text-muted-foreground">{$t('线缆协同工作台')}</span>
            </span>
          ) : null}
        </div>
        <nav
          aria-label={$t('主导航')}
          className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-3"
        >
          {NAV_GROUPS_WITH_P34.flatMap((group) => {
            if (group.permission !== undefined && !has(group.permission)) return []
            return [
              group.title !== null && !collapsed ? (
                <div
                  key={`group-${group.title}`}
                  className="px-2.5 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground first:pt-0"
                >
                  {$tx(group.title)}
                </div>
              ) : null,
              ...group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  title={collapsed ? $tx(item.label) : undefined}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center rounded-md text-sm transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35',
                      collapsed ? 'justify-center px-0 py-2.5' : 'gap-2.5 px-2.5 py-2',
                      isActive
                        ? 'bg-primary/10 font-semibold text-primary'
                        : 'text-sidebar-foreground/85 font-normal hover:bg-sidebar-accent hover:text-foreground',
                    )
                  }
                >
                  <item.icon className="size-4 shrink-0" aria-hidden />
                  {!collapsed ? <span className="truncate">{$tx(item.label)}</span> : null}
                </NavLink>
              )),
            ]
          })}
        </nav>
        <div className="border-t border-sidebar-border p-2">
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? $t('展开导航') : $t('收窄导航')}
            className={cn(
              'flex w-full items-center rounded-md py-2 text-muted-foreground transition-colors outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/35',
              collapsed ? 'justify-center' : 'justify-start gap-2.5 px-2.5',
            )}
          >
            {collapsed ? (
              <PanelLeftOpen className="size-4" aria-hidden />
            ) : (
              <>
                <PanelLeftClose className="size-4" aria-hidden />
                <span className="text-[13px]">{$t('收窄导航')}</span>
              </>
            )}
          </button>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-card/85 px-5 backdrop-blur">
          {session ? (
            <span className="min-w-0 truncate text-[13px] text-muted-foreground">
              {session.user.enterpriseName}
              <span className="mx-1.5 text-border" aria-hidden>
                {$t('｜')}
              </span>
              {$t('工厂')} {session.user.plantName}
              <span className="mx-1.5 text-border" aria-hidden>
                {$t('｜')}
              </span>
              {scopeLabel}
            </span>
          ) : null}
          <span className="flex-1" />
          {session ? (
            <BusinessClock plantName={session.user.plantName} data-testid-business-clock />
          ) : null}
          <LocaleSelect />
          {isMock ? <MockBadge /> : null}
          {session ? (
            <>
              <span className="flex items-center gap-2 rounded-full border bg-card py-1 pr-3 pl-1 shadow-xs">
                <span className="flex size-6 items-center justify-center rounded-full bg-primary/12 text-xs font-semibold text-primary">
                  {session.user.displayName.slice(0, 1)}
                </span>
                <span className="text-[13px] text-foreground">
                  {session.user.displayName}
                  <span className="text-muted-foreground">{$t('（')}{session.user.loginName}{$t('）')}</span>
                </span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => void logout()} title={$t('退出登录')}>
                <LogOut aria-hidden />
                {$t('退出登录')}
              </Button>
            </>
          ) : null}
        </header>
        <main className="min-w-0 flex-1 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
