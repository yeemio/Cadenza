import { lazy } from 'react'
import { LazyRouteOutlet } from './loading/mount'
import { Navigate, Route, Routes } from 'react-router-dom'
import { LocaleProvider } from '@cadenza/ui'
import { AuthProvider } from './auth'
import { PdaLayout, RequireAuth } from './components/PdaLayout'
import { LoginPage } from './pages/LoginPage'
import { P2_PDA_ROUTES } from './p2/mount'
import { P3_PDA_ROUTES } from './p3/mount'
import { P4_PDA_ROUTES } from './p4/mount'

const FeedScanPage = lazy(() => import('./pages/FeedScanPage').then((module) => ({ default: module.FeedScanPage })))
const MePage = lazy(() => import('./pages/MePage').then((module) => ({ default: module.MePage })))
const ProductionPage = lazy(() => import('./pages/ProductionPage').then((module) => ({ default: module.ProductionPage })))
const PutawayScanPage = lazy(() => import('./pages/PutawayScanPage').then((module) => ({ default: module.PutawayScanPage })))
const ShippingOutboundPage = lazy(() => import('./pages/ShippingOutboundPage').then((module) => ({ default: module.ShippingOutboundPage })))
const ShippingScanPage = lazy(() => import('./pages/ShippingScanPage').then((module) => ({ default: module.ShippingScanPage })))
const ScanPage = lazy(() => import('./pages/ScanPage').then((module) => ({ default: module.ScanPage })))
const TasksPage = lazy(() => import('./pages/TasksPage').then((module) => ({ default: module.TasksPage })))
const InventoryHubPage = lazy(() => import('./pages/InventoryHubPage').then((module) => ({ default: module.InventoryHubPage })))
const PackingAliasPage = lazy(() => import('./pages/PackingAliasPage').then((module) => ({ default: module.PackingAliasPage })))

export function App() {
  return (
    <LocaleProvider>
      <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<RequireAuth />}>
          <Route element={<PdaLayout />}>
            <Route element={<LazyRouteOutlet />}>
              <Route index element={<Navigate to="/tasks" replace />} />
              <Route path="/tasks" element={<TasksPage />} />
              <Route path="/production" element={<ProductionPage />} />
              <Route path="/feed" element={<FeedScanPage />} />
              <Route path="/putaway" element={<PutawayScanPage />} />
              <Route path="/shipping" element={<ShippingScanPage />} />
              <Route path="/shipping/outbound" element={<ShippingOutboundPage />} />
              <Route path="/outbound" element={<ShippingOutboundPage />} />
              <Route path="/packing" element={<PackingAliasPage />} />
              <Route path="/inventory" element={<InventoryHubPage />} />
              <Route path="/stock" element={<InventoryHubPage />} />
              <Route path="/moves" element={<InventoryHubPage />} />
              <Route path="/quality" element={<Navigate to="/p2/suspect" replace />} />
              <Route path="/inspect" element={<Navigate to="/p2/iqc-code" replace />} />
              <Route path="/scan" element={<ScanPage />} />
              <Route path="/me" element={<MePage />} />
              {/* L0 整合：P2 六域 PDA + P3 外协 + P4 问数 */}
              {P2_PDA_ROUTES.map((r) => (
                <Route key={r.path} path={r.path} element={r.element} />
              ))}
              {P3_PDA_ROUTES.map((r) => (
                <Route key={r.path} path={r.path} element={r.element} />
              ))}
              {P4_PDA_ROUTES.map((r) => (
                <Route key={r.path} path={r.path} element={r.element} />
              ))}
            </Route>
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/tasks" replace />} />
      </Routes>
    </AuthProvider>
    </LocaleProvider>
  )
}
