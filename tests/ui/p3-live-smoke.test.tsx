// @vitest-environment jsdom
/**
 * P3 域 live gated 冒烟（真实链路，需 apps/api @3001 运行中）：
 * - 默认跳过（api 不可达时不跑）；CADENZA_LIVE_UI=1 强制执行（供验收取证）；
 * - ot/spc/csw/cost 四域后端均已落盘（2026-10-28），但模块尚未注册进 app.module
 *   （L0 整合步挂载）：运行中 api 若未含 P3 路由（404 探测）则整组跳过——
 *   注册后由 L0 以 CADENZA_LIVE_UI=1 复跑取证（先例：第四波 live-smoke 整组跳过设计）。
 * 运行：CADENZA_LIVE_UI=1 pnpm test:ui tests/ui/p3-live-smoke.test.tsx
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { createApiClient, type ApiClient } from '@cadenza/ui'
import { createP3Client, type P3Client } from '../../packages/ui/src/api/p3'

const BASE = process.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:3001'
const FORCED = process.env.CADENZA_LIVE_UI === '1'

async function apiReachable(): Promise<boolean> {
  const probe = (async (): Promise<boolean> => {
    try {
      const res = await fetch(`${BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginName: '__probe__', password: '__probe__', platform: 'WEB' }),
      })
      return res.status > 0
    } catch {
      return false
    }
  })()
  const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2500))
  return Promise.race([probe, timeout])
}

let reachable = false
let token: string | null = null
let main: ApiClient
let p3: P3Client
let p3RoutesReady = false

beforeAll(async () => {
  reachable = await apiReachable()
  if (!reachable) {
    if (FORCED) throw new Error(`CADENZA_LIVE_UI=1 但 api 不可达：${BASE}`)
    return
  }
  main = createApiClient({ mode: 'live', baseURL: BASE, getToken: () => token })
  p3 = createP3Client({ mode: 'live', baseURL: BASE, getToken: () => token })
  try {
    const login = await main.login({ loginName: 'admin', password: 'CadAdmin001', platform: 'WEB' })
    token = login.token
  } catch {
    return
  }
  // P3 模块注册探测（未注册 → 404，整组跳过）
  try {
    const gateways = await p3.otListGateways({ page: 1, pageSize: 1 })
    p3RoutesReady = gateways.page === 1
  } catch {
    p3RoutesReady = false
  }
})

describe('live gated 冒烟（P3：ot/spc/csw/cost 真实端点形状）', () => {
  it('GET /ot/gateways：PageResult + 网关字段（状态/心跳/检查点/积压，OT-06/S3）', async ({ skip }) => {
    if (!reachable) skip('api 未运行（设 CADENZA_LIVE_UI=1 并先启动 apps/api）')
    if (!p3RoutesReady) skip('P3 模块尚未注册进运行中的 app.module（L0 整合后由验收步复跑取证）')
    const page = await p3.otListGateways({ page: 1, pageSize: 10 })
    expect(page.page).toBe(1)
    for (const g of page.items) {
      expect(['online', 'offline']).toContain(g.status)
      expect(typeof g.gatewayCode).toBe('string')
      expect(typeof g.checkpointSeq).toBe('number')
      expect(typeof g.lastBacklogCount).toBe('number')
    }
  })

  it('GET /ot/monitor：OT-29 必监项总览四段形状（gateways/deviceLatency/dedup/overflow）', async ({ skip }) => {
    if (!reachable) skip('api 未运行')
    if (!p3RoutesReady) skip('P3 模块尚未注册（L0 整合后复跑）')
    const overview = await p3.otMonitorOverview({})
    expect(Array.isArray(overview.gateways)).toBe(true)
    expect(Array.isArray(overview.deviceLatency)).toBe(true)
    expect(Array.isArray(overview.dedup)).toBe(true)
    expect(Array.isArray(overview.overflow)).toBe(true)
    for (const d of overview.deviceLatency) {
      expect(typeof d.noData).toBe('boolean')
    }
  })

  it('GET /spc/control-items：PageResult；/spc/ooc-tasks 处置链列表形状', async ({ skip }) => {
    if (!reachable) skip('api 未运行')
    if (!p3RoutesReady) skip('P3 模块尚未注册（L0 整合后复跑）')
    const items = await p3.spcListControlItems({ page: 1, pageSize: 10 })
    expect(items.page).toBe(1)
    for (const i of items.items) {
      expect(typeof i.specCode).toBe('string')
      expect(['active', 'retired']).toContain(i.status)
    }
    const ooc = await p3.spcListOocTasks({ page: 1, pageSize: 10 })
    for (const t of ooc.items) {
      expect(['open', 'disposed', 're_control_confirmed']).toContain(t.status)
      expect(typeof t.qualityDoubtHint).toBe('boolean')
    }
  })

  it('GET /csw/outsourcing-tasks：CS-19 状态机视图形状（statusLabel/occupationActive 组装列）', async ({ skip }) => {
    if (!reachable) skip('api 未运行')
    if (!p3RoutesReady) skip('P3 模块尚未注册（L0 整合后复跑）')
    const page = await p3.cswListOutsourcingTasks({ page: 1, pageSize: 10 })
    expect(page.page).toBe(1)
    for (const t of page.items) {
      expect(typeof t.taskNo).toBe('string')
      expect(typeof t.statusLabel).toBe('string')
      expect(typeof t.occupationActive).toBe('boolean')
    }
  })

  it('GET /cost/runs：CE-17 两列形状（estimateAmount/actualAmount 可空缺项）＋ GET /cost/meters', async ({ skip }) => {
    if (!reachable) skip('api 未运行')
    if (!p3RoutesReady) skip('P3 模块尚未注册（L0 整合后复跑）')
    const runs = await p3.costListRuns({ page: 1, pageSize: 10 })
    expect(runs.page).toBe(1)
    for (const r of runs.items) {
      expect(typeof r.runNo).toBe('string')
      // CE-03/14：缺价→actualAmount 为 null（缺项），不以 0 冒充
      if (r.actualAmount !== null) expect(typeof r.actualAmount).toBe('string')
    }
    const meters = await p3.costListMeters({ page: 1, pageSize: 10 })
    for (const m of meters.items) {
      expect(['electric', 'water', 'gas']).toContain(m.energyType)
      expect(['equipment', 'workshop']).toContain(m.coverageKind)
    }
  })
})
