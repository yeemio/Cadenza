// Node 24 source execution only. This transforms real TS; it is not a typecheck or a build.
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.')) {
      const url = new URL(specifier, context.parentURL)
      let path = fileURLToPath(url)
      if (path.includes('/packages/domain/dist/ot/')) {
        path = path.replace('/domain/dist/ot/', '/domain/src/ot/').replace(/\.js$/, '.ts')
      } else if (!existsSync(path) && existsSync(`${path}.ts`)) path += '.ts'
      if (path.endsWith('.ts') && existsSync(path)) return { url: pathToFileURL(path).href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.ts')) return {
      format: 'module',
      source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform', sourceUrl: url }),
      shortCircuit: true,
    }
    return nextLoad(url, context)
  },
})
