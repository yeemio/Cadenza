import type { PageRequest, PageResult } from '@cadenza/contracts'
import type {
  AuthMeResponse,
  BalanceDto,
  BarcodeResolveDto,
  CommandMeta,
  ConversionLineDto,
  EquipmentDto,
  EquipmentStatusLogDto,
  InventoryIssuePayload,
  InventoryReceivePayload,
  LoginRequest,
  LoginResponse,
  MaterialDto,
  OrgNodeDto,
  PackingOrderDto,
  PdaTaskDto,
  RackDto,
  RoleDto,
  ScopeGrantDto,
  ShipmentLineDto,
  ShipmentOrderDetailDto,
  ShipmentOrderDto,
  StorageLocationDto,
  UnitDetailDto,
  UserAccountDto,
  WarehouseDto,
  WorkCenterDto,
} from './types'
import {
  ALLOWED_MATERIAL_TYPES_BY_WAREHOUSE_TYPE,
  deptAllowedWarehouseTypes,
} from './types'

/**
 * 轻量 mock 拦截器：不经网络、不走 MSW，client 在 mock 模式下直接路由到本表。
 * 第二波起样例数据与 apps/api 实际 DTO/路由逐一对齐（kind/deptCategory/accountStatus/
 * PageResult/命令端点 {operationId,status,data}），并覆盖 org CRUD + reset-password/
 * unlock/grants 命令；用于离线演示与 UI 测试（界面以 isMockMode 显示"演示数据"标识）。
 */

/** 演示账号：admin / Cz123456（密码满足 OA-14：8–16 位且同时含数字与字母） */
export const MOCK_DEMO_ACCOUNT = 'admin'
export const MOCK_DEMO_PASSWORD = 'Cz123456'

/** 连续失败达到该次数后返回锁定文案（演示 OA-16 失败锁定口径；真实锁定在服务端） */
export const MOCK_LOGIN_LOCK_THRESHOLD = 5

export interface MockErrorShape {
  httpStatus: number
  code: string
  message: string
  details?: unknown
}

export class MockError extends Error {
  readonly httpStatus: number
  readonly code: string
  readonly details?: unknown
  constructor(shape: MockErrorShape) {
    super(shape.message)
    this.name = 'MockError'
    this.httpStatus = shape.httpStatus
    this.code = shape.code
    this.details = shape.details
  }
}

// ---------------- 内存演示数据（真实 DTO 形状） ----------------

const orgNodes: OrgNodeDto[] = [
  { id: 'n-ent', kind: 'enterprise', code: 'ZC-GROUP', name: '中辰线缆集团', parentId: null, parentKind: null, path: '/n-ent/', depth: 0, plantCode: null, companyOrgCode: null, deptCategory: null, status: 'active' },
  { id: 'n-legal', kind: 'legal_entity', code: 'ZC-MFG', name: '中辰电缆制造有限公司', parentId: 'n-ent', parentKind: 'enterprise', path: '/n-ent/n-legal/', depth: 1, plantCode: null, companyOrgCode: 'ZC-01', deptCategory: null, status: 'active' },
  { id: 'n-plant', kind: 'plant', code: 'F01', name: '杭州制造工厂', parentId: 'n-legal', parentKind: 'legal_entity', path: '/n-ent/n-legal/n-plant/', depth: 2, plantCode: 'F01', companyOrgCode: 'HZ-01', deptCategory: null, status: 'active' },
  { id: 'n-general', kind: 'department', code: 'F01-GEN', name: '综合管理部', parentId: 'n-plant', parentKind: 'plant', path: '/n-ent/n-legal/n-plant/n-general/', depth: 3, plantCode: null, companyOrgCode: null, deptCategory: 3, status: 'active' },
  { id: 'n-draw', kind: 'department', code: 'F01-DRAW', name: '拉丝车间', parentId: 'n-plant', parentKind: 'plant', path: '/n-ent/n-legal/n-plant/n-draw/', depth: 3, plantCode: null, companyOrgCode: null, deptCategory: 1, status: 'active' },
  { id: 'n-twist', kind: 'department', code: 'F01-TWIST', name: '绞制车间', parentId: 'n-plant', parentKind: 'plant', path: '/n-ent/n-legal/n-plant/n-twist/', depth: 3, plantCode: null, companyOrgCode: null, deptCategory: 1, status: 'active' },
  { id: 'n-extrude', kind: 'department', code: 'F01-EXTR', name: '挤塑车间', parentId: 'n-plant', parentKind: 'plant', path: '/n-ent/n-legal/n-plant/n-extrude/', depth: 3, plantCode: null, companyOrgCode: null, deptCategory: 1, status: 'active' },
  { id: 'n-wc-draw', kind: 'work_center', code: 'F01-DRAW-01', name: '拉丝一线', parentId: 'n-draw', parentKind: 'department', path: '/n-ent/n-legal/n-plant/n-draw/n-wc-draw/', depth: 4, plantCode: null, companyOrgCode: null, deptCategory: null, status: 'active' },
  { id: 'n-qc1', kind: 'department', code: 'F01-QC1', name: '质检一部', parentId: 'n-plant', parentKind: 'plant', path: '/n-ent/n-legal/n-plant/n-qc1/', depth: 3, plantCode: null, companyOrgCode: null, deptCategory: 2, status: 'active' },
  { id: 'n-qc2', kind: 'department', code: 'F01-QC2', name: '质检二部', parentId: 'n-plant', parentKind: 'plant', path: '/n-ent/n-legal/n-plant/n-qc2/', depth: 3, plantCode: null, companyOrgCode: null, deptCategory: 2, status: 'active' },
  { id: 'n-log', kind: 'department', code: 'F01-LOG', name: '物流一部', parentId: 'n-plant', parentKind: 'plant', path: '/n-ent/n-legal/n-plant/n-log/', depth: 3, plantCode: null, companyOrgCode: null, deptCategory: 3, status: 'active' },
]

const roleSeed: RoleDto[] = [
  { id: 'role-admin', name: '系统管理员', alias: 'sys_admin', sort: 1, isSystem: 2, parentRoleId: null, status: 'active' },
  { id: 'role-planner', name: '生产计划员', alias: 'planner', sort: 2, isSystem: 1, parentRoleId: null, status: 'active' },
  { id: 'role-operator', name: '车间操作工', alias: 'operator', sort: 3, isSystem: 1, parentRoleId: null, status: 'active' },
  { id: 'role-qc', name: '质检员', alias: 'qc_inspector', sort: 4, isSystem: 1, parentRoleId: null, status: 'active' },
  { id: 'role-storekeeper', name: '仓管员', alias: 'storekeeper', sort: 5, isSystem: 1, parentRoleId: null, status: 'active' },
  { id: 'role-viewer', name: '只读访客', alias: 'viewer', sort: 6, isSystem: 1, parentRoleId: null, status: 'active' },
]

const lockDemoUntil = () => new Date(Date.now() + 15 * 60_000).toISOString()

function mkUser(
  id: string,
  loginName: string,
  displayName: string,
  deptId: string,
  roleId: string,
  loginPlatform: 'WEB' | 'PDA',
  status: 'enabled' | 'disabled' = 'enabled',
  workshopDeptId: string | null = null,
): UserAccountDto {
  return {
    id,
    loginName,
    displayName,
    deptId,
    workshopDeptId,
    roleId,
    loginPlatform,
    accountStatus: status,
    plantId: 'n-plant',
    phone: null,
    failedLoginCount: 0,
    lockedUntil: null,
    status: 'active',
  }
}

const userSeed: UserAccountDto[] = [
  mkUser('user-s-1', 'admin', '系统管理员', 'n-general', 'role-admin', 'WEB'),
  mkUser('user-s-2', 'chen01', '陈工', 'n-draw', 'role-operator', 'PDA', 'enabled', 'n-draw'),
  mkUser('user-s-3', 'wang02', '王计划', 'n-general', 'role-planner', 'WEB'),
  mkUser('user-s-4', 'liu03', '刘质检', 'n-qc1', 'role-qc', 'PDA', 'enabled', 'n-draw'),
  mkUser('user-s-5', 'zhao04', '赵仓管', 'n-log', 'role-storekeeper', 'PDA'),
  mkUser('user-s-6', 'sun05', '孙操作', 'n-twist', 'role-operator', 'PDA'),
  mkUser('user-s-7', 'qian06', '钱检员', 'n-qc2', 'role-qc', 'WEB', 'disabled'),
  mkUser('user-s-8', 'zhou07', '周计划', 'n-general', 'role-planner', 'WEB'),
]

/** 生成足够多的演示行以验证分页（PC-16：total 以服务端口径为准） */
function buildUsers(): UserAccountDto[] {
  const extraNames = [
    ['吴', 'wu'], ['郑', 'zheng'], ['冯', 'feng'], ['褚', 'chu'], ['卫', 'wei'],
    ['蒋', 'jiang'], ['沈', 'shen'], ['韩', 'han'], ['杨', 'yang'], ['朱', 'zhu'],
    ['秦', 'qin'], ['尤', 'you'], ['许', 'xu'], ['何', 'he'], ['吕', 'lv'],
    ['施', 'shi'], ['张', 'zhang'], ['孔', 'kong'], ['曹', 'cao'], ['严', 'yan'],
  ]
  const depts = ['n-draw', 'n-twist', 'n-extrude', 'n-qc1', 'n-qc2']
  const extra: UserAccountDto[] = extraNames.map(([cn, py], i) => {
    const n = String(i + 1).padStart(2, '0')
    return mkUser(
      `user-x-${n}`,
      `${py}u${n}`,
      `${cn}操作${n}`,
      depts[i % depts.length],
      'role-operator',
      'PDA',
      i % 9 === 8 ? 'disabled' : 'enabled',
    )
  })
  return [...userSeed, ...extra]
}

const users = buildUsers()
// 演示"锁定"状态（解封入口）：孙操作连续失败 5 次被锁（OA-16）
const sun = users.find((u) => u.loginName === 'sun05')
if (sun) {
  sun.failedLoginCount = 5
  sun.lockedUntil = lockDemoUntil()
}

const grantSeed: ScopeGrantDto[] = [
  { id: 'grant-1', principalType: 'role', principalId: 'role-admin', permissions: ['org.read', 'org.admin', 'org.role.admin', 'masterdata.read', 'masterdata.admin', 'inventory.read', 'inventory.post', 'inventory.reserve', 'process.read', 'process.admin', 'scheduling.read', 'scheduling.admin', 'execution.read', 'execution.report', 'execution.review', 'execution.feed', 'execution.labor', 'quality.read', 'quality.post', 'warehousing.read', 'warehousing.post', 'shipping.read', 'shipping.post', 'purchase.read', 'purchase.post'], scopeType: 'enterprise', scopeObjectId: 'n-ent', status: 'active' },
  { id: 'grant-2', principalType: 'role', principalId: 'role-planner', permissions: ['org.read', 'masterdata.read', 'inventory.read'], scopeType: 'plant', scopeObjectId: 'n-plant', status: 'active' },
  { id: 'grant-3', principalType: 'role', principalId: 'role-operator', permissions: ['org.read'], scopeType: 'workshop', scopeObjectId: 'n-wc-draw', status: 'active' },
]
const grants = [...grantSeed]

const tasks: PdaTaskDto[] = [
  { id: 'task-001', title: '绞制上盘', orderNo: 'MO-2026-1027-001', processName: '绞制', quantity: '48.0000', unit: '盘', status: 'PENDING' },
  { id: 'task-002', title: '拉丝换规格', orderNo: 'MO-2026-1027-002', processName: '拉丝', quantity: '1200.0000', unit: '千克', status: 'PENDING' },
  { id: 'task-003', title: '挤塑开机', orderNo: 'MO-2026-1027-003', processName: '挤塑', quantity: '36.0000', unit: '千米', status: 'IN_PROGRESS' },
  { id: 'task-004', title: '成品入库', orderNo: 'MO-2026-1026-018', processName: '入库', quantity: '12.0000', unit: '轴', status: 'PENDING' },
  { id: 'task-005', title: '退库盘点', orderNo: 'MO-2026-1026-020', processName: '盘点', quantity: '5.0000', unit: '轴', status: 'DONE' },
]

// ---------------- masterdata / inventory 内存演示数据（第三波；真实 DTO 形状对齐 application 视图） ----------------

const now = '2026-10-27T09:00:00.000Z'

/** 料品（MD-01：U9 同步只读；materialType 1=原料 2=半成品 3=成品） */
const materials: MaterialDto[] = [
  { id: 'm-0001', orgScopeId: 'n-ent', code: 'CU-8.00', name: '铜杆 8.0mm', companyOrgCode: 'ZC-01', materialGroupCode: 'RAW-CU', materialGroupName: '铜杆类', descriptionZh: '上引法无氧铜杆', descriptionEn: 'Oxygen-free copper rod', voltage: null, standard: 'GB/T 3952', customer: null, materialType: 1, spec: 'Φ8.0mm', color: null, baseUom: 'KG', qcFlag: 1, remark: null, sourceSystem: 'U9', status: 'active', createdAt: now, updatedAt: now },
  { id: 'm-0002', orgScopeId: 'n-ent', code: 'AL-9.50', name: '铝杆 9.5mm', companyOrgCode: 'ZC-01', materialGroupCode: 'RAW-AL', materialGroupName: '铝杆类', descriptionZh: '电工圆铝杆', descriptionEn: null, voltage: null, standard: 'GB/T 3954', customer: null, materialType: 1, spec: 'Φ9.5mm', color: null, baseUom: 'KG', qcFlag: 1, remark: null, sourceSystem: 'U9', status: 'active', createdAt: now, updatedAt: now },
  { id: 'm-0003', orgScopeId: 'n-ent', code: 'XLPE-10KV', name: '10kV 交联聚乙烯绝缘料', companyOrgCode: 'ZC-01', materialGroupCode: 'RAW-XLPE', materialGroupName: '绝缘料类', descriptionZh: null, descriptionEn: null, voltage: '10kV', standard: null, customer: null, materialType: 1, spec: null, color: '本色', baseUom: 'KG', qcFlag: 1, remark: null, sourceSystem: 'U9', status: 'active', createdAt: now, updatedAt: now },
  { id: 'm-0004', orgScopeId: 'n-ent', code: 'CU-2.50-DRAWN', name: '拉制铜单丝 2.5mm', companyOrgCode: 'ZC-01', materialGroupCode: 'SEMI-CU', materialGroupName: '铜单丝', descriptionZh: '中拉机拉制', descriptionEn: null, voltage: null, standard: null, customer: null, materialType: 2, spec: 'Φ2.5mm', color: null, baseUom: 'KG', qcFlag: 0, remark: null, sourceSystem: 'U9', status: 'active', createdAt: now, updatedAt: now },
  { id: 'm-0005', orgScopeId: 'n-ent', code: 'STRAND-4X120', name: '绞合导体 4×120', companyOrgCode: 'ZC-01', materialGroupCode: 'SEMI-COND', materialGroupName: '绞合导体', descriptionZh: null, descriptionEn: null, voltage: null, standard: null, customer: null, materialType: 2, spec: '4×120mm²', color: null, baseUom: 'KM', qcFlag: 1, remark: null, sourceSystem: 'U9', status: 'active', createdAt: now, updatedAt: now },
  { id: 'm-0006', orgScopeId: 'n-ent', code: 'YJV-3X70', name: 'YJV 8.7/15kV 3×70 电缆', companyOrgCode: 'ZC-01', materialGroupCode: 'FIN-CABLE', materialGroupName: '中压电缆', descriptionZh: '交联聚乙烯绝缘电力电缆', descriptionEn: 'XLPE power cable', voltage: '8.7/15kV', standard: 'GB/T 12706', customer: null, materialType: 3, spec: '3×70mm²', color: null, baseUom: 'KM', qcFlag: 1, remark: null, sourceSystem: 'U9', status: 'active', createdAt: now, updatedAt: now },
  { id: 'm-0007', orgScopeId: 'n-ent', code: 'YJV-4X35', name: 'YJV 0.6/1kV 4×35 电缆', companyOrgCode: 'ZC-01', materialGroupCode: 'FIN-CABLE', materialGroupName: '低压电缆', descriptionZh: null, descriptionEn: null, voltage: '0.6/1kV', standard: 'GB/T 12706', customer: '华东电网', materialType: 3, spec: '4×35mm²', color: null, baseUom: 'KM', qcFlag: 1, remark: null, sourceSystem: 'U9', status: 'active', createdAt: now, updatedAt: now },
  { id: 'm-0008', orgScopeId: 'n-ent', code: 'DRUM-STEEL', name: '钢缆卷盘 800 型', companyOrgCode: 'ZC-01', materialGroupCode: 'PACK', materialGroupName: '包装件', descriptionZh: '成品电缆用钢制卷盘', descriptionEn: null, voltage: null, standard: null, customer: null, materialType: 1, spec: '800×560', color: null, baseUom: 'PCS', qcFlag: 0, remark: null, sourceSystem: 'U9', status: 'active', createdAt: now, updatedAt: now },
]

/** 换算行（MD-04/05：本系统唯一可编辑部分；referenced=true 演示 MD-05 拒改） */
const conversions: ConversionLineDto[] = [
  { id: 'cv-0001', materialId: 'm-0001', version: 1, unitName: '卷', factor: '500.0000', referenced: true, status: 'active', createdAt: now, updatedAt: now },
  { id: 'cv-0002', materialId: 'm-0001', version: 2, unitName: '捆', factor: '50.0000', referenced: false, status: 'active', createdAt: now, updatedAt: now },
  { id: 'cv-0003', materialId: 'm-0002', version: 1, unitName: '卷', factor: '800.0000', referenced: false, status: 'active', createdAt: now, updatedAt: now },
  { id: 'cv-0004', materialId: 'm-0003', version: 1, unitName: '袋', factor: '25.0000', referenced: false, status: 'active', createdAt: now, updatedAt: now },
  { id: 'cv-0005', materialId: 'm-0006', version: 1, unitName: '轴', factor: '2.0000', referenced: false, status: 'active', createdAt: now, updatedAt: now },
  { id: 'cv-0006', materialId: 'm-0007', version: 1, unitName: '盘', factor: '0.5000', referenced: false, status: 'active', createdAt: now, updatedAt: now },
]

/** 工作中心（MD-17：编码全局唯一，同部门内名称唯一） */
const workCenters: WorkCenterDto[] = [
  { id: 'wc-md-01', plantId: 'n-plant', deptId: 'n-draw', code: 'DRAW-01', name: '拉丝一线', status: 'active', createdAt: now, updatedAt: now },
  { id: 'wc-md-02', plantId: 'n-plant', deptId: 'n-draw', code: 'DRAW-02', name: '拉丝二线', status: 'active', createdAt: now, updatedAt: now },
  { id: 'wc-md-03', plantId: 'n-plant', deptId: 'n-twist', code: 'TWIST-01', name: '绞制一线', status: 'active', createdAt: now, updatedAt: now },
  { id: 'wc-md-04', plantId: 'n-plant', deptId: 'n-extrude', code: 'EXTR-01', name: '挤塑一线', status: 'active', createdAt: now, updatedAt: now },
  { id: 'wc-md-05', plantId: 'n-plant', deptId: 'n-qc1', code: 'QC-01', name: '质检一站', status: 'active', createdAt: now, updatedAt: now },
  { id: 'wc-md-06', plantId: 'n-plant', deptId: 'n-log', code: 'PACK-01', name: '成品包装站', status: 'active', createdAt: now, updatedAt: now },
]

/** 设备（MD-13：equipmentStatus 1=正常 2=维修；deptId 与工作中心部门一致 MD-10） */
const equipment: EquipmentDto[] = [
  { id: 'eq-0001', plantId: 'n-plant', deptId: 'n-draw', workCenterId: 'wc-md-01', code: 'LZ-450-01', name: '中拉机 01', actualNo: 'HT-2023-011', model: 'LZ450', stdRateText: '约 2.2 吨/班', equipmentStatus: 1, capacity: '2.2000', status: 'active', createdAt: now, updatedAt: now },
  { id: 'eq-0002', plantId: 'n-plant', deptId: 'n-draw', workCenterId: 'wc-md-01', code: 'LZ-450-02', name: '中拉机 02', actualNo: null, model: 'LZ450', stdRateText: null, equipmentStatus: 2, capacity: '2.2000', status: 'active', createdAt: now, updatedAt: now },
  { id: 'eq-0003', plantId: 'n-plant', deptId: 'n-draw', workCenterId: 'wc-md-02', code: 'XD-800-01', name: '小拉机 01', actualNo: null, model: 'XD800', stdRateText: null, equipmentStatus: 1, capacity: null, status: 'active', createdAt: now, updatedAt: now },
  { id: 'eq-0004', plantId: 'n-plant', deptId: 'n-twist', workCenterId: 'wc-md-03', code: 'JZ-1250-01', name: '框绞机 01', actualNo: 'HT-2022-007', model: 'JK1250', stdRateText: '约 60 盘/班', equipmentStatus: 1, capacity: null, status: 'active', createdAt: now, updatedAt: now },
  { id: 'eq-0005', plantId: 'n-plant', deptId: 'n-extrude', workCenterId: 'wc-md-04', code: 'JS-90-01', name: '挤塑机 01', actualNo: null, model: 'SJ90', stdRateText: null, equipmentStatus: 2, capacity: null, status: 'active', createdAt: now, updatedAt: now },
  { id: 'eq-0006', plantId: 'n-plant', deptId: 'n-extrude', workCenterId: 'wc-md-04', code: 'JS-120-01', name: '挤塑机 02', actualNo: null, model: 'SJ120', stdRateText: null, equipmentStatus: 1, capacity: null, status: 'active', createdAt: now, updatedAt: now },
  { id: 'eq-0007', plantId: 'n-plant', deptId: 'n-qc1', workCenterId: 'wc-md-05', code: 'QC-HV-01', name: '高压测试台 01', actualNo: null, model: 'HVS-50', stdRateText: null, equipmentStatus: 1, capacity: null, status: 'active', createdAt: now, updatedAt: now },
  { id: 'eq-0008', plantId: 'n-plant', deptId: 'n-log', workCenterId: 'wc-md-06', code: 'BZ-01', name: '自动包装线 01', actualNo: null, model: 'BZ-800', stdRateText: null, equipmentStatus: 1, capacity: null, status: 'active', createdAt: now, updatedAt: now },
]

const equipmentStatusLogs: EquipmentStatusLogDto[] = [
  { id: 'eqlog-0001', equipmentId: 'eq-0002', oldStatus: 1, newStatus: 2, source: 'WEB', actor: 'admin', createdAt: '2026-10-26T10:12:00.000Z' },
  { id: 'eqlog-0002', equipmentId: 'eq-0002', oldStatus: 2, newStatus: 1, source: 'WEB', actor: 'admin', createdAt: '2026-10-20T08:30:00.000Z' },
  { id: 'eqlog-0003', equipmentId: 'eq-0005', oldStatus: 1, newStatus: 2, source: 'PDA', actor: 'chen01', createdAt: '2026-10-25T14:05:00.000Z' },
]

/** 仓库（MD-23：类型限定可收料品类型；MD-24：物流部只建仓库、车间只建线边仓） */
const warehouses: WarehouseDto[] = [
  { id: 'wh-0101', plantId: 'n-plant', deptId: 'n-log', code: '0101', name: '原料一库', warehouseType: 'WAREHOUSE', materialTypes: [1], managerUserId: 'user-s-5', phone: '0571-88880001', address: '厂区北侧', qrBound: false, status: 'active', createdAt: now, updatedAt: now },
  { id: 'wh-0103', plantId: 'n-plant', deptId: 'n-log', code: '0103', name: '成品一库', warehouseType: 'WAREHOUSE', materialTypes: [3], managerUserId: 'user-s-5', phone: null, address: '厂区南侧', qrBound: true, status: 'active', createdAt: now, updatedAt: now },
  { id: 'wh-0201', plantId: 'n-plant', deptId: 'n-draw', code: '0201', name: '拉丝线边仓', warehouseType: 'LINE_SIDE', materialTypes: [1, 2], managerUserId: null, phone: null, address: null, qrBound: false, status: 'active', createdAt: now, updatedAt: now },
  { id: 'wh-0202', plantId: 'n-plant', deptId: 'n-twist', code: '0202', name: '绞制线边仓', warehouseType: 'LINE_SIDE', materialTypes: [1, 2, 3], managerUserId: null, phone: null, address: null, qrBound: false, status: 'active', createdAt: now, updatedAt: now },
]

/** 货架（MD-30：2 位数字编号；MD-31：zones/layers 1–99） */
const racks: RackDto[] = [
  { id: 'rack-01', plantId: 'n-plant', warehouseId: 'wh-0101', code: '01', zones: 2, layers: 3, remark: '铜杆存放架', status: 'active', createdAt: now, updatedAt: now },
  { id: 'rack-02', plantId: 'n-plant', warehouseId: 'wh-0103', code: '02', zones: 2, layers: 2, remark: null, status: 'active', createdAt: now, updatedAt: now },
]

/** 库位（普通库位 MD-28：8 位＝仓库码 4＋库位码 4；货架库位由货架生成 MD-31） */
const locations: StorageLocationDto[] = [
  { id: 'loc-01010001', plantId: 'n-plant', warehouseId: 'wh-0101', rackId: null, locationKind: 'NORMAL', code: '01010001', zoneCode: null, remark: '散装铜杆区', qrBound: false, status: 'active', createdAt: now, updatedAt: now },
  { id: 'loc-01010002', plantId: 'n-plant', warehouseId: 'wh-0101', rackId: null, locationKind: 'NORMAL', code: '01010002', zoneCode: null, remark: null, qrBound: false, status: 'active', createdAt: now, updatedAt: now },
  { id: 'loc-01030001', plantId: 'n-plant', warehouseId: 'wh-0103', rackId: null, locationKind: 'NORMAL', code: '01030001', zoneCode: null, remark: '成品发货区', qrBound: true, status: 'active', createdAt: now, updatedAt: now },
  { id: 'loc-r-010101', plantId: 'n-plant', warehouseId: 'wh-0101', rackId: 'rack-01', locationKind: 'RACK', code: '010101', zoneCode: '0101', remark: null, qrBound: false, status: 'active', createdAt: now, updatedAt: now },
  { id: 'loc-r-010102', plantId: 'n-plant', warehouseId: 'wh-0101', rackId: 'rack-01', locationKind: 'RACK', code: '010102', zoneCode: '0101', remark: null, qrBound: false, status: 'active', createdAt: now, updatedAt: now },
  { id: 'loc-r-010201', plantId: 'n-plant', warehouseId: 'wh-0101', rackId: 'rack-01', locationKind: 'RACK', code: '010201', zoneCode: '0102', remark: null, qrBound: false, status: 'active', createdAt: now, updatedAt: now },
  { id: 'loc-r-020101', plantId: 'n-plant', warehouseId: 'wh-0103', rackId: 'rack-02', locationKind: 'RACK', code: '020101', zoneCode: '0201', remark: null, qrBound: false, status: 'active', createdAt: now, updatedAt: now },
  { id: 'loc-r-020201', plantId: 'n-plant', warehouseId: 'wh-0103', rackId: 'rack-02', locationKind: 'RACK', code: '020201', zoneCode: '0202', remark: null, qrBound: false, status: 'active', createdAt: now, updatedAt: now },
  { id: 'loc-02010001', plantId: 'n-plant', warehouseId: 'wh-0201', rackId: null, locationKind: 'NORMAL', code: '02010001', zoneCode: null, remark: '拉丝线边产出位', qrBound: false, status: 'active', createdAt: now, updatedAt: now },
  { id: 'loc-02010002', plantId: 'n-plant', warehouseId: 'wh-0201', rackId: null, locationKind: 'NORMAL', code: '02010002', zoneCode: null, remark: '拉丝线边待检位', qrBound: false, status: 'active', createdAt: now, updatedAt: now },
  { id: 'loc-02020001', plantId: 'n-plant', warehouseId: 'wh-0202', rackId: null, locationKind: 'NORMAL', code: '02020001', zoneCode: null, remark: '绞制线边产出位', qrBound: false, status: 'active', createdAt: now, updatedAt: now },
]

/** 库存单元底账（供余额/条码/单元详情联查） */
interface MockUnit {
  unitId: string
  unitNo: string
  materialId: string
  materialCode: string
  lotNo: string
  traceMode: 'quantity' | 'segment'
  status: 'in_stock' | 'exhausted'
  balanceOpen: boolean
  locationCode: string
  quantity: string
  reserved: string
  available: string
  uomCode: string
  qualityStatus: string
  feetDisplay: string
}

const units: MockUnit[] = [
  { unitId: 'u-0001', unitNo: 'U-2026-1001-0001', materialId: 'm-0001', materialCode: 'CU-8.00', lotNo: 'LOT-CU-1026A', traceMode: 'quantity', status: 'in_stock', balanceOpen: true, locationCode: '01010001', quantity: '2400.0000', reserved: '400.0000', available: '2000.0000', uomCode: 'KG', qualityStatus: 'qualified', feetDisplay: '7874 英尺' },
  { unitId: 'u-0002', unitNo: 'U-2026-1001-0002', materialId: 'm-0003', materialCode: 'XLPE-10KV', lotNo: 'LOT-XLPE-1025B', traceMode: 'quantity', status: 'in_stock', balanceOpen: true, locationCode: '01010002', quantity: '750.0000', reserved: '0.0000', available: '750.0000', uomCode: 'KG', qualityStatus: 'pending_inspection', feetDisplay: '2460 英尺' },
  { unitId: 'u-0003', unitNo: 'U-2026-1001-0003', materialId: 'm-0004', materialCode: 'CU-2.50-DRAWN', lotNo: 'LOT-CUD-1026C', traceMode: 'segment', status: 'in_stock', balanceOpen: true, locationCode: '020101', quantity: '640.0000', reserved: '120.0000', available: '520.0000', uomCode: 'KG', qualityStatus: 'qualified', feetDisplay: '2099 英尺' },
  { unitId: 'u-0004', unitNo: 'U-2026-1002-0004', materialId: 'm-0006', materialCode: 'YJV-3X70', lotNo: 'LOT-YJV-1027A', traceMode: 'quantity', status: 'in_stock', balanceOpen: true, locationCode: '01030001', quantity: '3.6000', reserved: '0.0000', available: '3.6000', uomCode: 'KM', qualityStatus: 'qualified', feetDisplay: '11811 英尺' },
  { unitId: 'u-0005', unitNo: 'U-2026-1002-0005', materialId: 'm-0007', materialCode: 'YJV-4X35', lotNo: 'LOT-YJV-1027B', traceMode: 'quantity', status: 'in_stock', balanceOpen: true, locationCode: '01030001', quantity: '1.2000', reserved: '0.6000', available: '0.6000', uomCode: 'KM', qualityStatus: 'pending_inspection', feetDisplay: '3937 英尺' },
  { unitId: 'u-0006', unitNo: 'U-2026-1002-0006', materialId: 'm-0002', materialCode: 'AL-9.50', lotNo: 'LOT-AL-1020D', traceMode: 'quantity', status: 'exhausted', balanceOpen: false, locationCode: '01010001', quantity: '0.0000', reserved: '0.0000', available: '0.0000', uomCode: 'KG', qualityStatus: 'qualified', feetDisplay: '0 英尺' },
]

function balancesOf(query: URLSearchParams): { items: unknown[]; total: number; page: number; pageSize: number } {
  const unitNoLike = (query.get('unitNoLike') ?? '').trim()
  const materialCode = (query.get('materialCode') ?? '').trim()
  const includeClosed = query.get('includeClosed') === 'true'
  let list = units.filter((u) => includeClosed || u.status === 'in_stock')
  if (unitNoLike) list = list.filter((u) => u.unitNo.includes(unitNoLike))
  if (materialCode) list = list.filter((u) => u.materialCode === materialCode)
  const rows: BalanceDto[] = list.map((u) => ({
    balanceId: `bal-${u.unitId}`,
    unitId: u.unitId,
    unitNo: u.unitNo,
    materialCode: u.materialCode,
    lotNo: u.lotNo,
    locationCode: u.locationCode,
    ownerName: '中辰电缆制造有限公司',
    quantity: u.quantity,
    reservedQuantity: u.reserved,
    availableQuantity: u.available,
    uomCode: u.uomCode,
    qualityStatus: u.qualityStatus,
    status: u.status === 'in_stock' ? 'open' : 'closed',
    plantId: 'n-plant',
    feetDisplay: u.feetDisplay,
  }))
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1)
  const pageSize = Math.min(100, Math.max(1, Number(query.get('pageSize') ?? '20') || 20))
  const start = (page - 1) * pageSize
  return { items: rows.slice(start, start + pageSize), total: rows.length, page, pageSize }
}

/** 条码演示（IT-04/05/06）：单元码直达、载具码一码多物、未识别码 */
function resolveBarcodeOf(value: string): BarcodeResolveDto {
  if (value === 'BC-U-0001') {
    return {
      barcodeValue: value,
      kind: { kind: 'inventory_unit_label', confidence: 'exact', matchedPattern: 'BC-U-\\d{4}' },
      hasActiveBinding: true,
      boundType: 'inventory_unit',
      boundId: 'u-0001',
      candidates: [{ objectType: 'inventory_unit', objectId: 'u-0001', label: `库存单元 U-2026-1001-0001（CU-8.00）`, via: 'direct_binding' }],
    }
  }
  if (value === 'BC-CR-01') {
    const unit = (id: string) => units.find((u) => u.unitId === id)
    const loaded = ['u-0002', 'u-0003'].map(unit).filter((u): u is MockUnit => u !== undefined)
    return {
      barcodeValue: value,
      kind: { kind: 'carrier_label', confidence: 'exact', matchedPattern: 'BC-CR-\\d{2}' },
      hasActiveBinding: true,
      boundType: 'carrier',
      boundId: 'cr-01',
      candidates: loaded.map((u) => ({
        objectType: 'inventory_unit',
        objectId: u.unitId,
        label: `库存单元 ${u.unitNo}（${u.materialCode}）`,
        via: 'carrier_load',
      })),
    }
  }
  if (value.startsWith('EQU-')) {
    const code = value.slice(4)
    const eq = equipment.find((e) => e.code === code && e.status === 'active')
    if (eq) {
      return {
        barcodeValue: value,
        kind: { kind: 'equipment_label', confidence: 'exact', matchedPattern: 'EQU-(.+)' },
        hasActiveBinding: true,
        boundType: 'equipment',
        boundId: eq.id,
        candidates: [{ objectType: 'equipment', objectId: eq.id, label: `设备 ${eq.name}（${eq.code}）`, via: 'direct_binding' }],
      }
    }
  }
  return {
    barcodeValue: value,
    kind: { kind: 'unknown', confidence: 'none', matchedPattern: null },
    hasActiveBinding: false,
    boundType: null,
    boundId: null,
    candidates: [],
  }
}

/** 单元详情（IT-01/35：身份＋余额＋预留＋近期流水＋谱系边摘要） */
function unitDetailOf(key: { unitId?: string; unitNo?: string }): UnitDetailDto | null {
  const unit = key.unitId !== undefined ? units.find((u) => u.unitId === key.unitId) : key.unitNo !== undefined ? units.find((u) => u.unitNo === key.unitNo) : undefined
  if (unit === undefined) return null
  const isKm = unit.uomCode === 'KM'
  return {
    unitId: unit.unitId,
    unitNo: unit.unitNo,
    materialCode: unit.materialCode,
    lotNo: unit.lotNo,
    traceMode: unit.traceMode,
    status: unit.status,
    balanceOpen: unit.balanceOpen,
    balances: [
      {
        balanceId: `bal-${unit.unitId}`,
        locationCode: unit.locationCode,
        ownerName: '中辰电缆制造有限公司',
        quantity: unit.quantity,
        qualityStatus: unit.qualityStatus,
        status: unit.status === 'in_stock' ? 'open' : 'closed',
      },
    ],
    activeReservations:
      unit.reserved === '0.0000'
        ? []
        : [
            {
              reservationId: `rsv-${unit.unitId}`,
              holderType: 'production_order',
              holderRef: 'MO-2026-1027-001',
              quantity: unit.reserved,
              validUntil: '2026-11-03T00:00:00.000Z',
            },
          ],
    recentTransactions: [
      {
        transactionId: `tx-${unit.unitId}-02`,
        lineNo: 1,
        movementKind: 'issue',
        quantity: unit.reserved === '0.0000' ? '10.0000' : unit.reserved,
        beforeQty: unit.quantity,
        afterQty: unit.quantity,
        businessTime: '2026-10-27T08:40:00.000Z',
      },
      {
        transactionId: `tx-${unit.unitId}-01`,
        lineNo: 1,
        movementKind: 'receive',
        quantity: isKm ? '4.0000' : '3000.0000',
        beforeQty: '0.0000',
        afterQty: isKm ? '4.0000' : '3000.0000',
        businessTime: '2026-10-26T09:10:00.000Z',
      },
    ],
    genealogy: [
      {
        edgeId: `ge-${unit.unitId}-01`,
        edgeKind: 'receipt_origin',
        fromType: 'material_lot',
        fromId: `lot-${unit.lotNo}`,
        toType: 'inventory_unit',
        toId: unit.unitId,
        quantity: isKm ? '4.0000' : '3000.0000',
      },
    ],
  }
}

/** mock 通用查询过滤工具 */
function activeOnly<T extends { status: string }>(list: T[]): T[] {
  return list.filter((x) => x.status === 'active')
}

function paginate<T>(items: T[], query: URLSearchParams): PageResult<T> {
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1)
  const pageSize = Math.min(100, Math.max(1, Number(query.get('pageSize') ?? '20') || 20))
  const start = (page - 1) * pageSize
  return {
    items: items.slice(start, start + pageSize),
    total: items.length,
    page,
    pageSize,
  }
}

// ---------------- 第四域演示数据（process/scheduling/execution/quality/warehousing） ----------------
// 口径：固定演示时钟（MOCK_NOW/MOCK_TODAY）保证 jsdom 测试可复现；数量一律十进制字符串。

const MOCK_NOW = '2026-10-27T09:30:00.000Z'
const MOCK_TODAY = '2026-10-27'

/** 生产订单（[底稿 A1-1] 状态轴 + 挂起/作废独立） */
const productionOrders: Array<{
  id: string
  orderNo: string
  materialId: string
  materialSnapshot: Record<string, unknown>
  productionDeptId: string
  productionQty: string
  uom: string
  overrunRatio: string | null
  orderStatus: 'approved' | 'released' | 'in_progress' | 'pending_completion' | 'closed' | 'voided'
  processConfigStatus: 'unconfigured' | 'configured'
  suspended: boolean
  suspendedReason: string | null
  actualStartAt: string | null
  currentSettingsVersion: number
  salesOrderNo: string | null
  remark: string | null
  createdAt: string
}> = [
  { id: 'po-001', orderNo: 'MO-2026-1027-001', materialId: 'm-0005', materialSnapshot: { code: 'STRAND-4X120', name: '绞合导体 4×120', spec: '4×120mm²', color: null }, productionDeptId: 'n-draw', productionQty: '12.0000', uom: 'KM', overrunRatio: '0.0500', orderStatus: 'in_progress', processConfigStatus: 'configured', suspended: false, suspendedReason: null, actualStartAt: '2026-10-26T08:00:00.000Z', currentSettingsVersion: 1, salesOrderNo: 'SO-2026-0301', remark: null, createdAt: '2026-10-25T10:00:00.000Z' },
  { id: 'po-002', orderNo: 'MO-2026-1027-002', materialId: 'm-0007', materialSnapshot: { code: 'YJV-4X35', name: 'YJV 0.6/1kV 4×35 电缆', spec: '4×35mm²', color: null }, productionDeptId: 'n-draw', productionQty: '5.0000', uom: 'KM', overrunRatio: null, orderStatus: 'approved', processConfigStatus: 'configured', suspended: false, suspendedReason: null, actualStartAt: null, currentSettingsVersion: 1, salesOrderNo: 'SO-2026-0288', remark: null, createdAt: '2026-10-26T15:00:00.000Z' },
  { id: 'po-003', orderNo: 'MO-2026-1027-003', materialId: 'm-0006', materialSnapshot: { code: 'YJV-3X70', name: 'YJV 8.7/15kV 3×70 电缆', spec: '3×70mm²', color: null }, productionDeptId: 'n-extrude', productionQty: '3.0000', uom: 'KM', overrunRatio: null, orderStatus: 'in_progress', processConfigStatus: 'configured', suspended: true, suspendedReason: '客户规格变更待确认', actualStartAt: '2026-10-25T08:00:00.000Z', currentSettingsVersion: 1, salesOrderNo: 'SO-2026-0277', remark: null, createdAt: '2026-10-24T09:00:00.000Z' },
  { id: 'po-004', orderNo: 'MO-2026-1025-009', materialId: 'm-0007', materialSnapshot: { code: 'YJV-4X35', name: 'YJV 0.6/1kV 4×35 电缆', spec: '4×35mm²', color: null }, productionDeptId: 'n-draw', productionQty: '2.0000', uom: 'KM', overrunRatio: null, orderStatus: 'voided', processConfigStatus: 'configured', suspended: false, suspendedReason: null, actualStartAt: null, currentSettingsVersion: 1, salesOrderNo: null, remark: '客户撤销订单', createdAt: '2026-10-23T09:00:00.000Z' },
  { id: 'po-005', orderNo: 'MO-2026-1026-011', materialId: 'm-0006', materialSnapshot: { code: 'YJV-3X70', name: 'YJV 8.7/15kV 3×70 电缆', spec: '3×70mm²', color: null }, productionDeptId: 'n-extrude', productionQty: '4.0000', uom: 'KM', overrunRatio: null, orderStatus: 'closed', processConfigStatus: 'configured', suspended: false, suspendedReason: null, actualStartAt: '2026-10-20T08:00:00.000Z', currentSettingsVersion: 1, salesOrderNo: 'SO-2026-0255', remark: null, createdAt: '2026-10-19T09:00:00.000Z' },
]

/** 订单工序（[底稿 A2-3] 快照冻结：芯倍数/绞合/下线数量/工作中心/设置版本） */
interface MockOrderOperation {
  id: string
  orderId: string
  seq: number
  settingsVersion: number
  operationDefinitionId: string
  operationCode: string
  operationName: string
  coreMultiple: number
  strandFactor: string | null
  offlineQty: string
  workCenterId: string
  workCenterCode: string
  workCenterName: string
  uom: string
  productionDeptId: string
}

const orderOperations: MockOrderOperation[] = [
  { id: 'op-101', orderId: 'po-001', seq: 1, settingsVersion: 1, operationDefinitionId: 'od-ls', operationCode: 'LS-01', operationName: '拉丝', coreMultiple: 7, strandFactor: null, offlineQty: '12.0000', workCenterId: 'wc-md-01', workCenterCode: 'DRAW-01', workCenterName: '拉丝一线', uom: 'KM', productionDeptId: 'n-draw' },
  { id: 'op-102', orderId: 'po-001', seq: 2, settingsVersion: 1, operationDefinitionId: 'od-jh', operationCode: 'JH-01', operationName: '绞合', coreMultiple: 4, strandFactor: '1.0000', offlineQty: '12.0000', workCenterId: 'wc-md-03', workCenterCode: 'TWIST-01', workCenterName: '绞制一线', uom: 'KM', productionDeptId: 'n-twist' },
  { id: 'op-103', orderId: 'po-001', seq: 3, settingsVersion: 1, operationDefinitionId: 'od-js', operationCode: 'JS-01', operationName: '挤塑', coreMultiple: 1, strandFactor: null, offlineQty: '12.0000', workCenterId: 'wc-md-04', workCenterCode: 'EXTR-01', workCenterName: '挤塑一线', uom: 'KM', productionDeptId: 'n-extrude' },
  { id: 'op-201', orderId: 'po-002', seq: 1, settingsVersion: 1, operationDefinitionId: 'od-ls', operationCode: 'LS-01', operationName: '拉丝', coreMultiple: 7, strandFactor: null, offlineQty: '5.0000', workCenterId: 'wc-md-01', workCenterCode: 'DRAW-01', workCenterName: '拉丝一线', uom: 'KM', productionDeptId: 'n-draw' },
  { id: 'op-202', orderId: 'po-002', seq: 2, settingsVersion: 1, operationDefinitionId: 'od-js', operationCode: 'JS-01', operationName: '挤塑', coreMultiple: 1, strandFactor: null, offlineQty: '5.0000', workCenterId: 'wc-md-04', workCenterCode: 'EXTR-01', workCenterName: '挤塑一线', uom: 'KM', productionDeptId: 'n-extrude' },
  { id: 'op-301', orderId: 'po-003', seq: 1, settingsVersion: 1, operationDefinitionId: 'od-js', operationCode: 'JS-01', operationName: '挤塑', coreMultiple: 1, strandFactor: null, offlineQty: '3.0000', workCenterId: 'wc-md-04', workCenterCode: 'EXTR-01', workCenterName: '挤塑一线', uom: 'KM', productionDeptId: 'n-extrude' },
  { id: 'op-401', orderId: 'po-004', seq: 1, settingsVersion: 1, operationDefinitionId: 'od-ls', operationCode: 'LS-01', operationName: '拉丝', coreMultiple: 7, strandFactor: null, offlineQty: '2.0000', workCenterId: 'wc-md-01', workCenterCode: 'DRAW-01', workCenterName: '拉丝一线', uom: 'KM', productionDeptId: 'n-draw' },
]

/** 排产槽位（[A3-1] 唯一键：订单工序+设备+生产日期；改 0 = 删槽） */
interface MockSlot {
  id: string
  orderId: string
  orderOperationId: string
  equipmentId: string
  productionDate: string
  plannedQty: string
  uom: string
  remark: string | null
}

const scheduleSlots: MockSlot[] = [
  { id: 'slot-001', orderId: 'po-001', orderOperationId: 'op-101', equipmentId: 'eq-0001', productionDate: '2026-10-27', plannedQty: '6.0000', uom: 'KM', remark: null },
  { id: 'slot-002', orderId: 'po-002', orderOperationId: 'op-201', equipmentId: 'eq-0001', productionDate: '2026-10-27', plannedQty: '5.0000', uom: 'KM', remark: null },
  { id: 'slot-003', orderId: 'po-001', orderOperationId: 'op-102', equipmentId: 'eq-0004', productionDate: '2026-10-28', plannedQty: '8.0000', uom: 'KM', remark: '优先绞制' },
]

/** 设备日产能（[A3-2w]：eq-0001 当日 8.0000KM，已有 11.0000KM → 新增即超产能弱提醒演示） */
const capacityCalendar = new Map<string, string>([['eq-0001|2026-10-27', '8.0000']])

/** 班次参数（[A4-1] 白班起点，工厂级唯一） */
const shiftParameters = new Map<string, string>([['n-plant', '08:00']])

/** 线边库清单（[A6-5] 产出目标库位约束的 mock 配置） */
const LINE_SIDE_LOCATION_IDS = ['loc-02010001', 'loc-02010002', 'loc-02020001']

/** 投料可投单元扩展（半成品/合格/线边库；产品轴码 10 位第 2 位 E/F/M） */
const feedUnits: MockUnit[] = [
  { unitId: 'u-0007', unitNo: 'U-2026-1003-0007', materialId: 'm-0004', materialCode: 'CU-2.50-DRAWN', lotNo: 'LOT-CUD-1027A', traceMode: 'quantity', status: 'in_stock', balanceOpen: true, locationCode: '02010001', quantity: '300.0000', reserved: '0.0000', available: '300.0000', uomCode: 'KG', qualityStatus: 'qualified', feetDisplay: '984 英尺' },
  { unitId: 'u-0008', unitNo: 'U-2026-1003-0008', materialId: 'm-0004', materialCode: 'CU-2.50-DRAWN', lotNo: 'LOT-CUD-1026B', traceMode: 'quantity', status: 'in_stock', balanceOpen: true, locationCode: '02010001', quantity: '180.0000', reserved: '0.0000', available: '180.0000', uomCode: 'KG', qualityStatus: 'qualified', feetDisplay: '590 英尺' },
]
const feedUnitsByBarcode = new Map<string, string>([
  ['E5E0000007', 'u-0007'],
  ['E6F0000008', 'u-0008'],
  ['F3C0000002', 'u-0002'],
])
/** 投料单元产出归属（跨订单判定：originOrderId ≠ 本订单即跨订单） */
const feedUnitOrigin = new Map<string, string>([['u-0007', 'po-001'], ['u-0008', 'po-999']])

/** 报工会话/报工单（三入口同规则，仅 source 不同） */
interface MockReport {
  id: string
  sessionId: string
  orderId: string
  orderOperationId: string
  operationSeq: number
  source: 'order' | 'workbench' | 'scan'
  status: 'draft' | 'submitted' | 'deleted'
  reviewStatus: 'pending_review' | 'auto_approved' | 'manual_approved' | 'cancelled'
  operatorUserId: string
  operatorLogin: string
  businessTime: string
  shiftDate: string
  equipmentCode: string | null
  reviewedAt: string | null
  reviewedBy: string | null
  reviewCancelledAt: string | null
  remark: string | null
  /** 产出已入库且被下游消耗（取消审核对象关系守卫演示） */
  stockLocked: boolean
  outputs: Array<{ lineNo: number; quantity: string; qualifiedQty: string; uomCode: string; carrierCode: string | null; targetLocationId: string; targetLocationCode: string; stockUnitId: string | null }>
}

const reports: MockReport[] = [
  { id: 'rp-001', sessionId: 'es-001', orderId: 'po-001', orderOperationId: 'op-101', operationSeq: 1, source: 'workbench', status: 'draft', reviewStatus: 'pending_review', operatorUserId: 'user-s-1', operatorLogin: 'admin', businessTime: '2026-10-27T08:40:00.000Z', shiftDate: '2026-10-27', equipmentCode: 'LZ-450-01', reviewedAt: null, reviewedBy: null, reviewCancelledAt: null, remark: '中拉机早班', stockLocked: false, outputs: [{ lineNo: 1, quantity: '3.0000', qualifiedQty: '3.0000', uomCode: 'KM', carrierCode: 'E2A0000001', targetLocationId: 'loc-02010001', targetLocationCode: '02010001', stockUnitId: null }] },
  { id: 'rp-002', sessionId: 'es-002', orderId: 'po-001', orderOperationId: 'op-101', operationSeq: 1, source: 'order', status: 'submitted', reviewStatus: 'pending_review', operatorUserId: 'user-s-1', operatorLogin: 'admin', businessTime: '2026-10-27T08:10:00.000Z', shiftDate: '2026-10-27', equipmentCode: null, reviewedAt: null, reviewedBy: null, reviewCancelledAt: null, remark: null, stockLocked: false, outputs: [{ lineNo: 1, quantity: '2.0000', qualifiedQty: '1.8000', uomCode: 'KM', carrierCode: 'E2A0000002', targetLocationId: 'loc-02010001', targetLocationCode: '02010001', stockUnitId: null }] },
  { id: 'rp-003', sessionId: 'es-003', orderId: 'po-001', orderOperationId: 'op-101', operationSeq: 1, source: 'order', status: 'submitted', reviewStatus: 'manual_approved', operatorUserId: 'user-s-1', operatorLogin: 'admin', businessTime: '2026-10-26T16:20:00.000Z', shiftDate: '2026-10-26', equipmentCode: null, reviewedAt: '2026-10-26T17:00:00.000Z', reviewedBy: 'admin', reviewCancelledAt: null, remark: null, stockLocked: true, outputs: [{ lineNo: 1, quantity: '1.0000', qualifiedQty: '1.0000', uomCode: 'KM', carrierCode: 'E2A0000003', targetLocationId: 'loc-02010001', targetLocationCode: '02010001', stockUnitId: 'u-0031' }] },
  { id: 'rp-004', sessionId: 'es-004', orderId: 'po-001', orderOperationId: 'op-102', operationSeq: 2, source: 'workbench', status: 'submitted', reviewStatus: 'manual_approved', operatorUserId: 'user-s-1', operatorLogin: 'admin', businessTime: '2026-10-26T15:00:00.000Z', shiftDate: '2026-10-26', equipmentCode: 'JZ-1250-01', reviewedAt: '2026-10-26T15:40:00.000Z', reviewedBy: 'admin', reviewCancelledAt: null, remark: null, stockLocked: false, outputs: [{ lineNo: 1, quantity: '8.0000', qualifiedQty: '8.0000', uomCode: 'KM', carrierCode: 'E2A0000004', targetLocationId: 'loc-02020001', targetLocationCode: '02020001', stockUnitId: 'u-0032' }] },
]

/** 草稿会话登记（listDrafts 视图按 open 会话口径） */
interface MockSession {
  id: string
  orderId: string
  source: 'order' | 'workbench' | 'scan'
  status: 'open' | 'submitted' | 'cancelled'
  createdAt: string
}
const sessions: MockSession[] = [{ id: 'es-001', orderId: 'po-001', source: 'workbench', status: 'open', createdAt: '2026-10-27T08:41:00.000Z' }]

/** 投料记录（[A7-4] 扣前/扣后 + 销售行归属） */
interface MockConsumption {
  id: string
  orderId: string
  orderOperationId: string
  operationSeq: number
  reportId: string | null
  feedType: 'report' | 'standalone'
  inventoryUnitId: string
  unitNo: string
  barcodeValue: string | null
  quantity: string
  beforeQty: string
  afterQty: string
  uomCode: string
  salesOrderNo: string | null
  salesLineNo: string | null
  crossOrder: boolean
  deviationReason: string | null
  issuedLocationCode: string | null
  operatorLogin: string
  businessTime: string
  shiftDate: string
}
const consumptions: MockConsumption[] = [
  { id: 'mc-001', orderId: 'po-001', orderOperationId: 'op-102', operationSeq: 2, reportId: null, feedType: 'standalone', inventoryUnitId: 'u-0007', unitNo: 'U-2026-1003-0007', barcodeValue: 'E5E0000007', quantity: '120.0000', beforeQty: '300.0000', afterQty: '180.0000', uomCode: 'KG', salesOrderNo: 'SO-2026-0301', salesLineNo: '10', crossOrder: false, deviationReason: null, issuedLocationCode: '02010001', operatorLogin: 'admin', businessTime: '2026-10-26T14:00:00.000Z', shiftDate: '2026-10-26' },
]

/** 检验任务（A-T12-5 来源/阶段/规范版本化） */
interface MockInspection {
  id: string
  orderNo: string
  sourceType: 'work_report' | 'putaway_receipt'
  sourceRef: string
  inspectionStage: 'process' | 'finished'
  specCode: string
  specVersion: number
  inventoryUnitId: string | null
  unitNo: string | null
  materialId: string
  materialCode: string
  quantity: string
  uomCode: string
  status: 'pending' | 'in_progress' | 'concluded' | 'cancelled'
  productionOrderNo: string | null
  productionDeptName: string | null
}
const inspections: MockInspection[] = [
  { id: 'qio-001', orderNo: 'QI-2026-1027-001', sourceType: 'work_report', sourceRef: 'rp-002', inspectionStage: 'process', specCode: 'SPEC-STRAND-4X120', specVersion: 2, inventoryUnitId: null, unitNo: null, materialId: 'm-0005', materialCode: 'STRAND-4X120', quantity: '2.0000', uomCode: 'KM', status: 'pending', productionOrderNo: 'MO-2026-1027-001', productionDeptName: '拉丝车间' },
  { id: 'qio-002', orderNo: 'QI-2026-1026-008', sourceType: 'putaway_receipt', sourceRef: 'pt-003', inspectionStage: 'finished', specCode: 'SPEC-YJV-3X70', specVersion: 1, inventoryUnitId: 'u-0004', unitNo: 'U-2026-1002-0004', materialId: 'm-0006', materialCode: 'YJV-3X70', quantity: '3.6000', uomCode: 'KM', status: 'concluded', productionOrderNo: 'MO-2026-1026-011', productionDeptName: '挤塑车间' },
  { id: 'qio-003', orderNo: 'QI-2026-1027-003', sourceType: 'work_report', sourceRef: 'rp-003', inspectionStage: 'finished', specCode: 'SPEC-STRAND-4X120', specVersion: 2, inventoryUnitId: 'u-0031', unitNo: 'U-2026-1002-0031', materialId: 'm-0005', materialCode: 'STRAND-4X120', quantity: '1.0000', uomCode: 'KM', status: 'concluded', productionOrderNo: 'MO-2026-1027-001', productionDeptName: '拉丝车间' },
]

/** 结论版本链（追加历史 + 生效指针，S14） */
interface MockTestResult {
  resultId: string
  inspectionOrderId: string
  version: number
  resultKind: 'initial' | 'test' | 're_inspection'
  conclusion: 'pending' | 'qualified' | 'unqualified'
  items: Array<{ itemNo: string; itemName: string | null; measuredValue: string; judgement: 'pass' | 'fail' | 'not_tested'; note: string | null }>
  isEffective: boolean
  inspector: string | null
  inspectedAt: string | null
}
const testResults: MockTestResult[] = [
  { resultId: 'tr-002-1', inspectionOrderId: 'qio-002', version: 1, resultKind: 'initial', conclusion: 'qualified', items: [{ itemNo: '1', itemName: '导体电阻', measuredValue: '0.527', judgement: 'pass', note: null }, { itemNo: '2', itemName: '耐压试验', measuredValue: '21.0kV/5min', judgement: 'pass', note: null }], isEffective: true, inspector: 'liu03', inspectedAt: '2026-10-26T11:00:00.000Z' },
  { resultId: 'tr-003-1', inspectionOrderId: 'qio-003', version: 1, resultKind: 'initial', conclusion: 'unqualified', items: [{ itemNo: '1', itemName: '外观', measuredValue: '表面划痕', judgement: 'fail', note: '划痕长度约 15cm' }], isEffective: true, inspector: 'liu03', inspectedAt: '2026-10-27T08:00:00.000Z' },
]

/** 处置记录（放行/让步——让步保留原不合格事实） */
interface MockDisposition {
  dispositionId: string
  inspectionOrderId: string
  dispositionKind: 'release' | 'concession'
  basedOnVersion: number
  releasedBy: string
  releasedAt: string
  reason: string | null
}
const dispositions: MockDisposition[] = [
  { dispositionId: 'dp-002', inspectionOrderId: 'qio-002', dispositionKind: 'release', basedOnVersion: 1, releasedBy: 'liu03', releasedAt: '2026-10-26T11:30:00.000Z', reason: '成品检验合格放行' },
]

/** 隔离/存疑记录（A-T12-2/3） */
interface MockHold {
  id: string
  inventoryUnitId: string
  unitNo: string
  holdKind: 'pending_inspection' | 'unqualified' | 'suspect'
  status: 'active' | 'released'
  previousQualityStatus: string | null
  raisedBy: string
  raisedAt: string
  productionDeptName: string | null
  releasedBy: string | null
  releasedAt: string | null
  dispositionNote: string | null
}
const holds: MockHold[] = [
  { id: 'hold-001', inventoryUnitId: 'u-0005', unitNo: 'U-2026-1002-0005', holdKind: 'suspect', status: 'active', previousQualityStatus: 'pending_inspection', raisedBy: 'liu03', raisedAt: '2026-10-27T07:50:00.000Z', productionDeptName: '挤塑车间', releasedBy: null, releasedAt: null, dispositionNote: null },
  { id: 'hold-002', inventoryUnitId: 'u-0002', unitNo: 'U-2026-1001-0002', holdKind: 'pending_inspection', status: 'released', previousQualityStatus: 'qualified', raisedBy: 'zhao04', raisedAt: '2026-10-25T09:00:00.000Z', productionDeptName: null, releasedBy: 'liu03', releasedAt: '2026-10-26T10:00:00.000Z', dispositionNote: '检验完成后恢复' },
]

/** 待入库任务（A-T13-1 台账只读，禁手工增删改） */
interface MockPutawayTask {
  id: string
  sourceType: 'work_report' | 'finished_inspection'
  sourceRef: string
  unitNo: string | null
  palletCode: string | null
  materialId: string
  materialCode: string
  quantity: string
  uomCode: string
  targetWarehouseId: string | null
  status: 'pending' | 'done' | 'cancelled'
  inventoryUnitId: string | null
  locationCode: string | null
  putawayBy: string | null
  putawayAt: string | null
}
const putawayTasks: MockPutawayTask[] = [
  { id: 'pt-001', sourceType: 'work_report', sourceRef: 'rp-004', unitNo: 'U-2026-1002-0032', palletCode: null, materialId: 'm-0005', materialCode: 'STRAND-4X120', quantity: '8.0000', uomCode: 'KM', targetWarehouseId: 'wh-0202', status: 'pending', inventoryUnitId: 'u-0032', locationCode: null, putawayBy: null, putawayAt: null },
  { id: 'pt-002', sourceType: 'work_report', sourceRef: 'rp-004', unitNo: 'U-2026-1002-0032', palletCode: 'PLT-2026-001', materialId: 'm-0005', materialCode: 'STRAND-4X120', quantity: '8.0000', uomCode: 'KM', targetWarehouseId: 'wh-0202', status: 'pending', inventoryUnitId: 'u-0032', locationCode: null, putawayBy: null, putawayAt: null },
  { id: 'pt-003', sourceType: 'finished_inspection', sourceRef: 'qio-002', unitNo: 'U-2026-1002-0004', palletCode: null, materialId: 'm-0006', materialCode: 'YJV-3X70', quantity: '3.6000', uomCode: 'KM', targetWarehouseId: 'wh-0103', status: 'done', inventoryUnitId: 'u-0004', locationCode: '01030001', putawayBy: 'zhao04', putawayAt: '2026-10-26T13:00:00.000Z' },
]

/** 移库记录（A-T13-4 append-only） */
interface MockMoveRecord {
  id: string
  inventoryUnitId: string
  unitNo: string
  fromLocationCode: string | null
  toLocationCode: string | null
  quantity: string
  uomCode: string
  movedBy: string
  movedAt: string
  reason: string | null
}
const moveRecords: MockMoveRecord[] = [
  { id: 'mv-001', inventoryUnitId: 'u-0003', unitNo: 'U-2026-1001-0003', fromLocationCode: '010101', toLocationCode: '010102', quantity: '640.0000', uomCode: 'KG', movedBy: 'zhao04', movedAt: '2026-10-26T10:30:00.000Z', reason: '整理货架' },
]

/** 调拨单与行（A-T13-10 两段状态机） */
interface MockTransferLine {
  id: string
  lineNo: number
  inventoryUnitId: string
  unitNo: string
  materialCode: string | null
  quantity: string
  outQty: string
  inQty: string
  reservationId: string | null
  outDone: boolean
  inDone: boolean
}
interface MockTransfer {
  id: string
  orderNo: string
  transferKind: 'production' | 'warehouse' | 'auto'
  fromWarehouseId: string
  toWarehouseId: string
  fromWarehouseCode: string | null
  toWarehouseCode: string | null
  status: 'draft' | 'ready' | 'shipping' | 'shipped_in_transit' | 'receiving' | 'completed' | 'cancelled'
  transitLocationId: string | null
  transitLocationCode: string | null
  lockedValidUntil: string | null
  note: string | null
  submittedAt: string | null
  shippedAt: string | null
  completedAt: string | null
  lines: MockTransferLine[]
}
const transfers: MockTransfer[] = [
  { id: 'tf-001', orderNo: 'TR-2026-1027-001', transferKind: 'production', fromWarehouseId: 'wh-0202', toWarehouseId: 'wh-0103', fromWarehouseCode: '0202', toWarehouseCode: '0103', status: 'shipped_in_transit', transitLocationId: 'loc-01010002', transitLocationCode: '01010002', lockedValidUntil: '2026-10-30T00:00:00.000Z', note: '绞制成品转入成品库', submittedAt: '2026-10-27T08:00:00.000Z', shippedAt: '2026-10-27T08:30:00.000Z', completedAt: null, lines: [{ id: 'tl-001', lineNo: 1, inventoryUnitId: 'u-0032', unitNo: 'U-2026-1002-0032', materialCode: 'STRAND-4X120', quantity: '8.0000', outQty: '8.0000', inQty: '0.0000', reservationId: 'rsv-tf-001', outDone: true, inDone: false }] },
  { id: 'tf-002', orderNo: 'TR-2026-1027-002', transferKind: 'warehouse', fromWarehouseId: 'wh-0101', toWarehouseId: 'wh-0103', fromWarehouseCode: '0101', toWarehouseCode: '0103', status: 'draft', transitLocationId: 'loc-01010002', transitLocationCode: '01010002', lockedValidUntil: null, note: null, submittedAt: null, shippedAt: null, completedAt: null, lines: [{ id: 'tl-002', lineNo: 1, inventoryUnitId: 'u-0001', unitNo: 'U-2026-1001-0001', materialCode: 'CU-8.00', quantity: '400.0000', outQty: '0.0000', inQty: '0.0000', reservationId: null, outDone: false, inDone: false }] },
  { id: 'tf-003', orderNo: 'TR-2026-1026-015', transferKind: 'warehouse', fromWarehouseId: 'wh-0101', toWarehouseId: 'wh-0103', fromWarehouseCode: '0101', toWarehouseCode: '0103', status: 'completed', transitLocationId: 'loc-01010002', transitLocationCode: '01010002', lockedValidUntil: '2026-10-25T00:00:00.000Z', note: null, submittedAt: '2026-10-24T09:00:00.000Z', shippedAt: '2026-10-24T10:00:00.000Z', completedAt: '2026-10-24T11:00:00.000Z', lines: [{ id: 'tl-003', lineNo: 1, inventoryUnitId: 'u-0006', unitNo: 'U-2026-1002-0006', materialCode: 'AL-9.50', quantity: '900.0000', outQty: '900.0000', inQty: '900.0000', reservationId: 'rsv-tf-003', outDone: true, inDone: true }] },
]

/** 数量比较/求和（十进制字符串；演示精度用 Number 即可） */
function sumQtyStr(values: string[]): string {
  return values.reduce((acc, v) => acc + Number(v), 0).toFixed(4)
}

function toProductionOrderDto(o: (typeof productionOrders)[number]) {
  return {
    id: o.id,
    plantId: 'n-plant',
    orderNo: o.orderNo,
    orderType: '标准生产',
    salesContractNo: null,
    salesOrderNo: o.salesOrderNo,
    lineNo: null,
    materialId: o.materialId,
    materialSnapshot: o.materialSnapshot,
    productFamilyId: null,
    productionDeptId: o.productionDeptId,
    productionQty: o.productionQty,
    uom: o.uom,
    overrunRatio: o.overrunRatio,
    orderStatus: o.orderStatus,
    processConfigStatus: o.processConfigStatus,
    processConfirmedAt: o.createdAt,
    suspended: o.suspended,
    suspendedReason: o.suspendedReason,
    actualStartAt: o.actualStartAt,
    actualFinishAt: null,
    businessClosedAt: null,
    erpClosedAt: null,
    erpClosedBy: null,
    bomRevisionId: null,
    routeRevisionId: null,
    currentSettingsVersion: o.currentSettingsVersion,
    plannedStartAt: null,
    plannedFinishAt: null,
    segmentRequirement: null,
    remark: o.remark,
    createdAt: o.createdAt,
    updatedAt: o.createdAt,
  }
}

function toOrderOperationDto(op: MockOrderOperation) {
  return {
    id: op.id,
    plantId: 'n-plant',
    orderId: op.orderId,
    seq: op.seq,
    settingsVersion: op.settingsVersion,
    executionStatus: 'pending' as const,
    operationDefinitionId: op.operationDefinitionId,
    operationCode: op.operationCode,
    operationName: op.operationName,
    operationRemark: null,
    coreMultiple: op.coreMultiple,
    strandFactor: op.strandFactor,
    offlineQty: op.offlineQty,
    workCenterId: op.workCenterId,
    workCenterCode: op.workCenterCode,
    workCenterName: op.workCenterName,
    uom: op.uom,
    productionDeptId: op.productionDeptId,
    routeRevisionId: null,
    bomRevisionId: null,
    createdAt: now,
    updatedAt: now,
  }
}

/** 排产投影：某订单各工序已排数量/是否排完（[A3-4] 回写链） */
function scheduledQtyOfOperation(orderOperationId: string): string {
  return sumQtyStr(scheduleSlots.filter((s) => s.orderOperationId === orderOperationId).map((s) => s.plannedQty))
}

function orderSchedulingStatusOf(orderId: string): 'unplanned' | 'partially_scheduled' | 'fully_scheduled' {
  const ops = orderOperations.filter((o) => o.orderId === orderId)
  if (ops.length === 0) return 'unplanned'
  const planned = ops.filter((op) => Number(scheduledQtyOfOperation(op.id)) > 0).length
  const done = ops.filter((op) => Number(scheduledQtyOfOperation(op.id)) >= Number(op.offlineQty)).length
  if (planned === 0) return 'unplanned'
  return done === ops.length ? 'fully_scheduled' : 'partially_scheduled'
}

function orderViewOf(orderId: string): Record<string, unknown> | null {
  const order = productionOrders.find((o) => o.id === orderId)
  if (!order) return null
  const ops = orderOperations
    .filter((o) => o.orderId === orderId && o.settingsVersion === order.currentSettingsVersion)
    .slice()
    .sort((a, b) => a.seq - b.seq)
  const enterable = order.processConfigStatus === 'configured' && ops.length > 0
  const operations = ops.map((op) => {
    const scheduledQty = scheduledQtyOfOperation(op.id)
    return {
      orderOperationId: op.id,
      seq: op.seq,
      operationDefinitionId: op.operationDefinitionId,
      operationName: op.operationName,
      operationRemark: null,
      offlineQty: op.offlineQty,
      scheduledQty,
      fullyScheduled: Number(scheduledQty) >= Number(op.offlineQty),
      uom: op.uom,
      workCenterId: op.workCenterId,
      slots: scheduleSlots
        .filter((s) => s.orderOperationId === op.id)
        .map((s) => {
          const eq = equipment.find((e) => e.id === s.equipmentId)
          return {
            slotId: s.id,
            equipmentId: s.equipmentId,
            equipmentCode: eq?.code ?? s.equipmentId,
            equipmentName: eq?.name ?? s.equipmentId,
            equipmentStatus: eq?.equipmentStatus ?? 1,
            productionDate: s.productionDate,
            plannedQty: s.plannedQty,
            remark: s.remark,
          }
        }),
    }
  })
  return {
    orderId: order.id,
    plantId: 'n-plant',
    orderNo: order.orderNo,
    uom: order.uom,
    orderStatus: order.orderStatus,
    enterable,
    entryBlocker: enterable ? null : '工序未配置或存在未配置工作中心的工序，请先完成工艺设置',
    schedulingStatus: orderSchedulingStatusOf(orderId),
    operations,
  }
}

/** 设备看板投影（[A3-5]：日期列 = 今日起 30 天 ∪ 已有排产日，mock 固定演示窗口 7 天） */
function deviceBoardOf(workCenterId?: string): Record<string, unknown> {
  const activeWorkCenters = workCenters.filter((w) => w.status === 'active')
  const selected = workCenterId && workCenterId !== '' ? workCenterId : activeWorkCenters[0]?.id ?? null
  const dates: string[] = []
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(`${MOCK_TODAY}T00:00:00.000Z`)
    d.setUTCDate(d.getUTCDate() + i)
    dates.push(d.toISOString().slice(0, 10))
  }
  for (const s of scheduleSlots) {
    if (!dates.includes(s.productionDate)) dates.push(s.productionDate)
  }
  dates.sort()
  const rows =
    selected !== null
      ? equipment
          .filter((e) => e.status === 'active' && e.workCenterId === selected)
          .map((e) => {
            const slotsOf = scheduleSlots.filter((s) => s.equipmentId === e.id)
            const cells = dates
              .map((date) => {
                const dayRows = slotsOf.filter((s) => s.productionDate === date)
                if (dayRows.length === 0) return null
                return {
                  productionDate: date,
                  orderCount: new Set(dayRows.map((r) => r.orderId)).size,
                  plannedTotal: sumQtyStr(dayRows.map((r) => r.plannedQty)),
                  details: dayRows.map((r) => {
                    const order = productionOrders.find((o) => o.id === r.orderId)
                    return { orderId: r.orderId, orderNo: order?.orderNo ?? r.orderId, salesOrderNo: order?.salesOrderNo ?? null, plannedQty: r.plannedQty, uom: r.uom }
                  }),
                }
              })
              .filter((c): c is NonNullable<typeof c> => c !== null)
            return { equipmentId: e.id, code: e.code, name: e.name, equipmentStatus: e.equipmentStatus, workCenterId: e.workCenterId, cells }
          })
      : []
  return {
    plantId: 'n-plant',
    workCenterId: selected,
    today: MOCK_TODAY,
    dates,
    workCenters: activeWorkCenters.map((w) => ({ id: w.id, code: w.code, name: w.name })),
    equipments: rows,
  }
}

/** 槽位保存（[A3-1] 同键替换 / 改 0 删槽；[A3-2] 硬校验强拒；[A3-2w] 超产能弱提醒 confirm 二次确认） */
function applySlotEntry(
  entry: Record<string, unknown>,
  confirm: boolean,
  warnings: string[],
): { upserted: number; deleted: number; slotIds: string[] } {
  const orderOperationId = typeof entry['orderOperationId'] === 'string' ? entry['orderOperationId'] : ''
  const equipmentId = typeof entry['equipmentId'] === 'string' ? entry['equipmentId'] : ''
  const productionDate = typeof entry['productionDate'] === 'string' ? entry['productionDate'] : ''
  const plannedQty = typeof entry['plannedQty'] === 'string' ? entry['plannedQty'] : ''
  if (!orderOperationId || !equipmentId || !productionDate || plannedQty === '') {
    throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A3-1] 槽位条目需要 orderOperationId/equipmentId/productionDate/plannedQty', details: {} })
  }
  const op = orderOperations.find((o) => o.id === orderOperationId)
  if (!op) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '订单工序不存在或不在当前设置版本', details: {} })
  const order = productionOrders.find((o) => o.id === op.orderId)
  if (!order) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '生产订单不存在或不属于本企业', details: {} })
  if (order.orderStatus === 'closed' || order.orderStatus === 'voided') {
    throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A3-5] 已结束/已作废订单不可排产', details: {} })
  }
  const eq = equipment.find((e) => e.id === equipmentId && e.status === 'active')
  if (!eq) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '排产设备不存在', details: {} })
  const qty = Number(plannedQty)
  if (Number.isNaN(qty) || qty < 0) {
    throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A3-1] 计划产量必须为非负十进制定点字符串', details: {} })
  }
  if (qty > 0 && eq.equipmentStatus === 2) {
    throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A3-3] 设备 ${eq.code} 处于维修状态，不可排产（设备状态须为正常）`, details: {} })
  }
  const identityMatch = (s: MockSlot) => s.orderOperationId === orderOperationId && s.equipmentId === equipmentId && s.productionDate === productionDate
  // [A3-2] 硬校验：工序其余槽合计 + 本值 ≤ 下线数量（confirm 不豁免）
  const opOtherQty = scheduleSlots.filter((s) => s.orderOperationId === orderOperationId && !identityMatch(s)).reduce((acc, s) => acc + Number(s.plannedQty), 0)
  if (qty > 0 && opOtherQty + qty > Number(op.offlineQty) + 1e-9) {
    throw new MockError({
      httpStatus: 422,
      code: 'ERR_BUSINESS_RULE',
      message: `[A3-2] 工序 ${op.operationName}（${op.operationCode}）计划量合计 ${(opOtherQty + qty).toFixed(4)} 超过下线数量 ${op.offlineQty}（硬校验拒绝，confirm 不豁免）`,
      details: {},
    })
  }
  // [A3-2w] 超设备日产能弱提醒（confirm=false 拒且文案即二次确认提示；true 可提交并携带提醒）
  const capacity = capacityCalendar.get(`${equipmentId}|${productionDate}`)
  if (capacity !== undefined && qty > 0) {
    const equipDayQty = scheduleSlots.filter((s) => s.equipmentId === equipmentId && s.productionDate === productionDate && !identityMatch(s)).reduce((acc, s) => acc + Number(s.plannedQty), 0)
    if (equipDayQty + qty > Number(capacity) + 1e-9) {
      const warning = `设备 ${eq.code} 在 ${productionDate} 计划量合计 ${(equipDayQty + qty).toFixed(4)} 超过日产能 ${capacity}`
      if (!confirm) {
        throw new MockError({
          httpStatus: 422,
          code: 'ERR_BUSINESS_RULE',
          message: `[A3-2w] ${warning}（超设备日产能为弱提醒，确认后请携带 confirm=true 重新提交）`,
          details: {},
        })
      }
      warnings.push(warning)
    }
  }
  // 同键替换：先移除旧行；计划量 0 = 删槽不落行
  for (let i = scheduleSlots.length - 1; i >= 0; i -= 1) {
    if (identityMatch(scheduleSlots[i]!)) scheduleSlots.splice(i, 1)
  }
  if (qty <= 0) return { upserted: 0, deleted: 1, slotIds: [] }
  const slot: MockSlot = {
    id: `slot-${Math.random().toString(36).slice(2, 8)}`,
    orderId: op.orderId,
    orderOperationId,
    equipmentId,
    productionDate,
    plannedQty,
    uom: op.uom,
    remark: typeof entry['remark'] === 'string' ? entry['remark'] : null,
  }
  scheduleSlots.push(slot)
  return { upserted: 1, deleted: 0, slotIds: [slot.id] }
}

/** 三入口报工（[A6/D4]：同规则仅 source 不同；服务端注入 source/orderId） */
function handleReportEntry(
  source: 'order' | 'workbench' | 'scan',
  orderId: string,
  body: unknown,
  meta: CommandMeta | undefined,
): Record<string, unknown> {
  const p = (body ?? {}) as Record<string, unknown>
  const action = p['action'] === 'draft' ? 'draft' : 'submit'
  const order = productionOrders.find((o) => o.id === orderId)
  if (!order) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '生产订单不存在或不在授权数据范围内', details: {} })
  if (order.orderStatus === 'voided') {
    throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A6-1] 已作废订单不可报工', details: {} })
  }
  if (order.orderStatus !== 'in_progress') {
    throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A6-3] 订单状态 ${order.orderStatus} 不可报工（须进行中）`, details: {} })
  }
  if (order.suspended) {
    throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A6-3] 订单处于挂起状态，不可报工', details: {} })
  }
  const orderOperationId = typeof p['orderOperationId'] === 'string' ? p['orderOperationId'] : ''
  const op = orderOperations.find((o) => o.id === orderOperationId && o.orderId === order.id && o.settingsVersion === order.currentSettingsVersion)
  if (!op) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '订单工序不存在或不在当前设置版本', details: {} })
  const rawOutputs = Array.isArray(p['outputs']) ? (p['outputs'] as Array<Record<string, unknown>>) : []
  if (action === 'submit' && rawOutputs.length === 0) {
    throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A6-5] 报工单缺少产出行（保存界面产出数量为必填），拒绝提交', details: {} })
  }
  const outputs = rawOutputs.map((line, index) => {
    const quantity = typeof line['quantity'] === 'string' ? line['quantity'] : ''
    if (!quantity || Number.isNaN(Number(quantity)) || Number(quantity) <= 0) {
      throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `execution.report.submit.outputs[${index}] 产出数量必须大于 0`, details: {} })
    }
    const uomCode = typeof line['uomCode'] === 'string' ? line['uomCode'] : ''
    if (uomCode !== order.uom) {
      throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A5-2] 产出单位 ${uomCode} 与订单生产单位 ${order.uom} 不一致（超产/五量须同单位），拒绝`, details: {} })
    }
    const targetLocationId = typeof line['targetLocationId'] === 'string' ? line['targetLocationId'] : ''
    const targetLocationCode = typeof line['targetLocationCode'] === 'string' ? line['targetLocationCode'] : ''
    if (!LINE_SIDE_LOCATION_IDS.includes(targetLocationId)) {
      throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A6-5] 产出目标库位 ${targetLocationCode} 不在线边库清单内，拒绝`, details: {} })
    }
    const qualifiedQty = typeof line['qualifiedQty'] === 'string' ? line['qualifiedQty'] : quantity
    if (Number(qualifiedQty) > Number(quantity)) {
      throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `execution.report.submit.outputs[${index}] 合格数量不得大于产出数量`, details: {} })
    }
    return {
      lineNo: index + 1,
      quantity,
      qualifiedQty,
      uomCode,
      carrierCode: typeof line['carrierCode'] === 'string' ? line['carrierCode'] : null,
      targetLocationId,
      targetLocationCode,
      stockUnitId: null,
    }
  })
  const sessionId = `es-${Math.random().toString(36).slice(2, 8)}`
  const reportId = `rp-${Math.random().toString(36).slice(2, 8)}`
  const report: MockReport = {
    id: reportId,
    sessionId,
    orderId: order.id,
    orderOperationId: op.id,
    operationSeq: op.seq,
    source,
    status: action === 'draft' ? 'draft' : 'submitted',
    reviewStatus: 'pending_review',
    operatorUserId: 'user-s-1',
    operatorLogin: 'admin',
    businessTime: typeof p['businessTime'] === 'string' ? p['businessTime'] : MOCK_NOW,
    shiftDate: MOCK_TODAY,
    equipmentCode: typeof p['equipmentCode'] === 'string' ? p['equipmentCode'] : null,
    reviewedAt: null,
    reviewedBy: null,
    reviewCancelledAt: null,
    remark: typeof p['remark'] === 'string' ? p['remark'] : null,
    stockLocked: false,
    outputs,
  }
  reports.push(report)
  if (action === 'draft') {
    sessions.push({ id: sessionId, orderId: order.id, source, status: 'open', createdAt: MOCK_NOW })
    return {
      operationId: meta?.operationId ?? `mock-op-${Math.random().toString(36).slice(2, 10)}`,
      status: 'DRAFT_SAVED',
      data: { sessionId, reportId, status: 'draft' },
    }
  }
  return {
    operationId: meta?.operationId ?? `mock-op-${Math.random().toString(36).slice(2, 10)}`,
    status: 'COMMITTED',
    data: { reportId, status: 'submitted', reviewStatus: 'pending_review' },
  }
}

/** 单独投料（[A7] 单一服务端路径：码准入链→跨订单偏离→销售行余量→实时扣减） */
function handleFeedSubmit(body: unknown, meta: CommandMeta | undefined): Record<string, unknown> {
  const p = (body ?? {}) as Record<string, unknown>
  const command = 'execution.feed.submit'
  const orderId = typeof p['orderId'] === 'string' ? p['orderId'] : ''
  const orderOperationId = typeof p['orderOperationId'] === 'string' ? p['orderOperationId'] : ''
  const order = productionOrders.find((o) => o.id === orderId)
  if (!order) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '生产订单不存在', details: {} })
  if (order.orderStatus !== 'in_progress' || order.suspended) {
    throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A7-1/K03] 投料须订单进行中且未挂起（统一归属、部门、可开工、非质检四检）', details: {} })
  }
  const op = orderOperations.find((o) => o.id === orderOperationId && o.orderId === order.id)
  if (!op) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '投料工序不存在或不在当前设置版本', details: {} })
  if (op.productionDeptId === 'n-qc1' || op.productionDeptId === 'n-qc2') {
    throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A6-3] 质检工序一律不可选（不可投料）', details: {} })
  }
  const rawFeeds = Array.isArray(p['feeds']) ? (p['feeds'] as Array<Record<string, unknown>>) : []
  if (rawFeeds.length === 0) {
    throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '投料提交至少一行（一次提交一批）', details: {} })
  }
  const allUnits = [...units, ...feedUnits]
  const remainders = new Map<string, number>()
  const records: MockConsumption[] = []
  for (const line of rawFeeds) {
    const quantity = typeof line['quantity'] === 'string' ? line['quantity'] : ''
    if (!quantity || Number.isNaN(Number(quantity)) || Number(quantity) <= 0) {
      throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `${command} 行数量必须大于 0`, details: {} })
    }
    const barcodeValue = typeof line['barcodeValue'] === 'string' ? line['barcodeValue'] : undefined
    let unitId = typeof line['unitId'] === 'string' ? line['unitId'] : undefined
    const codeRef = barcodeValue ?? ''
    if (unitId === undefined && barcodeValue !== undefined) {
      // [A7-2] 产品轴码格式（10 位第 2 位 E/F/M；托码/原料码拒绝）
      if (!(barcodeValue.length === 10 && 'EFM'.includes(barcodeValue[1] ?? ''))) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A7-2] 投料只接受产品轴码（10 位载具码第 2 位 E/F/M）：${barcodeValue} 不是产品轴码（托码/原料码拒绝）`, details: {} })
      }
      unitId = feedUnitsByBarcode.get(barcodeValue)
      if (unitId === undefined) {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: `[A7-2] 码 ${barcodeValue} 无活动库存单元绑定（托码/未绑定码拒绝）`, details: {} })
      }
    }
    if (unitId === undefined) {
      throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '投料行缺少库存单元（unitId/barcodeValue 解析失败）', details: {} })
    }
    const unit = allUnits.find((u) => u.unitId === unitId)
    if (!unit) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '投料库存单元不存在或不属于订单所在工厂', details: {} })
    const material = materials.find((m) => m.id === unit.materialId)
    // ---- [A7-2] 码准入链（链序固定，第一步失败即拒绝） ----
    const salesOrderNo = typeof line['salesOrderNo'] === 'string' ? line['salesOrderNo'] : ''
    const salesLineNo = typeof line['salesLineNo'] === 'string' ? line['salesLineNo'] : ''
    if (!salesOrderNo || !salesLineNo) {
      throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A7-2] 码 ${codeRef || unit.unitNo} 无销售单号+行号归属，拒绝投料`, details: {} })
    }
    if (unit.qualityStatus !== 'qualified') {
      throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A7-2] 码 ${codeRef || unit.unitNo} 未审批且质检未完成，拒绝投料`, details: {} })
    }
    if (unit.status !== 'in_stock') {
      throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A7-2] 码 ${codeRef || unit.unitNo} 对应库存单元不在库，拒绝投料`, details: {} })
    }
    if (Number(unit.quantity) <= 0) {
      throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A7-2] 码 ${codeRef || unit.unitNo} 所在仓库无库存余额，拒绝投料`, details: {} })
    }
    const LINE_SIDE_CODES = ['02010001', '02010002', '02020001']
    if (!LINE_SIDE_CODES.includes(unit.locationCode)) {
      throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A7-2] 码 ${codeRef || unit.unitNo} 所在库位必须在线边库，拒绝投料`, details: {} })
    }
    if (material?.materialType === 3) {
      throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A7-2] 码 ${codeRef || unit.unitNo} 为成品，不可消耗，拒绝投料`, details: {} })
    }
    // ---- [A7-3] 跨订单偏离（非本订单产出：显式确认 + 偏离原因） ----
    const origin = feedUnitOrigin.get(unit.unitId)
    const isCrossOrder = origin !== undefined && origin !== order.id
    const deviationReason = typeof line['deviationReason'] === 'string' ? line['deviationReason'] : null
    if (isCrossOrder && (line['confirmed'] !== true || !deviationReason)) {
      throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A7-3] 码 ${codeRef || unit.unitNo} 为非本订单半成品（跨订单投料）：须显式确认并填写偏离原因（一次确认不是充分授权）`, details: {} })
    }
    // ---- [A7-4] 按销售行汇总 ≤ 剩余 + 实时余量 ----
    const remainderKey = `${salesOrderNo}|${salesLineNo}`
    const remain = remainders.get(remainderKey) ?? Number(unit.available)
    if (Number(quantity) > remain + 1e-9) {
      throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A7-4] 码 ${codeRef || unit.unitNo} 按销售行 ${remainderKey} 本次投料超出剩余可投（剩余 ${remain.toFixed(4)}），拒绝`, details: {} })
    }
    remainders.set(remainderKey, remain - Number(quantity))
    const beforeQty = unit.quantity
    unit.quantity = (Number(unit.quantity) - Number(quantity)).toFixed(4)
    unit.available = (Number(unit.available) - Number(quantity)).toFixed(4)
    records.push({
      id: `mc-${Math.random().toString(36).slice(2, 8)}`,
      orderId: order.id,
      orderOperationId: op.id,
      operationSeq: op.seq,
      reportId: null,
      feedType: 'standalone',
      inventoryUnitId: unit.unitId,
      unitNo: unit.unitNo,
      barcodeValue: barcodeValue ?? null,
      quantity,
      beforeQty,
      afterQty: unit.quantity,
      uomCode: unit.uomCode,
      salesOrderNo,
      salesLineNo,
      crossOrder: isCrossOrder,
      deviationReason: isCrossOrder ? deviationReason : null,
      issuedLocationCode: unit.locationCode,
      operatorLogin: 'admin',
      businessTime: typeof p['businessTime'] === 'string' ? p['businessTime'] : MOCK_NOW,
      shiftDate: MOCK_TODAY,
    })
  }
  for (const r of records) consumptions.unshift(r)
  return okCommand(
    {
      orderId: order.id,
      operationSeq: op.seq,
      lines: records.map((r) => ({ consumptionId: r.id, unitId: r.inventoryUnitId, unitNo: r.unitNo, quantity: r.quantity, beforeQty: r.beforeQty, afterQty: r.afterQty, salesOrderNo: r.salesOrderNo, salesLineNo: r.salesLineNo, salesLineRemainder: (remainders.get(`${r.salesOrderNo}|${r.salesLineNo}`) ?? 0).toFixed(4) })),
    },
    meta,
  )
}

/** 五量分立视图（[A5-3]：草稿/提交/审核/合格/入库，不做混口径） */
function orderQuantitiesOf(orderId: string): Record<string, unknown> {
  const order = productionOrders.find((o) => o.id === orderId)
  if (!order) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '生产订单不存在或不在授权数据范围内', details: {} })
  const ops = orderOperations.filter((o) => o.orderId === orderId && o.settingsVersion === order.currentSettingsVersion).slice().sort((a, b) => a.seq - b.seq)
  const orderReports = reports.filter((r) => r.orderId === orderId && r.status !== 'deleted')
  const fiveOf = (list: MockReport[]) => ({
    draftQty: sumQtyStr(list.filter((r) => r.status === 'draft').flatMap((r) => r.outputs.map((o) => o.quantity))),
    submittedQty: sumQtyStr(list.filter((r) => r.status === 'submitted' && r.reviewStatus === 'pending_review').flatMap((r) => r.outputs.map((o) => o.quantity))),
    approvedQty: sumQtyStr(list.filter((r) => r.status === 'submitted' && (r.reviewStatus === 'manual_approved' || r.reviewStatus === 'auto_approved')).flatMap((r) => r.outputs.map((o) => o.quantity))),
    qualifiedQty: sumQtyStr(list.filter((r) => r.status === 'submitted' && (r.reviewStatus === 'manual_approved' || r.reviewStatus === 'auto_approved')).flatMap((r) => r.outputs.map((o) => o.qualifiedQty))),
    stockedQty: sumQtyStr(list.filter((r) => r.status === 'submitted' && (r.reviewStatus === 'manual_approved' || r.reviewStatus === 'auto_approved')).flatMap((r) => r.outputs.filter((o) => o.stockUnitId !== null).map((o) => o.quantity))),
  })
  const rows = ops.map((op, i) => {
    const opReports = orderReports.filter((r) => r.orderOperationId === op.id)
    const quantities = fiveOf(opReports)
    const prevApproved = i === 0 ? null : fiveOf(orderReports.filter((r) => r.orderOperationId === ops[i - 1]!.id))
    const ready = i === 0 || Number(prevApproved!.approvedQty) > 0
    return {
      orderOperationId: op.id,
      seq: op.seq,
      operationName: op.operationName,
      isQc: op.productionDeptId === 'n-qc1' || op.productionDeptId === 'n-qc2',
      isLastNonQc: i === ops.length - 1,
      quantities,
      ready,
      readyReason: ready ? '就绪' : '前道工序尚无审核通过的报产',
    }
  })
  return { orderId: order.id, orderNo: order.orderNo, uom: order.uom, total: fiveOf(orderReports), operations: rows }
}

/** 调拨单视图（A-T13-10 状态机投影） */
function toTransferView(t: MockTransfer): Record<string, unknown> {
  const STATUS_LABELS: Record<string, string> = {
    draft: '草稿',
    ready: '待执行',
    shipping: '出库中',
    shipped_in_transit: '已出库在途',
    receiving: '收货中',
    completed: '完成',
    cancelled: '已取消',
  }
  return {
    id: t.id,
    orderNo: t.orderNo,
    transferKind: t.transferKind,
    fromWarehouseId: t.fromWarehouseId,
    toWarehouseId: t.toWarehouseId,
    fromWarehouseCode: t.fromWarehouseCode,
    toWarehouseCode: t.toWarehouseCode,
    fromWarehouseType: null,
    toWarehouseType: null,
    status: t.status,
    statusLabel: STATUS_LABELS[t.status] ?? t.status,
    transitLocationId: t.transitLocationId,
    transitLocationCode: t.transitLocationCode,
    lockedValidUntil: t.lockedValidUntil,
    note: t.note,
    submittedBy: t.submittedAt !== null ? 'admin' : null,
    submittedAt: t.submittedAt,
    shippedBy: t.shippedAt !== null ? 'admin' : null,
    shippedAt: t.shippedAt,
    completedBy: t.completedAt !== null ? 'admin' : null,
    completedAt: t.completedAt,
    plantId: 'n-plant',
  }
}

const loginFailureCounts = new Map<string, number>()

// ---------------- shipping 内存演示数据（第五波；视图形状对齐 shipping-queries.ts） ----------------

interface MockShipmentLine {
  id: string
  shipmentOrderId: string
  lineNo: number
  lineKind: ShipmentLineDto['lineKind']
  materialId: string | null
  materialCode: string
  salesOrderLineNo: string
  customerAxisNo: string | null
  standardSegmentLength: string | null
  actualSegmentLength: string | null
  segmentLength: string | null
  requiredCount: number
  scannedCount: number
  lineStatus: 'pending_packing' | 'packed'
  packingStatus: 'pending' | 'bound' | 'cancelled' | null
  packingOrderId: string | null
}

interface MockScan {
  id: string
  shipmentOrderId: string
  shipmentLineId: string
  scanKind: 'load' | 'supplement'
  inventoryUnitId: string | null
  unitNo: string
  customerAxisNo: string | null
  actualSegmentLength: string | null
  scannedBy: string
  scannedAt: string
  deleted: boolean
  deletedBy: string | null
  deletedAt: string | null
}

interface MockPacking {
  id: string
  packingNo: string
  shipmentOrderId: string
  palletCode: string
  toLocationId: string
  toLocationCode: string
  status: 'pending' | 'bound' | 'cancelled'
  boundBy: string | null
  boundAt: string | null
}

interface MockShipment {
  id: string
  plNo: string
  salesOrderNo: string
  customerName: string | null
  status: ShipmentOrderDto['status']
  compositionMissing: boolean
  outboundBy: string | null
  outboundAt: string | null
  actualAxisSyncStatus: ShipmentOrderDto['actualAxisSyncStatus']
  shippingStatusSyncStatus: ShipmentOrderDto['shippingStatusSyncStatus']
  actualAxisSnapshot: Record<string, unknown> | null
  statusSyncSnapshot: Record<string, unknown> | null
  createdAt: string
}

interface MockPhoto {
  id: string
  shipmentOrderId: string
  fileName: string
  storageKey: string
  contentType: string | null
  sizeBytes: number | null
  uploadedBy: string
  uploadedAt: string
}

interface MockDcComposition {
  id: string
  dcId: string
  salesOrderNo: string
  lineNo: number
  syncStatus: 'missing' | 'received'
  composition: Record<string, unknown> | null
  missingMarkedAt: string | null
}

/**
 * 备货扫码演示单元（五拒一成演示源；qualityStatus 映射 A-T14-3 五拒链）：
 * ok*=合格在库（可装入）；pending=待检（未审核拒）；suspect=存疑恒拒；locked=被作业预留锁定；out=已出库。
 */
const shippingDemoUnits: Array<{ unitNo: string; unitId: string; status: 'in_stock' | 'shipped'; qualityStatus: string; locked: boolean; actualSegmentLength: string | null }> = [
  { unitNo: 'SHPU-OK-001', unitId: 'su-ok-1', status: 'in_stock', qualityStatus: 'qualified', locked: false, actualSegmentLength: '598.5000' },
  { unitNo: 'SHPU-OK-002', unitId: 'su-ok-2', status: 'in_stock', qualityStatus: 'qualified', locked: false, actualSegmentLength: '199.8000' },
  { unitNo: 'SHPU-OK-003', unitId: 'su-ok-3', status: 'in_stock', qualityStatus: 'qualified', locked: false, actualSegmentLength: '600.0000' },
  { unitNo: 'SHPU-OK-004', unitId: 'su-ok-4', status: 'in_stock', qualityStatus: 'qualified', locked: false, actualSegmentLength: '1200.0000' },
  { unitNo: 'SHPU-OK-005', unitId: 'su-ok-5', status: 'in_stock', qualityStatus: 'qualified', locked: false, actualSegmentLength: null },
  { unitNo: 'SHPU-PEND-001', unitId: 'su-pend-1', status: 'in_stock', qualityStatus: 'pending_inspection', locked: false, actualSegmentLength: null },
  { unitNo: 'SHPU-SUS-001', unitId: 'su-sus-1', status: 'in_stock', qualityStatus: 'suspect', locked: false, actualSegmentLength: null },
  { unitNo: 'SHPU-LOCK-001', unitId: 'su-lock-1', status: 'in_stock', qualityStatus: 'qualified', locked: true, actualSegmentLength: null },
  { unitNo: 'SHPU-OUT-001', unitId: 'su-out-1', status: 'shipped', qualityStatus: 'qualified', locked: false, actualSegmentLength: null },
]

const shipments: MockShipment[] = [
  {
    id: 'shp-a', plNo: 'PL-2026-1028-001', salesOrderNo: 'SO-2026-1028-SHIP', customerName: '华东电网',
    status: 'pending_packing', compositionMissing: false, outboundBy: null, outboundAt: null,
    actualAxisSyncStatus: 'pending', shippingStatusSyncStatus: 'pending',
    actualAxisSnapshot: null, statusSyncSnapshot: null, createdAt: '2026-10-28T01:00:00.000Z',
  },
  {
    id: 'shp-b', plNo: 'PL-2026-1028-002', salesOrderNo: 'SO-2026-1028-SHIP', customerName: '华东电网',
    status: 'ready_to_ship', compositionMissing: false, outboundBy: null, outboundAt: null,
    actualAxisSyncStatus: 'pending', shippingStatusSyncStatus: 'pending',
    actualAxisSnapshot: null, statusSyncSnapshot: null, createdAt: '2026-10-28T01:10:00.000Z',
  },
  {
    id: 'shp-c', plNo: 'PL-2026-1027-009', salesOrderNo: 'SO-2026-1027-SHIP', customerName: '南方电网',
    status: 'shipped', compositionMissing: false, outboundBy: 'admin', outboundAt: '2026-10-27T08:20:00.000Z',
    actualAxisSyncStatus: 'pending', shippingStatusSyncStatus: 'sync_failed',
    actualAxisSnapshot: { plannedCustomerAxes: ['CAX-C-01'], actualAxes: ['SHPU-OK-004'], missingOnActual: ['CAX-C-01'], extraOnActual: ['SHPU-OK-004'], decidedAt: '2026-10-27T08:20:00.000Z' },
    statusSyncSnapshot: { plNo: 'PL-2026-1027-009', salesOrderNo: 'SO-2026-1027-SHIP', status: 'shipped', completedAt: '2026-10-27T08:20:00.000Z' },
    createdAt: '2026-10-27T06:00:00.000Z',
  },
]

const shipmentLines: MockShipmentLine[] = [
  // PL-A（待装箱）：三类行齐备，全部未扫——备货工作台主演示单
  { id: 'sl-a1', shipmentOrderId: 'shp-a', lineNo: 1, lineKind: 'axis_item', materialId: 'm-0006', materialCode: 'YJV-3X70', salesOrderLineNo: '10', customerAxisNo: 'CAX-A-01', standardSegmentLength: '600.0000', actualSegmentLength: null, segmentLength: null, requiredCount: 1, scannedCount: 0, lineStatus: 'pending_packing', packingStatus: null, packingOrderId: null },
  { id: 'sl-a2', shipmentOrderId: 'shp-a', lineNo: 2, lineKind: 'plain_item', materialId: 'm-0007', materialCode: 'YJV-4X35', salesOrderLineNo: '11', customerAxisNo: null, standardSegmentLength: null, actualSegmentLength: null, segmentLength: '200.0000', requiredCount: 2, scannedCount: 0, lineStatus: 'pending_packing', packingStatus: null, packingOrderId: null },
  { id: 'sl-a3', shipmentOrderId: 'shp-a', lineNo: 3, lineKind: 'pallet', materialId: 'm-0006', materialCode: 'YJV-3X70', salesOrderLineNo: '10', customerAxisNo: null, standardSegmentLength: null, actualSegmentLength: null, segmentLength: null, requiredCount: 1, scannedCount: 0, lineStatus: 'pending_packing', packingStatus: null, packingOrderId: null },
  // PL-B（待出库）：全部行扫满、打包已绑定
  { id: 'sl-b1', shipmentOrderId: 'shp-b', lineNo: 1, lineKind: 'axis_item', materialId: 'm-0006', materialCode: 'YJV-3X70', salesOrderLineNo: '10', customerAxisNo: 'CAX-B-01', standardSegmentLength: '600.0000', actualSegmentLength: '601.2000', segmentLength: null, requiredCount: 1, scannedCount: 1, lineStatus: 'packed', packingStatus: null, packingOrderId: null },
  { id: 'sl-b2', shipmentOrderId: 'shp-b', lineNo: 2, lineKind: 'pallet', materialId: 'm-0006', materialCode: 'YJV-3X70', salesOrderLineNo: '10', customerAxisNo: null, standardSegmentLength: null, actualSegmentLength: null, segmentLength: null, requiredCount: 1, scannedCount: 1, lineStatus: 'packed', packingStatus: 'bound', packingOrderId: 'pk-b1' },
  // PL-C（已出库）：快照留痕
  { id: 'sl-c1', shipmentOrderId: 'shp-c', lineNo: 1, lineKind: 'axis_item', materialId: 'm-0006', materialCode: 'YJV-3X70', salesOrderLineNo: '10', customerAxisNo: 'CAX-C-01', standardSegmentLength: '1200.0000', actualSegmentLength: '1200.0000', segmentLength: null, requiredCount: 1, scannedCount: 1, lineStatus: 'packed', packingStatus: null, packingOrderId: null },
]

const packingScans: MockScan[] = [
  { id: 'scan-b1', shipmentOrderId: 'shp-b', shipmentLineId: 'sl-b1', scanKind: 'load', inventoryUnitId: 'su-ok-3', unitNo: 'SHPU-OK-003', customerAxisNo: 'CAX-B-01', actualSegmentLength: '601.2000', scannedBy: 'admin', scannedAt: '2026-10-28T01:20:00.000Z', deleted: false, deletedBy: null, deletedAt: null },
  { id: 'scan-b2', shipmentOrderId: 'shp-b', shipmentLineId: 'sl-b2', scanKind: 'load', inventoryUnitId: 'su-ok-2', unitNo: 'SHPU-OK-002', customerAxisNo: null, actualSegmentLength: null, scannedBy: 'admin', scannedAt: '2026-10-28T01:22:00.000Z', deleted: false, deletedBy: null, deletedAt: null },
  { id: 'scan-c1', shipmentOrderId: 'shp-c', shipmentLineId: 'sl-c1', scanKind: 'load', inventoryUnitId: 'su-ok-4', unitNo: 'SHPU-OK-004', customerAxisNo: 'CAX-C-01', actualSegmentLength: '1200.0000', scannedBy: 'admin', scannedAt: '2026-10-27T08:10:00.000Z', deleted: false, deletedBy: null, deletedAt: null },
]

const packingOrders: MockPacking[] = [
  { id: 'pk-b1', packingNo: 'PK-1028B01', shipmentOrderId: 'shp-b', palletCode: 'PLT-2026-B01', toLocationId: 'loc-01030001', toLocationCode: '01030001', status: 'bound', boundBy: 'admin', boundAt: '2026-10-28T01:30:00.000Z' },
]

const shipmentPhotos: MockPhoto[] = [
  { id: 'ph-c1', shipmentOrderId: 'shp-c', fileName: 'PL-2026-1027-009-装箱图.jpg', storageKey: 'shipping/PL-2026-1027-009/pallet-01.jpg', contentType: 'image/jpeg', sizeBytes: 248_512, uploadedBy: 'admin', uploadedAt: '2026-10-27T08:15:00.000Z' },
]

const dcCompositions: MockDcComposition[] = [
  { id: 'dcc-1', dcId: 'DC-2026-1028-01', salesOrderNo: 'SO-2026-1028-SHIP', lineNo: 10, syncStatus: 'received', composition: { segmentLength: '600.0000', segmentQty: 2, packingPlan: 'PLT-01' }, missingMarkedAt: null },
  { id: 'dcc-2', dcId: 'DC-2026-1027-09', salesOrderNo: 'SO-2026-1027-SHIP', lineNo: 10, syncStatus: 'received', composition: { segmentLength: '1200.0000', segmentQty: 1 }, missingMarkedAt: null },
]

const SHIP_PL_STATUS_LABELS: Record<string, string> = { pending_packing: '待装箱', ready_to_ship: '待出库', shipped: '已出库' }
const SHIP_LINE_STATUS_LABELS: Record<string, string> = { pending_packing: '待装箱', packed: '已装箱' }
const SHIP_PACKING_LABELS: Record<string, string> = { pending: '待打包', bound: '已绑定', cancelled: '已取消' }
const SHIP_AXIS_LABELS: Record<string, string> = { pending: '待同步', synced: '已同步', sync_failed: '同步失败', noop_needed: '无需同步' }
const SHIP_STATUS_SYNC_LABELS: Record<string, string> = { pending: '待同步', synced: '已同步', sync_failed: '同步失败' }

function toShipmentOrderView(s: MockShipment): ShipmentOrderDto {
  return {
    orderId: s.id,
    plNo: s.plNo,
    salesOrderNo: s.salesOrderNo,
    customerName: s.customerName,
    status: s.status,
    statusLabel: SHIP_PL_STATUS_LABELS[s.status] ?? s.status,
    compositionMissing: s.compositionMissing,
    outboundBy: s.outboundBy,
    outboundAt: s.outboundAt,
    actualAxisSyncStatus: s.actualAxisSyncStatus,
    actualAxisSyncStatusLabel: SHIP_AXIS_LABELS[s.actualAxisSyncStatus] ?? s.actualAxisSyncStatus,
    shippingStatusSyncStatus: s.shippingStatusSyncStatus,
    shippingStatusSyncStatusLabel: SHIP_STATUS_SYNC_LABELS[s.shippingStatusSyncStatus] ?? s.shippingStatusSyncStatus,
    actualAxisSnapshot: s.actualAxisSnapshot,
    statusSyncSnapshot: s.statusSyncSnapshot,
    plantId: 'n-plant',
    createdAt: s.createdAt,
  }
}

function toShipmentLineView(l: MockShipmentLine): ShipmentLineDto {
  return {
    lineId: l.id,
    lineNo: l.lineNo,
    lineKind: l.lineKind,
    materialId: l.materialId,
    materialCode: l.materialCode,
    salesOrderLineNo: l.salesOrderLineNo,
    customerAxisNo: l.customerAxisNo,
    standardSegmentLength: l.standardSegmentLength,
    actualSegmentLength: l.actualSegmentLength,
    segmentLength: l.segmentLength,
    requiredCount: l.requiredCount,
    scannedCount: l.scannedCount,
    lineStatus: l.lineStatus,
    lineStatusLabel: SHIP_LINE_STATUS_LABELS[l.lineStatus] ?? l.lineStatus,
    packingStatus: l.packingStatus,
    packingOrderId: l.packingOrderId,
  }
}

function toPackingScanView(x: MockScan) {
  return {
    scanId: x.id,
    shipmentLineId: x.shipmentLineId,
    scanKind: x.scanKind,
    inventoryUnitId: x.inventoryUnitId,
    unitNo: x.unitNo,
    customerAxisNo: x.customerAxisNo,
    actualSegmentLength: x.actualSegmentLength,
    scannedBy: x.scannedBy,
    scannedAt: x.scannedAt,
    deleted: x.deleted,
    deletedBy: x.deletedBy,
    deletedAt: x.deletedAt,
  }
}

function toPackingOrderView(po: MockPacking): PackingOrderDto {
  const lines = shipmentLines.filter((l) => l.packingOrderId === po.id)
  return {
    packingId: po.id,
    packingNo: po.packingNo,
    shipmentOrderId: po.shipmentOrderId,
    palletCode: po.palletCode,
    toLocationId: po.toLocationId,
    toLocationCode: po.toLocationCode,
    status: po.status,
    statusLabel: SHIP_PACKING_LABELS[po.status] ?? po.status,
    boundBy: po.boundBy,
    boundAt: po.boundAt,
    lines: lines.map((l) => ({ lineId: l.id, lineNo: l.lineNo, materialCode: l.materialCode, requiredCount: l.requiredCount, scannedCount: l.scannedCount, lineStatus: l.lineStatus })),
    plantId: 'n-plant',
  }
}

/** mock 行与单的归属（mock 无外键，按行内 shipmentOrderId 过滤） */
function shipmentLinesByOrder(orderId: string): MockShipmentLine[] {
  return shipmentLines.filter((l) => l.shipmentOrderId === orderId)
}

/** mock 单状态重推（deriveOrderStatus 同口径：全部行扫满→待出库） */
function deriveShipmentStatus(orderId: string): 'pending_packing' | 'ready_to_ship' {
  const lines = shipmentLinesByOrder(orderId)
  return lines.length > 0 && lines.every((l) => l.lineStatus === 'packed') ? 'ready_to_ship' : 'pending_packing'
}

function toShipmentDetailView(s: MockShipment): ShipmentOrderDetailDto {
  return {
    ...toShipmentOrderView(s),
    lines: shipmentLinesByOrder(s.id).map(toShipmentLineView),
    scans: packingScans.filter((x) => x.shipmentOrderId === s.id).map(toPackingScanView),
    packings: packingOrders.filter((p) => p.shipmentOrderId === s.id).map(toPackingOrderView),
    photos: shipmentPhotos
      .filter((p) => p.shipmentOrderId === s.id)
      .map((p) => ({ photoId: p.id, fileName: p.fileName, storageKey: p.storageKey, contentType: p.contentType, sizeBytes: p.sizeBytes, uploadedBy: p.uploadedBy, uploadedAt: p.uploadedAt })),
  }
}

function handleLogin(body: LoginRequest): LoginResponse {
  const loginName = body?.loginName?.trim() ?? ''
  const password = body?.password ?? ''
  const ok = loginName === MOCK_DEMO_ACCOUNT && password === MOCK_DEMO_PASSWORD
  if (!ok) {
    const fails = (loginFailureCounts.get(loginName) ?? 0) + 1
    loginFailureCounts.set(loginName, fails)
    if (fails >= MOCK_LOGIN_LOCK_THRESHOLD) {
      throw new MockError({
        httpStatus: 401,
        code: 'ERR_AUTH_REQUIRED',
        message: `连续失败 ${fails} 次，该账号已临时锁定；请联系管理员解封后再试`,
        details: { lockedUntilRetry: fails + 3 },
      })
    }
    throw new MockError({
      httpStatus: 401,
      code: 'ERR_AUTH_REQUIRED',
      message: '账号或密码错误（演示账号 admin / Cz123456）',
      details: { remainingAttempts: MOCK_LOGIN_LOCK_THRESHOLD - fails },
    })
  }
  loginFailureCounts.delete(loginName)
  return {
    token: `mock-token-${Date.now().toString(36)}`,
    tokenType: 'Bearer',
    expiresAt: new Date(Date.now() + 720 * 60_000).toISOString(),
    user: { userId: 'user-s-1', loginName: 'admin' },
  }
}

/** mock 失败计数重置（测试用） */
export function resetMockLoginState(): void {
  loginFailureCounts.clear()
}

export interface MockHandlerContext {
  query: URLSearchParams
  body: unknown
  token: string | null
  meta?: CommandMeta
  params: Record<string, string>
}

export type MockHandler = (ctx: MockHandlerContext) => unknown

interface MockRouteDef {
  method: string
  pattern: RegExp
  keys: string[]
  handler: MockHandler
}

function okCommand(data: unknown, meta?: CommandMeta): Record<string, unknown> {
  return {
    operationId: meta?.operationId ?? `mock-op-${Math.random().toString(36).slice(2, 10)}`,
    status: 'COMMITTED',
    data,
  }
}

function requireReason(meta: CommandMeta | undefined, rule: string): void {
  if (!meta?.reason || !meta.reason.trim()) {
    throw new MockError({
      httpStatus: 422,
      code: 'ERR_BUSINESS_RULE',
      message: `[${rule}] 高影响操作必须填写原因（reason/x-reason，OA-29）`,
      details: {},
    })
  }
}

const routes: MockRouteDef[] = [
  // ---------------- auth ----------------
  {
    method: 'POST',
    pattern: /^\/auth\/login$/,
    keys: [],
    handler: ({ body }) => handleLogin(body as LoginRequest),
  },
  {
    method: 'POST',
    pattern: /^\/auth\/logout$/,
    keys: [],
    handler: ({ token }) => {
      if (!token || !mockSessionTokens.has(token)) {
        throw new MockError({ httpStatus: 401, code: 'ERR_AUTH_REQUIRED', message: '会话无效或已过期', details: {} })
      }
      mockSessionTokens.delete(token)
      return { ok: true, sessionId: 'mock-session-1' }
    },
  },
  {
    method: 'GET',
    pattern: /^\/auth\/me$/,
    keys: [],
    handler: ({ token }): AuthMeResponse => {
      if (!token || !mockSessionTokens.has(token)) {
        throw new MockError({ httpStatus: 401, code: 'ERR_AUTH_REQUIRED', message: '会话无效或已过期', details: {} })
      }
      return {
        user: {
          userId: 'user-s-1',
          loginName: 'admin',
          displayName: '系统管理员',
          enterpriseId: 'n-ent',
          enterpriseName: '中辰线缆集团',
          plantId: 'n-plant',
          plantName: '杭州制造工厂',
          roleId: 'role-admin',
          roleName: '系统管理员',
          loginPlatform: 'WEB',
        },
        permissions: [
          'org.read',
          'org.admin',
          'org.role.admin',
          'masterdata.read',
          'masterdata.admin',
          'inventory.read',
          'inventory.post',
          'inventory.reserve',
          'shipping.read',
          'shipping.post',
        ],
        dataScope: { enterpriseWide: true, plantIds: ['n-plant'] },
        session: { id: 'mock-session-1', expiresAt: new Date(Date.now() + 720 * 60_000).toISOString() },
      }
    },
  },
  // ---------------- 机构 ----------------
  {
    method: 'GET',
    pattern: /^\/org\/nodes$/,
    keys: [],
    handler: ({ query }) => {
      const kind = query.get('kind')
      const plantId = query.get('plantId')
      let list = orgNodes.filter((n) => n.status === 'active')
      if (kind) list = list.filter((n) => n.kind === kind)
      if (plantId) {
        const under = (id: string): boolean => {
          const node = orgNodes.find((n) => n.id === id)
          return node != null && (node.id === plantId || node.path.includes(`/${plantId}/`))
        }
        list = list.filter((n) => under(n.id))
      }
      return paginate([...list].sort((a, b) => a.path.localeCompare(b.path)), query)
    },
  },
  {
    method: 'POST',
    pattern: /^\/org\/nodes$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const code = typeof p['code'] === 'string' ? p['code'] : ''
      const name = typeof p['name'] === 'string' ? p['name'] : ''
      const kind = typeof p['kind'] === 'string' ? p['kind'] : ''
      if (!code || !name || !kind) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: 'payload 需要 code/name/kind', details: {} })
      }
      if (orgNodes.some((n) => n.status === 'active' && n.code === code)) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[OA-01] 机构编码已存在：${code}`, details: {} })
      }
      if (orgNodes.some((n) => n.status === 'active' && n.name === name)) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[OA-01] 机构名称已存在：${name}`, details: {} })
      }
      const parentId = typeof p['parentId'] === 'string' ? p['parentId'] : null
      const parent = parentId ? orgNodes.find((n) => n.id === parentId) : null
      if (parentId && !parent) {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '上级机构不存在', details: {} })
      }
      const id = `n-mock-${Math.random().toString(36).slice(2, 8)}`
      orgNodes.push({
        id,
        kind,
        code,
        name,
        parentId,
        parentKind: parent?.kind ?? null,
        path: `${parent ? parent.path : '/'}${id}/`,
        depth: (parent?.depth ?? -1) + 1,
        plantCode: typeof p['plantCode'] === 'string' ? p['plantCode'] : null,
        companyOrgCode: typeof p['companyOrgCode'] === 'string' ? p['companyOrgCode'] : null,
        deptCategory: typeof p['deptCategory'] === 'number' ? p['deptCategory'] : null,
        status: 'active',
      })
      return okCommand({ nodeId: id, code }, meta)
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/org\/nodes\/([^/]+)$/,
    keys: ['id'],
    handler: ({ params, body, meta }) => {
      const node = orgNodes.find((n) => n.id === params['id'])
      if (!node || node.status !== 'active') {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '机构不存在', details: {} })
      }
      const p = (body ?? {}) as Record<string, unknown>
      if (typeof p['name'] === 'string' && p['name'] !== node.name) {
        if (orgNodes.some((n) => n.status === 'active' && n.name === p['name'] && n.id !== node.id)) {
          throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[OA-01] 机构名称已存在：${String(p['name'])}`, details: {} })
        }
        node.name = p['name']
      }
      if ('plantCode' in p) node.plantCode = typeof p['plantCode'] === 'string' ? p['plantCode'] : null
      if ('companyOrgCode' in p) node.companyOrgCode = typeof p['companyOrgCode'] === 'string' ? p['companyOrgCode'] : null
      if ('deptCategory' in p) node.deptCategory = typeof p['deptCategory'] === 'number' ? p['deptCategory'] : null
      return okCommand({ nodeId: node.id }, meta)
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/org\/nodes\/([^/]+)$/,
    keys: ['id'],
    handler: ({ params, meta }) => {
      requireReason(meta, 'OA-29')
      const node = orgNodes.find((n) => n.id === params['id'])
      if (!node || node.status !== 'active') {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '机构不存在', details: {} })
      }
      // OA-05：子树挂用户不可删（mock 口径）
      const inSubtree = users.filter((u) => u.status === 'active' && orgNodes.some((n) => n.id === u.deptId && n.path.startsWith(node.path)))
      if (inSubtree.length > 0) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[OA-05] 本机构或其下级机构仍挂有用户，不可删除', details: {} })
      }
      const affected = orgNodes.filter((n) => n.path.startsWith(node.path)).length
      for (const n of orgNodes) if (n.path.startsWith(node.path)) n.status = 'retired'
      return okCommand({ nodeId: node.id, affectedNodes: affected }, meta)
    },
  },
  // ---------------- 用户 ----------------
  {
    method: 'GET',
    pattern: /^\/org\/users$/,
    keys: [],
    handler: ({ query }) => {
      const like = (query.get('loginNameLike') ?? '').trim()
      const plantId = query.get('plantId')
      let list = users.filter((u) => u.status === 'active')
      if (like) list = list.filter((u) => u.loginName.includes(like))
      if (plantId) list = list.filter((u) => u.plantId === plantId)
      return paginate(list, query)
    },
  },
  {
    method: 'POST',
    pattern: /^\/org\/users$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const loginName = typeof p['loginName'] === 'string' ? p['loginName'] : ''
      const password = typeof p['password'] === 'string' ? p['password'] : ''
      if (!loginName || !password) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: 'payload 需要 loginName/password/displayName/deptId/roleId/loginPlatform', details: {} })
      }
      if (users.some((u) => u.status === 'active' && u.loginName === loginName)) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[OA-10] 登录账号已存在：${loginName}`, details: {} })
      }
      if (!/^(?=.*[A-Za-z])(?=.*\d).{8,16}$/.test(password)) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[OA-14] 密码须 8–16 位且同时包含数字与字母', details: {} })
      }
      const deptId = typeof p['deptId'] === 'string' ? p['deptId'] : ''
      const dept = orgNodes.find((n) => n.id === deptId && n.kind === 'department' && n.status === 'active')
      if (!dept) {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '所属部门不存在或不是部门节点', details: {} })
      }
      if (dept.deptCategory === 2 && !p['workshopDeptId']) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[OA-13] 所属部门为质检部（deptCategory=2）时车间部门必填（服务端强制，GAP-A5 待裁定口径）', details: {} })
      }
      const roleId = typeof p['roleId'] === 'string' ? p['roleId'] : ''
      if (!roleSeed.some((r) => r.id === roleId && r.status === 'active')) {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '所属角色不存在或不属于本企业', details: {} })
      }
      const created = mkUser(
        `user-mock-${Math.random().toString(36).slice(2, 8)}`,
        loginName,
        typeof p['displayName'] === 'string' ? p['displayName'] : loginName,
        deptId,
        roleId,
        p['loginPlatform'] === 'WEB' ? 'WEB' : 'PDA',
        p['accountStatus'] === 'disabled' ? 'disabled' : 'enabled',
        typeof p['workshopDeptId'] === 'string' ? p['workshopDeptId'] : null,
      )
      users.push(created)
      return okCommand({ userId: created.id, loginName }, meta)
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/org\/users\/([^/]+)$/,
    keys: ['id'],
    handler: ({ params, body, meta }) => {
      const user = users.find((u) => u.id === params['id'])
      if (!user || user.status !== 'active') {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '用户不存在', details: {} })
      }
      const p = (body ?? {}) as Record<string, unknown>
      if (typeof p['displayName'] === 'string') user.displayName = p['displayName']
      if (typeof p['roleId'] === 'string') user.roleId = p['roleId']
      if (p['loginPlatform'] === 'WEB' || p['loginPlatform'] === 'PDA') user.loginPlatform = p['loginPlatform']
      if (p['accountStatus'] === 'enabled' || p['accountStatus'] === 'disabled') user.accountStatus = p['accountStatus']
      if ('phone' in p) user.phone = typeof p['phone'] === 'string' ? p['phone'] : null
      if (typeof p['deptId'] === 'string') user.deptId = p['deptId']
      if ('workshopDeptId' in p) user.workshopDeptId = typeof p['workshopDeptId'] === 'string' ? p['workshopDeptId'] : null
      return okCommand({ userId: user.id }, meta)
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/org\/users\/([^/]+)$/,
    keys: ['id'],
    handler: ({ params, meta }) => {
      const user = users.find((u) => u.id === params['id'])
      if (!user || user.status !== 'active') {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '用户不存在', details: {} })
      }
      user.status = 'retired'
      return okCommand({ userId: user.id }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/org\/users\/([^/]+)\/reset-password$/,
    keys: ['id'],
    handler: ({ params, body, meta }) => {
      const user = users.find((u) => u.id === params['id'])
      if (!user || user.status !== 'active') {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '用户不存在', details: {} })
      }
      const p = (body ?? {}) as Record<string, unknown>
      const explicit = typeof p['password'] === 'string' ? p['password'] : undefined
      if (explicit !== undefined && !/^(?=.*[A-Za-z])(?=.*\d).{8,16}$/.test(explicit)) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[OA-14] 密码须 8–16 位且同时包含数字与字母', details: {} })
      }
      return okCommand({ userId: user.id, mode: explicit !== undefined ? 'explicit-compliant' : 'account.initPassword' }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/org\/users\/([^/]+)\/unlock$/,
    keys: ['id'],
    handler: ({ params, meta }) => {
      const user = users.find((u) => u.id === params['id'])
      if (!user || user.status !== 'active') {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '用户不存在', details: {} })
      }
      user.failedLoginCount = 0
      user.lockedUntil = null
      loginFailureCounts.delete(user.loginName)
      return okCommand({ userId: user.id }, meta)
    },
  },
  // ---------------- 角色 ----------------
  {
    method: 'GET',
    pattern: /^\/org\/roles$/,
    keys: [],
    handler: ({ query }) => {
      const includeRetired = query.get('includeRetired') === 'true'
      const list = roleSeed.filter((r) => includeRetired || r.status === 'active')
      return paginate(list, query)
    },
  },
  {
    method: 'POST',
    pattern: /^\/org\/roles$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const name = typeof p['name'] === 'string' ? p['name'] : ''
      const alias = typeof p['alias'] === 'string' ? p['alias'] : ''
      const sort = typeof p['sort'] === 'number' ? p['sort'] : undefined
      if (!name || !alias || sort === undefined) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: 'payload 需要 name/alias/sort', details: {} })
      }
      const conflict = roleSeed.find((r) => r.status === 'active' && (r.name === name || r.alias === alias || r.sort === sort))
      if (conflict) {
        throw new MockError({
          httpStatus: 422,
          code: 'ERR_BUSINESS_RULE',
          message: `[OA-17] 角色名称/别名/排序与既有角色冲突（${conflict.name} / ${conflict.alias} / sort=${conflict.sort}）`,
          details: {},
        })
      }
      const created: RoleDto = {
        id: `role-mock-${Math.random().toString(36).slice(2, 8)}`,
        name,
        alias,
        sort,
        isSystem: 1,
        parentRoleId: null,
        status: 'active',
      }
      roleSeed.push(created)
      return okCommand({ roleId: created.id }, meta)
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/org\/roles\/([^/]+)$/,
    keys: ['id'],
    handler: ({ params, body, meta }) => {
      const role = roleSeed.find((r) => r.id === params['id'])
      if (!role || role.status !== 'active') {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '角色不存在或不属于本企业', details: {} })
      }
      const p = (body ?? {}) as Record<string, unknown>
      if (role.isSystem === 2 && typeof p['alias'] === 'string' && p['alias'] !== role.alias) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[OA-18] 内置角色不可修改别名', details: {} })
      }
      if (typeof p['name'] === 'string') role.name = p['name']
      if (typeof p['alias'] === 'string') role.alias = p['alias']
      if (typeof p['sort'] === 'number') role.sort = p['sort']
      return okCommand({ roleId: role.id }, meta)
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/org\/roles\/([^/]+)$/,
    keys: ['id'],
    handler: ({ params, meta }) => {
      const role = roleSeed.find((r) => r.id === params['id'])
      if (!role || role.status !== 'active') {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '角色不存在或不属于本企业', details: {} })
      }
      if (role.isSystem === 2) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[OA-18] 内置角色不可删除', details: {} })
      }
      if (users.some((u) => u.status === 'active' && u.roleId === role.id)) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[OA-19] 已关联用户的角色不可删除', details: {} })
      }
      role.status = 'retired'
      return okCommand({ roleId: role.id }, meta)
    },
  },
  // ---------------- 授权 ----------------
  {
    method: 'GET',
    pattern: /^\/org\/grants$/,
    keys: [],
    handler: ({ query }) => {
      const principalType = query.get('principalType')
      const principalId = query.get('principalId')
      const includeRetired = query.get('includeRetired') === 'true'
      let list = grants.filter((g) => includeRetired || g.status === 'active')
      if (principalType === 'role' || principalType === 'user') list = list.filter((g) => g.principalType === principalType)
      if (principalId) list = list.filter((g) => g.principalId === principalId)
      return paginate(list, query)
    },
  },
  {
    method: 'POST',
    pattern: /^\/org\/grants\/revoke$/,
    keys: [],
    handler: ({ body, meta }) => {
      requireReason(meta, 'OA-29')
      return handleGrantBody(body, meta, 'revoke')
    },
  },
  {
    method: 'POST',
    pattern: /^\/org\/grants$/,
    keys: [],
    handler: ({ body, meta }) => {
      requireReason(meta, 'OA-29')
      return handleGrantBody(body, meta, 'grant')
    },
  },
  // ---------------- 主数据：料品（只读 MD-01/02）与换算行（MD-04/05） ----------------
  {
    method: 'GET',
    pattern: /^\/masterdata\/materials$/,
    keys: [],
    handler: ({ query }) => {
      const nameLike = (query.get('nameLike') ?? '').trim()
      const codeLike = (query.get('codeLike') ?? '').trim()
      let list = activeOnly(materials)
      if (nameLike) list = list.filter((m) => m.name.includes(nameLike))
      if (codeLike) list = list.filter((m) => m.code.includes(codeLike))
      return paginate(list, query)
    },
  },
  {
    method: 'GET',
    pattern: /^\/masterdata\/materials\/([^/]+)\/conversions$/,
    keys: ['id'],
    handler: ({ params }) => {
      const material = materials.find((m) => m.id === params['id'] && m.status === 'active') ?? null
      return { material, items: activeOnly(conversions).filter((c) => c.materialId === params['id']) }
    },
  },
  {
    method: 'POST',
    pattern: /^\/masterdata\/conversions$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const materialId = typeof p['materialId'] === 'string' ? p['materialId'] : ''
      const unitName = typeof p['unitName'] === 'string' ? p['unitName'] : ''
      const factor = typeof p['factor'] === 'string' ? p['factor'] : ''
      if (!materialId || !unitName || !factor) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: 'payload 需要 materialId/unitName/factor', details: {} })
      }
      if (!materials.some((m) => m.id === materialId && m.status === 'active')) {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '料品不存在或不属于本企业', details: {} })
      }
      if (unitName.length === 0 || unitName.length > 100 || !/^\d+(\.\d+)?$/.test(factor.trim()) || factor.trim().split('.')[0]!.length > 9 || (factor.includes('.') && factor.split('.')[1]!.length > 4)) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[MD-04] 换算数量须为非负数字（整数≤9 位、小数≤4 位），单位名必填且最长 100 字符', details: {} })
      }
      const version = activeOnly(conversions).filter((c) => c.materialId === materialId).length + 1
      const line: ConversionLineDto = {
        id: `cv-mock-${Math.random().toString(36).slice(2, 8)}`,
        materialId,
        version,
        unitName,
        factor: factor.trim(),
        referenced: false,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      }
      conversions.push(line)
      return okCommand({ conversionId: line.id, version }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/masterdata\/conversions\/([^/]+)\/new-version$/,
    keys: ['id'],
    handler: ({ params, body, meta }) => {
      const line = conversions.find((c) => c.id === params['id'] && c.status === 'active')
      if (!line) {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '换算行不存在', details: {} })
      }
      const p = (body ?? {}) as Record<string, unknown>
      const factor = typeof p['factor'] === 'string' ? p['factor'] : ''
      if (!/^\d+(\.\d+)?$/.test(factor.trim())) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[MD-04] 换算数量须为非负数字', details: {} })
      }
      const version = activeOnly(conversions).filter((c) => c.materialId === line.materialId).length + 1
      const created: ConversionLineDto = {
        id: `cv-mock-${Math.random().toString(36).slice(2, 8)}`,
        materialId: line.materialId,
        version,
        unitName: typeof p['unitName'] === 'string' && p['unitName'] ? p['unitName'] : line.unitName,
        factor: factor.trim(),
        referenced: false,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      }
      conversions.push(created)
      return okCommand({ conversionId: created.id, version }, meta)
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/masterdata\/conversions\/([^/]+)$/,
    keys: ['id'],
    handler: ({ params, body, meta }) => {
      const line = conversions.find((c) => c.id === params['id'] && c.status === 'active')
      if (!line) {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '换算行不存在', details: {} })
      }
      if (line.referenced) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[MD-05] 换算行已被采购收货引用，不可修改或删除；如需变更请生成新版本', details: {} })
      }
      const p = (body ?? {}) as Record<string, unknown>
      if (typeof p['unitName'] === 'string' && p['unitName']) line.unitName = p['unitName']
      if (typeof p['factor'] === 'string' && p['factor']) {
        if (!/^\d+(\.\d+)?$/.test(p['factor'].trim())) {
          throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[MD-04] 换算数量须为非负数字', details: {} })
        }
        line.factor = p['factor'].trim()
      }
      return okCommand({ conversionId: line.id }, meta)
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/masterdata\/conversions\/([^/]+)$/,
    keys: ['id'],
    handler: ({ params, meta }) => {
      const line = conversions.find((c) => c.id === params['id'] && c.status === 'active')
      if (!line) {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '换算行不存在', details: {} })
      }
      if (line.referenced) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[MD-05] 换算行已被采购收货引用，不可修改或删除', details: {} })
      }
      line.status = 'retired'
      return okCommand({ conversionId: line.id }, meta)
    },
  },
  // ---------------- 主数据：设备（MD-09～16） ----------------
  {
    method: 'GET',
    pattern: /^\/masterdata\/equipment$/,
    keys: [],
    handler: ({ query }) => {
      const nameLike = (query.get('nameLike') ?? '').trim()
      const codeLike = (query.get('codeLike') ?? '').trim()
      let list = activeOnly(equipment)
      if (nameLike) list = list.filter((e) => e.name.includes(nameLike))
      if (codeLike) list = list.filter((e) => e.code.includes(codeLike))
      return paginate(list, query)
    },
  },
  {
    method: 'GET',
    pattern: /^\/masterdata\/equipment\/([^/]+)\/status-logs$/,
    keys: ['id'],
    handler: ({ params }) => equipmentStatusLogs.filter((l) => l.equipmentId === params['id']),
  },
  {
    method: 'POST',
    pattern: /^\/masterdata\/equipment$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const code = typeof p['code'] === 'string' ? p['code'] : ''
      const name = typeof p['name'] === 'string' ? p['name'] : ''
      const deptId = typeof p['deptId'] === 'string' ? p['deptId'] : ''
      const workCenterId = typeof p['workCenterId'] === 'string' ? p['workCenterId'] : ''
      const equipmentStatus = typeof p['equipmentStatus'] === 'number' ? p['equipmentStatus'] : undefined
      if (!code || !name || !deptId || !workCenterId || equipmentStatus === undefined) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: 'payload 需要 code/name/deptId/workCenterId/equipmentStatus', details: {} })
      }
      if (equipmentStatus !== 1 && equipmentStatus !== 2) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[MD-13] 设备状态仅支持：1=正常、2=维修', details: {} })
      }
      if (code.toUpperCase().startsWith('EQU-')) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[MD-15] 设备编码不得自带 EQU- 前缀', details: {} })
      }
      if (activeOnly(equipment).some((e) => e.code === code)) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[MD-09] 设备编码重复', details: {} })
      }
      if (activeOnly(equipment).some((e) => e.name === name)) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[MD-09] 设备名称重复', details: {} })
      }
      const wc = workCenters.find((w) => w.id === workCenterId && w.status === 'active')
      if (!wc) {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '工作中心不存在或不属于本企业', details: {} })
      }
      if (wc.deptId !== deptId) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[MD-10] 设备所属部门必须与其所属工作中心的部门一致', details: {} })
      }
      const created: EquipmentDto = {
        id: `eq-mock-${Math.random().toString(36).slice(2, 8)}`,
        plantId: 'n-plant',
        deptId,
        workCenterId,
        code,
        name,
        actualNo: typeof p['actualNo'] === 'string' ? p['actualNo'] : null,
        model: typeof p['model'] === 'string' ? p['model'] : null,
        stdRateText: typeof p['stdRateText'] === 'string' ? p['stdRateText'] : null,
        equipmentStatus,
        capacity: typeof p['capacity'] === 'string' ? p['capacity'] : null,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      }
      equipment.push(created)
      return okCommand({ equipmentId: created.id, equipmentQrCode: `EQU-${code}` }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/masterdata\/equipment\/([^/]+)\/change-status$/,
    keys: ['id'],
    handler: ({ params, body, meta }) => {
      const eq = equipment.find((e) => e.id === params['id'] && e.status === 'active')
      if (!eq) {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '设备不存在或不属于本企业', details: {} })
      }
      const p = (body ?? {}) as Record<string, unknown>
      const next = typeof p['equipmentStatus'] === 'number' ? p['equipmentStatus'] : undefined
      const source = typeof p['source'] === 'string' ? p['source'] : 'WEB'
      if (next === undefined) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: 'payload 需要 equipmentStatus', details: {} })
      }
      if (next !== 1 && next !== 2) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[MD-13] 设备状态仅支持：1=正常、2=维修', details: {} })
      }
      if (source !== 'WEB' && source !== 'PDA') {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[MD-14] 状态变化来源须为 WEB/PDA', details: {} })
      }
      const journaled = next !== eq.equipmentStatus
      if (journaled) {
        equipmentStatusLogs.unshift({
          id: `eqlog-mock-${Math.random().toString(36).slice(2, 8)}`,
          equipmentId: eq.id,
          oldStatus: eq.equipmentStatus,
          newStatus: next,
          source,
          actor: 'admin',
          createdAt: now,
        })
        eq.equipmentStatus = next
      }
      return okCommand({ equipmentId: eq.id, journaled }, meta)
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/masterdata\/equipment\/([^/]+)$/,
    keys: ['id'],
    handler: ({ params, body, meta }) => {
      const eq = equipment.find((e) => e.id === params['id'] && e.status === 'active')
      if (!eq) {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '设备不存在或不属于本企业', details: {} })
      }
      const p = (body ?? {}) as Record<string, unknown>
      if (typeof p['name'] === 'string' && p['name'] !== eq.name) {
        if (activeOnly(equipment).some((e) => e.name === p['name'] && e.id !== eq.id)) {
          throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[MD-09] 设备名称重复', details: {} })
        }
        eq.name = p['name']
      }
      if (typeof p['capacity'] === 'string') eq.capacity = p['capacity']
      if (typeof p['actualNo'] === 'string') eq.actualNo = p['actualNo']
      if (typeof p['model'] === 'string') eq.model = p['model']
      if (typeof p['stdRateText'] === 'string') eq.stdRateText = p['stdRateText']
      return okCommand({ equipmentId: eq.id }, meta)
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/masterdata\/equipment\/([^/]+)$/,
    keys: ['id'],
    handler: ({ params, meta }) => {
      const eq = equipment.find((e) => e.id === params['id'] && e.status === 'active')
      if (!eq) {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '设备不存在或不属于本企业', details: {} })
      }
      eq.status = 'retired'
      return okCommand({ equipmentId: eq.id }, meta)
    },
  },
  // ---------------- 主数据：仓库（MD-22～27，MD-24 部门类型约束服务端终校） ----------------
  {
    method: 'GET',
    pattern: /^\/masterdata\/warehouses$/,
    keys: [],
    handler: ({ query }) => {
      const nameLike = (query.get('nameLike') ?? '').trim()
      let list = activeOnly(warehouses)
      if (nameLike) list = list.filter((w) => w.name.includes(nameLike))
      return paginate(list, query)
    },
  },
  {
    method: 'POST',
    pattern: /^\/masterdata\/warehouses$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const code = typeof p['code'] === 'string' ? p['code'] : ''
      const name = typeof p['name'] === 'string' ? p['name'] : ''
      const deptId = typeof p['deptId'] === 'string' ? p['deptId'] : ''
      const warehouseType = typeof p['warehouseType'] === 'string' ? p['warehouseType'] : ''
      const materialTypes = Array.isArray(p['materialTypes']) && p['materialTypes'].every((x) => typeof x === 'number') ? (p['materialTypes'] as number[]) : undefined
      if (!code || !name || !deptId || !warehouseType || !materialTypes) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: 'payload 需要 code/name/deptId/warehouseType/materialTypes', details: {} })
      }
      if (!/^\d{4}$/.test(code)) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[MD-22] 仓库编码必须为 4 位数字', details: {} })
      }
      if (name.length === 0 || name.length > 20) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[MD-22] 仓库名称必填且最长 20 字符', details: {} })
      }
      if (warehouseType !== 'WAREHOUSE' && warehouseType !== 'LINE_SIDE') {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '仓库类型须为 WAREHOUSE/LINE_SIDE', details: {} })
      }
      const allowed = ALLOWED_MATERIAL_TYPES_BY_WAREHOUSE_TYPE[warehouseType as 'WAREHOUSE' | 'LINE_SIDE']
      if (materialTypes.length === 0 || materialTypes.some((t) => !allowed.includes(t))) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[MD-23] 料品类型不在仓库类型 ${warehouseType} 允许范围内（且至少一种）`, details: {} })
      }
      const dept = orgNodes.find((n) => n.id === deptId && n.kind === 'department' && n.status === 'active')
      if (!dept) {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '所属部门不存在或不是部门节点', details: {} })
      }
      const deptAllowed = deptAllowedWarehouseTypes(dept.deptCategory)
      if (deptAllowed !== undefined && !deptAllowed.includes(warehouseType as 'WAREHOUSE' | 'LINE_SIDE')) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[MD-24] 该部门类型仅允许创建${deptAllowed.map((t) => (t === 'WAREHOUSE' ? '仓库' : '线边仓')).join('/')}`, details: {} })
      }
      if (activeOnly(warehouses).some((w) => w.code === code)) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[MD-22] 同一工厂下仓库编码不能重复', details: {} })
      }
      if (activeOnly(warehouses).some((w) => w.name === name)) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[MD-22] 仓库名称全局不能重复', details: {} })
      }
      const created: WarehouseDto = {
        id: `wh-mock-${Math.random().toString(36).slice(2, 8)}`,
        plantId: 'n-plant',
        deptId,
        code,
        name,
        warehouseType: warehouseType as 'WAREHOUSE' | 'LINE_SIDE',
        materialTypes,
        managerUserId: typeof p['managerUserId'] === 'string' ? p['managerUserId'] : null,
        phone: typeof p['phone'] === 'string' ? p['phone'] : null,
        address: typeof p['address'] === 'string' ? p['address'] : null,
        qrBound: false,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      }
      warehouses.push(created)
      return okCommand({ warehouseId: created.id }, meta)
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/masterdata\/warehouses\/([^/]+)$/,
    keys: ['id'],
    handler: ({ params, body, meta }) => {
      const wh = warehouses.find((w) => w.id === params['id'] && w.status === 'active')
      if (!wh) {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '仓库不存在或不属于本企业', details: {} })
      }
      const p = (body ?? {}) as Record<string, unknown>
      if (wh.qrBound && (p['warehouseType'] !== undefined || p['materialTypes'] !== undefined)) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[MD-26] 仓库已被二维码占用，不允许修改仓库类型或料品类型', details: {} })
      }
      if (typeof p['name'] === 'string' && p['name'] && p['name'] !== wh.name) {
        if (activeOnly(warehouses).some((w) => w.name === p['name'] && w.id !== wh.id)) {
          throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[MD-22] 仓库名称全局不能重复', details: {} })
        }
        wh.name = p['name']
      }
      if (typeof p['materialTypes'] === 'object' && Array.isArray(p['materialTypes'])) wh.materialTypes = p['materialTypes'] as number[]
      if (typeof p['phone'] === 'string') wh.phone = p['phone']
      if (typeof p['address'] === 'string') wh.address = p['address']
      return okCommand({ warehouseId: wh.id }, meta)
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/masterdata\/warehouses\/([^/]+)$/,
    keys: ['id'],
    handler: ({ params, meta }) => {
      const wh = warehouses.find((w) => w.id === params['id'] && w.status === 'active')
      if (!wh) {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '仓库不存在或不属于本企业', details: {} })
      }
      if (wh.qrBound) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[MD-26] 仓库已被二维码占用，不可删除', details: {} })
      }
      let affected = 0
      for (const loc of locations) {
        if (loc.warehouseId === wh.id && loc.locationKind === 'NORMAL' && loc.status === 'active') {
          loc.status = 'retired'
          affected += 1
        }
      }
      wh.status = 'retired'
      return okCommand({ warehouseId: wh.id, affectedNormalLocations: affected }, meta)
    },
  },
  // ---------------- 主数据：普通库位（MD-28/29）与货架（MD-30/31/33） ----------------
  {
    method: 'GET',
    pattern: /^\/masterdata\/locations$/,
    keys: [],
    handler: ({ query }) => {
      const warehouseId = query.get('warehouseId')
      const codeLike = (query.get('codeLike') ?? '').trim()
      let list = activeOnly(locations)
      if (warehouseId) list = list.filter((l) => l.warehouseId === warehouseId)
      if (codeLike) list = list.filter((l) => l.code.includes(codeLike))
      return paginate(list, query)
    },
  },
  {
    method: 'POST',
    pattern: /^\/masterdata\/locations$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const warehouseId = typeof p['warehouseId'] === 'string' ? p['warehouseId'] : ''
      const code = typeof p['code'] === 'string' ? p['code'] : ''
      if (!warehouseId || !code) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: 'payload 需要 warehouseId/code', details: {} })
      }
      const wh = warehouses.find((w) => w.id === warehouseId && w.status === 'active')
      if (!wh) {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '所属仓库不存在或不属于本企业', details: {} })
      }
      if (!/^\d{8}$/.test(code) || !code.startsWith(wh.code)) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[MD-28] 普通库位编码必须为 8 位数字（仓库码 4 位 + 库位码 4 位），前缀须为 ${wh.code}`, details: {} })
      }
      if (activeOnly(locations).some((l) => l.code === code)) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[MD-28] 同一工厂下库位编码不能重复', details: {} })
      }
      const created: StorageLocationDto = {
        id: `loc-mock-${Math.random().toString(36).slice(2, 8)}`,
        plantId: 'n-plant',
        warehouseId,
        rackId: null,
        locationKind: 'NORMAL',
        code,
        zoneCode: null,
        remark: typeof p['remark'] === 'string' ? p['remark'] : null,
        qrBound: false,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      }
      locations.push(created)
      return okCommand({ locationId: created.id }, meta)
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/masterdata\/locations\/([^/]+)$/,
    keys: ['id'],
    handler: ({ params, body, meta }) => {
      const loc = locations.find((l) => l.id === params['id'] && l.status === 'active')
      if (!loc) {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '库位不存在或不属于本企业', details: {} })
      }
      const p = (body ?? {}) as Record<string, unknown>
      if (loc.qrBound && typeof p['code'] === 'string' && p['code'] !== loc.code) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[MD-29] 库位已被二维码占用，不允许修改库位编码', details: {} })
      }
      if (typeof p['code'] === 'string' && p['code']) loc.code = p['code']
      if (typeof p['remark'] === 'string') loc.remark = p['remark']
      return okCommand({ locationId: loc.id }, meta)
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/masterdata\/locations\/([^/]+)$/,
    keys: ['id'],
    handler: ({ params, meta }) => {
      const loc = locations.find((l) => l.id === params['id'] && l.status === 'active')
      if (!loc) {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '库位不存在或不属于本企业', details: {} })
      }
      if (loc.qrBound) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[MD-29] 库位已被二维码占用，不可删除', details: {} })
      }
      loc.status = 'retired'
      return okCommand({ locationId: loc.id }, meta)
    },
  },
  {
    method: 'GET',
    pattern: /^\/masterdata\/racks$/,
    keys: [],
    handler: ({ query }) => {
      const warehouseId = query.get('warehouseId')
      const codeLike = (query.get('codeLike') ?? '').trim()
      let list = activeOnly(racks)
      if (warehouseId) list = list.filter((r) => r.warehouseId === warehouseId)
      if (codeLike) list = list.filter((r) => r.code.includes(codeLike))
      return paginate(list, query)
    },
  },
  {
    method: 'POST',
    pattern: /^\/masterdata\/racks$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const warehouseId = typeof p['warehouseId'] === 'string' ? p['warehouseId'] : ''
      const code = typeof p['code'] === 'string' ? p['code'] : ''
      const zones = typeof p['zones'] === 'number' ? p['zones'] : undefined
      const layers = typeof p['layers'] === 'number' ? p['layers'] : undefined
      if (!warehouseId || !code || zones === undefined || layers === undefined) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: 'payload 需要 warehouseId/code/zones/layers', details: {} })
      }
      const wh = warehouses.find((w) => w.id === warehouseId && w.status === 'active')
      if (!wh) {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '所属仓库不存在或不属于本企业', details: {} })
      }
      if (!/^\d{2}$/.test(code)) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[MD-30] 货架编号必须为 2 位数字', details: {} })
      }
      if (!Number.isInteger(zones) || zones < 1 || zones > 99 || !Number.isInteger(layers) || layers < 1 || layers > 99) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[MD-31] 区域数量与货架层数必须为 1–99 的整数', details: {} })
      }
      if (activeOnly(racks).some((r) => r.code === code)) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[MD-30] 同一工厂下货架编号不能重复', details: {} })
      }
      const rack: RackDto = {
        id: `rack-mock-${Math.random().toString(36).slice(2, 8)}`,
        plantId: 'n-plant',
        warehouseId,
        code,
        zones,
        layers,
        remark: typeof p['remark'] === 'string' ? p['remark'] : null,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      }
      racks.push(rack)
      // MD-31：按区域数×层数自动生成货架库位（2+2+2 位编号）
      for (let z = 1; z <= zones; z += 1) {
        for (let l = 1; l <= layers; l += 1) {
          locations.push({
            id: `loc-r-mock-${code}-${z}-${l}-${Math.random().toString(36).slice(2, 6)}`,
            plantId: 'n-plant',
            warehouseId,
            rackId: rack.id,
            locationKind: 'RACK',
            code: `${code}${String(z).padStart(2, '0')}${String(l).padStart(2, '0')}`,
            zoneCode: `${code}${String(z).padStart(2, '0')}`,
            remark: null,
            qrBound: false,
            status: 'active',
            createdAt: now,
            updatedAt: now,
          })
        }
      }
      return okCommand({ rackId: rack.id, generatedLocations: zones * layers }, meta)
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/masterdata\/racks\/([^/]+)$/,
    keys: ['id'],
    handler: ({ params, body, meta }) => {
      const rack = racks.find((r) => r.id === params['id'] && r.status === 'active')
      if (!rack) {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '货架不存在或不属于本企业', details: {} })
      }
      const p = (body ?? {}) as Record<string, unknown>
      if (typeof p['remark'] === 'string') rack.remark = p['remark']
      return okCommand({ rackId: rack.id }, meta)
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/masterdata\/racks\/([^/]+)$/,
    keys: ['id'],
    handler: ({ params, meta }) => {
      const rack = racks.find((r) => r.id === params['id'] && r.status === 'active')
      if (!rack) {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '货架不存在或不属于本企业', details: {} })
      }
      let affected = 0
      for (const loc of locations) {
        if (loc.rackId === rack.id && loc.status === 'active') {
          loc.status = 'retired'
          affected += 1
        }
      }
      rack.status = 'retired'
      return okCommand({ rackId: rack.id, affectedLocations: affected }, meta)
    },
  },
  // ---------------- 主数据：工作中心（MD-17/18） ----------------
  {
    method: 'GET',
    pattern: /^\/masterdata\/work-centers$/,
    keys: [],
    handler: ({ query }) => {
      const codeLike = (query.get('codeLike') ?? '').trim()
      let list = activeOnly(workCenters)
      if (codeLike) list = list.filter((w) => w.code.includes(codeLike))
      return paginate(list, query)
    },
  },
  {
    method: 'POST',
    pattern: /^\/masterdata\/work-centers$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const code = typeof p['code'] === 'string' ? p['code'] : ''
      const name = typeof p['name'] === 'string' ? p['name'] : ''
      const deptId = typeof p['deptId'] === 'string' ? p['deptId'] : ''
      if (!code || !name || !deptId) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: 'payload 需要 code/name/deptId', details: {} })
      }
      if (activeOnly(workCenters).some((w) => w.code === code)) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[MD-17] 工作中心编码全局不能重复', details: {} })
      }
      if (activeOnly(workCenters).some((w) => w.deptId === deptId && w.name === name)) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[MD-17] 同一部门内工作中心名称不能重复', details: {} })
      }
      const created: WorkCenterDto = {
        id: `wc-mock-${Math.random().toString(36).slice(2, 8)}`,
        plantId: 'n-plant',
        deptId,
        code,
        name,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      }
      workCenters.push(created)
      return okCommand({ workCenterId: created.id }, meta)
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/masterdata\/work-centers\/([^/]+)$/,
    keys: ['id'],
    handler: ({ params, body, meta }) => {
      const wc = workCenters.find((w) => w.id === params['id'] && w.status === 'active')
      if (!wc) {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '工作中心不存在或不属于本企业', details: {} })
      }
      const p = (body ?? {}) as Record<string, unknown>
      if (typeof p['name'] === 'string' && p['name']) wc.name = p['name']
      if (typeof p['code'] === 'string' && p['code'] && p['code'] !== wc.code) {
        if (activeOnly(workCenters).some((w) => w.code === p['code'] && w.id !== wc.id)) {
          throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[MD-17] 工作中心编码全局不能重复', details: {} })
        }
        wc.code = p['code']
      }
      return okCommand({ workCenterId: wc.id }, meta)
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/masterdata\/work-centers\/([^/]+)$/,
    keys: ['id'],
    handler: ({ params, meta }) => {
      const wc = workCenters.find((w) => w.id === params['id'] && w.status === 'active')
      if (!wc) {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '工作中心不存在或不属于本企业', details: {} })
      }
      if (activeOnly(equipment).some((e) => e.workCenterId === wc.id)) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[MD-18] 工作中心被设备引用，不可删除', details: {} })
      }
      wc.status = 'retired'
      return okCommand({ workCenterId: wc.id }, meta)
    },
  },
  // ---------------- 库存查询（IT-20/04/05/06/01/35） ----------------
  {
    method: 'GET',
    pattern: /^\/inventory\/balances$/,
    keys: [],
    handler: ({ query }) => balancesOf(query),
  },
  {
    method: 'GET',
    pattern: /^\/inventory\/barcode\/([^/]+)\/resolve$/,
    keys: ['value'],
    handler: ({ params }) => resolveBarcodeOf(decodeURIComponent(params['value'])),
  },
  {
    method: 'GET',
    pattern: /^\/inventory\/units$/,
    keys: [],
    handler: ({ query }) => {
      const detail = unitDetailOf({ unitId: query.get('unitId') ?? undefined, unitNo: query.get('unitNo') ?? undefined })
      if (detail === null) {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '库存单元不存在或不在授权数据范围内', details: {} })
      }
      return detail
    },
  },
  // ---------------- 库存命令（inventory.post/reserve；IT-07 数量十进制字符串） ----------------
  {
    method: 'POST',
    pattern: /^\/inventory\/receive$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Partial<InventoryReceivePayload>
      if (!p.plantId || !p.quantity || !p.unitNo || !p.materialCode || !p.locationCode) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: 'payload 需要 plantId/quantity/unitNo/materialCode/locationCode 等必填字段', details: {} })
      }
      if (!/^\d+(\.\d+)?$/.test(p.quantity) || Number(p.quantity) <= 0) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[IT-07] 收货数量必须大于 0 且为十进制定点字符串', details: {} })
      }
      if (units.some((u) => u.unitNo === p.unitNo)) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[IT-01] 库存单元号 ${p.unitNo} 已存在（内部唯一 ID 不可重复）`, details: {} })
      }
      const unitId = `u-mock-${Math.random().toString(36).slice(2, 8)}`
      units.push({
        unitId,
        unitNo: p.unitNo,
        materialId: p.materialId ?? '',
        materialCode: p.materialCode,
        lotNo: p.lotNo ?? '',
        traceMode: p.traceMode === 'segment' ? 'segment' : 'quantity',
        status: 'in_stock',
        balanceOpen: true,
        locationCode: p.locationCode,
        quantity: p.quantity,
        reserved: '0.0000',
        available: p.quantity,
        uomCode: p.uomCode ?? 'KG',
        qualityStatus: p.qualityStatus ?? 'pending_inspection',
        feetDisplay: `${Math.round(Number(p.quantity) * 3.2808)} 英尺`,
      })
      return okCommand({ unitId, unitNo: p.unitNo, afterQty: p.quantity }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/inventory\/issue$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Partial<InventoryIssuePayload>
      if (!p.unitId || !p.quantity) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: 'payload 需要 unitId/quantity', details: {} })
      }
      const unit = units.find((u) => u.unitId === p.unitId)
      if (!unit) {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '库存单元不存在或不在授权数据范围内', details: {} })
      }
      const avail = Number(unit.available)
      if (!/^\d+(\.\d+)?$/.test(p.quantity) || Number(p.quantity) <= 0) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[IT-07] 发料数量必须大于 0 且为十进制定点字符串', details: {} })
      }
      if (avail < Number(p.quantity)) {
        throw new MockError({
          httpStatus: 409,
          code: 'ERR_INSUFFICIENT_STOCK',
          message: `[IT-14] 可用量不足（单元 ${unit.unitNo} 可用 ${unit.available}、本次申请 ${p.quantity}），无负库存拒绝`,
          details: {},
        })
      }
      const after = (avail - Number(p.quantity)).toFixed(4)
      unit.quantity = (Number(unit.quantity) - Number(p.quantity)).toFixed(4)
      unit.available = after
      if (Number(unit.quantity) <= 0) {
        unit.status = 'exhausted'
        unit.balanceOpen = false
      }
      return okCommand({ unitId: unit.unitId, afterQty: after }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/inventory\/(move|transfer\/out|transfer\/in|split)$/,
    keys: ['cmd'],
    handler: ({ params, body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const unitKey = params['cmd'] === 'split' ? 'sourceUnitId' : 'unitId'
      const unitId = typeof p[unitKey] === 'string' ? (p[unitKey] as string) : ''
      const qty = typeof p['quantity'] === 'string' ? p['quantity'] : ''
      if (!unitId || !qty) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `payload 需要 ${unitKey}/quantity`, details: {} })
      }
      if (!/^\d+(\.\d+)?$/.test(qty) || Number(qty) <= 0) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[IT-07] 数量必须大于 0 且为十进制定点字符串', details: {} })
      }
      const unit = units.find((u) => u.unitId === unitId)
      if (!unit) {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '库存单元不存在或不在授权数据范围内', details: {} })
      }
      if (params['cmd'] === 'move' && typeof p['toLocationCode'] === 'string') unit.locationCode = p['toLocationCode']
      return okCommand({ unitId, movementKind: params['cmd'].replace('/', '_') }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/inventory\/reservations\/release$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      if (typeof p['reservationId'] !== 'string' || !p['reservationId']) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: 'payload 需要 reservationId', details: {} })
      }
      return okCommand({ reservationId: p['reservationId'], status: 'released' }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/inventory\/reservations$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const unitId = typeof p['unitId'] === 'string' ? p['unitId'] : ''
      const holderType = typeof p['holderType'] === 'string' ? p['holderType'] : ''
      const holderRef = typeof p['holderRef'] === 'string' ? p['holderRef'] : ''
      const quantity = typeof p['quantity'] === 'string' ? p['quantity'] : ''
      const validUntil = typeof p['validUntil'] === 'string' ? p['validUntil'] : ''
      if (!unitId || !holderType || !holderRef || !quantity || !validUntil) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: 'payload 需要 unitId/holderType/holderRef/quantity/validUntil', details: {} })
      }
      if (!/^\d+(\.\d+)?$/.test(quantity) || Number(quantity) <= 0) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[IT-23] 预留数量必须为正的十进制定点字符串', details: {} })
      }
      if (Number.isNaN(Date.parse(validUntil)) || new Date(validUntil).getTime() <= Date.now()) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[IT-23] 预留有效期必须晚于当前时间', details: {} })
      }
      const unit = units.find((u) => u.unitId === unitId)
      if (!unit) {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '库存单元不存在或不在授权数据范围内', details: {} })
      }
      const reservationId = `rsv-mock-${Math.random().toString(36).slice(2, 8)}`
      unit.reserved = (Number(unit.reserved) + Number(quantity)).toFixed(4)
      unit.available = (Number(unit.available) - Number(quantity)).toFixed(4)
      return okCommand({ reservationId, unitId, reservedQuantity: unit.reserved }, meta)
    },
  },
  // ---------------- 第四域路由：process 生产订单 ----------------
  {
    method: 'GET',
    pattern: /^\/process\/orders$/,
    keys: [],
    handler: ({ query }) => {
      const orderNoLike = (query.get('orderNoLike') ?? '').trim()
      const statuses = (query.get('statuses') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
      const suspendedRaw = query.get('suspended')
      let list = productionOrders.slice()
      if (orderNoLike) list = list.filter((o) => o.orderNo.includes(orderNoLike))
      if (statuses.length > 0) list = list.filter((o) => statuses.includes(o.orderStatus))
      if (suspendedRaw === 'true') list = list.filter((o) => o.suspended)
      return paginate(list.map(toProductionOrderDto), query)
    },
  },
  {
    method: 'GET',
    pattern: /^\/process\/orders\/([^/]+)$/,
    keys: ['id'],
    handler: ({ params }) => {
      const order = productionOrders.find((o) => o.id === params['id'])
      if (!order) {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '生产订单不存在或不在授权数据范围内', details: {} })
      }
      return {
        order: toProductionOrderDto(order),
        operations: orderOperations.filter((op) => op.orderId === order.id).map(toOrderOperationDto),
      }
    },
  },
  {
    method: 'POST',
    pattern: /^\/process\/orders\/receive$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const orderNo = typeof p['orderNo'] === 'string' ? p['orderNo'] : ''
      const materialId = typeof p['materialId'] === 'string' ? p['materialId'] : ''
      const productionQty = typeof p['productionQty'] === 'string' ? p['productionQty'] : ''
      const uom = typeof p['uom'] === 'string' ? p['uom'] : ''
      if (!orderNo || !materialId || !productionQty || !uom) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: 'payload 需要 orderNo/materialId/productionDeptId/productionQty/uom', details: {} })
      }
      if (productionOrders.some((o) => o.orderNo === orderNo)) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[NEW-1] 生产单号 ${orderNo} 已存在（同企业唯一）`, details: {} })
      }
      const material = materials.find((m) => m.id === materialId)
      if (!material) {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '料品不存在', details: {} })
      }
      const id = `po-${Math.random().toString(36).slice(2, 8)}`
      const initialStatus = p['initialStatus'] === 'released' ? 'released' : 'approved'
      productionOrders.push({
        id,
        orderNo,
        materialId,
        materialSnapshot: { code: material.code, name: material.name, spec: material.spec, color: material.color },
        productionDeptId: 'n-draw',
        productionQty,
        uom,
        overrunRatio: null,
        orderStatus: initialStatus,
        processConfigStatus: 'configured',
        suspended: false,
        suspendedReason: null,
        actualStartAt: null,
        currentSettingsVersion: 1,
        salesOrderNo: null,
        remark: null,
        createdAt: MOCK_NOW,
      })
      const opId = `op-${Math.random().toString(36).slice(2, 8)}`
      orderOperations.push({ id: opId, orderId: id, seq: 1, settingsVersion: 1, operationDefinitionId: 'od-ls', operationCode: 'LS-01', operationName: '拉丝', coreMultiple: 1, strandFactor: null, offlineQty: productionQty, workCenterId: 'wc-md-01', workCenterCode: 'DRAW-01', workCenterName: '拉丝一线', uom, productionDeptId: 'n-draw' })
      return okCommand({ orderId: id, orderNo, orderStatus: initialStatus, operationCount: 1 }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/process\/orders\/([^/]+)\/release$/,
    keys: ['id'],
    handler: ({ params, meta }) => {
      const order = productionOrders.find((o) => o.id === params['id'])
      if (!order) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '生产订单不存在', details: {} })
      if (order.orderStatus !== 'approved') {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A1-1] 订单状态 ${order.orderStatus} 不可放行（须已审批）`, details: {} })
      }
      order.orderStatus = 'released'
      return okCommand({ orderId: order.id, orderStatus: 'released' }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/process\/orders\/([^/]+)\/start$/,
    keys: ['id'],
    handler: ({ params, meta }) => {
      const order = productionOrders.find((o) => o.id === params['id'])
      if (!order) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '生产订单不存在', details: {} })
      if (order.orderStatus !== 'released') {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A1-1] 订单状态 ${order.orderStatus} 不可开工（须已下达）`, details: {} })
      }
      if (order.suspended) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A1-1] 挂起中的订单不可开工（请先解除挂起）', details: {} })
      }
      order.orderStatus = 'in_progress'
      order.actualStartAt = MOCK_NOW
      return okCommand({ orderId: order.id, orderStatus: 'in_progress' }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/process\/orders\/([^/]+)\/suspend$/,
    keys: ['id'],
    handler: ({ params, body, meta }) => {
      const order = productionOrders.find((o) => o.id === params['id'])
      if (!order) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '生产订单不存在', details: {} })
      const p = (body ?? {}) as Record<string, unknown>
      const reason = typeof p['reason'] === 'string' ? p['reason'] : meta?.reason
      if (!reason || !reason.trim()) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[OA-29] 挂起必须填写原因（reason/x-reason）', details: {} })
      }
      if (order.orderStatus !== 'in_progress') {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A1-1] 订单状态 ${order.orderStatus} 不可挂起（须进行中）`, details: {} })
      }
      order.suspended = true
      order.suspendedReason = reason
      return okCommand({ orderId: order.id, suspended: true }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/process\/orders\/([^/]+)\/resume$/,
    keys: ['id'],
    handler: ({ params, meta }) => {
      const order = productionOrders.find((o) => o.id === params['id'])
      if (!order) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '生产订单不存在', details: {} })
      if (!order.suspended) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A1-1] 订单未处于挂起状态，无需解除', details: {} })
      }
      order.suspended = false
      order.suspendedReason = null
      return okCommand({ orderId: order.id, suspended: false }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/process\/orders\/([^/]+)\/void$/,
    keys: ['id'],
    handler: ({ params, meta }) => {
      const order = productionOrders.find((o) => o.id === params['id'])
      if (!order) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '生产订单不存在', details: {} })
      if (order.orderStatus === 'closed' || order.orderStatus === 'voided') {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A1-1] 订单状态 ${order.orderStatus} 不可作废`, details: {} })
      }
      order.orderStatus = 'voided'
      return okCommand({ orderId: order.id, orderStatus: 'voided' }, meta)
    },
  },
  // ---------------- 第四域路由：scheduling 排程（订单/设备双投影 + 槽位编辑） ----------------
  {
    method: 'GET',
    pattern: /^\/scheduling\/order-view\/([^/]+)$/,
    keys: ['orderId'],
    handler: ({ params }) => {
      const view = orderViewOf(params['orderId'] ?? '')
      if (view === null) {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '生产订单不存在或不属于本企业', details: {} })
      }
      return view
    },
  },
  {
    method: 'GET',
    pattern: /^\/scheduling\/device-view$/,
    keys: [],
    handler: ({ query }) => deviceBoardOf(query.get('workCenterId') ?? undefined),
  },
  {
    method: 'GET',
    pattern: /^\/scheduling\/pda\/plan$/,
    keys: [],
    handler: ({ query }) => {
      const workCenterId = query.get('workCenterId') ?? ''
      if (!workCenterId) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: 'workCenterId 必填（PDA 排产计划按工作中心查询）', details: {} })
      }
      const wc = workCenters.find((w) => w.id === workCenterId && w.status === 'active')
      if (!wc) {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '工作中心不存在或不属于本企业', details: {} })
      }
      const dateWindow: string[] = []
      for (let i = 7; i >= 0; i -= 1) {
        const d = new Date(`${MOCK_TODAY}T00:00:00.000Z`)
        d.setUTCDate(d.getUTCDate() - i)
        dateWindow.push(d.toISOString().slice(0, 10))
      }
      const rows = scheduleSlots.filter((s) => {
        const eq = equipment.find((e) => e.id === s.equipmentId)
        const order = productionOrders.find((o) => o.id === s.orderId)
        return eq?.workCenterId === workCenterId && dateWindow.includes(s.productionDate) && order && order.orderStatus !== 'closed' && order.orderStatus !== 'voided'
      })
      const byDate = new Map<string, MockSlot[]>()
      for (const row of rows) {
        const list = byDate.get(row.productionDate) ?? []
        list.push(row)
        byDate.set(row.productionDate, list)
      }
      return {
        workCenterId,
        workCenterName: wc.name,
        groups: [...byDate.keys()].sort().map((date) => ({
          productionDate: date,
          items: (byDate.get(date) ?? []).map((r) => {
            const order = productionOrders.find((o) => o.id === r.orderId)
            const eq = equipment.find((e) => e.id === r.equipmentId)
            const snap = order?.materialSnapshot ?? {}
            const desc = [snap['name'], snap['spec'], snap['color']].filter((x) => typeof x === 'string' && x).join(' / ') || '-'
            return {
              slotId: r.id,
              orderNo: order?.orderNo ?? r.orderId,
              salesOrderNo: order?.salesOrderNo ?? null,
              equipmentId: r.equipmentId,
              equipmentName: eq?.name ?? r.equipmentId,
              materialDesc: desc,
              plannedQty: r.plannedQty,
              uom: r.uom,
              remark: r.remark,
            }
          }),
        })),
      }
    },
  },
  {
    method: 'GET',
    pattern: /^\/scheduling\/shift-date$/,
    keys: [],
    handler: ({ query }) => {
      const plantId = query.get('plantId') ?? ''
      if (!plantId) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: 'plantId 必填（班次参数为工厂级）', details: {} })
      }
      return { plantId, dayShiftStart: shiftParameters.get(plantId) ?? null, actualTime: MOCK_NOW, shiftDate: MOCK_TODAY }
    },
  },
  {
    method: 'POST',
    pattern: /^\/scheduling\/slots\/batch$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const raw = p['entries']
      if (!Array.isArray(raw) || raw.length === 0) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A3-1] entries 必须为非空数组（批量矩阵保存载荷）', details: {} })
      }
      const confirm = p['confirm'] === true
      const warnings: string[] = []
      let applied = { upserted: 0, deleted: 0 }
      for (const entry of raw) {
        const result = applySlotEntry((entry ?? {}) as Record<string, unknown>, confirm, warnings)
        applied = { upserted: applied.upserted + result.upserted, deleted: applied.deleted + result.deleted }
      }
      return okCommand({ applied, warnings: warnings.length > 0 ? warnings : null }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/scheduling\/slots$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const confirm = p['confirm'] === true
      const warnings: string[] = []
      const applied = applySlotEntry(p, confirm, warnings)
      return okCommand(
        { action: applied.upserted > 0 ? 'upserted' : applied.deleted > 0 ? 'deleted' : 'noop', slotId: applied.slotIds[0] ?? null, warnings: warnings.length > 0 ? warnings : null },
        meta,
      )
    },
  },
  {
    method: 'POST',
    pattern: /^\/scheduling\/capacity$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const equipmentId = typeof p['equipmentId'] === 'string' ? p['equipmentId'] : ''
      const productionDate = typeof p['productionDate'] === 'string' ? p['productionDate'] : ''
      const capacity = typeof p['capacity'] === 'string' ? p['capacity'] : ''
      if (!equipmentId || !productionDate || !capacity) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: 'payload 需要 equipmentId/productionDate/capacity', details: {} })
      }
      capacityCalendar.set(`${equipmentId}|${productionDate}`, capacity)
      return okCommand({ equipmentId, productionDate, capacity }, meta)
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/scheduling\/capacity$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const equipmentId = typeof p['equipmentId'] === 'string' ? p['equipmentId'] : ''
      const productionDate = typeof p['productionDate'] === 'string' ? p['productionDate'] : ''
      if (!equipmentId || !productionDate) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: 'payload 需要 equipmentId/productionDate', details: {} })
      }
      capacityCalendar.delete(`${equipmentId}|${productionDate}`)
      return okCommand({ equipmentId, productionDate, cleared: true }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/scheduling\/shift$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const plantId = typeof p['plantId'] === 'string' ? p['plantId'] : ''
      const dayShiftStart = typeof p['dayShiftStart'] === 'string' ? p['dayShiftStart'] : ''
      if (!plantId || !dayShiftStart) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: 'payload 需要 plantId/dayShiftStart', details: {} })
      }
      if (!/^\d{2}:\d{2}$/.test(dayShiftStart)) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A4-1] 白班起点必须为 HH:MM 24 小时制', details: {} })
      }
      shiftParameters.set(plantId, dayShiftStart)
      return okCommand({ plantId, dayShiftStart }, meta)
    },
  },
  // ---------------- 第四域路由：execution 报工/投料 ----------------
  {
    method: 'GET',
    pattern: /^\/execution\/scan\/context$/,
    keys: [],
    handler: ({ query }) => {
      const plantId = query.get('plantId') ?? ''
      const equipmentId = query.get('equipmentId') ?? ''
      if (!plantId || !equipmentId) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '需要 plantId/equipmentId（扫设备码上下文）', details: {} })
      }
      const shiftDate = query.get('shiftDate') ?? MOCK_TODAY
      return scheduleSlots
        .filter((s) => s.equipmentId === equipmentId && s.productionDate === shiftDate)
        .map((s) => {
          const op = orderOperations.find((o) => o.id === s.orderOperationId)
          return { orderId: s.orderId, orderOperationId: s.orderOperationId, operationSeq: op?.seq ?? 0, operationDefinitionId: op?.operationDefinitionId ?? '' }
        })
    },
  },
  {
    method: 'POST',
    pattern: /^\/execution\/orders\/([^/]+)\/reports$/,
    keys: ['orderId'],
    handler: ({ params, body, meta }) => handleReportEntry('order', params['orderId'] ?? '', body, meta),
  },
  {
    method: 'POST',
    pattern: /^\/execution\/workbench\/reports$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      return handleReportEntry('workbench', typeof p['orderId'] === 'string' ? p['orderId'] : '', body, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/execution\/scan\/reports$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      return handleReportEntry('scan', typeof p['orderId'] === 'string' ? p['orderId'] : '', body, meta)
    },
  },
  {
    method: 'GET',
    pattern: /^\/execution\/reports\/drafts$/,
    keys: [],
    handler: ({ query }) => {
      const orderId = query.get('orderId')
      const source = query.get('source')
      const rows = sessions
        .filter((s) => s.status === 'open')
        .filter((s) => !orderId || s.orderId === orderId)
        .filter((s) => !source || s.source === source)
        .map((s) => {
          const report = reports.find((r) => r.sessionId === s.id) ?? null
          const op = report ? orderOperations.find((o) => o.id === report.orderOperationId) : null
          return {
            sessionId: s.id,
            reportId: report?.id ?? null,
            orderId: s.orderId,
            source: s.source,
            orderOperationId: report?.orderOperationId ?? null,
            operationSeq: report?.operationSeq ?? op?.seq ?? null,
            operatorUserId: report?.operatorUserId ?? 'user-s-1',
            operatorLogin: report?.operatorLogin ?? 'admin',
            shiftDate: report?.shiftDate ?? MOCK_TODAY,
            businessTime: report?.businessTime ?? s.createdAt,
            remark: report?.remark ?? null,
            draftFeeds: [],
            lockedOperationId: report && report.outputs.length > 0 ? report.orderOperationId : null,
            outputs: (report?.outputs ?? []).map((o) => ({
              lineNo: o.lineNo,
              quantity: o.quantity,
              qualifiedQty: o.qualifiedQty,
              uomCode: o.uomCode,
              carrierCode: o.carrierCode,
              targetLocationId: o.targetLocationId,
              targetLocationCode: o.targetLocationCode,
            })),
          }
        })
      return paginate(rows, query)
    },
  },
  {
    method: 'GET',
    pattern: /^\/execution\/reports\/([^/]+)$/,
    keys: ['id'],
    handler: ({ params }) => {
      const report = reports.find((r) => r.id === params['id'])
      if (!report) {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '报工单不存在或不在授权数据范围内', details: {} })
      }
      return {
        report: {
          id: report.id,
          sessionId: report.sessionId,
          orderId: report.orderId,
          orderOperationId: report.orderOperationId,
          operationSeq: report.operationSeq,
          source: report.source,
          status: report.status,
          reviewStatus: report.reviewStatus,
          operatorUserId: report.operatorUserId,
          operatorLogin: report.operatorLogin,
          businessTime: report.businessTime,
          shiftDate: report.shiftDate,
          equipmentCode: report.equipmentCode,
          reviewedAt: report.reviewedAt,
          reviewedBy: report.reviewedBy,
          reviewCancelledAt: report.reviewCancelledAt,
          qcCompletedAt: null,
          correctionOf: null,
          remark: report.remark,
        },
        outputs: report.outputs.map((o, i) => ({
          id: `${report.id}-out-${i + 1}`,
          reportId: report.id,
          lineNo: o.lineNo,
          quantity: o.quantity,
          qualifiedQty: o.qualifiedQty,
          uomId: 'uom-km',
          uomCode: o.uomCode,
          carrierCode: o.carrierCode,
          targetLocationId: o.targetLocationId,
          targetLocationCode: o.targetLocationCode,
          ownerId: 'owner-1',
          ownerName: '中辰电缆制造有限公司',
          measurementBasis: 'nominal',
          stockUnitId: o.stockUnitId,
          createdAt: report.businessTime,
        })),
        feeds: consumptions
          .filter((c) => c.reportId === report.id)
          .map((c) => ({ ...c, plantId: 'n-plant' })),
        reviewCancelled: report.reviewCancelledAt !== null,
      }
    },
  },
  {
    method: 'POST',
    pattern: /^\/execution\/reports\/([^/]+)\/submit$/,
    keys: ['id'],
    handler: ({ params, meta }) => {
      const report = reports.find((r) => r.id === params['id'])
      if (!report) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '报工单不存在', details: {} })
      if (report.status !== 'draft') {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A6-6] 报工单状态 ${report.status} 不可提交（仅草稿可提交）`, details: {} })
      }
      if (report.outputs.length === 0) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A6-5] 报工单缺少产出行（保存界面产出数量为必填），拒绝提交', details: {} })
      }
      report.status = 'submitted'
      report.reviewStatus = 'pending_review'
      const session = sessions.find((s) => s.id === report.sessionId)
      if (session) session.status = 'submitted'
      return okCommand({ reportId: report.id, status: 'submitted', reviewStatus: 'pending_review' }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/execution\/reports\/([^/]+)\/review$/,
    keys: ['id'],
    handler: ({ params, meta }) => {
      const report = reports.find((r) => r.id === params['id'])
      if (!report) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '报工单不存在', details: {} })
      if (report.status !== 'submitted') {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A6-5] 草稿不能审核；已审核不可重复（撤审回待审可重新审核）', details: {} })
      }
      if (report.reviewStatus === 'manual_approved') {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A6-6] 已人工审核的单不可重复审核（如需变更请先取消审核）', details: {} })
      }
      if (report.outputs.length === 0) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '报工单无产出行，不可审核', details: {} })
      }
      report.reviewStatus = 'manual_approved'
      report.reviewedAt = MOCK_NOW
      report.reviewedBy = 'admin'
      const stockedUnits = report.outputs.map((o, i) => {
        if (o.stockUnitId === null) o.stockUnitId = `u-stock-${report.id}-${i + 1}`
        return o.stockUnitId
      })
      return okCommand({ reportId: report.id, reviewStatus: 'manual_approved', stockedUnits }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/execution\/reports\/([^/]+)\/review-cancel$/,
    keys: ['id'],
    handler: ({ params, body, meta }) => {
      const report = reports.find((r) => r.id === params['id'])
      if (!report) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '报工单不存在', details: {} })
      const p = (body ?? {}) as Record<string, unknown>
      const reason = typeof p['reason'] === 'string' ? p['reason'] : meta?.reason
      if (!reason || !reason.trim()) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[OA-29] 取消审核必须填写原因（reason/x-reason）', details: {} })
      }
      if (report.reviewStatus !== 'manual_approved') {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A6-6] 仅已人工审核的单可取消审核', details: {} })
      }
      if (report.stockLocked) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A6-6] 产出已入库/被消耗，不可取消审核（对象关系守卫：移出线边库/上架/被消耗/质检完成即拦截）', details: {} })
      }
      report.reviewStatus = 'cancelled'
      report.reviewCancelledAt = MOCK_NOW
      for (const o of report.outputs) o.stockUnitId = null
      return okCommand({ reportId: report.id, reviewStatus: 'cancelled' }, meta)
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/execution\/reports\/([^/]+)$/,
    keys: ['id'],
    handler: ({ params, body, meta }) => {
      const report = reports.find((r) => r.id === params['id'])
      if (!report) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '报工单不存在', details: {} })
      const p = (body ?? {}) as Record<string, unknown>
      if (report.status === 'submitted' && report.reviewStatus === 'manual_approved') {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A6-6] 已审核单不可编辑（请先取消审核）', details: {} })
      }
      const rawOutputs = p['outputs']
      if (Array.isArray(rawOutputs)) {
        if (rawOutputs.length !== report.outputs.length) {
          throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A6-6] 待审单编辑仅允许改产出数量/合格数（行数与载体码不可改）', details: {} })
        }
        rawOutputs.forEach((item, i) => {
          const line = (item ?? {}) as Record<string, unknown>
          if (typeof line['carrierCode'] === 'string' && line['carrierCode'] !== report.outputs[i]!.carrierCode) {
            throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A6-6] 待审单编辑不可改产出载体码（删除守卫「码未动」前提）', details: {} })
          }
          if (typeof line['quantity'] === 'string') report.outputs[i]!.quantity = line['quantity']
          if (typeof line['qualifiedQty'] === 'string') report.outputs[i]!.qualifiedQty = line['qualifiedQty']
        })
      }
      if (typeof p['remark'] === 'string') report.remark = p['remark']
      return okCommand({ reportId: report.id, status: report.status }, meta)
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/execution\/reports\/([^/]+)$/,
    keys: ['id'],
    handler: ({ params, meta }) => {
      const report = reports.find((r) => r.id === params['id'])
      if (!report) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '报工单不存在', details: {} })
      if (report.reviewStatus === 'manual_approved' || report.reviewStatus === 'auto_approved') {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A6-6] 已审核单不可删除（请先取消审核）', details: {} })
      }
      if (report.outputs.some((o) => o.stockUnitId !== null)) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A6-6] 产出已入库，不可删除', details: {} })
      }
      report.status = 'deleted'
      const session = sessions.find((s) => s.id === report.sessionId)
      if (session) session.status = 'cancelled'
      return okCommand({ reportId: report.id, status: 'deleted' }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/execution\/feeds$/,
    keys: [],
    handler: ({ body, meta }) => handleFeedSubmit(body, meta),
  },
  {
    method: 'POST',
    pattern: /^\/execution\/labor-records$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const orderId = typeof p['orderId'] === 'string' ? p['orderId'] : ''
      const hours = typeof p['hours'] === 'string' ? p['hours'] : ''
      if (!orderId || !hours) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: 'execution.labor.record：载荷缺少必填字段 orderId/hours', details: {} })
      }
      if (!Number.isFinite(Number(hours)) || Number(hours) <= 0) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '工时必须为正的十进制定点字符串', details: {} })
      }
      const order = productionOrders.find((o) => o.id === orderId)
      if (!order) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '生产订单不存在', details: {} })
      return okCommand({ orderId, hours }, meta)
    },
  },
  {
    method: 'GET',
    pattern: /^\/execution\/orders\/([^/]+)\/quantities$/,
    keys: ['id'],
    handler: ({ params }) => orderQuantitiesOf(params['id'] ?? ''),
  },
  {
    method: 'GET',
    pattern: /^\/execution\/orders\/([^/]+)\/labor-records$/,
    keys: ['id'],
    handler: ({ params }) => {
      const order = productionOrders.find((o) => o.id === params['id'])
      if (!order) return []
      return []
    },
  },
  // ---------------- 第四域路由：quality 质量放行 ----------------
  {
    method: 'GET',
    pattern: /^\/quality\/inspections$/,
    keys: [],
    handler: ({ query }) => {
      const statuses = (query.get('statuses') ?? '').split(',').filter(Boolean)
      const stages = (query.get('stages') ?? '').split(',').filter(Boolean)
      const orderNoLike = (query.get('orderNoLike') ?? '').trim()
      let list = inspections.slice()
      if (statuses.length > 0) list = list.filter((i) => statuses.includes(i.status))
      if (stages.length > 0) list = list.filter((i) => stages.includes(i.inspectionStage))
      if (orderNoLike) list = list.filter((i) => i.orderNo.includes(orderNoLike) || (i.productionOrderNo ?? '').includes(orderNoLike))
      return paginate(
        list.map((i) => ({
          id: i.id,
          orderNo: i.orderNo,
          sourceType: i.sourceType,
          sourceRef: i.sourceRef,
          inspectionStage: i.inspectionStage,
          specCode: i.specCode,
          specVersion: i.specVersion,
          inventoryUnitId: i.inventoryUnitId,
          unitNo: i.unitNo,
          materialId: i.materialId,
          materialCode: i.materialCode,
          lotId: null,
          quantity: i.quantity,
          uomId: 'uom-km',
          uomCode: i.uomCode,
          status: i.status,
          productionOrderNo: i.productionOrderNo,
          productionDeptId: null,
          productionDeptName: i.productionDeptName,
          plantId: 'n-plant',
        })),
        query,
      )
    },
  },
  {
    method: 'GET',
    pattern: /^\/quality\/inspections\/([^/]+)$/,
    keys: ['id'],
    handler: ({ params }) => {
      const item = inspections.find((i) => i.id === params['id'])
      if (!item) {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '检验单不存在或不在授权数据范围内', details: {} })
      }
      const STATUS_LABELS: Record<string, string> = { pending: '待检', in_progress: '检验中', concluded: '已出结论', cancelled: '已作废' }
      return {
        id: item.id,
        orderNo: item.orderNo,
        sourceType: item.sourceType,
        sourceRef: item.sourceRef,
        inspectionStage: item.inspectionStage,
        specCode: item.specCode,
        specVersion: item.specVersion,
        inventoryUnitId: item.inventoryUnitId,
        unitNo: item.unitNo,
        materialId: item.materialId,
        materialCode: item.materialCode,
        lotId: null,
        quantity: item.quantity,
        uomId: 'uom-km',
        uomCode: item.uomCode,
        status: item.status,
        productionOrderNo: item.productionOrderNo,
        productionDeptId: null,
        productionDeptName: item.productionDeptName,
        plantId: 'n-plant',
        statusLabel: STATUS_LABELS[item.status] ?? item.status,
        results: testResults
          .filter((r) => r.inspectionOrderId === item.id)
          .map((r) => ({ ...r })),
        dispositions: dispositions
          .filter((d) => d.inspectionOrderId === item.id)
          .map((d) => ({ ...d })),
      }
    },
  },
  {
    method: 'GET',
    pattern: /^\/quality\/holds$/,
    keys: [],
    handler: ({ query }) => {
      const statuses = (query.get('statuses') ?? '').split(',').filter(Boolean)
      const holdKinds = (query.get('holdKinds') ?? '').split(',').filter(Boolean)
      let list = holds.slice()
      if (statuses.length > 0) list = list.filter((h) => statuses.includes(h.status))
      if (holdKinds.length > 0) list = list.filter((h) => holdKinds.includes(h.holdKind))
      const HOLD_LABELS: Record<string, string> = { pending_inspection: '待检隔离', unqualified: '不合格隔离', suspect: '质量存疑' }
      return paginate(
        list.map((h) => ({
          id: h.id,
          inventoryUnitId: h.inventoryUnitId,
          unitNo: h.unitNo,
          holdKind: h.holdKind,
          holdKindLabel: HOLD_LABELS[h.holdKind] ?? h.holdKind,
          status: h.status,
          previousQualityStatus: h.previousQualityStatus,
          raisedBy: h.raisedBy,
          raisedAt: h.raisedAt,
          productionDeptId: null,
          productionDeptName: h.productionDeptName,
          releasedBy: h.releasedBy,
          releasedAt: h.releasedAt,
          dispositionNote: h.dispositionNote,
          plantId: 'n-plant',
          businessTime: h.raisedAt,
        })),
        query,
      )
    },
  },
  {
    method: 'POST',
    pattern: /^\/quality\/inspections\/generate$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const plantId = typeof p['plantId'] === 'string' ? p['plantId'] : ''
      if (!plantId) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: 'quality.inspection.generate：载荷缺少必填字段 plantId', details: {} })
      }
      const sourceRef = 'rp-002'
      const existing = inspections.find((i) => i.sourceRef === sourceRef && i.sourceType === 'work_report' && i.inspectionStage === 'process')
      if (existing) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A-T12-5] 来源 (work_report, ${sourceRef}, process) 已生成检验单 ${existing.orderNo}，不可重复生成`, details: {} })
      }
      const id = `qio-${Math.random().toString(36).slice(2, 8)}`
      inspections.push({ id, orderNo: `QI-2026-1027-${String(inspections.length + 1).padStart(3, '0')}`, sourceType: 'work_report', sourceRef, inspectionStage: 'process', specCode: 'SPEC-STRAND-4X120', specVersion: 2, inventoryUnitId: null, unitNo: null, materialId: 'm-0005', materialCode: 'STRAND-4X120', quantity: '2.0000', uomCode: 'KM', status: 'pending', productionOrderNo: 'MO-2026-1027-001', productionDeptName: '拉丝车间' })
      return okCommand({ inspectionOrderId: id, generated: 1 }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/quality\/test-results$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const inspectionOrderId = typeof p['inspectionOrderId'] === 'string' ? p['inspectionOrderId'] : ''
      const conclusion = p['conclusion'] === 'qualified' ? 'qualified' : p['conclusion'] === 'unqualified' ? 'unqualified' : ''
      if (!inspectionOrderId || !conclusion) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: 'quality.test-result.submit：载荷缺少必填字段 inspectionOrderId/conclusion', details: {} })
      }
      const item = inspections.find((i) => i.id === inspectionOrderId)
      if (!item) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '检验单不存在或不在授权数据范围内', details: {} })
      if (item.status === 'cancelled') {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A-T12-5] 已作废检验单不可提交实测', details: {} })
      }
      const items = Array.isArray(p['items']) ? (p['items'] as unknown) : []
      const versions = testResults.filter((r) => r.inspectionOrderId === inspectionOrderId)
      const version = versions.length + 1
      const resultKind = versions.length === 0 ? 'initial' : item.status === 'concluded' ? 're_inspection' : 'test'
      for (const r of versions) r.isEffective = false
      testResults.push({
        resultId: `tr-${Math.random().toString(36).slice(2, 8)}`,
        inspectionOrderId,
        version,
        resultKind,
        conclusion,
        items: items as MockTestResult['items'],
        isEffective: true,
        inspector: typeof p['inspector'] === 'string' ? p['inspector'] : 'admin',
        inspectedAt: MOCK_NOW,
      })
      item.status = 'concluded'
      return okCommand({ inspectionOrderId, version, conclusion, resultKind }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/quality\/dispositions\/release$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const inspectionOrderId = typeof p['inspectionOrderId'] === 'string' ? p['inspectionOrderId'] : ''
      const item = inspections.find((i) => i.id === inspectionOrderId)
      if (!item) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '检验单不存在或不在授权数据范围内', details: {} })
      const effective = testResults.find((r) => r.inspectionOrderId === inspectionOrderId && r.isEffective)
      if (item.status !== 'concluded' || !effective) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A-T12-1] 检验单尚未出结论，不可判定放行', details: {} })
      }
      if (effective.conclusion !== 'qualified') {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A-T12-1] 生效结论为不合格，不可直接放行（如需入库请走让步放行并保留原不合格事实）', details: {} })
      }
      if (dispositions.some((d) => d.inspectionOrderId === inspectionOrderId)) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A-T12-1] 该检验单已有处置记录，不可重复放行', details: {} })
      }
      dispositions.push({ dispositionId: `dp-${Math.random().toString(36).slice(2, 8)}`, inspectionOrderId, dispositionKind: 'release', basedOnVersion: effective.version, releasedBy: 'admin', releasedAt: MOCK_NOW, reason: typeof p['reason'] === 'string' ? p['reason'] : null })
      return okCommand({ inspectionOrderId, dispositionKind: 'release', basedOnVersion: effective.version }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/quality\/dispositions\/concession$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const inspectionOrderId = typeof p['inspectionOrderId'] === 'string' ? p['inspectionOrderId'] : ''
      const reason = typeof p['reason'] === 'string' ? p['reason'].trim() : (meta?.reason ?? '').trim()
      const basedOnVersion = typeof p['basedOnVersion'] === 'number' ? p['basedOnVersion'] : Number(p['basedOnVersion'])
      const item = inspections.find((i) => i.id === inspectionOrderId)
      if (!item) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '检验单不存在或不在授权数据范围内', details: {} })
      if (!reason) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A-T12-1] 让步放行必须填写让步原因（reason）', details: {} })
      }
      const origin = testResults.find((r) => r.inspectionOrderId === inspectionOrderId && r.version === basedOnVersion)
      if (!origin || origin.conclusion !== 'unqualified') {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A-T12-1] 让步须引用原不合格结论版本（based_on_version=${String(p['basedOnVersion'])} 不存在或不为不合格）`, details: {} })
      }
      if (dispositions.some((d) => d.inspectionOrderId === inspectionOrderId)) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A-T12-1] 该检验单已有处置记录，不可重复处置', details: {} })
      }
      dispositions.push({ dispositionId: `dp-${Math.random().toString(36).slice(2, 8)}`, inspectionOrderId, dispositionKind: 'concession', basedOnVersion, releasedBy: 'admin', releasedAt: MOCK_NOW, reason })
      return okCommand({ inspectionOrderId, dispositionKind: 'concession', basedOnVersion, note: '让步放行不改动原不合格结论（结论链保留）' }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/quality\/suspects$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const plantId = typeof p['plantId'] === 'string' ? p['plantId'] : ''
      const unitNo = typeof p['unitNo'] === 'string' ? p['unitNo'] : undefined
      const barcodeValue = typeof p['barcodeValue'] === 'string' ? p['barcodeValue'] : undefined
      if (!plantId || (!unitNo && !barcodeValue)) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: 'quality.suspect.register：载荷需要 plantId 与 unitNo/unitId/barcodeValue 之一', details: {} })
      }
      if (barcodeValue !== undefined && barcodeValue.startsWith('PLT-')) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A-T12-3] 托码不可登记存疑（请扫单元码）：${barcodeValue}`, details: {} })
      }
      const unit = [...units, ...feedUnits].find((u) => (unitNo !== undefined ? u.unitNo === unitNo : u.unitNo === barcodeValue))
      if (!unit) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '库存单元不存在', details: {} })
      if (unit.status !== 'in_stock') {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A-T12-3] 单元 ${unit.unitNo} 不在库，不可登记存疑`, details: {} })
      }
      if (!unit.locationCode) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A-T12-3] 单元 ${unit.unitNo} 不在库位（必须先入库）`, details: {} })
      }
      if (holds.some((h) => h.inventoryUnitId === unit.unitId && h.status === 'active')) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A-T12-3] 单元 ${unit.unitNo} 已存在未恢复的存疑/隔离记录`, details: {} })
      }
      holds.push({ id: `hold-${Math.random().toString(36).slice(2, 8)}`, inventoryUnitId: unit.unitId, unitNo: unit.unitNo, holdKind: 'suspect', status: 'active', previousQualityStatus: unit.qualityStatus, raisedBy: 'admin', raisedAt: MOCK_NOW, productionDeptName: null, releasedBy: null, releasedAt: null, dispositionNote: null })
      return okCommand({ unitNo: unit.unitNo, holdKind: 'suspect', status: 'active' }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/quality\/suspects\/restore$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const dispositionNote = typeof p['dispositionNote'] === 'string' ? p['dispositionNote'].trim() : ''
      const holdId = typeof p['holdId'] === 'string' ? p['holdId'] : undefined
      const unitId = typeof p['unitId'] === 'string' ? p['unitId'] : undefined
      if (!dispositionNote) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A-T12-3] 存疑恢复必须填写处置依据（dispositionNote）', details: {} })
      }
      const hold = holds.find((h) => (holdId !== undefined ? h.id === holdId : unitId !== undefined ? h.inventoryUnitId === unitId : false) && h.status === 'active')
      if (!hold) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '存疑记录不存在或已恢复', details: {} })
      hold.status = 'released'
      hold.releasedBy = 'admin'
      hold.releasedAt = MOCK_NOW
      hold.dispositionNote = dispositionNote
      return okCommand({ holdId: hold.id, unitNo: hold.unitNo, status: 'released' }, meta)
    },
  },
  // ---------------- 第四域路由：warehousing 入库/移库/调拨 ----------------
  {
    method: 'GET',
    pattern: /^\/warehousing\/putaway-tasks$/,
    keys: [],
    handler: ({ query }) => {
      const statuses = (query.get('statuses') ?? '').split(',').filter(Boolean)
      const sourceTypes = (query.get('sourceTypes') ?? '').split(',').filter(Boolean)
      let list = putawayTasks.slice()
      if (statuses.length > 0) list = list.filter((t) => statuses.includes(t.status))
      if (sourceTypes.length > 0) list = list.filter((t) => sourceTypes.includes(t.sourceType))
      const STATUS_LABELS: Record<string, string> = { pending: '待入库', done: '已完成', cancelled: '已取消' }
      return paginate(
        list.map((t) => ({
          id: t.id,
          sourceType: t.sourceType,
          sourceRef: t.sourceRef,
          unitNo: t.unitNo,
          palletCode: t.palletCode,
          materialId: t.materialId,
          materialCode: t.materialCode,
          quantity: t.quantity,
          uomId: 'uom-km',
          uomCode: t.uomCode,
          targetWarehouseId: t.targetWarehouseId,
          status: t.status,
          statusLabel: STATUS_LABELS[t.status] ?? t.status,
          inventoryUnitId: t.inventoryUnitId,
          locationId: null,
          locationCode: t.locationCode,
          putawayBy: t.putawayBy,
          putawayAt: t.putawayAt,
          plantId: 'n-plant',
        })),
        query,
      )
    },
  },
  {
    method: 'GET',
    pattern: /^\/warehousing\/moves$/,
    keys: [],
    handler: ({ query }) => {
      const unitNoLike = (query.get('unitNoLike') ?? '').trim()
      let list = moveRecords.slice()
      if (unitNoLike) list = list.filter((m) => m.unitNo.includes(unitNoLike))
      return paginate(
        list.map((m) => ({
          id: m.id,
          inventoryUnitId: m.inventoryUnitId,
          unitNo: m.unitNo,
          fromLocationId: null,
          fromLocationCode: m.fromLocationCode,
          toLocationId: null,
          toLocationCode: m.toLocationCode,
          quantity: m.quantity,
          uomId: 'uom-kg',
          uomCode: m.uomCode,
          movedBy: m.movedBy,
          movedAt: m.movedAt,
          reason: m.reason,
          plantId: 'n-plant',
        })),
        query,
      )
    },
  },
  {
    method: 'GET',
    pattern: /^\/warehousing\/transfers$/,
    keys: [],
    handler: ({ query }) => {
      const statuses = (query.get('statuses') ?? '').split(',').filter(Boolean)
      const orderNoLike = (query.get('orderNoLike') ?? '').trim()
      let list = transfers.slice()
      if (statuses.length > 0) list = list.filter((t) => statuses.includes(t.status))
      if (orderNoLike) list = list.filter((t) => t.orderNo.includes(orderNoLike))
      return paginate(list.map(toTransferView), query)
    },
  },
  {
    method: 'GET',
    pattern: /^\/warehousing\/transfers\/([^/]+)$/,
    keys: ['id'],
    handler: ({ params }) => {
      const t = transfers.find((x) => x.id === params['id'])
      if (!t) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '调拨单不存在或不在授权数据范围内', details: {} })
      return { ...toTransferView(t), lines: t.lines.map((l) => ({ lineId: l.id, lineNo: l.lineNo, inventoryUnitId: l.inventoryUnitId, unitNo: l.unitNo, materialCode: l.materialCode, quantity: l.quantity, outQty: l.outQty, inQty: l.inQty, reservationId: l.reservationId, outDone: l.outDone, inDone: l.inDone })) }
    },
  },
  {
    method: 'POST',
    pattern: /^\/warehousing\/putaway\/refresh$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const plantId = typeof p['plantId'] === 'string' ? p['plantId'] : ''
      if (!plantId) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: 'warehousing.putaway.refresh：载荷缺少必填字段 plantId', details: {} })
      }
      return okCommand({ plantId, scanned: 0, createdCount: 0, pendingCount: putawayTasks.filter((t) => t.status === 'pending').length }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/warehousing\/putaway\/confirm$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const taskIds = Array.isArray(p['taskIds']) ? (p['taskIds'] as string[]) : []
      const unitNos = Array.isArray(p['unitNos']) ? (p['unitNos'] as string[]) : []
      const palletCode = typeof p['palletCode'] === 'string' ? p['palletCode'] : ''
      const toLocationCode = typeof p['toLocationCode'] === 'string' ? p['toLocationCode'] : ''
      if (taskIds.length === 0 && unitNos.length === 0 && !palletCode) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: 'warehousing.putaway.confirm：需要 taskIds/unitNos/palletCode 之一（任务台账/组单/整托三入口）', details: {} })
      }
      const picked = putawayTasks.filter((t) => (taskIds.length > 0 ? taskIds.includes(t.id) : false) || (unitNos.length > 0 ? t.unitNo !== null && unitNos.includes(t.unitNo) : false) || (palletCode ? t.palletCode === palletCode : false))
      if (picked.length === 0) {
        throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '未找到匹配的待入库任务', details: {} })
      }
      for (const t of picked) {
        if (t.status !== 'pending') {
          throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A-T13-1] 任务 ${t.id} 状态 ${t.status} 不可确认入库（仅待入库；台账禁手工增删改）`, details: {} })
        }
      }
      for (const t of picked) {
        t.status = 'done'
        t.locationCode = toLocationCode
        t.putawayBy = 'admin'
        t.putawayAt = MOCK_NOW
      }
      return okCommand({ confirmedCount: picked.length, taskIds: picked.map((t) => t.id) }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/warehousing\/moves$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const unitId = typeof p['unitId'] === 'string' ? p['unitId'] : ''
      const toLocationId = typeof p['toLocationId'] === 'string' ? p['toLocationId'] : ''
      const toLocationCode = typeof p['toLocationCode'] === 'string' ? p['toLocationCode'] : ''
      if (!unitId || !toLocationId || !toLocationCode) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: 'warehousing.move.execute：载荷需要 unitId/toLocationId/toLocationCode', details: {} })
      }
      const unit = [...units, ...feedUnits].find((u) => u.unitId === unitId)
      if (!unit) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '库存单元不存在或不在授权数据范围内', details: {} })
      const toLocation = locations.find((l) => l.id === toLocationId || l.code === toLocationCode)
      if (!toLocation) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '目标库位不存在', details: {} })
      if (unit.locationCode === toLocation.code) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A-T13-4] 单元 ${unit.unitNo} 原库位与新库位相同，拒绝移库`, details: {} })
      }
      const fromLocation = locations.find((l) => l.code === unit.locationCode)
      if (fromLocation && fromLocation.warehouseId !== toLocation.warehouseId) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A-T13-4] 单元 ${unit.unitNo} 跨仓移动拒绝：移库仅限同仓内库位移动（跨仓请走调拨）`, details: {} })
      }
      const quantity = typeof p['quantity'] === 'string' ? p['quantity'] : unit.quantity
      const fromCode = unit.locationCode
      unit.locationCode = toLocation.code
      const record: MockMoveRecord = { id: `mv-${Math.random().toString(36).slice(2, 8)}`, inventoryUnitId: unit.unitId, unitNo: unit.unitNo, fromLocationCode: fromCode, toLocationCode: toLocation.code, quantity, uomCode: unit.uomCode, movedBy: 'admin', movedAt: MOCK_NOW, reason: typeof p['reason'] === 'string' ? p['reason'] : null }
      moveRecords.unshift(record)
      return okCommand({ moveId: record.id, unitNo: unit.unitNo, fromLocationCode: fromCode, toLocationCode: toLocation.code }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/warehousing\/transfers$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const fromWarehouseId = typeof p['fromWarehouseId'] === 'string' ? p['fromWarehouseId'] : ''
      const toWarehouseId = typeof p['toWarehouseId'] === 'string' ? p['toWarehouseId'] : ''
      const transitLocationCode = typeof p['transitLocationCode'] === 'string' ? p['transitLocationCode'] : ''
      const rawLines = Array.isArray(p['lines']) ? (p['lines'] as Array<Record<string, unknown>>) : []
      if (!fromWarehouseId || !toWarehouseId || !transitLocationCode || rawLines.length === 0) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: 'warehousing.transfer.create：载荷需要 fromWarehouseId/toWarehouseId/transitLocationCode/lines', details: {} })
      }
      if (fromWarehouseId === toWarehouseId) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A-T13-6] 调入仓库不得等于调出仓库', details: {} })
      }
      const fromWh = warehouses.find((w) => w.id === fromWarehouseId)
      const transitLocation = locations.find((l) => l.code === transitLocationCode)
      if (!fromWh || !transitLocation) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '调出仓库或中转库位不存在', details: {} })
      const lines: MockTransferLine[] = []
      for (const line of rawLines) {
        const unitId = typeof line['unitId'] === 'string' ? line['unitId'] : ''
        const unit = [...units, ...feedUnits].find((u) => u.unitId === unitId || u.unitNo === line['unitNo'])
        if (!unit) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: `调拨行库存单元不存在：${String(line['unitNo'] ?? unitId)}`, details: {} })
        const unitLocation = locations.find((l) => l.code === unit.locationCode)
        if (!unitLocation || unitLocation.warehouseId !== fromWarehouseId) {
          throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A-T13-7] 单元 ${unit.unitNo} 不在调出仓库（仓库匹配校验失败）`, details: {} })
        }
        if (unit.status !== 'in_stock') {
          throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A-T13-7] 单元 ${unit.unitNo} 库存状态为 ${unit.status}，仅在库码可调拨出库`, details: {} })
        }
        lines.push({ id: `tl-${Math.random().toString(36).slice(2, 8)}`, lineNo: lines.length + 1, inventoryUnitId: unit.unitId, unitNo: unit.unitNo, materialCode: typeof line['materialCode'] === 'string' ? line['materialCode'] : unit.materialCode, quantity: typeof line['quantity'] === 'string' ? line['quantity'] : unit.quantity, outQty: '0.0000', inQty: '0.0000', reservationId: null, outDone: false, inDone: false })
      }
      const id = `tf-${Math.random().toString(36).slice(2, 8)}`
      const orderNo = `TR-2026-1027-${String(transfers.length + 10).padStart(3, '0')}`
      const toWh = warehouses.find((w) => w.id === toWarehouseId)
      transfers.unshift({ id, orderNo, transferKind: p['transferKind'] === 'production' ? 'production' : p['transferKind'] === 'auto' ? 'auto' : 'warehouse', fromWarehouseId, toWarehouseId, fromWarehouseCode: fromWh.code, toWarehouseCode: toWh?.code ?? null, status: 'draft', transitLocationId: transitLocation.id, transitLocationCode: transitLocation.code, lockedValidUntil: null, note: typeof p['note'] === 'string' ? p['note'] : null, submittedAt: null, shippedAt: null, completedAt: null, lines })
      return okCommand({ transferOrderId: id, orderNo, status: 'draft', lineCount: lines.length }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/warehousing\/transfers\/submit$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const transferOrderId = typeof p['transferOrderId'] === 'string' ? p['transferOrderId'] : ''
      const lockValidUntil = typeof p['lockValidUntil'] === 'string' ? p['lockValidUntil'] : ''
      const t = transfers.find((x) => x.id === transferOrderId)
      if (!t) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '调拨单不存在或不在授权数据范围内', details: {} })
      if (!lockValidUntil) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A-T13-11] 调拨锁定（作业预留）必须含有效期（valid_until，ISO-8601）', details: {} })
      }
      if (Number.isNaN(Date.parse(lockValidUntil)) || new Date(lockValidUntil).getTime() <= Date.now()) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A-T13-11] 调拨锁定有效期必须晚于当前时间（不得签发即时过期锁定）', details: {} })
      }
      if (t.status !== 'draft') {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A-T13-10] 仅草稿可提交（当前状态 ${t.status}）`, details: {} })
      }
      t.status = 'ready'
      t.lockedValidUntil = lockValidUntil
      t.submittedAt = MOCK_NOW
      for (const l of t.lines) l.reservationId = `rsv-${t.id}-${l.lineNo}`
      return okCommand({ transferOrderId: t.id, orderNo: t.orderNo, status: 'ready', lockedValidUntil: lockValidUntil }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/warehousing\/transfers\/ship$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const t = transfers.find((x) => x.id === p['transferOrderId'])
      if (!t) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '调拨单不存在或不在授权数据范围内', details: {} })
      if (t.status !== 'ready' && t.status !== 'shipping') {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A-T13-10] 调拨状态 ${t.status} 不可出库（须待执行/出库中）`, details: {} })
      }
      const line = t.lines.find((l) => l.id === p['lineId'])
      if (!line) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '调拨行不存在', details: {} })
      if (line.outDone) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '该行已完成出库（幂等拒绝，请勿重复提交）', details: {} })
      }
      const qty = typeof p['quantity'] === 'string' && p['quantity'] ? p['quantity'] : line.quantity
      if (Number(qty) > Number(line.quantity) - Number(line.outQty)) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A-T13-7] 行 ${String(line.lineNo)} 本次调出量超过行计划量（剩余 ${(Number(line.quantity) - Number(line.outQty)).toFixed(4)}）`, details: {} })
      }
      line.outQty = (Number(line.outQty) + Number(qty)).toFixed(4)
      line.outDone = Number(line.outQty) >= Number(line.quantity)
      if (t.status === 'ready') t.status = 'shipping'
      return okCommand({ transferOrderId: t.id, lineId: line.id, outQty: line.outQty, outDone: line.outDone, status: t.status }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/warehousing\/transfers\/transit$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const t = transfers.find((x) => x.id === p['transferOrderId'])
      if (!t) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '调拨单不存在或不在授权数据范围内', details: {} })
      if (t.lines.some((l) => !l.outDone)) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A-T13-10] 存在未完成出库的行，不可推进在途', details: {} })
      }
      if (t.status === 'shipped_in_transit' || t.status === 'receiving' || t.status === 'completed') {
        return okCommand({ transferOrderId: t.id, status: t.status, idempotent: true }, meta)
      }
      if (t.status !== 'shipping') {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A-T13-10] 调拨状态 ${t.status} 不可推进在途（须出库中且各行出库完成）`, details: {} })
      }
      t.status = 'shipped_in_transit'
      t.shippedAt = MOCK_NOW
      return okCommand({ transferOrderId: t.id, status: 'shipped_in_transit' }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/warehousing\/transfers\/receive$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const t = transfers.find((x) => x.id === p['transferOrderId'])
      if (!t) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '调拨单不存在或不在授权数据范围内', details: {} })
      if (t.status !== 'shipped_in_transit' && t.status !== 'receiving') {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A-T13-10] 调拨尚未出库在途，不可接收（当前状态 ${t.status}）`, details: {} })
      }
      const line = t.lines.find((l) => l.id === p['lineId'])
      if (!line) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '调拨行不存在', details: {} })
      if (!line.outDone) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A-T13-10] 行 ${String(line.lineNo)} 尚未完成出库，不可接收`, details: {} })
      }
      if (line.inDone) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '该行已完成接收（幂等拒绝，请勿重复提交）', details: {} })
      }
      const qty = typeof p['quantity'] === 'string' && p['quantity'] ? p['quantity'] : (Number(line.quantity) - Number(line.outQty) + Number(line.inQty)).toFixed(4)
      line.inQty = (Number(line.inQty) + Number(qty)).toFixed(4)
      line.inDone = Number(line.inQty) >= Number(line.quantity)
      if (t.status === 'shipped_in_transit') t.status = 'receiving'
      let completed = false
      if (t.lines.every((l) => l.inDone)) {
        t.status = 'completed'
        t.completedAt = MOCK_NOW
        completed = true
      }
      return okCommand({ transferOrderId: t.id, lineId: line.id, inQty: line.inQty, inDone: line.inDone, status: t.status, completed }, meta)
    },
  },
  // ---------------- shipping（T14 装箱发运；查询+11 命令，服务端口径路由） ----------------
  {
    method: 'GET',
    pattern: /^\/shipping\/shipment-orders$/,
    keys: [],
    handler: ({ query }) => {
      const statuses = (query.get('statuses') ?? '').split(',').filter(Boolean)
      const plNoLike = (query.get('plNoLike') ?? '').trim()
      let list = shipments.slice()
      if (statuses.length > 0) list = list.filter((s) => statuses.includes(s.status))
      if (plNoLike) list = list.filter((s) => s.plNo.includes(plNoLike))
      return paginate(list.map(toShipmentOrderView), query)
    },
  },
  {
    method: 'GET',
    pattern: /^\/shipping\/shipment-orders\/([^/]+)$/,
    keys: ['id'],
    handler: ({ params }) => {
      const s = shipments.find((x) => x.id === params['id'])
      if (!s) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '发货单不存在或不在授权数据范围内', details: {} })
      return toShipmentDetailView(s)
    },
  },
  {
    method: 'GET',
    pattern: /^\/shipping\/packing-board$/,
    keys: [],
    handler: ({ query }) => {
      const statuses = (query.get('statuses') ?? '').split(',').filter(Boolean)
      const palletCodeLike = (query.get('palletCodeLike') ?? '').trim()
      let list = packingOrders.slice()
      if (statuses.length > 0) list = list.filter((p) => statuses.includes(p.status))
      if (palletCodeLike) list = list.filter((p) => p.palletCode.includes(palletCodeLike))
      return paginate(list.map(toPackingOrderView), query)
    },
  },
  {
    method: 'GET',
    pattern: /^\/shipping\/outbound-status$/,
    keys: [],
    handler: ({ query }) => {
      const list = shipments.filter((s) => s.status === 'shipped')
      return paginate(list.map(toShipmentOrderView), query)
    },
  },
  {
    method: 'GET',
    pattern: /^\/shipping\/dc-compositions$/,
    keys: [],
    handler: ({ query }) => {
      const soNo = query.get('salesOrderNo')
      if (!soNo) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '缺少 salesOrderNo 查询参数', details: {} })
      }
      return dcCompositions
        .filter((c) => c.salesOrderNo === soNo)
        .map((c) => ({ id: c.id, dcId: c.dcId, salesOrderNo: c.salesOrderNo, lineNo: c.lineNo, syncStatus: c.syncStatus, composition: c.composition, missingMarkedAt: c.missingMarkedAt, plantId: 'n-plant' }))
    },
  },
  {
    method: 'POST',
    pattern: /^\/shipping\/dc-composition\/inbound$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const dcId = typeof p['dcId'] === 'string' ? p['dcId'] : ''
      const salesOrderNo = typeof p['salesOrderNo'] === 'string' ? p['salesOrderNo'] : ''
      const lineNo = typeof p['lineNo'] === 'number' && Number.isInteger(p['lineNo']) ? p['lineNo'] : NaN
      if (!dcId || !salesOrderNo) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A-T14-1] shipping.dc-composition.inbound：载荷缺少必填字段 dcId/salesOrderNo', details: {} })
      }
      if (!Number.isInteger(lineNo) || lineNo < 1) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[IF-04] lineNo 必须为正整数', details: {} })
      }
      if (p['plantId'] === undefined) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[IF-00.8] DC 组成 dcId 缺组织映射（plantId），已写入隔离队列（QUARANTINED），不重复应用', details: {} })
      }
      const existing = dcCompositions.find((c) => c.dcId === dcId && c.salesOrderNo === salesOrderNo && c.lineNo === lineNo)
      if (existing) {
        return okCommand({ dcCompositionId: existing.id, dcId, salesOrderNo, lineNo, skipped: true, syncStatus: existing.syncStatus }, meta)
      }
      const composition = p['composition'] !== undefined && p['composition'] !== null && typeof p['composition'] === 'object' && !Array.isArray(p['composition'])
        ? (p['composition'] as Record<string, unknown>)
        : null
      const row: MockDcComposition = { id: `dcc-${Math.random().toString(36).slice(2, 8)}`, dcId, salesOrderNo, lineNo, syncStatus: composition === null ? 'missing' : 'received', composition, missingMarkedAt: composition === null ? MOCK_NOW : null }
      dcCompositions.unshift(row)
      return okCommand({ dcCompositionId: row.id, dcId, salesOrderNo, lineNo, skipped: false, syncStatus: row.syncStatus }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/shipping\/pl\/inbound$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const plNo = typeof p['plNo'] === 'string' ? p['plNo'] : ''
      const salesOrderNo = typeof p['salesOrderNo'] === 'string' ? p['salesOrderNo'] : ''
      if (!plNo || !salesOrderNo) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A-T14-1] shipping.pl.inbound：载荷缺少必填字段 plNo/salesOrderNo', details: {} })
      }
      if (p['plantId'] === undefined) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[IF-00.8] 发货单 PL 缺组织映射（plantId），已写入隔离队列（QUARANTINED），不重复应用', details: {} })
      }
      const existing = shipments.find((s) => s.plNo === plNo)
      if (existing) {
        return okCommand({ orderId: existing.id, plNo, skipped: true, status: existing.status, created: 0 }, meta)
      }
      const rawLines = Array.isArray(p['lines']) ? (p['lines'] as Array<Record<string, unknown>>) : []
      if (rawLines.length === 0) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A-T14-1] PL 载荷至少包含一行备货行（三类行之一）', details: {} })
      }
      const newLines: MockShipmentLine[] = []
      for (const [index, raw] of rawLines.entries()) {
        const kind = typeof raw['lineKind'] === 'string' ? raw['lineKind'] : ''
        if (kind !== 'pallet' && kind !== 'axis_item' && kind !== 'plain_item') {
          throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A-T14-3] 第 ${index + 1} 行 lineKind 必须为 pallet/axis_item/plain_item`, details: {} })
        }
        if (kind === 'axis_item' && !raw['customerAxisNo']) {
          throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A-T14-3] 第 ${index + 1} 行为有轴单品，缺少客户轴号`, details: {} })
        }
        const requiredRaw = raw['requiredCount'] ?? (kind === 'axis_item' ? 1 : kind === 'pallet' ? raw['totalAxes'] : raw['pieces'])
        const requiredCount = typeof requiredRaw === 'number' && Number.isInteger(requiredRaw) ? requiredRaw : 0
        if (requiredCount < 1) {
          throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A-T14-3] 第 ${index + 1} 行应扫数必须为正整数`, details: {} })
        }
        newLines.push({
          id: `sl-${Math.random().toString(36).slice(2, 8)}`,
          shipmentOrderId: '',
          lineNo: typeof raw['lineNo'] === 'number' && Number.isInteger(raw['lineNo']) ? raw['lineNo'] : index + 1,
          lineKind: kind as MockShipmentLine['lineKind'],
          materialId: typeof raw['materialId'] === 'string' ? raw['materialId'] : null,
          materialCode: typeof raw['materialCode'] === 'string' ? raw['materialCode'] : '',
          salesOrderLineNo: typeof raw['salesOrderLineNo'] === 'string' ? raw['salesOrderLineNo'] : String(index + 1),
          customerAxisNo: kind === 'axis_item' && typeof raw['customerAxisNo'] === 'string' ? raw['customerAxisNo'] : null,
          standardSegmentLength: kind === 'axis_item' && typeof raw['standardSegmentLength'] === 'string' ? raw['standardSegmentLength'] : null,
          actualSegmentLength: null,
          segmentLength: kind === 'plain_item' && typeof raw['segmentLength'] === 'string' ? raw['segmentLength'] : null,
          requiredCount,
          scannedCount: 0,
          lineStatus: 'pending_packing',
          packingStatus: kind === 'pallet' ? 'pending' : null,
          packingOrderId: null,
        })
      }
      const composedLineNos = new Set(dcCompositions.filter((c) => c.composition !== null && c.salesOrderNo === salesOrderNo).map((c) => String(c.lineNo)))
      const compositionMissing = newLines.some((l) => !composedLineNos.has(l.salesOrderLineNo))
      const order: MockShipment = {
        id: `shp-${Math.random().toString(36).slice(2, 8)}`,
        plNo,
        salesOrderNo,
        customerName: typeof p['customerName'] === 'string' ? p['customerName'] : null,
        status: 'pending_packing',
        compositionMissing,
        outboundBy: null,
        outboundAt: null,
        actualAxisSyncStatus: 'pending',
        shippingStatusSyncStatus: 'pending',
        actualAxisSnapshot: null,
        statusSyncSnapshot: null,
        createdAt: MOCK_NOW,
      }
      shipments.unshift(order)
      for (const l of newLines) {
        l.shipmentOrderId = order.id
        shipmentLines.push(l)
      }
      return okCommand({ orderId: order.id, plNo, skipped: false, created: 1, compositionMissing, status: order.status, lines: newLines.map((l) => ({ lineId: l.id, lineNo: l.lineNo, lineKind: l.lineKind })) }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/shipping\/packing$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const plantId = typeof p['plantId'] === 'string' ? p['plantId'] : ''
      const shipmentOrderId = typeof p['shipmentOrderId'] === 'string' ? p['shipmentOrderId'] : ''
      const palletCode = typeof p['palletCode'] === 'string' ? p['palletCode'] : ''
      const toLocationId = typeof p['toLocationId'] === 'string' ? p['toLocationId'] : ''
      const toLocationCode = typeof p['toLocationCode'] === 'string' ? p['toLocationCode'] : ''
      if (!plantId || !shipmentOrderId || !palletCode || !toLocationId || !toLocationCode) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A-T14-4] 打包任务创建须先扫托码+选调入库位（plantId/shipmentOrderId/palletCode/toLocationId/toLocationCode 必填）', details: {} })
      }
      const order = shipments.find((s) => s.id === shipmentOrderId)
      if (!order) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '发货单不存在', details: {} })
      if (order.status === 'shipped') {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A-T14-4] PL 已出库，不可再创建打包任务', details: {} })
      }
      const palletLines = shipmentLinesByOrder(order.id).filter((l) => l.lineKind === 'pallet' && l.packingOrderId === null)
      if (palletLines.length === 0) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A-T14-4] 打包任务至少关联一条托盘行（本单无托盘行无须打包任务）', details: {} })
      }
      const boundPacking = packingOrders.find((x) => x.palletCode === palletCode && x.status === 'bound')
      if (boundPacking) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A-T14-4] 托码 ${palletCode} 已打包（bound），托码与库位只读，不得重复打包`, details: {} })
      }
      const packing: MockPacking = {
        id: `pk-${Math.random().toString(36).slice(2, 8)}`,
        packingNo: `PK-${Date.now().toString(36).toUpperCase()}`,
        shipmentOrderId: order.id,
        palletCode,
        toLocationId,
        toLocationCode,
        status: 'pending',
        boundBy: null,
        boundAt: null,
      }
      packingOrders.unshift(packing)
      const linked: string[] = []
      for (const l of palletLines) {
        l.packingOrderId = packing.id
        l.packingStatus = 'pending'
        linked.push(l.id)
      }
      return okCommand({ packingId: packing.id, packingNo: packing.packingNo, palletCode, toLocationCode, linkedLines: linked, status: packing.status }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/shipping\/packing\/bind$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const plantId = typeof p['plantId'] === 'string' ? p['plantId'] : ''
      const packingOrderId = typeof p['packingOrderId'] === 'string' ? p['packingOrderId'] : ''
      if (!plantId || !packingOrderId) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A-T14-4] shipping.packing.bind：载荷缺少必填字段 plantId/packingOrderId', details: {} })
      }
      const packing = packingOrders.find((x) => x.id === packingOrderId)
      if (!packing) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '打包任务不存在', details: {} })
      if (packing.status !== 'pending') {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A-T14-4] 打包任务状态为 ${packing.status}，仅待打包（pending）可绑定托码（已打包托码库位只读）`, details: {} })
      }
      const linkedLines = shipmentLinesByOrder(packing.shipmentOrderId).filter((l) => l.packingOrderId === packing.id)
      const unfinished = linkedLines.filter((l) => l.scannedCount < l.requiredCount)
      if (unfinished.length > 0) {
        throw new MockError({
          httpStatus: 422,
          code: 'ERR_BUSINESS_RULE',
          message: `[A-T14-4] 绑定托码要求每行已扫完：行 ${unfinished.map((l) => l.id).join('、')} 已扫/应扫未满（${unfinished.map((l) => `${l.scannedCount}/${l.requiredCount}`).join('、')}）`,
          details: {},
        })
      }
      packing.status = 'bound'
      packing.boundBy = 'admin'
      packing.boundAt = MOCK_NOW
      for (const l of linkedLines) l.packingStatus = 'bound'
      return okCommand({ packingId: packing.id, status: 'bound', palletCode: packing.palletCode, boundLines: linkedLines.length, boundAt: packing.boundAt }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/shipping\/scan\/load$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const shipmentOrderId = typeof p['shipmentOrderId'] === 'string' ? p['shipmentOrderId'] : ''
      const lineId = typeof p['lineId'] === 'string' ? p['lineId'] : ''
      const unitNo = typeof p['unitNo'] === 'string' ? p['unitNo'] : ''
      if (!p['plantId'] || !shipmentOrderId || !lineId || !unitNo) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A-T14-3] shipping.scan.load：载荷缺少必填字段 plantId/shipmentOrderId/lineId/unitNo', details: {} })
      }
      const order = shipments.find((s) => s.id === shipmentOrderId)
      if (!order) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '发货单不存在', details: {} })
      if (order.status === 'shipped') {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A-T14-3] PL 已出库，不可再装入', details: {} })
      }
      const line = shipmentLines.find((l) => l.id === lineId && l.shipmentOrderId === order.id)
      if (!line) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '备货行不存在或不属于该发货单', details: {} })
      const unit = shippingDemoUnits.find((u) => u.unitNo === unitNo)
      if (!unit) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: `库存单元 ${unitNo} 不存在`, details: {} })
      // A-T14-3 五拒一成（与 domain assertScanLoadable 同链序）
      if (packingScans.some((x) => x.shipmentOrderId === order.id && x.unitNo === unitNo && !x.deleted)) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A-T14-3] 码 ${unitNo} 已装入本单且未删除，拒绝重复装入`, details: {} })
      }
      if (unit.status !== 'in_stock') {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A-T14-3] 码 ${unitNo} 不在库（当前 ${unit.status}），仅库存内码可装入`, details: {} })
      }
      if (unit.qualityStatus === 'suspect') {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A-T14-3] 码 ${unitNo} 质量存疑，拒绝装入（存疑不受参数控制恒拒）`, details: {} })
      }
      if (unit.qualityStatus !== 'qualified') {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A-T14-3] 码 ${unitNo} 未审核（质量状态 ${unit.qualityStatus}，仅合格可用码可装入）`, details: {} })
      }
      if (unit.locked) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A-T14-3] 码 ${unitNo} 被其它业务锁定（活动作业预留），拒绝装入`, details: {} })
      }
      const segment = line.lineKind === 'axis_item' ? line.standardSegmentLength : line.lineKind === 'plain_item' ? line.segmentLength : null
      if (line.lineKind !== 'pallet' && segment === null) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A-T14-3] 备货行 ${line.id} 无段长（快照缺失），拒收`, details: {} })
      }
      if (line.scannedCount >= line.requiredCount) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A-T14-3] 备货行 ${line.id} 已扫满（已扫 ${line.scannedCount}/应扫 ${line.requiredCount}），拒绝多扫`, details: {} })
      }
      const actualSegmentLength = typeof p['actualSegmentLength'] === 'string' ? p['actualSegmentLength'] : unit.actualSegmentLength
      const scan: MockScan = {
        id: `scan-${Math.random().toString(36).slice(2, 8)}`,
        shipmentOrderId: order.id,
        shipmentLineId: line.id,
        scanKind: 'load',
        inventoryUnitId: unit.unitId,
        unitNo,
        customerAxisNo: line.customerAxisNo,
        actualSegmentLength,
        scannedBy: 'admin',
        scannedAt: MOCK_NOW,
        deleted: false,
        deletedBy: null,
        deletedAt: null,
      }
      packingScans.unshift(scan)
      line.scannedCount += 1
      line.lineStatus = line.scannedCount >= line.requiredCount ? 'packed' : 'pending_packing'
      if (line.lineKind === 'axis_item' && actualSegmentLength !== null) line.actualSegmentLength = actualSegmentLength
      const nextStatus = deriveShipmentStatus(order.id)
      if (nextStatus !== order.status) order.status = nextStatus
      return okCommand({ scanId: scan.id, unitNo, lineId: line.id, scannedCount: line.scannedCount, requiredCount: line.requiredCount, lineStatus: line.lineStatus, orderStatus: order.status }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/shipping\/scan\/delete$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const shipmentOrderId = typeof p['shipmentOrderId'] === 'string' ? p['shipmentOrderId'] : ''
      const scanId = typeof p['scanId'] === 'string' ? p['scanId'] : ''
      if (!p['plantId'] || !shipmentOrderId || !scanId) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A-T14-3] shipping.scan.delete：载荷缺少必填字段 plantId/shipmentOrderId/scanId', details: {} })
      }
      const order = shipments.find((s) => s.id === shipmentOrderId)
      if (!order) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '发货单不存在', details: {} })
      const scan = packingScans.find((x) => x.id === scanId && x.shipmentOrderId === order.id)
      if (!scan) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '扫码记录不存在或不属于该发货单', details: {} })
      if (scan.deleted) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A-T14-3] 扫码记录已删除，不可重复删码', details: {} })
      }
      if (order.status === 'shipped') {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A-T14-3] PL 已出库，扫码记录不可删除', details: {} })
      }
      const line = shipmentLines.find((l) => l.id === scan.shipmentLineId)
      if (!line) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '备货行不存在', details: {} })
      scan.deleted = true
      scan.deletedBy = 'admin'
      scan.deletedAt = MOCK_NOW
      line.scannedCount = Math.max(0, line.scannedCount - 1)
      line.lineStatus = line.scannedCount >= line.requiredCount ? 'packed' : 'pending_packing'
      order.status = deriveShipmentStatus(order.id)
      return okCommand({ scanId: scan.id, deleted: true, scannedCount: line.scannedCount, lineStatus: line.lineStatus, orderStatus: order.status }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/shipping\/scan\/supplement$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const shipmentOrderId = typeof p['shipmentOrderId'] === 'string' ? p['shipmentOrderId'] : ''
      const lineId = typeof p['lineId'] === 'string' ? p['lineId'] : ''
      const unitNo = typeof p['unitNo'] === 'string' ? p['unitNo'] : ''
      if (!p['plantId'] || !shipmentOrderId || !lineId || !unitNo) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A-T14-5] shipping.scan.supplement：载荷缺少必填字段 plantId/shipmentOrderId/lineId/unitNo', details: {} })
      }
      const order = shipments.find((s) => s.id === shipmentOrderId)
      if (!order) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '发货单不存在', details: {} })
      if (order.status === 'shipped') {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A-T14-5] PL 已出库，不可再补码', details: {} })
      }
      const line = shipmentLines.find((l) => l.id === lineId && l.shipmentOrderId === order.id)
      if (!line) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '备货行不存在或不属于该发货单', details: {} })
      if (line.lineKind !== 'plain_item') {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A-T14-5] 补码仅适用于无轴单品行（当前行类型 ${line.lineKind}；有轴单品经扫码装入、托盘行逐轴扫满）`, details: {} })
      }
      if (line.scannedCount >= line.requiredCount) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A-T14-5] 无轴行已扫满（已扫 ${line.scannedCount}/应扫 ${line.requiredCount}），补码 ${unitNo} 拒绝（C-7 缺口按应扫上限 fail-closed）`, details: {} })
      }
      if (packingScans.some((x) => x.shipmentOrderId === order.id && x.unitNo === unitNo && !x.deleted)) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A-T14-5] 轴号 ${unitNo} 已登记本单且未删除，拒绝重复补码`, details: {} })
      }
      const scan: MockScan = {
        id: `scan-${Math.random().toString(36).slice(2, 8)}`,
        shipmentOrderId: order.id,
        shipmentLineId: line.id,
        scanKind: 'supplement',
        inventoryUnitId: null,
        unitNo,
        customerAxisNo: null,
        actualSegmentLength: typeof p['actualSegmentLength'] === 'string' ? p['actualSegmentLength'] : line.segmentLength,
        scannedBy: 'admin',
        scannedAt: MOCK_NOW,
        deleted: false,
        deletedBy: null,
        deletedAt: null,
      }
      packingScans.unshift(scan)
      line.scannedCount += 1
      line.lineStatus = line.scannedCount >= line.requiredCount ? 'packed' : 'pending_packing'
      order.status = deriveShipmentStatus(order.id)
      return okCommand({ scanId: scan.id, unitNo, lineId: line.id, scanKind: 'supplement', scannedCount: line.scannedCount, requiredCount: line.requiredCount, lineStatus: line.lineStatus, orderStatus: order.status }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/shipping\/ship\/confirm$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const shipmentOrderId = typeof p['shipmentOrderId'] === 'string' ? p['shipmentOrderId'] : ''
      if (!p['plantId'] || !shipmentOrderId) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A-T14-7] shipping.ship.confirm：载荷缺少必填字段 plantId/shipmentOrderId', details: {} })
      }
      const order = shipments.find((s) => s.id === shipmentOrderId)
      if (!order) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '发货单不存在', details: {} })
      const lines = shipmentLinesByOrder(order.id)
      if (order.status !== 'ready_to_ship') {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A-T14-7] 确认出库仅可自 待出库 执行（当前 ${order.status}）`, details: {} })
      }
      const short = lines.filter((l) => l.scannedCount < l.requiredCount)
      if (short.length > 0) {
        const detail = short
          .map((l) => `料品 ${l.materialCode}（段长 ${l.standardSegmentLength ?? l.segmentLength ?? '无'}，行 ${l.lineNo}）：已扫 ${l.scannedCount}/应扫 ${l.requiredCount}`)
          .join('；')
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[A-T14-7] 存在已扫<应扫的备货行，拒绝确认出库——${detail}`, details: {} })
      }
      // 实发轴差异判定（resolveActualAxisSyncDecision 同口径）
      const plannedCustomerAxes = lines.filter((l) => l.lineKind === 'axis_item' && l.customerAxisNo !== null).map((l) => l.customerAxisNo!)
      const actualAxes = packingScans.filter((x) => x.shipmentOrderId === order.id && !x.deleted && x.scanKind === 'load').map((x) => x.unitNo)
      const missingOnActual = plannedCustomerAxes.filter((a) => !actualAxes.includes(a))
      const extraOnActual = actualAxes.filter((a) => !plannedCustomerAxes.includes(a))
      const hasDiff = missingOnActual.length > 0 || extraOnActual.length > 0
      // 已扫合格单元 → shipped（库存记已发货）
      const posted: Array<Record<string, unknown>> = []
      for (const scan of packingScans.filter((x) => x.shipmentOrderId === order.id && !x.deleted && x.scanKind === 'load')) {
        const unit = shippingDemoUnits.find((u) => u.unitNo === scan.unitNo)
        if (unit && unit.status === 'in_stock') {
          unit.status = 'shipped'
          posted.push({ unitNo: unit.unitNo, transactionId: `tx-${Math.random().toString(36).slice(2, 8)}` })
        }
      }
      order.status = 'shipped'
      order.outboundBy = 'admin'
      order.outboundAt = MOCK_NOW
      order.actualAxisSyncStatus = hasDiff ? 'pending' : 'noop_needed'
      order.shippingStatusSyncStatus = 'pending'
      order.actualAxisSnapshot = { plannedCustomerAxes, actualAxes, missingOnActual, extraOnActual, decidedAt: MOCK_NOW }
      order.statusSyncSnapshot = { plNo: order.plNo, salesOrderNo: order.salesOrderNo, status: 'shipped', completedAt: MOCK_NOW }
      return okCommand({
        orderId: order.id,
        plNo: order.plNo,
        status: 'shipped',
        outboundBy: order.outboundBy,
        outboundAt: order.outboundAt,
        postedUnits: posted.length,
        posted,
        actualAxisSyncStatus: order.actualAxisSyncStatus,
        actualAxisDiff: hasDiff ? { missingOnActual, extraOnActual } : null,
        shippingStatusSyncStatus: order.shippingStatusSyncStatus,
      }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/shipping\/sync\/actual-axis\/retry$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const order = shipments.find((s) => s.id === p['shipmentOrderId'])
      if (!order) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '发货单不存在', details: {} })
      if (order.status !== 'shipped') {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[IF-06] 实发轴同步仅已出库发货单参与（当前 ${order.status}）`, details: {} })
      }
      if (order.actualAxisSyncStatus === 'synced' || order.actualAxisSyncStatus === 'noop_needed') {
        return okCommand({ orderId: order.id, task: 'actual-axis-sync', skipped: true, status: order.actualAxisSyncStatus, dispatched: false }, meta)
      }
      const outcome = p['outcome'] === 'failure' ? 'failure' : 'success'
      order.actualAxisSyncStatus = outcome === 'success' ? 'synced' : 'sync_failed'
      return okCommand({ orderId: order.id, task: 'actual-axis-sync', skipped: false, outcome, dispatched: outcome === 'success', status: order.actualAxisSyncStatus, snapshot: order.actualAxisSnapshot }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/shipping\/sync\/status\/retry$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const order = shipments.find((s) => s.id === p['shipmentOrderId'])
      if (!order) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '发货单不存在', details: {} })
      if (order.status !== 'shipped') {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: `[IF-07] 发货状态同步仅已出库发货单参与（当前 ${order.status}）`, details: {} })
      }
      if (order.shippingStatusSyncStatus === 'synced') {
        return okCommand({ orderId: order.id, task: 'status-sync', skipped: true, status: order.shippingStatusSyncStatus, dispatched: false }, meta)
      }
      const outcome = p['outcome'] === 'failure' ? 'failure' : 'success'
      order.shippingStatusSyncStatus = outcome === 'success' ? 'synced' : 'sync_failed'
      return okCommand({ orderId: order.id, task: 'status-sync', skipped: false, outcome, dispatched: outcome === 'success', status: order.shippingStatusSyncStatus, snapshot: order.statusSyncSnapshot }, meta)
    },
  },
  {
    method: 'POST',
    pattern: /^\/shipping\/photos$/,
    keys: [],
    handler: ({ body, meta }) => {
      const p = (body ?? {}) as Record<string, unknown>
      const order = shipments.find((s) => s.id === p['shipmentOrderId'])
      if (!order) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '发货单不存在', details: {} })
      const photosPayload = Array.isArray(p['photos']) ? (p['photos'] as Array<Record<string, unknown>>) : []
      if (photosPayload.length === 0) {
        throw new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message: '[A-T14-10] 装箱图附件至少一张（photos 数组）', details: {} })
      }
      const attached: Array<Record<string, unknown>> = []
      const failed: Array<Record<string, unknown>> = []
      for (const [index, raw] of photosPayload.entries()) {
        const fileName = typeof raw['fileName'] === 'string' ? raw['fileName'] : undefined
        const storageKey = typeof raw['storageKey'] === 'string' ? raw['storageKey'] : undefined
        if (!fileName || !storageKey) {
          failed.push({ index, fileName, reason: '缺少 fileName 或 storageKey' })
          continue
        }
        const photo: MockPhoto = {
          id: `ph-${Math.random().toString(36).slice(2, 8)}`,
          shipmentOrderId: order.id,
          fileName,
          storageKey,
          contentType: typeof raw['contentType'] === 'string' ? raw['contentType'] : null,
          sizeBytes: typeof raw['sizeBytes'] === 'number' && Number.isInteger(raw['sizeBytes']) ? raw['sizeBytes'] : null,
          uploadedBy: 'admin',
          uploadedAt: MOCK_NOW,
        }
        shipmentPhotos.unshift(photo)
        attached.push({ photoId: photo.id, fileName })
      }
      return okCommand({ orderId: order.id, attached, failed }, meta)
    },
  },
  // ---------------- PDA（占位演示数据） ----------------
  {
    method: 'GET',
    pattern: /^\/pda\/tasks$/,
    keys: [],
    handler: ({ query }) => {
      const status = query.get('status')
      const filtered = status ? tasks.filter((t) => t.status === status) : tasks
      return paginate(filtered, query)
    },
  },
  // ---------------- purchase（T08；空库列表 + 模拟入站 sync） ----------------
  {
    method: 'GET',
    pattern: /^\/purchase\/order-lines$/,
    keys: [],
    handler: ({ query }) => {
      const page = Number(query.get('page') ?? '1') || 1
      const pageSize = Number(query.get('pageSize') ?? '10') || 10
      return { items: [], total: 0, page, pageSize }
    },
  },
  {
    method: 'POST',
    pattern: /^\/purchase\/orders\/sync$/,
    keys: [],
    handler: ({ body, meta }) => {
      const b = (body ?? {}) as Record<string, unknown>
      if (typeof b.orgCode !== 'string' || !b.orgCode) {
        throw new MockError({ code: 'ERR_BUSINESS_RULE', message: '[A-3] purchase.order-sync：载荷缺少必填字段 orgCode', httpStatus: 422, details: {} })
      }
      if (typeof b.orderNo !== 'string' || !b.orderNo) {
        throw new MockError({ code: 'ERR_BUSINESS_RULE', message: '[A-3] purchase.order-sync：载荷缺少必填字段 orderNo', httpStatus: 422, details: {} })
      }
      return okCommand({ orderNo: b.orderNo, applied: true }, meta)
    },
  },

]

function handleGrantBody(body: unknown, meta: CommandMeta | undefined, action: 'grant' | 'revoke'): Record<string, unknown> {
  const p = (body ?? {}) as Record<string, unknown>
  const principalType = p['principalType'] === 'user' ? 'user' : p['principalType'] === 'role' ? 'role' : undefined
  const principalId = typeof p['principalId'] === 'string' ? p['principalId'] : ''
  const scopeType = typeof p['scopeType'] === 'string' ? p['scopeType'] : ''
  const scopeObjectId = typeof p['scopeObjectId'] === 'string' ? p['scopeObjectId'] : ''
  const permissions = Array.isArray(p['permissions']) && p['permissions'].every((x) => typeof x === 'string') ? (p['permissions'] as string[]) : []
  if (!principalType || !principalId || !scopeType || !scopeObjectId || permissions.length === 0) {
    throw new MockError({
      httpStatus: 422,
      code: 'ERR_BUSINESS_RULE',
      message: 'payload 需要 principalType/principalId/scopeType/scopeObjectId/permissions(非空)',
      details: {},
    })
  }
  const row = grants.find(
    (g) => g.principalType === principalType && g.principalId === principalId && g.scopeType === scopeType && g.scopeObjectId === scopeObjectId,
  )
  if (action === 'grant') {
    if (row) {
      row.permissions = [...new Set([...row.permissions, ...permissions])]
      return okCommand({ grantId: row.id, permissions: row.permissions }, meta)
    }
    const created: ScopeGrantDto = {
      id: `grant-mock-${Math.random().toString(36).slice(2, 8)}`,
      principalType,
      principalId,
      permissions,
      scopeType: scopeType as ScopeGrantDto['scopeType'],
      scopeObjectId,
      status: 'active',
    }
    grants.push(created)
    return okCommand({ grantId: created.id, permissions: created.permissions }, meta)
  }
  if (!row) {
    throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '授权行不存在', details: {} })
  }
  row.permissions = row.permissions.filter((x) => !permissions.includes(x))
  if (row.permissions.length === 0) row.status = 'retired'
  return okCommand({ grantId: row.id, permissions: row.permissions }, meta)
}

/** 路由分发：method + path → handler（支持 :id 动态段，params 自动注入）；client mock 模式在此分发 */
export function mockRoutes(method: string, path: string): ((ctx: Omit<MockHandlerContext, 'params'>) => unknown) | null {
  for (const route of routes) {
    if (route.method !== method) continue
    const match = route.pattern.exec(path)
    if (!match) continue
    const params: Record<string, string> = {}
    route.keys.forEach((key, i) => {
      params[key] = decodeURIComponent(match[i + 1] ?? '')
    })
    return (ctx: Omit<MockHandlerContext, 'params'>) => route.handler({ ...ctx, params })
  }
  return null
}

/** 供鉴权演示：mock 会话 token 集合（登录成功后加入，登出移除） */
export const mockSessionTokens = new Set<string>()

export function pageQueryOf(page: PageRequest, extra?: Record<string, string>): URLSearchParams {
  const query = new URLSearchParams({ page: String(page.page), pageSize: String(page.pageSize) })
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v) query.set(k, v)
    }
  }
  return query
}
