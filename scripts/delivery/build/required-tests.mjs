import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createExclusiveDatabase, parseAdminUrl } from './exclusive-pg.mjs'
import { REPO_ROOT, assertSimFixtures } from './fixture-path.mjs'

function specs(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(directory, entry.name)
    return entry.isDirectory() ? (entry.name === 'node_modules' ? [] : specs(child)) : entry.name.endsWith('.spec.ts') ? [child] : []
  }).sort()
}
export function selectSpecs(root, suite) {
  if (suite === 'idempotency') return ['tests/integration/command-idempotency.spec.ts', 'tests/pr13/exclusive-pg.spec.ts'].map((file) => path.join(root, file))
  if (suite === 'engine') return specs(path.join(root, 'tests/sol-sap-engine'))
  if (suite === 'recon') return specs(path.join(root, 'tests/sol-sap-recon'))
  if (suite !== 'all') throw new Error('Unknown required test suite')
  return ['apps', 'packages'].flatMap((base) => readdirSync(path.join(root, base), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).flatMap((entry) => specs(path.join(root, base, entry.name, 'test'))))
    .concat(specs(path.join(root, 'tests'))).sort()
}
export function assessReport(report, expectedFiles, exitCode) {
  const failures = [], counts = { declared: 0, passed: 0, failed: 0, skipped: 0, todo: 0, unknown: 0 }
  if (exitCode !== 0) failures.push('Vitest exited unsuccessfully')
  if (report?.success !== true) failures.push('Vitest did not report success')
  if (!Array.isArray(report?.testResults)) return { status: 'FAIL', counts, failures: [...failures, 'Missing testResults'] }
  const expected = new Set(expectedFiles.map((name) => path.resolve(name))), observed = new Set()
  for (const file of report.testResults) {
    const name = path.resolve(file.name ?? '')
    if (observed.has(name)) failures.push('Duplicate suite report: ' + name)
    observed.add(name)
    if (!expected.has(name)) failures.push('Unexpected suite: ' + name)
    if (file.status !== 'passed') failures.push('Suite did not pass: ' + name)
    if (!file.assertionResults?.length) failures.push('Suite has zero test results: ' + name)
    for (const test of file.assertionResults ?? []) {
      counts.declared++
      if (test.status === 'passed') counts.passed++
      else if (test.status === 'failed') counts.failed++
      else if (test.status === 'todo') counts.todo++
      else if (['pending', 'skipped', 'disabled'].includes(test.status)) counts.skipped++
      else counts.unknown++
    }
  }
  for (const name of expected) if (!observed.has(name)) failures.push('Mandatory suite absent: ' + name)
  if (!counts.declared || counts.failed || counts.skipped || counts.todo || counts.unknown) failures.push('Mandatory test results contain failure, skip, todo, unknown or zero execution')
  if (report.numTotalTests !== counts.declared || report.numPassedTests !== counts.passed || report.numFailedTests !== counts.failed ||
      report.numPendingTests !== counts.skipped || (report.numTodoTests ?? 0) !== counts.todo) failures.push('Reporter counters disagree with individual results')
  if ((report.numFailedTestSuites ?? 0) > 0 || report.unhandledErrors?.length || report.testExecError) failures.push('Suite or unhandled execution error')
  return { status: failures.length ? 'FAIL' : 'PASS', counts, failures,
    counterMeaning: 'Individual Vitest result statuses; a failed beforeAll is a runner failure, not proof that business assertions ran.' }
}
export async function runRequired(root, suite, env = process.env) {
  const output = path.join(root, '.cache/delivery/required-' + suite + '-' + Date.now() + '-' + process.pid)
  mkdirSync(output, { recursive: true })
  const summary = { status: 'NOT_RUN', suite, counts: { declared: 0, passed: 0, failed: 0, skipped: 0, todo: 0, unknown: 0 },
    runnerStarted: false, databaseCleanup: 'PRESERVED', e01Claim: 'No historical SIM evidence is replaced by this gate.' }
  try {
    const selected = selectSpecs(root, suite)
    if (!selected.length) throw new Error('No mandatory files selected')
    parseAdminUrl(env.CADENZA_TEST_ADMIN_URL)
    if (suite !== 'idempotency') assertSimFixtures()
    const database = await createExclusiveDatabase('required', env)
    summary.database = database.database
    await database.pool.end()
    const vitest = path.join(root, 'node_modules/vitest/vitest.mjs')
    if (!existsSync(vitest)) throw new Error('Install the locked project dependencies before the mandatory gate')
    const reportPath = path.join(output, 'vitest.json')
    const args = [vitest, 'run', ...selected.map((file) => path.relative(root, file)), '--reporter=json', '--outputFile=' + reportPath]
    summary.runnerStarted = true
    const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      env: { ...env, DATABASE_URL: database.url, CADENZA_REQUIRE_PG: '1' } })
    writeFileSync(path.join(output, 'stdout.log'), result.stdout ?? '')
    writeFileSync(path.join(output, 'stderr.log'), result.stderr ?? '')
    summary.exitCode = result.status
    if (!existsSync(reportPath)) throw new Error('Vitest did not produce its mandatory JSON report')
    Object.assign(summary, assessReport(JSON.parse(readFileSync(reportPath, 'utf8')), selected, result.status))
  } catch (error) { summary.status = 'FAIL'; summary.reason = error.message }
  writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  return { ...summary, summaryFile: path.join(output, 'summary.json') }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  if (args.length !== 2 || args[0] !== '--suite' || !['idempotency', 'engine', 'recon', 'all'].includes(args[1])) {
    console.error('Usage: required-tests.mjs --suite idempotency|engine|recon|all'); process.exitCode = 2
  } else {
    const result = await runRequired(REPO_ROOT, args[1])
    console.log(JSON.stringify(result))
    if (result.status !== 'PASS') process.exitCode = 1
  }
}
