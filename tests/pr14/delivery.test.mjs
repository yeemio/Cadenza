import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SimulatedGateway } from '../../packages/edge/src/gateway.ts'
import { FileCheckpointStore, MemoryCheckpointStore } from '../../packages/edge/src/checkpoint.ts'

const points = [{ deviceSerial: 'D1', pointCode: 'P1', unit: 'M', semantic: 'meter_length' }]
const at = (n) => `2026-11-03T00:00:${String(n).padStart(2, '0')}Z`
const ack = (p) => ({ status: 'COMMITTED', data: { received: p.samples.length } })
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }

test('no transport never acknowledges samples or overflow; restart retains both and sequence', async () => {
  const store = new MemoryCheckpointStore()
  const g = new SimulatedGateway('G', points, { capacity: 2, checkpointStore: store })
  for (let i = 1; i <= 3; i++) await g.tick(at(i))
  assert.deepEqual(await g.flush(), { flushed: 0, checkpointSeq: 3 })
  assert.equal(g.backlog, 2)
  assert.equal(g.takeOverflowStats().count, 1)
  assert.equal(g.toPayload(g.peekBuffer()).overflow.count, 1)
  assert.equal(g.toPayload(g.peekBuffer()).overflow.count, 1)
  const next = new SimulatedGateway('G', points, { capacity: 2, checkpointStore: store })
  assert.equal(await next.restoreFromCheckpoint(), true)
  assert.equal(next.backlog, 2)
  assert.equal(next.takeOverflowStats().count, 1)
  assert.equal((await next.tick(at(4)))[0].eventId, 'D1@4')
})

test('send rejection and incomplete acknowledgments preserve pending data and overflow', async () => {
  const responses = [undefined, { ok: true, received: 0 }, { status: 'BUSINESS_REJECTION' },
    { status: 'COMMITTED' }, { status: 'BUSINESS_REJECTION', ok: true, received: 1 }]
  for (const response of responses) {
    const g = new SimulatedGateway('G', points, { capacity: 1, transport: { async send() { return response } } })
    g.setOnline(false)
    await g.tick(at(1)); await g.tick(at(2)); g.setOnline(true)
    await assert.rejects(g.flush(), /did not acknowledge/)
    assert.equal(g.backlog, 1)
    assert.equal(g.takeOverflowStats().count, 1)
  }
  const g = new SimulatedGateway('G', points, { transport: { async send() { throw new Error('offline') } } })
  await g.tick(at(1))
  await assert.rejects(g.flush(), /offline/)
  assert.equal(g.backlog, 1)
})

test('only the acknowledged snapshot is removed while ticks arrive during a single flight', async () => {
  const started = deferred(); const release = deferred(); let calls = 0
  const g = new SimulatedGateway('G', points, { capacity: 2, transport: { async send(p) {
    calls++; started.resolve(); await release.promise; return ack(p)
  } } })
  g.setOnline(false); await g.tick(at(1)); await g.tick(at(2)); g.setOnline(true)
  const flush = g.flush(); await started.promise
  const other = g.flush()
  g.setOnline(false); await g.tick(at(3)); await g.tick(at(4))
  release.resolve(); await Promise.all([flush, other])
  assert.equal(calls, 1)
  assert.deepEqual(g.peekBuffer().map((s) => s.eventId), ['D1@3', 'D1@4'])
  assert.equal(g.takeOverflowStats().count, 2)
  g.setOnline(true); await g.flush()
  assert.equal(g.backlog, 0)
  assert.equal(g.takeOverflowStats(), null)
})

test('overflow generated during a failed flight is merged and retried', async () => {
  const started = deferred(); const release = deferred(); let fail = true; const received = []
  const g = new SimulatedGateway('G', points, { capacity: 1, transport: { async send(p) {
    received.push(p); started.resolve(); await release.promise
    if (fail) throw new Error('lost')
    return ack(p)
  } } })
  g.setOnline(false); await g.tick(at(1)); await g.tick(at(2)); g.setOnline(true)
  const attempt = g.flush(); await started.promise
  g.setOnline(false); await g.tick(at(3)); release.resolve()
  await assert.rejects(attempt, /lost/)
  assert.equal(g.takeOverflowStats().count, 2)
  fail = false; g.setOnline(true); await g.flush()
  assert.equal(received[1].overflow.count, 2)
  assert.equal(g.backlog, 0)
})

test('file checkpoint and lost acknowledgment replay the same IDs after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cadenza-pr14-'))
  try {
    const store = new FileCheckpointStore(join(dir, 'checkpoint.json')); const seen = new Set()
    let lost = true; let duplicateCount = 0
    const transport = { async send(p) {
      for (const s of p.samples) { if (seen.has(s.eventId)) duplicateCount++; seen.add(s.eventId) }
      if (lost) throw new Error('response lost after receiver accepted')
      return ack(p)
    } }
    const first = new SimulatedGateway('G', points, { checkpointStore: store, transport })
    await first.tick(at(1)); assert.equal(first.backlog, 1)
    lost = false
    const restarted = new SimulatedGateway('G', points, { checkpointStore: store, transport })
    await restarted.restoreFromCheckpoint(); await restarted.flush()
    assert.equal(restarted.backlog, 0); assert.equal(seen.size, 1); assert.equal(duplicateCount, 1)
    assert.equal((await restarted.tick(at(2)))[0].eventId, 'D1@2')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('checkpoint failures prevent send and do not erase the sample', async () => {
  let sends = 0
  const g = new SimulatedGateway('G', points, {
    checkpointStore: { async save() { throw new Error('disk full') }, async load() { return null } },
    transport: { async send(p) { sends++; return ack(p) } },
  })
  await assert.rejects(g.tick(at(1)), /disk full/)
  assert.equal(sends, 0); assert.equal(g.backlog, 1)
})

test('samples arriving while the pre-send checkpoint is pending are not sent in that snapshot', async () => {
  const saving = deferred(); const release = deferred(); const sent = []
  const store = new MemoryCheckpointStore(); let blockNext = false
  const checkpointStore = {
    load: (key) => store.load(key),
    async save(cp) {
      if (blockNext) { blockNext = false; saving.resolve(); await release.promise }
      await store.save(cp)
    },
  }
  const g = new SimulatedGateway('G', points, { checkpointStore, transport: { async send(p) { sent.push(p); return ack(p) } } })
  g.setOnline(false); await g.tick(at(1)); g.setOnline(true); blockNext = true
  const attempt = g.flush(); await saving.promise
  g.setOnline(false); const arriving = g.tick(at(2))
  release.resolve(); await Promise.all([attempt, arriving])
  assert.deepEqual(sent[0].samples.map((s) => s.eventId), ['D1@1'])
  assert.equal(sent[0].checkpointSeq, 1)
  assert.deepEqual(g.peekBuffer().map((s) => s.eventId), ['D1@2'])
  const restarted = new SimulatedGateway('G', points, { checkpointStore })
  await restarted.restoreFromCheckpoint()
  assert.deepEqual(restarted.peekBuffer().map((s) => s.eventId), ['D1@2'])
})
