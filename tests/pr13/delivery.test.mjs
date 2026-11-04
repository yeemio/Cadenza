import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseAdminUrl, freshDatabaseName } from '../../scripts/delivery/build/exclusive-pg.mjs'
import { simCsvDirectory, assertSimFixtures, DEFAULT_SIM_CSV, REPO_ROOT } from '../../scripts/delivery/build/fixture-path.mjs'
import { assessReport } from '../../scripts/delivery/build/required-tests.mjs'
import { includeColdPath, coldBuild } from '../../scripts/delivery/build/cold-build.mjs'
import { BUILD_ENTRIES, assertNodeEntry, verifyBuilt } from '../../scripts/delivery/build/verify-built.mjs'

const directories = []
function temporary() { const dir = mkdtempSync(path.join(tmpdir(), 'cadenza-pr13-unit-')); directories.push(dir); return dir }
test.after(() => { for (const dir of directories) rmSync(dir, { recursive: true, force: true }) })
const requiredFile = path.resolve('tests/integration/command-idempotency.spec.ts')
function report(statuses = ['passed']) {
  return { success: true, numTotalTests: statuses.length, numPassedTests: statuses.filter((s) => s === 'passed').length,
    numFailedTests: statuses.filter((s) => s === 'failed').length, numPendingTests: statuses.filter((s) => ['pending', 'skipped', 'disabled'].includes(s)).length,
    numTodoTests: statuses.filter((s) => s === 'todo').length, numFailedTestSuites: 0,
    testResults: [{ name: requiredFile, status: 'passed', assertionResults: statuses.map((status) => ({ status })) }] }
}
test('explicit admin URL is portable across authorized hosts and ports', () => {
  assert.equal(parseAdminUrl('postgresql://tester:example@pg-test.internal:6543/postgres').port, '6543')
})
for (const [name, url] of [
  ['missing', undefined], ['shared business database', 'postgres://tester@localhost/cadenza_dev'],
  ['query endpoint override', 'postgres://tester@localhost/postgres?host=elsewhere'],
  ['wrong protocol', 'https://tester@localhost/postgres'], ['absent user', 'postgres://localhost/postgres'],
]) test('test database selection rejects ' + name, () => assert.throws(() => parseAdminUrl(url)))
test('fresh names are unique PostgreSQL-safe names under the lane prefix', () => {
  const names = Array.from({ length: 50 }, () => freshDatabaseName('idempotency'))
  assert.equal(new Set(names).size, names.length)
  for (const name of names) { assert.match(name, /^cadenza_pr13_idempotency_[a-f0-9]{32}$/); assert.ok(Buffer.byteLength(name) <= 63) }
  assert.throws(() => freshDatabaseName('production'))
})
test('default fixture directory is anchored to repository and independent of cwd', () => {
  const previous = process.cwd(); process.chdir(temporary())
  try { assert.equal(simCsvDirectory({}), DEFAULT_SIM_CSV); assert.ok(DEFAULT_SIM_CSV.startsWith(REPO_ROOT)) }
  finally { process.chdir(previous) }
})
test('an explicitly missing fixture location fails instead of falling back', () => {
  const missing = path.join(temporary(), 'missing')
  assert.equal(simCsvDirectory({ CADENZA_SIM_CSV_DIR: missing }), missing)
  assert.throws(() => assertSimFixtures(missing), /Missing frozen SIM fixture/)
  assert.throws(() => simCsvDirectory({ CADENZA_SIM_CSV_DIR: 'relative/path' }), /absolute/)
})
test('explicit existing fixture files can be discovered without a developer home directory', () => {
  const directory = temporary()
  for (const name of ['messages', 'message_attempts', 'plants', 'stock_objects']) writeFileSync(path.join(directory, name + '.csv'), 'id\nfixture\n')
  assert.equal(assertSimFixtures(simCsvDirectory({ CADENZA_SIM_CSV_DIR: directory })), directory)
})
test('complete passing reports preserve exact individual result counts', () => {
  const result = assessReport(report(['passed', 'passed']), [requiredFile], 0)
  assert.equal(result.status, 'PASS'); assert.deepEqual(result.counts, { declared: 2, passed: 2, failed: 0, skipped: 0, todo: 0, unknown: 0 })
})
for (const status of ['failed', 'pending', 'skipped', 'disabled', 'todo', 'unrecognized']) {
  test('exit zero cannot conceal mandatory ' + status + ' tests', () => assert.equal(assessReport(report(['passed', status]), [requiredFile], 0).status, 'FAIL'))
}
test('zero tests and absent mandatory file cannot pass', () => {
  assert.equal(assessReport(report([]), [requiredFile], 0).status, 'FAIL')
  assert.equal(assessReport(report(), [requiredFile, path.resolve('missing.spec.ts')], 0).status, 'FAIL')
})
test('missing, duplicated and unexpected reports fail the gate', () => {
  assert.equal(assessReport({}, [requiredFile], 0).status, 'FAIL')
  const duplicate = report(); duplicate.testResults.push(duplicate.testResults[0])
  assert.equal(assessReport(duplicate, [requiredFile], 0).status, 'FAIL')
  assert.equal(assessReport(report(), [path.resolve('different.spec.ts')], 0).status, 'FAIL')
})
test('report counter disagreement and nonzero process status fail', () => {
  const wrong = report(); wrong.numPassedTests = 999
  assert.equal(assessReport(wrong, [requiredFile], 0).status, 'FAIL')
  assert.equal(assessReport(report(), [requiredFile], 1).status, 'FAIL')
})
test('failed beforeAll and unhandled errors fail even with passing assertion statuses', () => {
  const hook = report(); hook.testResults[0].status = 'failed'
  assert.equal(assessReport(hook, [requiredFile], 0).status, 'FAIL')
  const unhandled = report(); unhandled.unhandledErrors = ['error']
  assert.equal(assessReport(unhandled, [requiredFile], 0).status, 'FAIL')
})
test('actual mandatory CLI without PG exits nonzero and records zero execution', () => {
  const env = { ...process.env }; delete env.CADENZA_TEST_ADMIN_URL
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts/delivery/build/required-tests.mjs'), '--suite', 'idempotency'], { cwd: temporary(), env, encoding: 'utf8' })
  assert.equal(result.status, 1)
  const receipt = JSON.parse(result.stdout.trim())
  assert.equal(receipt.runnerStarted, false); assert.equal(receipt.counts.passed, 0); assert.equal(receipt.counts.skipped, 0)
  assert.match(receipt.reason, /CADENZA_TEST_ADMIN_URL is required/)
})
test('cold snapshots exclude existing dist, dependencies, caches and local env secrets', () => {
  for (const file of ['apps/ai/dist/apps/ai/src/main.js', 'packages/integrations/im/dist/index.js', 'node_modules/x/index.js', '.git/index', '.env', 'apps/api/.env.local']) assert.equal(includeColdPath(file), false)
  for (const file of ['apps/ai/src/main.ts', 'packages/integrations/im/src/index.ts', 'pnpm-lock.yaml', '.env.example']) assert.equal(includeColdPath(file), true)
})
test('actual cold gate rejects a nonmatching package manager before installation or build', () => {
  const root = temporary(); writeFileSync(path.join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@11.28.5' }))
  const receipt = coldBuild(root, { pnpm: process.execPath, offline: true })
  directories.push(receipt.isolatedDirectory)
  assert.equal(receipt.status, 'FAIL'); assert.equal(receipt.packageInstall, 'NOT_RUN'); assert.equal(receipt.workspaceBuild, 'NOT_RUN')
  assert.match(receipt.reason, /Pinned pnpm/)
})
test('compiled entry checks find missing relative imports without executing the entry', () => {
  const root = temporary(), entry = path.join(root, 'main.js')
  writeFileSync(entry, "throw new Error('must not execute'); require('./dependency.js'); require('node:fs')")
  assert.throws(() => assertNodeEntry(entry, root), /Unresolved built import/)
  writeFileSync(path.join(root, 'dependency.js'), 'module.exports = 1')
  assert.equal(assertNodeEntry(entry, root), 2)
})
test('syntax-invalid compiled JavaScript is refused', () => {
  const root = temporary(), entry = path.join(root, 'main.js'); writeFileSync(entry, 'const = broken')
  assert.throws(() => assertNodeEntry(entry, root), /Invalid built JavaScript/)
})
function syntheticOutputs() {
  const root = temporary(); writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'synthetic lock')
  for (const [directory, entry] of Object.entries(BUILD_ENTRIES)) {
    const file = path.join(root, directory, entry); mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, entry.endsWith('.html') ? '<script type="module" src="/assets/main.js"></script>' : 'module.exports = {}')
    if (entry.endsWith('.html')) { mkdirSync(path.join(path.dirname(file), 'assets')); writeFileSync(path.join(path.dirname(file), 'assets/main.js'), 'export {}') }
  }
  return root
}
test('built manifest includes nested IM and AI and refuses a missing IM entry', () => {
  const root = syntheticOutputs(); const manifest = verifyBuilt(root)
  assert.equal(manifest.packages.length, 12); assert.equal(manifest.runtimeStarted, false)
  assert.ok(manifest.packages.some((p) => p.directory === 'packages/integrations/im'))
  rmSync(path.join(root, 'packages/integrations/im/dist/index.js'))
  assert.throws(() => verifyBuilt(root), /Missing required entry: packages\/integrations\/im/)
})
test('missing Web/PDA assets are refused and output digests change with content', () => {
  const root = syntheticOutputs(); const first = verifyBuilt(root).aggregateDigest
  writeFileSync(path.join(root, 'apps/web/dist/assets/main.js'), 'export const changed = 1')
  assert.notEqual(verifyBuilt(root).aggregateDigest, first)
  rmSync(path.join(root, 'apps/pda/dist/assets/main.js'))
  assert.throws(() => verifyBuilt(root), /Missing web asset/)
})
