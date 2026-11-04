import { describe, expect, it, vi } from 'vitest'
import { issueMaterial, type PostingContext } from '../../packages/application/src/inventory-posting'
import type { InventoryCommandTools, InventoryUnitRecord, NewGenealogyEdge, NewStockEntry, NewStockTransaction,
  ReservationRecord, StockBalancePatch, StockBalanceRecord } from '../../packages/application/src/inventory-repositories'
import type { AuditFactInput } from '../../packages/application/src/repositories'

// Application-boundary evidence with repository doubles. This is not evidence
// of PostgreSQL casts, transaction rollback, locks or command-bus replay.
const now = '2026-11-04T12:00:00.000Z'
const taskId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
const reservationId = '30000000-0000-4000-8000-000000000001'
const unitId = '30000000-0000-4000-8000-000000000002'
const plantId = '30000000-0000-4000-8000-000000000003'
const enterpriseId = '30000000-0000-4000-8000-000000000004'
const uomId = '30000000-0000-4000-8000-000000000005'
const locationId = '30000000-0000-4000-8000-000000000006'
const actor = { actorUserId: '30000000-0000-4000-8000-000000000007', actorLoginName: 'pr03-operator', enterpriseId }

function fixture(holderRef: string | null) {
  const unit: InventoryUnitRecord = { id: unitId, unitNo: 'PR03-R2-unit', materialId: taskId, materialCode: 'PR03-R2',
    lotId: taskId, uomId, uomCode: 'M', traceMode: 'quantity', status: 'in_stock', balanceOpen: true,
    balanceClosedAt: null, plantId, enterpriseId, businessTime: now, createdAt: now, createdBy: actor.actorLoginName }
  const balance: StockBalanceRecord = { id: '30000000-0000-4000-8000-000000000008', unitId, locationId, locationCode: '03010001',
    ownerId: enterpriseId, ownerName: 'PR03 owner', quantity: '20.0000', uomId, uomCode: 'M', measurementBasis: 'base',
    conversionRevisionId: null, qualityStatus: 'qualified', legacyStatus: null, status: 'active', closedAt: null,
    plantId, enterpriseId, businessTime: now, createdAt: now }
  const reservation: ReservationRecord | null = holderRef === null ? null : { id: reservationId, unitId, locationId,
    holderType: 'task', holderRef, quantity: '10.0000', uomId, uomCode: 'M', measurementBasis: balance.measurementBasis,
    conversionRevisionId: null, status: 'active', validUntil: '2026-11-05T12:00:00.000Z', acquiredAt: now,
    commandReceiptId: taskId, releasedAt: null, releasedBy: null, releaseReason: null, plantId, enterpriseId,
    createdBy: actor.actorLoginName }
  const insertLine = vi.fn(async (line: NewStockTransaction) => ({ ...line, id: taskId, createdAt: now }))
  const insertEntry = vi.fn(async (entry: NewStockEntry) => ({ ...entry, id: taskId, createdAt: now }))
  const adjust = vi.fn(async (_id: string, patch: StockBalancePatch) => ({ ...balance, ...patch }))
  const consume = vi.fn(async () => reservation)
  const audit = vi.fn(async (_fact: AuditFactInput) => {})
  const insertEdge = vi.fn(async (edge: NewGenealogyEdge) => ({ ...edge, id: taskId, createdAt: now }))
  const tools = {
    now: () => new Date(now),
    org: { findById: async (id: string) => id === plantId ? { id, enterpriseId, kind: 'plant', status: 'active' } : null },
    users: { findById: async (id: string) => id === actor.actorUserId
      ? { id, enterpriseId, roleId: taskId, status: 'active', accountStatus: 'enabled' } : null },
    grants: { listActiveByPrincipals: async () => [{ principalType: 'user', principalId: actor.actorUserId, enterpriseId,
      status: 'active', permissions: ['inventory.post'], scopeType: 'plant', scopeObjectId: plantId }] },
    audit: { record: audit }, outbox: { collect: vi.fn() },
    inv: {
      units: { lockForUpdate: async (ids: readonly string[]) => ids.includes(unitId) ? [unit] : [],
        businessHolds: async () => [], hasActiveQualityHold: async () => false },
      balances: { listActiveByUnit: async () => [balance], lockByKey: async () => balance, adjust },
      reservations: { listActiveByUnit: async () => reservation === null ? [] : [reservation],
        findById: async (id: string) => id === reservationId ? reservation : null, consume },
      transactions: { insertLine, insertEntry }, genealogy: { insertEdge },
    },
  } as unknown as InventoryCommandTools
  const pc: PostingContext = { tools, ctx: actor, commandReceiptId: taskId, businessTime: now, shiftDate: '2026-11-04',
    writePermission: 'inventory.post' }
  const payload: Record<string, unknown> = { unitId, quantity: '5.0000', ...(reservation === null ? {} : { reservationId }) }
  return { pc, payload, reservation, insertLine, insertEntry, adjust, consume, audit, insertEdge }
}

interface ReferenceCase {
  name: string
  holderRef: string | null
  payload: Record<string, unknown>
  refType: string | null
  refId: string | null
}
const cases: ReferenceCase[] = [
  { name: 'text holder without an explicit reference', holderRef: 'PR03-task', payload: {}, refType: 'reservation', refId: reservationId },
  { name: 'matching text aliases', holderRef: 'PR03-task',
    payload: { holderType: 'task', holderRef: 'PR03-task', refType: 'task', refId: 'PR03-task' }, refType: 'reservation', refId: reservationId },
  { name: 'a type-only echo stays paired with the reservation UUID', holderRef: 'PR03-task',
    payload: { refType: 'task' }, refType: 'reservation', refId: reservationId },
  { name: 'a UUID-shaped holder is not an implicit ledger reference', holderRef: taskId,
    payload: {}, refType: 'reservation', refId: reservationId },
  { name: 'an explicit UUID type and id', holderRef: taskId, payload: { refType: 'task', refId: taskId }, refType: 'task', refId: taskId },
  { name: 'an explicit UUID id with its existing holder type', holderRef: taskId, payload: { refId: taskId }, refType: 'task', refId: taskId },
  ...[
    taskId.toUpperCase(),
    `{${taskId}}`,
    'a0eebc999c0b4ef8bb6d6bb9bd380a11',
    'a0ee-bc99-9c0b-4ef8-bb6d-6bb9-bd38-0a11',
    '{a0eebc99-9c0b4ef8-bb6d6bb9-bd380a11}',
  ].map((value): ReferenceCase => ({ name: `PostgreSQL UUID spelling ${value}`, holderRef: value,
    payload: { refType: 'task', refId: value }, refType: 'task', refId: value })),
  { name: 'UUID-looking text with a trailing newline stays text', holderRef: `${taskId}\n`,
    payload: { refType: 'task', refId: `${taskId}\n` }, refType: 'reservation', refId: reservationId },
  { name: 'unreserved issue without a reference', holderRef: null, payload: {}, refType: null, refId: null },
  { name: 'unreserved explicit UUID and genealogy', holderRef: null,
    payload: { refType: 'inventory_unit', refId: taskId }, refType: 'inventory_unit', refId: taskId },
]

describe('PR03 R2 issue reference semantics at the application boundary', () => {
  it.each(cases)('$name', async ({ holderRef, payload, refType, refId }) => {
    const f = fixture(holderRef)
    const result = await issueMaterial(f.pc, { ...f.payload, ...payload })
    expect(result).toMatchObject({ transactionId: taskId, beforeQty: '20.0000', afterQty: '15.0000', balanceClosed: false })
    expect(f.insertLine).toHaveBeenCalledTimes(1)
    expect(f.insertLine.mock.calls[0]![0]).toMatchObject({ refType, refId, quantity: '-5.0000', beforeQty: '20.0000', afterQty: '15.0000' })
    expect(f.insertEntry).toHaveBeenCalledTimes(1)
    expect(f.adjust).toHaveBeenCalledTimes(1)
    expect(f.audit).toHaveBeenCalledTimes(1)
    expect(f.audit.mock.calls[0]![0]).toMatchObject({ action: 'inventory.issue-material', subjectId: unitId,
      before: { quantity: '20.0000' }, after: { quantity: '15.0000', ...(holderRef === null ? {} : {
        reservation: { id: reservationId, holderType: 'task', holderRef }, ledgerReference: { refType, refId },
      }) } })
    if (holderRef === null) {
      expect(f.consume).not.toHaveBeenCalled()
      expect(f.audit.mock.calls[0]![0].after).toEqual({ quantity: '15.0000' })
    } else {
      expect(f.consume).toHaveBeenCalledExactlyOnceWith(reservationId, '5.0000', now, actor.actorLoginName)
      expect(f.reservation!.holderRef).toBe(holderRef)
    }
    if (payload.refType === 'inventory_unit') expect(f.insertEdge).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ toId: taskId }))
    else expect(f.insertEdge).not.toHaveBeenCalled()
  })

  it.each(['other actor', 'wrong business reference'] as const)('still rejects %s before any write', async (kind) => {
    const f = fixture('PR03-task')
    if (kind === 'other actor') f.reservation!.createdBy = 'other-operator'
    else Object.assign(f.payload, { refType: 'task', refId: 'other-task' })
    await expect(issueMaterial(f.pc, f.payload)).rejects.toMatchObject({ name: 'InventoryRuleViolation', rule: 'IT-23' })
    for (const write of [f.insertLine, f.insertEntry, f.adjust, f.consume, f.audit, f.insertEdge]) expect(write).not.toHaveBeenCalled()
  })
})
