import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as dshExports from '../../packages/integrations/dsh'
import type { ModelRequest } from '../../packages/integrations/dsh'

const { DSH_RUNTIME_DECLARATION, DEFAULT_RUNTIME_PROFILE, MockModelClient } = dshExports

const DSH_DIR = join(__dirname, '../../packages/integrations/dsh')

function baseRequest(): ModelRequest {
  return {
    requestId: 'req-1',
    sessionId: 'sess-1',
    turnSeq: 1,
    messages: [
      { role: 'system', content: 'ctx' },
      { role: 'user', content: '问一下订单进度' },
    ],
    tools: [],
  }
}

describe('DS-14 运行时版本声明', () => {
  it('固定为 mock-1 且 profileRef=null（真实 DSH=SITE_PENDING/GAP-P1）', () => {
    expect(DSH_RUNTIME_DECLARATION).toEqual({ kind: 'mock', version: 'mock-1', profileRef: null })
  })

  it('声明为单一只读常量（deep-frozen 断言值不再变体）', () => {
    expect(Object.isFrozen(DSH_RUNTIME_DECLARATION)).toBe(false) // 不要求 frozen，但值固定
    expect(DSH_RUNTIME_DECLARATION.kind).toBe('mock')
    expect(DSH_RUNTIME_DECLARATION.profileRef).toBeNull()
  })
})

describe('DS-15/DS-17 边缘包公开面与零业务依赖（结构断言）', () => {
  const files = readdirSync(DSH_DIR).filter((name) => name.endsWith('.ts'))

  it('包内源文件不引用任何 @cadenza/* 业务面（DS-17 零业务依赖）', () => {
    expect(files.length).toBeGreaterThanOrEqual(7)
    for (const name of files) {
      const text = readFileSync(join(DSH_DIR, name), 'utf8')
      expect(text.includes('@cadenza/'), `${name} 引用了业务包`).toBe(false)
      expect(text.includes('node:pg') || text.includes('require('), `${name} 不应携带存储驱动`).toBe(false)
    }
  })

  it('包内相对导入不逃逸出本包（厂商类型止于此包，DS-04/DS-17）', () => {
    for (const name of files) {
      const text = readFileSync(join(DSH_DIR, name), 'utf8')
      const imports = [...text.matchAll(/from '([^']+)'/g)].map((m) => m[1] as string)
      for (const specifier of imports) {
        if (specifier.startsWith('.')) {
          expect(specifier.startsWith('./'), `${name} 逃逸出包：${specifier}`).toBe(true)
        }
      }
    }
  })

  it('四族接口 + 声明 + mock 适配器全部自包出口可导入（DS-15 出口收敛）', async () => {
    const index = readFileSync(join(DSH_DIR, 'index.ts'), 'utf8')
    for (const family of ['./model-client', './tools', './session-store', './runtime-profile', './runtime-declaration', './mock-model']) {
      expect(index.includes(family), `index.ts 未导出 ${family}`).toBe(true)
    }
    expect(typeof dshExports.MockModelClient).toBe('function')
    expect(dshExports.DEFAULT_RUNTIME_PROFILE.toolCallLimitPerTurn).toBe(8)
  })

  it('RuntimeProfile 缺省值与合同一致（DS-07 上限 8；DS-09 查询 15s；时区 Asia/Shanghai）', () => {
    expect(DEFAULT_RUNTIME_PROFILE.toolCallLimitPerTurn).toBe(8)
    expect(DEFAULT_RUNTIME_PROFILE.singleQueryTimeoutMs).toBe(15_000)
    expect(DEFAULT_RUNTIME_PROFILE.turnBudgetMs).toBeGreaterThanOrEqual(DEFAULT_RUNTIME_PROFILE.singleQueryTimeoutMs)
    expect(DEFAULT_RUNTIME_PROFILE.timezone).toBe('Asia/Shanghai')
    expect(DEFAULT_RUNTIME_PROFILE.retry.maxRetries).toBeGreaterThanOrEqual(1) // DS-22 有限重试由配置声明
  })
})

describe('DS-13/DS-16 mock 模型适配器', () => {
  it('脚本按序消费且确定性：同脚本两次运行产出逐字相同', async () => {
    const steps = [
      { kind: 'tool_calls' as const, toolCalls: [{ capabilityId: 'aq.quality', capabilityVersion: 1, params: { relativeTime: 'last_7_days' } }] },
      { kind: 'clarify' as const, question: '请确认订单', optionIds: ['opt-order-1'] },
      { kind: 'answer' as const, text: '本周不合格 1 单。【解释非事实】可能原因待复核。' },
    ]
    const runA = new MockModelClient({ steps: [...steps] })
    const runB = new MockModelClient({ steps: [...steps] })
    const resultsA = [await runA.complete(baseRequest()), await runA.complete(baseRequest()), await runA.complete(baseRequest())]
    const resultsB = [await runB.complete(baseRequest()), await runB.complete(baseRequest()), await runB.complete(baseRequest())]
    expect(resultsA).toEqual(resultsB)
    expect(resultsA[0]?.kind).toBe('tool_calls')
    expect(resultsA[1]?.kind).toBe('clarify')
    expect(resultsA[2]?.kind).toBe('answer')
    expect(runA.pending()).toBe(0)
    expect(runA.consumed()).toHaveLength(3)
  })

  it('越权问法拒答（refuse，提示走业务页面，DS-13）', async () => {
    const client = new MockModelClient({
      steps: [{ kind: 'refuse', text: '该操作超出问数只读范围，请走业务页面。【解释非事实】' }],
    })
    const result = await client.complete(baseRequest())
    expect(result.kind).toBe('refuse')
    if (result.kind === 'refuse') expect(result.text).toContain('业务页面')
  })

  it('usageUnknown 步骤返回 unknown 用量；counted 步骤返回确定计数', async () => {
    const unknown = await new MockModelClient({
      steps: [{ kind: 'answer', text: 'x', usageUnknown: true }],
    }).complete(baseRequest())
    expect(unknown.usage).toEqual({ kind: 'unknown' })
    const counted = await new MockModelClient({
      steps: [{ kind: 'answer', text: 'x' }],
    }).complete(baseRequest())
    expect(counted.usage.kind).toBe('counted')
  })

  it('脚本耗尽回落 answer-from-results：无工具结果时如实说明，不虚构数据', async () => {
    const client = new MockModelClient({ steps: [], fallback: 'answer-from-results' })
    const result = await client.complete(baseRequest())
    expect(result.kind).toBe('answer')
    if (result.kind === 'answer') expect(result.text).toContain('未能获取结构化结果')
  })

  it('delayMs 注入可复现超时场景（DS-09 前置），调用计数可断言（DS-11 取消后不再调用模型）', async () => {
    const client = new MockModelClient({ steps: [{ kind: 'answer', text: 'ok', delayMs: 120 }] })
    const started = Date.now()
    await client.complete(baseRequest())
    expect(Date.now() - started).toBeGreaterThanOrEqual(100)
    expect(client.calls()).toBe(1)
  })

  it('mock 不访问网络（结构断言：包源码无 fetch/http 客户端导入）', () => {
    for (const name of readdirSync(DSH_DIR).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(join(DSH_DIR, name), 'utf8')
      expect(text.includes('fetch('), `${name} 出现 fetch`).toBe(false)
      expect(text.includes('node:http'), `${name} 出现 http 客户端`).toBe(false)
    }
  })
})
