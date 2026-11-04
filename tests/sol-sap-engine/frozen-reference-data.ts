import { simCsvDirectory } from '../../scripts/delivery/build/fixture-path.mjs'
export const frozenCsvDirectory = simCsvDirectory
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SAP_SIM_REFERENCE_COLUMNS, type SapSimReferenceData, type SapSimReferenceRow, type SapSimReferenceTable } from '@cadenza/domain'

export function readFrozenCsv(csvDirectory: string, name: string): SapSimReferenceRow[] {
  const text = readFileSync(join(csvDirectory, `${name}.csv`), 'utf8').replace(/^\uFEFF/, '')
  const records: string[][] = []
  let row: string[] = [], cell = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++ } else quoted = !quoted
    } else if (!quoted && (char === ',' || char === '\n' || char === '\r')) {
      row.push(cell); cell = ''
      if (char !== ',') {
        if (row.some((value) => value !== '')) records.push(row)
        row = []
        if (char === '\r' && text[i + 1] === '\n') i++
      }
    } else cell += char
  }
  if (quoted) throw new Error(`Unclosed CSV quote: ${name}`)
  if (cell || row.length) { row.push(cell); records.push(row) }
  const headers = records.shift() ?? []
  return records.map((values) => Object.fromEntries(headers.map((header, i) => [header, values[i] ?? ''])))
}

/** Project only identity/measurement/movement columns; balance and expected-result tables are never read. */
export function loadFrozenReferenceData(csvDirectory: string, organizationCode: string, plantCode: string): SapSimReferenceData {
  const names = Object.keys(SAP_SIM_REFERENCE_COLUMNS) as SapSimReferenceTable[]
  const tables = Object.fromEntries(names.map((name) => [name, readFrozenCsv(csvDirectory, name).map((row) =>
    Object.fromEntries(SAP_SIM_REFERENCE_COLUMNS[name].map((column) => [column, row[column] ?? ''])))])) as SapSimReferenceData['tables']
  const plant = tables.plants.find((row) => row['sap_plant'] === plantCode && row['entity_id'] === organizationCode)
  if (!plant) throw new Error('Frozen reference scope not found')
  tables.material_mappings = tables.material_mappings.filter((row) => row['plant_id'] === plant['id'])
  tables.orders = tables.orders.filter((row) => row['plant_id'] === plant['id'] && row['entity_id'] === organizationCode)
  const orders = new Set(tables.orders.map((row) => row['id']))
  tables.feeds = tables.feeds.filter((row) => orders.has(row['order_id']) && row['plant_id'] === plant['id'])
  tables.raw_issues = tables.raw_issues.filter((row) => orders.has(row['order_id']))
  tables.transfers = tables.transfers.filter((row) => [row['origin_plant_id'], row['destination_plant_id']].includes(plant['id']))
  const transfers = new Set(tables.transfers.map((row) => row['id']))
  tables.transfer_lines = tables.transfer_lines.filter((row) => transfers.has(row['transfer_id']))
  tables.inventory_events = tables.inventory_events.filter((row) => row['plant_context_id'] === plant['id'] &&
    ['APPROVED_ABNORMAL_DEDUCTION', 'SIM_PHYSICAL_DISPOSITION'].includes(row['action']))
  return {
    version: 'CBL01G-SIM-v2.0', tables,
    sources: Object.fromEntries(names.map((name) => [name, {
      path: join(csvDirectory, `${name}.csv`),
      sha256: createHash('sha256').update(readFileSync(join(csvDirectory, `${name}.csv`))).digest('hex'),
    }])) as SapSimReferenceData['sources'],
  }
}
