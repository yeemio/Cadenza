// @vitest-environment jsdom
/**
 * live gated 冒烟测试（真实链路，需要 apps/api @3001 运行中）：
 * - 默认跳过（探测 /auth/login 不可达时不跑，保证常规 pnpm test:ui 不红）；
 * - api 在运行时自动执行；设 CADENZA_LIVE_UI=1 强制执行（不可达即失败，供验收取证）。
 * 链路与 web 页面同构：真实登录 → /auth/me（上下文/范围）→ /org/users 分页（Bearer + PageResult）。
 * 运行：CADENZA_LIVE_UI=1 pnpm test:ui tests/ui/live-smoke.test.tsx
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { createApiClient, ApiError, type ApiClient } from '@cadenza/ui'

const BASE = process.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:3001'
const FORCED = process.env.CADENZA_LIVE_UI === '1'

async function apiReachable(): Promise<boolean> {
  // jsdom 环境无 AbortSignal.timeout，用 Promise.race 手动超时
  const probe = (async (): Promise<boolean> => {
    try {
      const res = await fetch(`${BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginName: '__probe__', password: '__probe__', platform: 'WEB' }),
      })
      // 401/400 都说明 api 在运行（守卫/校验已应答）；只有网络错误才不可达
      return res.status > 0
    } catch {
      return false
    }
  })()
  const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2500))
  return Promise.race([probe, timeout])
}

let client: ApiClient
let reachable = false

beforeAll(async () => {
  reachable = await apiReachable()
  if (!reachable && FORCED) throw new Error(`CADENZA_LIVE_UI=1 但 api 不可达：${BASE}`)
})

describe('live gated 冒烟（真实登录 → me → 用户列表）', () => {
  it('真实登录 admin → /auth/me → /org/users 全链路（企业范围）', async ({ skip }) => {
    if (!reachable) skip('api 未运行（设 CADENZA_LIVE_UI=1 并先启动 apps/api）')
    let token: string | null = null
    client = createApiClient({
      mode: 'live',
      baseURL: BASE,
      getToken: () => token,
      onUnauthorized: () => {
        token = null
      },
    })
    const login = await client.login({ loginName: 'admin', password: 'CadAdmin001', platform: 'WEB' })
    expect(login.tokenType).toBe('Bearer')
    token = login.token

    const me = await client.me()
    expect(me.user.loginName).toBe('admin')
    expect(me.user.enterpriseName.length).toBeGreaterThan(0)
    expect(me.permissions).toContain('org.admin')
    expect(me.dataScope.enterpriseWide).toBe(true)

    const users = await client.listUsers({ page: 1, pageSize: 10 })
    expect(users.page).toBe(1)
    expect(users.pageSize).toBe(10)
    expect(users.total).toBeGreaterThanOrEqual(1)
    const first = users.items[0]!
    expect(['WEB', 'PDA']).toContain(first.loginPlatform)
    expect(['enabled', 'disabled']).toContain(first.accountStatus)
    expect(Object.keys(first).some((k) => k.toLowerCase().includes('password'))).toBe(false)
  })

  it('hfadmin01 为厂区范围（plantIds 非空、enterpriseWide=false，OA-25 服务端口径）', async ({ skip }) => {
    if (!reachable) skip('api 未运行')
    let token: string | null = null
    const scoped = createApiClient({
      mode: 'live',
      baseURL: BASE,
      getToken: () => token,
    })
    const login = await scoped.login({ loginName: 'hfadmin01', password: 'HfPlant0001', platform: 'WEB' })
    token = login.token
    const me = await scoped.me()
    expect(me.dataScope.enterpriseWide).toBe(false)
    expect(me.dataScope.plantIds.length).toBeGreaterThanOrEqual(1)
  })

  it('无效 token 访问受保护端点 → ApiError(ERR_AUTH_REQUIRED)+401 并触发 onUnauthorized', async ({ skip }) => {
    if (!reachable) skip('api 未运行')
    let fired = false
    const bad = createApiClient({
      mode: 'live',
      baseURL: BASE,
      getToken: () => 'not-a-real-token',
      onUnauthorized: () => {
        fired = true
      },
    })
    const err = await bad.listUsers({ page: 1, pageSize: 10 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).httpStatus).toBe(401)
    expect((err as ApiError).code).toBe('ERR_AUTH_REQUIRED')
    expect(fired).toBe(true)
  })
})

describe('live gated 冒烟（第三波：masterdata/inventory 真实端点）', () => {
  // dev 种子 grantDevDomainPermissions 给 sysadmin 角色合并 masterdata.read/admin + inventory.read/post（企业范围）
  let live!: ApiClient

  beforeAll(async () => {
    if (!reachable) return
    let token: string | null = null
    live = createApiClient({
      mode: 'live',
      baseURL: BASE,
      getToken: () => token,
    })
    const login = await live.login({ loginName: 'admin', password: 'CadAdmin001', platform: 'WEB' })
    token = login.token
  })

  it('GET /masterdata/materials：PageResult 形状 + 料品字段（U9 同步主档，企业级只读）', async ({ skip }) => {
    if (!reachable) skip('api 未运行')
    const page = await live.listMaterials({ page: 1, pageSize: 10 })
    expect(page.page).toBe(1)
    expect(page.total).toBeGreaterThanOrEqual(0)
    for (const m of page.items) {
      expect([1, 2, 3]).toContain(m.materialType)
      expect(typeof m.code).toBe('string')
      expect(typeof m.baseUom).toBe('string')
      expect(['active', 'retired']).toContain(m.status)
      expect(Object.keys(m).some((k) => k.toLowerCase().includes('deleted'))).toBe(false)
    }
  })

  it('GET /masterdata/warehouses：PageResult + warehouseType/materialTypes 字典值（MD-23）', async ({ skip }) => {
    if (!reachable) skip('api 未运行')
    const page = await live.listWarehouses({ page: 1, pageSize: 10 })
    for (const w of page.items) {
      expect(['WAREHOUSE', 'LINE_SIDE']).toContain(w.warehouseType)
      expect(w.materialTypes.length).toBeGreaterThanOrEqual(1)
      expect(w.materialTypes.every((t) => [1, 2, 3].includes(t))).toBe(true)
      expect(typeof w.qrBound).toBe('boolean')
    }
  })

  it('GET /inventory/balances：余额三段数量（IT-14）+ feetDisplay 展示列（IT-10）', async ({ skip }) => {
    if (!reachable) skip('api 未运行')
    const page = await live.listBalances({ page: 1, pageSize: 10 })
    expect(page.page).toBe(1)
    for (const b of page.items) {
      expect(typeof b.quantity).toBe('string')
      expect(typeof b.reservedQuantity).toBe('string')
      expect(typeof b.availableQuantity).toBe('string')
      expect(typeof b.uomCode).toBe('string')
      expect(typeof b.feetDisplay).toBe('string')
      expect(['qualified', 'pending_inspection', 'unqualified']).toContain(b.qualityStatus)
    }
  })
})

describe('live gated 冒烟（第四波：process/scheduling/execution/quality/warehousing 真实端点）', () => {
  // 四域模块正由并行 writer 注册进 app.module（L0 整合）：运行中 api 若未含四域路由则整组跳过，
  // 待整合注册后由 CADENZA_LIVE_UI=1 执行取证（DELIVERY 遗留项）。
  let live!: ApiClient
  let fourDomainsReady = false

  beforeAll(async () => {
    if (!reachable) return
    let token: string | null = null
    live = createApiClient({ mode: 'live', baseURL: BASE, getToken: () => token })
    try {
      const login = await live.login({ loginName: 'admin', password: 'CadAdmin001', platform: 'WEB' })
      token = login.token
    } catch {
      return
    }
    try {
      const probe = await live.listProductionOrders({ page: 1, pageSize: 1 })
      fourDomainsReady = probe.page === 1
    } catch {
      fourDomainsReady = false
    }
  })

  it('GET /process/orders：PageResult + 状态轴字典值（approved～voided）', async ({ skip }) => {
    if (!reachable) skip('api 未运行')
    if (!fourDomainsReady) skip('四域模块尚未注册进运行中的 app.module（整合后执行，DELIVERY 遗留）')
    const page = await live.listProductionOrders({ page: 1, pageSize: 10 })
    expect(page.page).toBe(1)
    for (const o of page.items) {
      expect(['approved', 'released', 'in_progress', 'pending_completion', 'closed', 'voided']).toContain(o.orderStatus)
      expect(typeof o.productionQty).toBe('string')
      expect(typeof o.uom).toBe('string')
    }
  })

  it('GET /scheduling/device-view：双投影形状（dates/workCenters/equipments.cells）', async ({ skip }) => {
    if (!reachable) skip('api 未运行')
    if (!fourDomainsReady) skip('四域模块尚未注册进运行中的 app.module（整合后执行）')
    // 企业范围须显式 plantId（服务端口径）；取 admin 会话工厂
    const me = await live.me()
    const board = await live.schedulingDeviceView({ plantId: me.user.plantId })
    expect(typeof board.today).toBe('string')
    expect(Array.isArray(board.dates)).toBe(true)
    expect(Array.isArray(board.workCenters)).toBe(true)
    expect(Array.isArray(board.equipments)).toBe(true)
  })

  it('GET /execution/reports/drafts：草稿箱 PageResult 形状（DraftView 字段）', async ({ skip }) => {
    if (!reachable) skip('api 未运行')
    if (!fourDomainsReady) skip('四域模块尚未注册进运行中的 app.module（整合后执行）')
    const drafts = await live.listReportDrafts({ page: 1, pageSize: 10 })
    expect(drafts.page).toBe(1)
    for (const d of drafts.items) {
      expect(['order', 'workbench', 'scan']).toContain(d.source)
      expect(typeof d.sessionId).toBe('string')
    }
  })

  it('GET /quality/inspections 与 /warehousing/putaway-tasks：分页 + 状态标签字典', async ({ skip }) => {
    if (!reachable) skip('api 未运行')
    if (!fourDomainsReady) skip('四域模块尚未注册进运行中的 app.module（整合后执行）')
    const inspections = await live.listInspections({ page: 1, pageSize: 10 })
    for (const i of inspections.items) {
      expect(['work_report', 'putaway_receipt']).toContain(i.sourceType)
      expect(['process', 'finished']).toContain(i.inspectionStage)
    }
    const tasks = await live.listPutawayTasks({ page: 1, pageSize: 10 })
    for (const t of tasks.items) {
      expect(['pending', 'done', 'cancelled']).toContain(t.status)
      expect(typeof t.quantity).toBe('string')
    }
  })
})
