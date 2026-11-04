import { BusinessClock, LocaleSelect, MockBadge, cn, t as $t, tx as $tx } from '@cadenza/ui'
import {
  ArrowLeftRight,
  Bot,
  Cog,
  Factory,
  ListChecks,
  PackageOpen,
  PackagePlus,
  Truck,
  UserRound,
  type LucideIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { Navigate, NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../auth'
import { api, isMock } from '../api'
import { AIQUERY_USE, useP4Permissions } from '../p4/permissions'
import { CSW_READ, useP3PdaPermissions } from '../p3/permissions'

export function RequireAuth({ children }: { children?: ReactNode }) {
  const { session } = useAuth()
  const location = useLocation()
  if (!session) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }
  return <>{children ?? <Outlet />}</>
}

/** 底部导航项：大触区（≥56px），高对比图标文字 */
const TABS: Array<{ to: string; label: string; icon: LucideIcon }> = [
  { to: '/tasks', label: '任务', icon: ListChecks },
  { to: '/production', label: '生产', icon: Cog },
  { to: '/feed', label: '投料', icon: PackagePlus },
  { to: '/putaway', label: '入库', icon: PackageOpen },
  { to: '/shipping', label: '发运', icon: Truck },
  { to: '/me', label: '我的', icon: UserRound },
]

/**
 * L0 整合接线（2026-10-29）：P3 外协接收（csw.read）与 P4 问数（aiquery.use）Tab
 * 按许可显隐（PC-10，服务端守卫终校）；无许可时该 Tab 不显示。
 */
function useMountedTabs(): Array<{ to: string; label: string; icon: LucideIcon }> {
  const p3 = useP3PdaPermissions()
  const p4 = useP4Permissions()
  const extra: Array<{ to: string; label: string; icon: LucideIcon }> = []
  if (p3.has(CSW_READ)) extra.push({ to: '/outsourcing/receive', label: $t('外协接收'), icon: ArrowLeftRight })
  if (p4.has(AIQUERY_USE)) extra.push({ to: '/ai/query', label: $t('问数'), icon: Bot })
  return [...TABS, ...extra]
}

/**
 * PDA 布局（UI 现代化版，大触区规范保留）：
 * 顶栏（用户/工厂上下文 + mock 模式"演示数据"标识）+ 内容区 + 底部大触区导航。
 * PC-03：系统返回键不依赖（仅导航返回）；底部导航与页内按钮均走显式路由。
 * MockBadge 仅在 mock 演示模式渲染（live 模式不显示——与 web AppLayout 同步修复）。
 */
export function PdaLayout() {
  const { session } = useAuth()
  const tabs = useMountedTabs()
  return (
    <div className="flex h-screen flex-col bg-background font-sans">
      <header className="flex h-12 flex-none items-center gap-2.5 bg-topbar px-3.5 text-topbar-foreground">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-white/12">
          <Factory className="size-4" aria-hidden />
        </span>
        <strong className="text-[15px] font-semibold">{$t('Cadenza 现场终端')}</strong>
        {session ? (
          <span className="truncate text-xs opacity-85">{session.user.plantName}</span>
        ) : null}
        <span className="flex-1" />
        {session ? <BusinessClock plantId={session.user.plantId} loadCalendar={api.schedulingShiftInfo} /> : null}
        <LocaleSelect className="h-7 border-white/25 bg-white/10 text-[12px] text-topbar-foreground" />
        {isMock ? <MockBadge /> : null}
      </header>
      <main className="min-w-0 flex-1 overflow-y-auto p-3.5">
        <Outlet />
      </main>
      <nav
        aria-label={$t('底部导航')}
        className="flex flex-none border-t bg-card pb-[env(safe-area-inset-bottom)] shadow-[0_-1px_8px_oklch(0.262_0.024_262/0.06)]"
      >
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              cn(
                'relative flex min-h-[3.75rem] flex-1 flex-col items-center justify-center gap-0.5 text-[13px] no-underline transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35',
                isActive
                  ? 'font-bold text-primary'
                  : 'font-normal text-muted-foreground hover:text-foreground',
              )
            }
          >
            {({ isActive }) => (
              <>
                <span
                  className={cn(
                    'absolute inset-x-[calc(50%-1rem)] top-0 h-0.5 rounded-full bg-primary transition-opacity',
                    isActive ? 'opacity-100' : 'opacity-0',
                  )}
                  aria-hidden
                />
                <tab.icon className="size-5" aria-hidden />
                {$tx(tab.label)}
              </>
            )}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
