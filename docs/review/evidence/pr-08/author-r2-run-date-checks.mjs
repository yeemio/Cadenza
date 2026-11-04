import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { stripTypeScriptTypes } from 'node:module'
import { spawnSync } from 'node:child_process'

const out = resolve(process.argv[2])
mkdirSync(out, { recursive: true })
const productPath = 'packages/persistence/src/execution-repositories.ts'
const testPath = 'tests/pr08/execution-date.unit.spec.ts'
const product = readFileSync(productPath, 'utf8')
const test = readFileSync(testPath, 'utf8')
const hash = value => createHash('sha256').update(value).digest('hex')
const runnerImport = "import { describe, it } from 'vitest'"
const productImport = "from '../../packages/persistence/src/execution-repositories'"
assert.equal(test.split(runnerImport).length - 1, 1)
assert.equal(test.split(productImport).length - 1, 1)
// Same checked-in test body/assertions. Only the registration import and module
// path change for the available native Node runner; no Vitest PASS is claimed.
const nativeTest = test
  .replace(runnerImport, "import { describe, it } from 'node:test'")
  .replace(productImport, "from './execution-repositories.native.mjs'")
const productJs = stripTypeScriptTypes(product, { mode: 'transform', sourceUrl: productPath })
const testJs = stripTypeScriptTypes(nativeTest, { mode: 'transform', sourceUrl: testPath })
writeFileSync(join(out, 'execution-repositories.native.mjs'), productJs)
writeFileSync(join(out, 'execution-date.unit.native.mjs'), testJs)
const args = ['--test', '--test-reporter=tap', join(out, 'execution-date.unit.native.mjs')]
const startedAt = new Date().toISOString()
const run = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: process.cwd() })
const completedAt = new Date().toISOString()
if (run.error) throw run.error
process.stdout.write(run.stdout)
process.stderr.write(run.stderr)
const summary = {
  boundary: 'NATIVE_NODE_EXECUTION_OF_SAME_ASSERTIONS_WITH_SQL_CLIENT_DOUBLES_NOT_VITEST_NOT_PG',
  product: { path: productPath, sha256: hash(product), compiledJsSha256: hash(productJs) },
  test: { path: testPath, sha256: hash(test), compiledJsSha256: hash(testJs) },
  registrationImportsAdapted: 1, repositoryImportPathsAdapted: 1,
  testBodyOrAssertionsRewritten: false, processTzModified: false,
  inheritedTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  node: process.version, command: [process.execPath, ...args],
  startedAt, completedAt, exitCode: run.status,
  counts: Object.fromEntries(['tests', 'pass', 'fail', 'skipped', 'cancelled', 'todo'].map(key => {
    const match = run.stdout.match(new RegExp('\\n# ' + key + ' (\\d+)'))
    return [key, match ? Number(match[1]) : null]
  })),
  sqlExecutedAgainstPostgres: false, typecheckCompilerInvoked: false,
}
writeFileSync(join(out, 'native-run.json'), JSON.stringify(summary, null, 2) + '\n')
console.log('PR08_DATE_NATIVE_RESULT ' + JSON.stringify(summary))
process.exitCode = run.status ?? 1
