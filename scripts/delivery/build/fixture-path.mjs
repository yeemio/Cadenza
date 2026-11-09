import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
export const DEFAULT_SIM_CSV = path.join(REPO_ROOT, 'delivery/company-simulation/group-sap-cn-kr-20261029/CBL01G_SAP_CN_KR_20261029/data/csv')
export function simCsvDirectory(env = process.env) {
  const explicit = env.CADENZA_SIM_CSV_DIR
  if (explicit !== undefined && (!explicit.trim() || !path.isAbsolute(explicit))) {
    throw new Error('CADENZA_SIM_CSV_DIR must be an explicit absolute directory')
  }
  return explicit ?? DEFAULT_SIM_CSV
}
export function assertSimFixtures(directory = simCsvDirectory()) {
  for (const name of ['messages', 'message_attempts', 'plants', 'stock_objects']) {
    try { if (!statSync(path.join(directory, name + '.csv')).isFile()) throw new Error('not file') }
    catch { throw new Error('Missing frozen SIM fixture ' + name + '.csv; use the repository fixtures or CADENZA_SIM_CSV_DIR') }
  }
  return directory
}
