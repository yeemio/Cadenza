import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, copyFileSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { verifyBuilt } from './verify-built.mjs'

export function includeColdPath(relative) {
  const parts = relative.split('/')
  return !parts.some((part) => ['dist', 'node_modules', '.git', '.cache'].includes(part)) &&
    !parts.some((part) => part.startsWith('.env') && part !== '.env.example')
}
function command(binary, args, cwd, receipt, phase) {
  const result = spawnSync(binary, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: { ...process.env, CI: 'true' } })
  receipt.commands.push({ phase, command: [binary, ...args], exitCode: result.status, signal: result.signal ?? null,
    stdout: result.stdout ?? '', stderr: result.stderr ?? '', spawnError: result.error?.code ?? null })
  if (result.status !== 0) throw new Error(phase + ' failed')
  return result.stdout.trim()
}
export function coldBuild(root, options = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'cadenza-cold-build-'))
  const checkout = path.join(directory, 'source')
  const receipt = { status: 'NOT_RUN', sourceRoot: root, isolatedDirectory: directory, oldDistUsed: false,
    packageInstall: 'NOT_RUN', workspaceBuild: 'NOT_RUN', commands: [], preserved: true }
  const output = path.join(directory, 'cold-build-receipt.json')
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
    const expected = /^pnpm@(\d+\.\d+\.\d+)$/.exec(pkg.packageManager)?.[1]
    if (!expected) throw new Error('Exact pnpm packageManager version is required')
    const pnpm = options.pnpm ?? 'pnpm'
    const actual = command(pnpm, ['--version'], root, receipt, 'package-manager-version')
    if (actual !== expected) throw new Error('Pinned pnpm ' + expected + ' is required; observed ' + actual)
    if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node >=24 is required')
    const top = command('git', ['rev-parse', '--show-toplevel'], root, receipt, 'source-repository')
    if (path.resolve(top) !== path.resolve(root)) throw new Error('Source must be the exact repository root')
    if (command('git', ['status', '--porcelain'], root, receipt, 'source-cleanliness')) throw new Error('Commit the candidate in an isolated clean checkout before the cold gate')
    receipt.sourceCommit = command('git', ['rev-parse', 'HEAD'], root, receipt, 'source-commit')
    const names = command('git', ['ls-files', '-z'], root, receipt, 'tracked-source-list').split('\0').filter(Boolean)
    const sourceManifest = []
    for (const relative of names.filter(includeColdPath)) {
      const source = path.join(root, relative), target = path.join(checkout, relative)
      if (!lstatSync(source).isFile()) throw new Error('Tracked symlink or special file is not allowed in cold snapshot: ' + relative)
      mkdirSync(path.dirname(target), { recursive: true }); copyFileSync(source, target)
      sourceManifest.push({ path: relative, sha256: createHash('sha256').update(readFileSync(target)).digest('hex') })
    }
    receipt.sourceManifestSha256 = createHash('sha256').update(JSON.stringify(sourceManifest)).digest('hex')
    receipt.sourceFileCount = sourceManifest.length
    // The destination did not exist before this run; node_modules and every dist were excluded.
    receipt.packageInstall = 'STARTED'
    command(pnpm, ['install', '--frozen-lockfile', ...(options.offline ? ['--offline'] : [])], checkout, receipt, 'frozen-install')
    receipt.packageInstall = 'PASS'; receipt.workspaceBuild = 'STARTED'
    command(pnpm, ['run', 'build'], checkout, receipt, 'workspace-build')
    receipt.workspaceBuild = 'PASS'; receipt.entries = verifyBuilt(checkout); receipt.status = 'COLD_BUILD_PASS'
  } catch (error) { receipt.status = 'FAIL'; receipt.reason = error.message }
  writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n')
  return { ...receipt, receiptFile: output }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  if (args.some((arg) => arg !== '--offline')) { console.error('Usage: pnpm build:cold [--offline]'); process.exitCode = 2 }
  else {
    const result = coldBuild(fileURLToPath(new URL('../../../', import.meta.url)), { offline: args.includes('--offline') })
    console.log(JSON.stringify({ status: result.status, reason: result.reason, receiptFile: result.receiptFile }))
    if (result.status !== 'COLD_BUILD_PASS') process.exitCode = 1
  }
}
