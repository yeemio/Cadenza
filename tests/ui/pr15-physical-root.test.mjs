import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { measureBuild, verifyColdReceipt } from './pr15-measure-build.mjs'

// Local guard fixtures only. These are not authentic cold receipts or byte measurements.
// Child builds are explicit port doubles and deliberately end NOT_MEASURED.
const sha = value => createHash('sha256').update(value).digest('hex')
const temporary = []
test.after(() => { for (const dir of temporary) rmSync(dir, { recursive: true, force: true }) })
function fixture() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'cadenza-pr15-r1-unit-'))); temporary.push(dir)
  const isolated = path.join(dir, 'physical'), root = path.join(isolated, 'source'), alias = path.join(dir, 'alias')
  mkdirSync(root, { recursive: true }); symlinkSync(isolated, alias, 'dir')
  const values = {
    'package.json': JSON.stringify({ name: 'pr15-unit-only', packageManager: 'pnpm@99.0.0-unit-fixture' }),
    'pnpm-lock.yaml': 'UNIT_ONLY_NOT_AN_INSTALL_LOCK\n',
    'pnpm-workspace.yaml': 'packages: []\n',
    'tsconfig.base.json': '{}\n',
    'apps/web/index.html': '<div id="root"></div>',
    'apps/web/vite.config.ts': 'export default {}',
    'apps/pda/index.html': '<div id="root"></div>',
    'apps/pda/vite.config.ts': 'export default {}',
    'packages/ui/src/fixture.ts': 'export const unitOnly = true',
    'packages/contracts/src/fixture.ts': 'export const unitOnly = true',
    'packages/application/src/fixture.ts': 'FULL_TRACKED_SOURCE_GUARD',
    'tests/ui/pr15-measure-build.mjs': 'FROZEN_OLD_RECIPE_NOT_EXECUTED',
  }
  for (const [relative, value] of Object.entries(values)) {
    const file = path.join(root, relative); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, value)
  }
  const manifest = Object.keys(values).sort().map(relative => ({ path: relative, sha256: sha(values[relative]) }))
  const lock = sha(values['pnpm-lock.yaml'])
  const receipt = { status: 'COLD_BUILD_PASS', sourceCommit: 'UNIT_FIXTURE_NOT_A_REAL_COMMIT', isolatedDirectory: isolated,
    entries: { dependencyLockSha256: lock }, sourceManifestSha256: sha(JSON.stringify(manifest)), sourceFileCount: manifest.length,
    commands: [{ phase: 'tracked-source-list', stdout: manifest.map(row => row.path).join('\0') + '\0' }] }
  const receiptFile = path.join(isolated, 'unit-only-receipt.json')
  writeFileSync(receiptFile, JSON.stringify(receipt))
  const vite = path.join(root, 'node_modules/vite'); mkdirSync(path.join(vite, 'bin'), { recursive: true })
  writeFileSync(path.join(vite, 'package.json'), JSON.stringify({ name: 'vite', version: '0.0.0-unit-double' }))
  writeFileSync(path.join(vite, 'bin/vite.js'), 'throw new Error("must use explicit child-process double in this local test")')
  return { dir, root, isolated, alias, aliasRoot: path.join(alias, 'source'), receipt, receiptFile, lock, manifest }
}
function withChildDouble(fn, body) {
  const replacement = mock.method(childProcess, 'spawnSync', fn)
  syncBuiltinESMExports()
  try { return body() } finally { replacement.mock.restore(); syncBuiltinESMExports() }
}
test('real filesystem aliases bind the same physical cold source in both directions', () => {
  const f = fixture()
  assert.notEqual(f.aliasRoot, f.root)
  assert.equal(realpathSync(f.aliasRoot), f.root)
  assert.equal(verifyColdReceipt(f.aliasRoot, f.receipt, f.lock), true)
  assert.equal(verifyColdReceipt(f.root, { ...f.receipt, isolatedDirectory: f.alias }, f.lock), true)
})
test('an unrelated physical root rejects even when every tracked byte is identical', () => {
  const a = fixture(), b = fixture()
  assert.equal(a.receipt.sourceManifestSha256, b.receipt.sourceManifestSha256)
  assert.throws(() => verifyColdReceipt(b.aliasRoot, a.receipt, b.lock), /does not bind/)
})
test('mutation outside the UI measurement subset still invalidates the full cold manifest through an alias', () => {
  const f = fixture()
  writeFileSync(path.join(f.root, 'packages/application/src/fixture.ts'), 'MUTATED')
  assert.throws(() => verifyColdReceipt(f.aliasRoot, f.receipt, f.lock), /Source changed/)
})
test('cold source file count remains mandatory through a genuine alias', () => {
  const f = fixture()
  assert.throws(() => verifyColdReceipt(f.aliasRoot, { ...f.receipt, sourceFileCount: f.receipt.sourceFileCount - 1 }, f.lock), /Source changed/)
})
test('cold source manifest digest remains mandatory through a genuine alias', () => {
  const f = fixture()
  assert.throws(() => verifyColdReceipt(f.aliasRoot, { ...f.receipt, sourceManifestSha256: sha('different') }, f.lock), /Source changed/)
})
test('failed cold status cannot bind an otherwise matching physical source', () => {
  const f = fixture()
  assert.throws(() => verifyColdReceipt(f.aliasRoot, { ...f.receipt, status: 'FAIL' }, f.lock), /does not bind/)
})
test('a different dependency lock cannot bind an otherwise matching physical source', () => {
  const f = fixture()
  assert.throws(() => verifyColdReceipt(f.aliasRoot, f.receipt, sha('different lock')), /does not bind/)
})
for (const unsafe of ['../outside.ts', '/outside.ts', '..\\outside.ts']) {
  test('aliased source retains unsafe tracked path rejection: ' + unsafe, () => {
    const f = fixture()
    const receipt = { ...f.receipt, commands: [{ phase: 'tracked-source-list', stdout: unsafe + '\0' }] }
    assert.throws(() => verifyColdReceipt(f.aliasRoot, receipt, f.lock), /Unsafe cold source path/)
  })
}
test('a missing exact tracked-source list still rejects through an alias', () => {
  const f = fixture()
  assert.throws(() => verifyColdReceipt(f.aliasRoot, { ...f.receipt, commands: [] }, f.lock), /no exact tracked-source list/)
})
test('external recipe dispatches Web and PDA with physical roots/configs/output/cwd and leaves the frozen inputs untouched', () => {
  const f = fixture(), calls = []
  const originalReceipt = readFileSync(f.receiptFile)
  const outputParent = path.join(f.isolated, 'temporary-outputs'); mkdirSync(outputParent)
  const oldTmp = process.env.TMPDIR
  process.env.TMPDIR = path.join(f.alias, 'temporary-outputs')
  try {
    const report = withChildDouble((binary, args, options) => {
      calls.push({ binary, args, options })
      if (binary === 'pnpm') return { status: 0, stdout: '99.0.0-unit-fixture\n', stderr: '' }
      const app = path.basename(args[2]), output = args[args.indexOf('--outDir') + 1]
      if (app === 'pda') return { status: 1, stdout: '', stderr: 'INTENTIONAL_UNIT_DOUBLE_NO_REAL_BUILD\n' }
      assert.equal(app, 'web')
      mkdirSync(path.join(output, '.vite'), { recursive: true })
      writeFileSync(path.join(output, 'unit-only.js'), 'UNIT_DOUBLE_NOT_BUILD_EVIDENCE')
      writeFileSync(path.join(output, '.vite/manifest.json'), JSON.stringify({ 'index.html': { isEntry: true, file: 'unit-only.js' } }))
      return { status: 0, stdout: 'UNIT_DOUBLE_NOT_BUILD_EVIDENCE\n', stderr: '' }
    }, () => measureBuild(f.aliasRoot, 'UNIT_ONLY_NOT_ACCEPTANCE', f.receiptFile))
    assert.equal(report.status, 'NOT_MEASURED')
    assert.match(report.reason, /pda build failed/)
    assert.equal(report.devicePerformance, 'NOT_RUN')
    assert.deepEqual(report.rootIdentity, { requestedRoot: f.aliasRoot, physicalRoot: f.root })
    assert.equal(report.outputs, realpathSync(report.outputs))
    assert.equal(path.dirname(report.outputs), outputParent)
    assert.equal(report.coldBuildVerified, true) // Only this synthetic guard fixture, not a real cold build.
    assert.deepEqual(report.coldReceiptIdentity, { path: realpathSync(f.receiptFile), sha256: sha(originalReceipt),
      declaredSourceRoot: f.root, physicalSourceRoot: f.root, sourceManifestSha256: f.receipt.sourceManifestSha256, sourceFileCount: f.manifest.length })
    assert.equal(report.recipeSha256, sha(readFileSync(new URL('./pr15-measure-build.mjs', import.meta.url))))
    assert.notEqual(report.recipeSha256, sha(readFileSync(path.join(f.root, 'tests/ui/pr15-measure-build.mjs'))))
    assert.equal(calls.length, 3)
    assert.deepEqual(calls[0].args, ['--version'])
    for (const [index, app] of ['web', 'pda'].entries()) {
      const { binary, args, options } = calls[index + 1]
      assert.equal(binary, process.execPath)
      assert.equal(options.cwd, f.root)
      assert.equal(args[0], realpathSync(path.join(f.root, 'node_modules/vite/bin/vite.js')))
      assert.equal(args[2], realpathSync(path.join(f.root, 'apps', app)))
      assert.equal(args[args.indexOf('--config') + 1], realpathSync(path.join(f.root, 'apps', app, 'vite.config.ts')))
      assert.equal(args[args.indexOf('--outDir') + 1], path.join(report.outputs, app))
      assert.equal(report.commands[index].cwd, f.root)
    }
    assert.equal(calls[0].options.cwd, f.root)
    assert.deepEqual(readFileSync(f.receiptFile), originalReceipt)
    for (const row of f.manifest) assert.equal(sha(readFileSync(path.join(f.root, row.path))), row.sha256, row.path)
  } finally {
    if (oldTmp === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = oldTmp
  }
})
test('the pinned package-manager guard still stops before dispatching any build', () => {
  const f = fixture(), calls = []
  const report = withChildDouble((binary, args) => { calls.push({ binary, args }); return { status: 0, stdout: 'different-version', stderr: '' } },
    () => measureBuild(f.aliasRoot, 'UNIT_ONLY_NOT_ACCEPTANCE', f.receiptFile))
  temporary.push(report.outputs)
  assert.equal(report.status, 'NOT_MEASURED')
  assert.match(report.reason, /exact pinned pnpm/)
  assert.equal(calls.length, 1); assert.equal(calls[0].binary, 'pnpm')
  assert.deepEqual(report.commands, [])
})
test('the actual coordinator rejects an unrelated receipt before dispatching any build', () => {
  const a = fixture(), b = fixture(), calls = []
  const report = withChildDouble((binary, args) => { calls.push({ binary, args }); return { status: 0, stdout: '99.0.0-unit-fixture', stderr: '' } },
    () => measureBuild(b.aliasRoot, 'UNIT_ONLY_NOT_ACCEPTANCE', a.receiptFile))
  temporary.push(report.outputs)
  assert.equal(report.status, 'NOT_MEASURED')
  assert.match(report.reason, /does not bind/)
  assert.equal(calls.length, 1); assert.equal(calls[0].binary, 'pnpm')
  assert.deepEqual(report.commands, [])
  assert.equal(report.coldBuildVerified, false)
})
test('the external helper CLI invoked through a real alias emits an honest failure report without a cold source', () => {
  const f = fixture(), alias = path.join(f.dir, 'external-recipe-alias.mjs'), out = path.join(f.dir, 'not-measured.json')
  symlinkSync(fileURLToPath(new URL('./pr15-measure-build.mjs', import.meta.url)), alias)
  const result = childProcess.spawnSync(process.execPath, [alias, '--root', path.join(f.dir, 'missing-cold-source'),
    '--label', 'UNIT_ONLY_MISSING_INPUT', '--out', out], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.equal(existsSync(out), true)
  const report = JSON.parse(readFileSync(out, 'utf8')); temporary.push(report.outputs)
  assert.equal(report.status, 'NOT_MEASURED')
  assert.equal(report.coldBuildVerified, false)
  assert.deepEqual(report.commands, [])
  assert.match(report.reason, /ENOENT/)
  assert.equal(JSON.parse(result.stdout).status, 'NOT_MEASURED')
})
