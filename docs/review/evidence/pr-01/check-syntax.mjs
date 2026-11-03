import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'

// Syntax transformation only. This is neither TypeScript typechecking nor
// application/PG execution. Run against PR01 plus its PR02 compatibility commit.
const root = new URL('../../../../', import.meta.url)
const files = [
  'apps/api/src/rework/rework.composition.ts',
  'apps/api/src/shipping/shipping.composition.ts',
  'packages/application/src/command-bus.ts',
  'packages/application/src/purchase-handlers.ts',
  'packages/application/src/shipping-handlers.ts',
  'packages/persistence/src/pg-command-bus.ts',
  'tests/api/shipping-api.spec.ts',
  'tests/integration/command-idempotency.spec.ts',
  'tests/integration/rework-flow.spec.ts',
  'tests/integration/shipping-flow.spec.ts',
  'tests/pr01/diagnostics.pg.spec.ts',
  'tests/pr01/transaction.pg.spec.ts',
]
console.log(`Node ${process.version}; TypeScript syntax transformation ONLY`)
for (const file of files) {
  stripTypeScriptTypes(readFileSync(new URL(file, root), 'utf8'), { mode: 'transform', sourceUrl: file })
  console.log(`PARSED ${file}`)
}
console.log(`parsed=${files.length}; failed=0; business_tests_executed=0`)
