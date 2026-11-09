import { lazy } from 'react'
import { LazyRouteOutlet } from './loading/mount'
import { Navigate, Route, Routes } from 'react-router-dom'
import { LocaleProvider } from '@cadenza/ui'
import { AppLayout, RequireAuth } from './components/AppLayout'
import { AuthProvider } from './auth'
import { P2_ROUTES } from './p2/mount'
import { P3_ROUTES } from './p3/mount'
import { P4_ROUTES } from './p4/mount'
import { LoginPage } from './pages/LoginPage'

const DashboardPage = lazy(() => import('./pages/DashboardPage').then((module) => ({ default: module.DashboardPage })))
const PurchaseOrdersPage = lazy(() => import('./pages/PurchaseOrdersPage').then((module) => ({ default: module.PurchaseOrdersPage })))
const GroupAllocationRevisionPage = lazy(() => import('./pages/GroupAllocationRevisionPage').then((module) => ({ default: module.GroupAllocationRevisionPage })))
const ShortageKittingPage = lazy(() => import('./pages/ShortageKittingPage').then((module) => ({ default: module.ShortageKittingPage })))
const FeedRacePlanPage = lazy(() => import('./pages/FeedRacePlanPage').then((module) => ({ default: module.FeedRacePlanPage })))
const ScanBlockPage = lazy(() => import('./pages/ScanBlockPage').then((module) => ({ default: module.ScanBlockPage })))
const VendorRiskPage = lazy(() => import('./pages/VendorRiskPage').then((module) => ({ default: module.VendorRiskPage })))
const SapReconciliationPage = lazy(() => import('./pages/SapReconciliationPage').then((module) => ({ default: module.SapReconciliationPage })))
const ReworkScrapRecallHubPage = lazy(() => import('./pages/ReworkScrapRecallHubPage').then((module) => ({ default: module.ReworkScrapRecallHubPage })))
const CorrectClearPage = lazy(() => import('./pages/CorrectClearPage').then((module) => ({ default: module.CorrectClearPage })))
const ReturnRestoreHubPage = lazy(() => import('./pages/ReturnRestoreHubPage').then((module) => ({ default: module.ReturnRestoreHubPage })))
const ExecutionWorkbenchPage = lazy(() => import('./pages/ExecutionWorkbenchPage').then((module) => ({ default: module.ExecutionWorkbenchPage })))
const FeedingPage = lazy(() => import('./pages/FeedingPage').then((module) => ({ default: module.FeedingPage })))
const InventoryBalancesPage = lazy(() => import('./pages/InventoryBalancesPage').then((module) => ({ default: module.InventoryBalancesPage })))
const InventoryBarcodePage = lazy(() => import('./pages/InventoryBarcodePage').then((module) => ({ default: module.InventoryBarcodePage })))
const InventoryUnitPage = lazy(() => import('./pages/InventoryUnitPage').then((module) => ({ default: module.InventoryUnitPage })))
const MasterEquipmentPage = lazy(() => import('./pages/MasterEquipmentPage').then((module) => ({ default: module.MasterEquipmentPage })))
const MasterMaterialsPage = lazy(() => import('./pages/MasterMaterialsPage').then((module) => ({ default: module.MasterMaterialsPage })))
const MasterWarehouseDetailPage = lazy(() => import('./pages/MasterWarehouseDetailPage').then((module) => ({ default: module.MasterWarehouseDetailPage })))
const MasterWarehousesPage = lazy(() => import('./pages/MasterWarehousesPage').then((module) => ({ default: module.MasterWarehousesPage })))
const MasterWorkCentersPage = lazy(() => import('./pages/MasterWorkCentersPage').then((module) => ({ default: module.MasterWorkCentersPage })))
const OrgGrantsPage = lazy(() => import('./pages/OrgGrantsPage').then((module) => ({ default: module.OrgGrantsPage })))
const OrgNodesPage = lazy(() => import('./pages/OrgNodesPage').then((module) => ({ default: module.OrgNodesPage })))
const OrgRolesPage = lazy(() => import('./pages/OrgRolesPage').then((module) => ({ default: module.OrgRolesPage })))
const OrgUsersPage = lazy(() => import('./pages/OrgUsersPage').then((module) => ({ default: module.OrgUsersPage })))
const ProductionOrderDetailPage = lazy(() => import('./pages/ProductionOrderDetailPage').then((module) => ({ default: module.ProductionOrderDetailPage })))
const ProductionOrdersPage = lazy(() => import('./pages/ProductionOrdersPage').then((module) => ({ default: module.ProductionOrdersPage })))
const QualityHoldsPage = lazy(() => import('./pages/QualityHoldsPage').then((module) => ({ default: module.QualityHoldsPage })))
const QualityInspectionDetailPage = lazy(() => import('./pages/QualityInspectionDetailPage').then((module) => ({ default: module.QualityInspectionDetailPage })))
const QualityInspectionsPage = lazy(() => import('./pages/QualityInspectionsPage').then((module) => ({ default: module.QualityInspectionsPage })))
const SchedulingPage = lazy(() => import('./pages/SchedulingPage').then((module) => ({ default: module.SchedulingPage })))
const ShippingOrdersPage = lazy(() => import('./pages/ShippingOrdersPage').then((module) => ({ default: module.ShippingOrdersPage })))
const ShippingOutboundPage = lazy(() => import('./pages/ShippingOutboundPage').then((module) => ({ default: module.ShippingOutboundPage })))
const ShippingPackingPage = lazy(() => import('./pages/ShippingPackingPage').then((module) => ({ default: module.ShippingPackingPage })))
const WarehousingMovesPage = lazy(() => import('./pages/WarehousingMovesPage').then((module) => ({ default: module.WarehousingMovesPage })))
const WarehousingPutawayPage = lazy(() => import('./pages/WarehousingPutawayPage').then((module) => ({ default: module.WarehousingPutawayPage })))
const WarehousingTransfersPage = lazy(() => import('./pages/WarehousingTransfersPage').then((module) => ({ default: module.WarehousingTransfersPage })))

export function App() {
  return (
    <LocaleProvider>
      <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<RequireAuth />}>
          <Route element={<AppLayout />}>
            <Route element={<LazyRouteOutlet />}>
              <Route index element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/org/nodes" element={<OrgNodesPage />} />
              <Route path="/org/users" element={<OrgUsersPage />} />
              <Route path="/org/roles" element={<OrgRolesPage />} />
              <Route path="/org/grants" element={<OrgGrantsPage />} />
              <Route path="/masterdata/materials" element={<MasterMaterialsPage />} />
              <Route path="/masterdata/equipment" element={<MasterEquipmentPage />} />
              <Route path="/masterdata/warehouses" element={<MasterWarehousesPage />} />
              <Route path="/masterdata/warehouses/:id" element={<MasterWarehouseDetailPage />} />
              <Route path="/masterdata/work-centers" element={<MasterWorkCentersPage />} />
              <Route path="/inventory/balances" element={<InventoryBalancesPage />} />
              <Route path="/inventory/barcode" element={<InventoryBarcodePage />} />
              <Route path="/inventory/units" element={<InventoryUnitPage />} />
              <Route path="/production/orders" element={<ProductionOrdersPage />} />
              <Route path="/production/orders/:id" element={<ProductionOrderDetailPage />} />
              <Route path="/production/scheduling" element={<SchedulingPage />} />
              <Route path="/production/workbench" element={<ExecutionWorkbenchPage />} />
              <Route path="/production/feeding" element={<FeedingPage />} />
              <Route path="/quality/inspections" element={<QualityInspectionsPage />} />
              <Route path="/quality/inspections/:id" element={<QualityInspectionDetailPage />} />
              <Route path="/quality/holds" element={<QualityHoldsPage />} />
              <Route path="/warehousing/putaway" element={<WarehousingPutawayPage />} />
              <Route path="/warehousing/moves" element={<WarehousingMovesPage />} />
              <Route path="/warehousing/transfers" element={<WarehousingTransfersPage />} />
              <Route path="/shipping/orders" element={<ShippingOrdersPage />} />
              <Route path="/shipping/packing" element={<ShippingPackingPage />} />
              <Route path="/shipping/outbound" element={<ShippingOutboundPage />} />
              <Route path="/purchase/orders" element={<PurchaseOrdersPage />} />
              {/* G 分配修订 / 缺料齐套：专用壳入口（非成本分摊、非投料排程冒充）；API 缺则空态待 L1 */}
              <Route path="/group/allocation-revision" element={<GroupAllocationRevisionPage />} />
              <Route path="/production/allocation" element={<GroupAllocationRevisionPage />} />
              <Route path="/group/shortage-kitting" element={<ShortageKittingPage />} />
              <Route path="/production/kitting" element={<ShortageKittingPage />} />
              <Route path="/inventory/shortage" element={<ShortageKittingPage />} />
              {/* P1：返工召回/修正清码/投料竞争/退料恢复/扫描拦截/供应商风险 专用入口 */}
              <Route path="/quality/rework" element={<ReworkScrapRecallHubPage />} />
              <Route path="/quality/scrap" element={<ReworkScrapRecallHubPage />} />
              <Route path="/quality/recall" element={<ReworkScrapRecallHubPage />} />
              <Route path="/group/rework-scrap-recall" element={<ReworkScrapRecallHubPage />} />
              <Route path="/production/correct-clear" element={<CorrectClearPage />} />
              <Route path="/inventory/correct" element={<CorrectClearPage />} />
              <Route path="/inventory/clear" element={<CorrectClearPage />} />
              <Route path="/correct" element={<CorrectClearPage />} />
              <Route path="/clear" element={<CorrectClearPage />} />
              <Route path="/production/feed-race-plan" element={<FeedRacePlanPage />} />
              <Route path="/quality/return-restore" element={<ReturnRestoreHubPage />} />
              <Route path="/production/feeding/return" element={<ReturnRestoreHubPage />} />
              <Route path="/return" element={<ReturnRestoreHubPage />} />
              <Route path="/quality/restore" element={<ReturnRestoreHubPage />} />
              <Route path="/scan-block" element={<ScanBlockPage />} />
              <Route path="/production/scan-block" element={<ScanBlockPage />} />
              <Route path="/group/vendor-risk" element={<VendorRiskPage />} />
              <Route path="/vendor-risk" element={<VendorRiskPage />} />
              {/* P2：SAP 双账/对账专用入口（GAP-RECON-UI）；已接 GET/POST /sap/reconciliation；≠ 成本 CE-16 / fixture；勿伪关 GAP */}
              <Route path="/sap/reconciliation" element={<SapReconciliationPage />} />
              <Route path="/group/sap-reconciliation" element={<SapReconciliationPage />} />
              <Route path="/reconciliation" element={<SapReconciliationPage />} />
              {/* L0 整合（2026-10-29）：P2 六域 + P3（OT/SPC/成本/外协）+ P4 问数入口路由挂载 */}
              {P2_ROUTES.map((r) => (
                <Route key={r.path} path={r.path} element={r.element} />
              ))}
              {P3_ROUTES.map((r) => (
                <Route key={r.path} path={r.path} element={r.element} />
              ))}
              {P4_ROUTES.map((r) => (
                <Route key={r.path} path={r.path} element={r.element} />
              ))}
            </Route>
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </AuthProvider>
    </LocaleProvider>
  )
}
