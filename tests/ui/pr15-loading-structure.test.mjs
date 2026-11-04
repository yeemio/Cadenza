import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { routeContract, staticPageGraph, lazyPageImports } from './pr15-source-graph.mjs'
import { readBuildMetrics, compareMeasurements, verifyColdReceipt } from './pr15-measure-build.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url)), temporary = []
const baseline = JSON.parse(readFileSync(new URL('./pr15-baseline-routes.json', import.meta.url), 'utf8'))
const sha = (data) => createHash('sha256').update(data).digest('hex')
function directory() { const dir = mkdtempSync(path.join(tmpdir(), 'cadenza-pr15-test-')); temporary.push(dir); return dir }
test.after(() => { for (const dir of temporary) rmSync(dir, { recursive: true, force: true }) })
function jsxAttribute(node, name) { return node.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.text === name)?.initializer }
function routeElement(node) {
  const element = jsxAttribute(node, 'element')
  return element && ts.isJsxExpression(element) && element.expression && ts.isJsxSelfClosingElement(element.expression) ? element.expression.tagName.getText() : null
}
for (const app of ['web', 'pda']) {
  test(app + ': every original route, alias, parameter and redirect is retained', () => assert.deepEqual(routeContract(root, app), baseline[app].routes))
  test(app + ': initial static imports reach only LoginPage, including navigation mount dependencies', () => {
    assert.deepEqual(staticPageGraph(root, app).staticPageModules, ['apps/' + app + '/src/pages/LoginPage.tsx'])
    assert.ok(baseline[app].graph.staticPageModules.length > 20)
  })
  test(app + ': all named lazy import targets actually export their page', () => {
    const imports = lazyPageImports(root, app)
    assert.equal(imports.length, baseline[app].graph.staticPageModules.length - 1)
    for (const item of imports) {
      const file = path.resolve(root, 'apps', app, path.dirname(item.file), item.module) + '.tsx'
      const text = readFileSync(file, 'utf8'), name = path.basename(item.module)
      assert.match(text, new RegExp('export (?:function|const|class) ' + name + '\\b'), file)
    }
  })
  test(app + ': lazy business routes and mounted map routes stay inside RequireAuth and the existing layout', () => {
    const file = path.join(root, 'apps', app, 'src/App.tsx')
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    assert.deepEqual(source.parseDiagnostics, [])
    let checked = 0
    function visit(node) {
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText() === 'Route') {
        const attribute = jsxAttribute(node, 'path')
        if (attribute && !(ts.isStringLiteral(attribute) && ['/login', '*'].includes(attribute.text))) {
          const ancestors = []
          for (let parent = node.parent; parent; parent = parent.parent) {
            if (ts.isJsxElement(parent) && parent.openingElement.tagName.getText() === 'Route') ancestors.push(routeElement(parent.openingElement))
          }
          assert.ok(ancestors.includes('RequireAuth')); assert.ok(ancestors.includes(app === 'web' ? 'AppLayout' : 'PdaLayout'))
          assert.ok(ancestors.includes('LazyRouteOutlet')); checked++
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source); assert.ok(checked > 10)
  })
  test(app + ': all changed TSX files parse without syntax diagnostics', () => {
    for (const relative of ['src/App.tsx', 'src/loading/mount.tsx', 'src/p2/mount.tsx', 'src/p3/mount.tsx', 'src/p4/mount.tsx']) {
      const file = path.join(root, 'apps', app, relative)
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      assert.deepEqual(source.parseDiagnostics, [], file)
    }
  })
}
function outputFixture() {
  const dir = directory(); mkdirSync(path.join(dir, '.vite')); mkdirSync(path.join(dir, 'assets'))
  const manifest = {
    'index.html': { isEntry: true, file: 'assets/main.js', imports: ['shared'], dynamicImports: ['route'], css: ['assets/main.css'] },
    shared: { file: 'assets/shared.js', imports: ['shared2'] }, shared2: { file: 'assets/shared2.js', imports: ['shared'] },
    route: { isDynamicEntry: true, file: 'assets/route.js', imports: ['shared'] },
  }
  const values = { 'main.js': 'MAIN', 'shared.js': 'SHARED', 'shared2.js': 'SHARED2', 'route.js': 'ROUTE'.repeat(100), 'main.css': 'body{}' }
  for (const [name, content] of Object.entries(values)) writeFileSync(path.join(dir, 'assets', name), content)
  writeFileSync(path.join(dir, '.vite/manifest.json'), JSON.stringify(manifest))
  return { dir, manifest }
}
test('measurement counts static import closure once and excludes dynamic route bytes', () => {
  const result = readBuildMetrics(outputFixture().dir)
  assert.equal(result.initialJsBytes, 4 + 6 + 7)
  assert.equal(result.totalJsBytes, 4 + 6 + 7 + 500)
  assert.equal(result.initialJs.length, 3); assert.deepEqual(result.dynamicEntries, ['route'])
  assert.ok(result.totalJsGzipBytes > result.initialJsGzipBytes)
})
test('missing imported chunks cannot produce a measurement', () => {
  const { dir, manifest } = outputFixture(); manifest.shared.imports.push('missing')
  writeFileSync(path.join(dir, '.vite/manifest.json'), JSON.stringify(manifest))
  assert.throws(() => readBuildMetrics(dir), /Manifest import is missing/)
})
test('missing artifact files and unsafe paths cannot produce a measurement', () => {
  const { dir, manifest } = outputFixture(); rmSync(path.join(dir, 'assets/main.js'))
  assert.throws(() => readBuildMetrics(dir), /artifact is missing/)
  manifest['index.html'].file = '../outside.js'; writeFileSync(path.join(dir, '.vite/manifest.json'), JSON.stringify(manifest))
  assert.throws(() => readBuildMetrics(dir), /Unsafe build artifact path/)
})
test('multiple HTML entrypoints are rejected instead of selecting an arbitrary denominator', () => {
  const { dir, manifest } = outputFixture(); manifest.extra = { isEntry: true, file: 'assets/route.js' }
  writeFileSync(path.join(dir, '.vite/manifest.json'), JSON.stringify(manifest))
  assert.throws(() => readBuildMetrics(dir), /exactly one/)
})
function measurements() {
  const before = { status: 'MEASURED', mode: 'production', coldBuildVerified: true, lockSha256: 'fixture-lock', recipeSha256: 'recipe',
    toolchain: { node: 'fixture', pnpm: 'fixture', vite: 'fixture' }, apps: {} }
  for (const app of ['web', 'pda']) before.apps[app] = { initialJsBytes: 1000, initialJsGzipBytes: 500, totalJsBytes: 1000, totalJsGzipBytes: 500, largestJsBytes: 1000, initialKeys: ['index.html'], dynamicEntries: [] }
  const after = structuredClone(before)
  for (const app of ['web', 'pda']) Object.assign(after.apps[app], { initialJsBytes: 400, initialJsGzipBytes: 200, totalJsBytes: 1100, totalJsGzipBytes: 570, largestJsBytes: 400, dynamicEntries: ['route'] })
  return { before, after }
}
test('comparison reports initial savings and total-size overhead separately', () => {
  const { before, after } = measurements(), result = compareMeasurements(before, after)
  assert.equal(result.status, 'BUILD_BYTES_IMPROVED'); assert.equal(result.apps.web.initialJsByteChange, -600)
  assert.equal(result.apps.web.totalJsByteChange, 100); assert.equal(result.devicePerformance, 'NOT_MEASURED_BY_THIS_TOOL')
})
for (const field of ['lockSha256', 'recipeSha256', 'toolchain', 'mode', 'status', 'coldBuildVerified']) {
  test('comparison rejects mismatched/unverified ' + field, () => {
    const { before, after } = measurements(); after[field] = field === 'coldBuildVerified' ? false : 'different'
    assert.equal(compareMeasurements(before, after).status, 'FAIL_OR_UNVERIFIED')
  })
}
test('unchanged initial bytes or eager dynamic entries cannot be reported as an improvement', () => {
  const { before, after } = measurements(); after.apps.pda.initialJsBytes = 1000
  assert.equal(compareMeasurements(before, after).status, 'FAIL_OR_UNVERIFIED')
  after.apps.pda.initialJsBytes = 400; after.apps.web.initialKeys.push('route')
  assert.equal(compareMeasurements(before, after).status, 'FAIL_OR_UNVERIFIED')
})
test('a cold receipt is bound to unchanged source bytes, not only a directory and lock', () => {
  const isolated = directory(), root = path.join(isolated, 'source'); mkdirSync(root)
  writeFileSync(path.join(root, 'source.ts'), 'original')
  const manifest = [{ path: 'source.ts', sha256: sha('original') }]
  const receipt = { status: 'COLD_BUILD_PASS', isolatedDirectory: isolated, entries: { dependencyLockSha256: 'lock' },
    sourceManifestSha256: sha(JSON.stringify(manifest)), sourceFileCount: 1, commands: [{ phase: 'tracked-source-list', stdout: 'source.ts\0' }] }
  assert.equal(verifyColdReceipt(root, receipt, 'lock'), true)
  writeFileSync(path.join(root, 'source.ts'), 'modified')
  assert.throws(() => verifyColdReceipt(root, receipt, 'lock'), /Source changed/)
})
