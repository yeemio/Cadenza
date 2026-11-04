import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const BUILD_ENTRIES = Object.freeze({
  'packages/contracts': 'dist/index.js', 'packages/domain': 'dist/index.js',
  'packages/application': 'dist/index.js', 'packages/persistence': 'dist/index.js',
  'packages/edge': 'dist/index.js', 'packages/ui': 'dist/index.js',
  'packages/integrations/im': 'dist/index.js',
  'apps/api': 'dist/main.js', 'apps/worker': 'dist/main.js',
  'apps/ai': 'dist/apps/ai/src/main.js',
  'apps/web': 'dist/index.html', 'apps/pda': 'dist/index.html',
})
const sha = (value) => createHash('sha256').update(value).digest('hex')
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      if (entry.isSymbolicLink()) throw new Error('Build output must not contain symlinks')
      const absolute = path.join(directory, entry.name)
      return entry.isDirectory() ? files(absolute) : entry.isFile() ? [absolute] : []
    })
}
export function assertNodeEntry(entry, root) {
  const pending = [entry], seen = new Set()
  while (pending.length) {
    const file = pending.pop()
    if (seen.has(file)) continue
    seen.add(file)
    if (!existsSync(file) || !statSync(file).isFile()) throw new Error('Missing built module: ' + path.relative(root, file))
    if (path.extname(file) !== '.js') continue
    const syntax = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    if (syntax.status !== 0) throw new Error('Invalid built JavaScript: ' + path.relative(root, file))
    const require = createRequire(pathToFileURL(file))
    const code = readFileSync(file, 'utf8')
    for (const match of code.matchAll(/(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const specifier = match[1]
      if (specifier.startsWith('node:') || builtinModules.includes(specifier)) continue
      let resolved
      try { resolved = require.resolve(specifier) }
      catch { throw new Error('Unresolved built import ' + specifier + ' in ' + path.relative(root, file)) }
      if ((specifier.startsWith('.') || specifier.startsWith('@cadenza/')) && !resolved.includes(path.sep + 'node_modules' + path.sep)) {
        if (resolved.endsWith('.ts')) throw new Error('Runtime import resolves to TypeScript source: ' + specifier)
        pending.push(resolved)
      }
    }
  }
  return seen.size
}
export function verifyBuilt(root) {
  const packages = [], fullManifest = {}
  for (const [directory, entry] of Object.entries(BUILD_ENTRIES)) {
    const absolute = path.join(root, directory, entry)
    if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new Error('Missing required entry: ' + directory + '/' + entry)
    if (entry.endsWith('.html')) {
      const html = readFileSync(absolute, 'utf8')
      const assets = [...html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/g)].map((m) => m[1].split('?')[0])
      if (!assets.some((name) => name.endsWith('.js'))) throw new Error('Web entry has no JavaScript asset: ' + directory)
      for (const asset of assets) {
        if (/^(?:[a-z]+:|\/\/)/i.test(asset) || asset.split('/').includes('..')) throw new Error('Nonlocal build asset: ' + directory)
        if (!existsSync(path.join(root, directory, 'dist', asset.replace(/^\//, '')))) throw new Error('Missing web asset: ' + directory + '/' + asset)
      }
    } else if (directory !== 'packages/ui') {
      // Resolve static compiled imports without starting main.js, a server, a model or a channel.
      assertNodeEntry(absolute, root)
    }
    const manifest = files(path.join(root, directory, 'dist')).map((file) => ({
      path: path.relative(root, file).split(path.sep).join('/'), sha256: sha(readFileSync(file)),
    }))
    for (const item of manifest) fullManifest[item.path] = item.sha256
    packages.push({ directory, entry, files: manifest.length, sha256: sha(JSON.stringify(manifest)) })
  }
  return { schemaVersion: 1, status: 'BUILT_ENTRY_CHECK_PASS', runtimeStarted: false,
    limitation: 'Static entry and literal import resolution; no database, browser, model, IM channel or device runtime acceptance.',
    dependencyLockSha256: sha(readFileSync(path.join(root, 'pnpm-lock.yaml'))), packages,
    aggregateDigest: sha(JSON.stringify(fullManifest)), fullManifest }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const root = fileURLToPath(new URL('../../../', import.meta.url))
    const result = verifyBuilt(root)
    const output = path.join(root, '.cache/delivery/built-entries.json')
    mkdirSync(path.dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
    console.log(JSON.stringify({ status: result.status, packages: result.packages.length, aggregateDigest: result.aggregateDigest, output }))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
