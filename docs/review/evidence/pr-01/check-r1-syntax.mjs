import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'

// Grammar only; does not import dependencies, typecheck, run Vitest or connect PG.
const root = new URL('../../../../', import.meta.url)
const files = [
  'tests/integration/rework-flow.spec.ts',
  'tests/integration/shipping-flow.spec.ts',
]
console.log(`Node ${process.version}; R1 syntax transformation ONLY`)
for (const path of files) {
  stripTypeScriptTypes(readFileSync(new URL(path, root), 'utf8'), { mode: 'transform', sourceUrl: path })
  console.log(`PARSED ${path}`)
}
console.log(`parsed=${files.length}; failed=0; business_tests_executed=0`)
