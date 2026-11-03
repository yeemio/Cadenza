import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type pg from 'pg'
import { addQty } from '@cadenza/domain'
import { GroupSimExecutionService, type GroupSimFacts } from '../../packages/application/src/group-sim-gates'
import { buildGroupCommandBus } from '../../apps/api/src/group/group.composition'
import { buildSchedulingCommandBus, PgScheduleSlotReadPort } from '../../apps/api/src/scheduling/scheduling.composition'
import { buildShippingCommandBus } from '../../apps/api/src/shipping/shipping.composition'
import { buildExecutionCommandBus } from '../../apps/api/src/execution/execution.composition'

export const FROZEN_SOURCE = 'delivery/company-simulation/group-sap-cn-kr-20261029/CBL01G_SAP_CN_KR_20261029/data/CBL01G_dataset.json'
export interface SimBindings {
  enterpriseId: string
  cn12PlantId: string
  kr22PlantId: string
  cn12BackupEquipmentId: string
  n2OrderId: string
  deliveryPlantId: string
}

type FrozenRow = Record<string, string | number | null>
/** Only the server composition calls this adapter; no request path accepts replacements for these facts. */
export function loadFrozenGateFacts(bindings: SimBindings) {
  const bytes = readFileSync(resolve(FROZEN_SOURCE))
  const tables = (JSON.parse(bytes.toString('utf8')) as { tables: Record<string, FrozenRow[]> }).tables
  const row = (table: string, id: string) => {
    const result = tables[table]?.find(item => item['id'] === id)
    if (!result) throw new Error(`Missing frozen SIM input: ${table}/${id}`)
    return result
  }
  const tool = row('metrology', 'CBL01G-TOOL-CN12')
  const permit = row('offline_permits', 'CBL01G-PERMIT-N2')
  const bom = row('bom_routes', 'CBL01G-BOM-F2')
  const sourceLines = tables['transfer_lines']!.filter(line => line['transfer_id'] === 'CBL01G-T1')
  const sourceQty = sourceLines.reduce((sum, line) => addQty(sum, String(line['qty'])), '0.0000')
  const sourceHash = createHash('sha256').update(bytes).digest('hex')
  const facts: GroupSimFacts = {
    sourceHash, enterpriseId: bindings.enterpriseId,
    tools: [{ id: String(tool['id']), equipmentId: bindings.cn12BackupEquipmentId, plantId: bindings.cn12PlantId,
      validUntil: `${String(tool['valid_to'])}T23:59:59.999+08:00`, status: String(tool['status']) }],
    amounts: tables['financial_quantity_summary']!.map(amount => ({ id: String(amount['id']), currency: String(amount['currency']), amount: String(amount['external_order_value']) })),
    conversion: { referenceId: 'CBL01G-T1', sourceBasis: 'core_m', targetBasis: 'cable_m', unit: 'm',
      sourcePerTarget: String(bom['core_m_per_cable_m']), sourceQty, plantId: bindings.deliveryPlantId },
    permits: [{ id: String(permit['id']), orderId: bindings.n2OrderId, plantId: bindings.kr22PlantId, orderVersion: Number(permit['order_version']),
      issuedAt: String(permit['issued_at']), expiresAt: String(permit['expires_at']), maxOutput: String(permit['max_output_m']) }],
  }
  return { facts, evidence: { sourcePath: FROZEN_SOURCE, sourceHash, bindings,
    bindingHash: createHash('sha256').update(JSON.stringify(bindings)).digest('hex'), raw: { tool, permit, bom, sourceLines,
      amounts: tables['financial_quantity_summary'], recall: row('recall_cases', 'CBL01G-RECALL-GK1') } } }
}

/** Reusable internal SIM entry for recon: actual domain buses, server clock and frozen fact adapter. */
export function buildFrozenGroupSimRuntime(pool: pg.Pool, bindings: SimBindings, now: () => Date,
  executionConfig: NonNullable<Parameters<typeof buildExecutionCommandBus>[1]>['config']) {
  const loaded = loadFrozenGateFacts(bindings)
  const group = buildGroupCommandBus(pool, now)
  const service = new GroupSimExecutionService({
    facts: loaded.facts, now, group,
    scheduling: buildSchedulingCommandBus(pool), shipping: buildShippingCommandBus(pool),
    execution: buildExecutionCommandBus(pool, { schedule: new PgScheduleSlotReadPort(pool), config: executionConfig }),
    orderScope: async (id) => {
      const result = await pool.query<{ enterprise_id: string; plant_id: string; current_settings_version: number }>(
        'SELECT enterprise_id, plant_id, current_settings_version FROM production_order WHERE id=$1', [id])
      const order = result.rows[0]
      return order ? { enterpriseId: order.enterprise_id, plantId: order.plant_id, version: order.current_settings_version } : null
    },
  })
  return { service, group, configuration: loaded.evidence }
}
