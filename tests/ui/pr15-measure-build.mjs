import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { includeColdPath } from '../../scripts/delivery/build/cold-build.mjs'

const sha = (value) => createHash('sha256').update(value).digest('hex')
export function verifyColdReceipt(root, receipt, lockSha256) {
  if (receipt.status !== 'COLD_BUILD_PASS' || path.resolve(receipt.isolatedDirectory, 'source') !== path.resolve(root) ||
      receipt.entries?.dependencyLockSha256 !== lockSha256) throw new Error('Cold-build receipt does not bind this successful built source and lock')
  const names = receipt.commands?.find((item) => item.phase === 'tracked-source-list')?.stdout
  if (typeof names !== 'string') throw new Error('Cold receipt has no exact tracked-source list')
  const manifest = names.trim().split('\0').filter(Boolean).filter(includeColdPath).map((relative) => {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('Unsafe cold source path')
    return { path: relative, sha256: sha(readFileSync(path.join(root, relative))) }
  })
  if (sha(JSON.stringify(manifest)) !== receipt.sourceManifestSha256 || manifest.length !== receipt.sourceFileCount) {
    throw new Error('Source changed after the cold build; the previous receipt cannot be reused')
  }
  return true
}
export function readBuildMetrics(directory) {
  const manifest = JSON.parse(readFileSync(path.join(directory, '.vite/manifest.json'), 'utf8'))
  const entries = Object.entries(manifest).filter(([, chunk]) => chunk.isEntry)
  if (entries.length !== 1 || entries[0][0] !== 'index.html') throw new Error('Expected exactly one index.html build entry')
  const initial = new Set(), pending = ['index.html']
  while (pending.length) {
    const key = pending.pop()
    if (initial.has(key)) continue
    if (!manifest[key]) throw new Error('Manifest import is missing: ' + key)
    initial.add(key); pending.push(...(manifest[key].imports ?? []))
  }
  const safeFile = (relative) => {
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('Unsafe build artifact path')
    const file = path.join(directory, relative)
    if (!existsSync(file)) throw new Error('Build artifact is missing: ' + relative)
    const bytes = readFileSync(file)
    return { path: relative, bytes: bytes.length, gzipBytes: gzipSync(bytes, { level: 9 }).length, sha256: sha(bytes) }
  }
  const allJs = [...new Set(Object.values(manifest).map((chunk) => chunk.file).filter((file) => file.endsWith('.js')))].sort().map(safeFile)
  const initialJsPaths = new Set([...initial].map((key) => manifest[key].file).filter((file) => file.endsWith('.js')))
  const initialJs = allJs.filter((file) => initialJsPaths.has(file.path))
  const css = [...new Set([...initial].flatMap((key) => manifest[key].css ?? []))].sort().map(safeFile)
  const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0)
  const dynamicEntries = Object.entries(manifest).filter(([, value]) => value.isDynamicEntry).map(([key]) => key).sort()
  return { initialJsBytes: sum(initialJs, 'bytes'), initialJsGzipBytes: sum(initialJs, 'gzipBytes'),
    totalJsBytes: sum(allJs, 'bytes'), totalJsGzipBytes: sum(allJs, 'gzipBytes'), initialCssBytes: sum(css, 'bytes'),
    largestJsBytes: Math.max(...allJs.map((row) => row.bytes), 0), initialKeys: [...initial].sort(),
    dynamicEntries, initialJs, initialCss: css, allJs,
    meaning: 'Initial JavaScript means the unique transitive static-import closure of index.html. Dynamic route chunks are excluded. Gzip is per-file level 9, summed; no timing/device claim.' }
}
function inputFiles(root) {
  const selected = ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'tsconfig.base.json']
  function walk(relative) {
    const absolute = path.join(root, relative)
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.cache', '.git'].includes(entry.name) || entry.name.startsWith('.env')) continue
      const next = path.join(relative, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Build source contains a symlink: ' + next)
      if (entry.isDirectory()) walk(next)
      else if (entry.isFile()) selected.push(next)
    }
  }
  for (const directory of ['apps/web', 'apps/pda', 'packages/ui', 'packages/contracts']) walk(directory)
  return selected.sort().map((file) => ({ path: file.split(path.sep).join('/'), sha256: sha(readFileSync(path.join(root, file))) }))
}
export function compareMeasurements(baseline, candidate) {
  const failures = []
  if (baseline.status !== 'MEASURED' || candidate.status !== 'MEASURED') failures.push('Both exact candidates must have successful measurements')
  if (baseline.lockSha256 !== candidate.lockSha256 || JSON.stringify(baseline.toolchain) !== JSON.stringify(candidate.toolchain) || baseline.recipeSha256 !== candidate.recipeSha256) failures.push('Lock, toolchain or measurement recipe differs')
  if (baseline.mode !== 'production' || candidate.mode !== 'production') failures.push('Production mode is required')
  if (!baseline.coldBuildVerified || !candidate.coldBuildVerified) failures.push('Both clean-build receipts are required for acceptance')
  const apps = {}
  for (const app of ['web', 'pda']) {
    const before = baseline.apps?.[app], after = candidate.apps?.[app]
    if (!before || !after) { failures.push('Missing application measurement: ' + app); continue }
    apps[app] = { initialJsByteChange: after.initialJsBytes - before.initialJsBytes,
      initialGzipByteChange: after.initialJsGzipBytes - before.initialJsGzipBytes,
      totalJsByteChange: after.totalJsBytes - before.totalJsBytes,
      totalGzipByteChange: after.totalJsGzipBytes - before.totalJsGzipBytes,
      largestAfterChunkBytes: after.largestJsBytes }
    if (!(after.initialJsBytes < before.initialJsBytes) || !(after.initialJsGzipBytes < before.initialJsGzipBytes)) failures.push(app + ' initial JS/gzip did not decrease')
    if (!after.dynamicEntries?.length || after.initialKeys.some((key) => after.dynamicEntries.includes(key))) failures.push(app + ' dynamic route entries are missing or in the initial closure')
  }
  return { status: failures.length ? 'FAIL_OR_UNVERIFIED' : 'BUILD_BYTES_IMPROVED', apps, failures,
    devicePerformance: 'NOT_MEASURED_BY_THIS_TOOL', scope: 'Comparable built asset bytes only; full app/browser/device behavior requires separate tests.' }
}
export function measureBuild(root, label, coldReceiptFile) {
  const outputs = mkdtempSync(path.join(tmpdir(), 'cadenza-pr15-measure-'))
  const report = { schemaVersion: 1, label, mode: 'production', status: 'NOT_RUN', outputs, apps: {}, commands: [],
    recipeSha256: sha(readFileSync(fileURLToPath(import.meta.url))), devicePerformance: 'NOT_RUN', coldBuildVerified: false }
  try {
    const files = inputFiles(root); report.sourceFiles = files; report.sourceDigest = sha(JSON.stringify(files))
    report.lockSha256 = sha(readFileSync(path.join(root, 'pnpm-lock.yaml')))
    const version = spawnSync('pnpm', ['--version'], { cwd: root, encoding: 'utf8' })
    const expected = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).packageManager.replace(/^pnpm@/, '')
    if (version.status !== 0 || version.stdout.trim() !== expected) throw new Error('Install and use the exact pinned pnpm before recording comparable build sizes')
    const require = createRequire(path.join(root, 'package.json'))
    const vitePackage = require.resolve('vite/package.json'), vite = JSON.parse(readFileSync(vitePackage, 'utf8'))
    report.toolchain = { node: process.versions.node, pnpm: expected, vite: vite.version }
    if (coldReceiptFile) {
      const receipt = JSON.parse(readFileSync(coldReceiptFile, 'utf8'))
      verifyColdReceipt(root, receipt, report.lockSha256)
      report.coldBuildVerified = true; report.coldSourceCommit = receipt.sourceCommit
    }
    for (const app of ['web', 'pda']) {
      const output = path.join(outputs, app)
      const args = [path.join(path.dirname(vitePackage), 'bin/vite.js'), 'build', path.join(root, 'apps', app), '--mode', 'production',
        '--config', path.join(root, 'apps', app, 'vite.config.ts'), '--outDir', output, '--manifest']
      const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
        env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITE_'))),
          NODE_ENV: 'production', VITE_API_MODE: 'live', VITE_API_BASE_URL: 'http://127.0.0.1:3001' } })
      const log = path.join(outputs, app + '-build.log'); writeFileSync(log, (result.stdout ?? '') + (result.stderr ?? ''))
      report.commands.push({ command: [process.execPath, ...args], exitCode: result.status, log })
      if (result.status !== 0) throw new Error(app + ' build failed; output is not a measurement')
      report.apps[app] = readBuildMetrics(output)
    }
    report.status = 'MEASURED'
  } catch (error) { report.status = 'NOT_MEASURED'; report.reason = error.message }
  return report
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2), args = {}
  for (let index = 0; index < argv.length; index += 2) {
    if (!['--root', '--label', '--out', '--cold-receipt', '--baseline', '--candidate'].includes(argv[index]) || !argv[index + 1]) throw new Error('Invalid measurement arguments')
    args[argv[index].slice(2)] = argv[index + 1]
  }
  if (!args.out || existsSync(args.out)) throw new Error('Choose a new --out evidence path; existing evidence is never overwritten')
  const result = args.baseline && args.candidate ? compareMeasurements(JSON.parse(readFileSync(args.baseline, 'utf8')), JSON.parse(readFileSync(args.candidate, 'utf8')))
    : args.root && args.label ? measureBuild(path.resolve(args.root), args.label, args['cold-receipt']) : null
  if (!result) throw new Error('Use --root DIR --label NAME --out FILE [--cold-receipt FILE], or --baseline FILE --candidate FILE --out FILE')
  mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true }); writeFileSync(args.out, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ status: result.status, reason: result.reason, failures: result.failures, output: args.out }))
  if (!['MEASURED', 'BUILD_BYTES_IMPROVED'].includes(result.status)) process.exitCode = 1
}
