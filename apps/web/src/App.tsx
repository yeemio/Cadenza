import { Navigate, Route, Routes } from 'react-router-dom'
import { LocaleProvider } from '@cadenza/ui'
import { AppLayout, RequireAuth } from './components/AppLayout'
import { AuthProvider } from './auth'
import { DashboardPage } from './pages/DashboardPage'
import { P2_ROUTES } from './p2/mount'
import { P3_ROUTES } from './p3/mount'
import { P4_ROUTES } from './p4/mount'
import { PurchaseOrdersPage } from './pages/PurchaseOrdersPage'
import { GroupAllocationRevisionPage } from './pages/GroupAllocationRevisionPage'
import { ShortageKittingPage } from './pages/ShortageKittingPage'
import { FeedRacePlanPage } from './pages/FeedRacePlanPage'
import { ScanBlockPage } from './pages/ScanBlockPage'
import { VendorRiskPage } from './pages/VendorRiskPage'
import { SapReconciliationPage } from './pages/SapReconciliationPage'
import { ReworkScrapRecallHubPage } from './pages/ReworkScrapRecallHubPage'
import { CorrectClearPage } from './pages/CorrectClearPage'
import { ReturnRestoreHubPage } from './pages/ReturnRestoreHubPage'
import { ExecutionWorkbenchPage } from './pages/ExecutionWorkbenchPage'
import { FeedingPage } from './pages/FeedingPage'
import { InventoryBalancesPage } from './pages/InventoryBalancesPage'
import { InventoryBarcodePage } from './pages/InventoryBarcodePage'
import { InventoryUnitPage } from './pages/InventoryUnitPage'
import { LoginPage } from './pages/LoginPage'
import { MasterEquipmentPage } from './pages/MasterEquipmentPage'
import { MasterMaterialsPage } from './pages/MasterMaterialsPage'
import { MasterWarehouseDetailPage } from './pages/MasterWarehouseDetailPage'
import { MasterWarehousesPage } from './pages/MasterWarehousesPage'
import { MasterWorkCentersPage } from './pages/MasterWorkCentersPage'
import { OrgGrantsPage } from './pages/OrgGrantsPage'
import { OrgNodesPage } from './pages/OrgNodesPage'
import { OrgRolesPage } from './pages/OrgRolesPage'
import { OrgUsersPage } from './pages/OrgUsersPage'
import { ProductionOrderDetailPage } from './pages/ProductionOrderDetailPage'
import { ProductionOrdersPage } from './pages/ProductionOrdersPage'
import { QualityHoldsPage } from './pages/QualityHoldsPage'
import { QualityInspectionDetailPage } from './pages/QualityInspectionDetailPage'
import { QualityInspectionsPage } from './pages/QualityInspectionsPage'
import { SchedulingPage } from './pages/SchedulingPage'
import { ShippingOrdersPage } from './pages/ShippingOrdersPage'
import { ShippingOutboundPage } from './pages/ShippingOutboundPage'
import { ShippingPackingPage } from './pages/ShippingPackingPage'
import { WarehousingMovesPage } from './pages/WarehousingMovesPage'
import { WarehousingPutawayPage } from './pages/WarehousingPutawayPage'
import { WarehousingTransfersPage } from './pages/WarehousingTransfersPage'

export function App() {
  return (
    <LocaleProvider>
      <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<RequireAuth />}>
          <Route element={<AppLayout />}>
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
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </AuthProvider>
    </LocaleProvider>
  )
}
