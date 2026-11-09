# PR14 R1: legacy regression correction

Date: 2026-11-03. Identity: `same_family_external_advisory`.
Exact incremental parent: `624067da1a5340a107db4c7786fc7755a572e1ed`.
Branch: `codex/fix-14-edge-delivery-ack`. Product base remains
`cb25076d99cda0ac359151ff9eea65507de8cc4d`; no prerequisite PR.

## Received evidence and approved scope

The PR head, complete legacy test, controller-r0.json, controller-r0.md and raw
controller-r0-vitest.log were read at the exact parent. Controller R0 executed
the existing regression: 5 tests, 4 passed, 1 failed, 0 skipped. Its failing
expectation assumed delivery without a transport while the gateway was offline.
The controller also recorded the unchanged seven-case source gate, targeted
contracts/domain/edge build and edge typecheck as passed. These are existing R0
results, not newly executed R1 coverage.

Owner/controller approved adding only `packages/edge/test/edge-gateway.spec.ts`
to the implementation scope. R1 changes that test, the fix-contract addendum and
this evidence note. No product algorithm, previous seven-case test, frozen
contract or existing raw log is modified.

## Correction

- An explicit transport-less case checks both online and offline flush: zero
  acknowledged samples, unchanged pending event data, overflow and checkpoint.
- The existing successful recovery case now supplies `MemoryTransport`. It
  first verifies that offline flush sends nothing and retains the original
  three samples. Only after `setOnline(true)` does it expect three acknowledgments.
- It checks the actual sent event IDs, one transport batch and the empty saved
  backlog, then restores and verifies the sequence continues without sending
  while offline. All previous assertions remain; no case is deleted or skipped.

The legacy suite now contains six test declarations. That source count is not
an execution result and does not add the old seven-case gate to R1 totals.

## Author-side verification and limits

Node v24.22.1. Actual syntax-only command, from the candidate root:

```sh
node --input-type=module -e "import { readFileSync } from 'node:fs'; import { stripTypeScriptTypes } from 'node:module'; stripTypeScriptTypes(readFileSync(process.argv[1], 'utf8'), { mode: 'transform' }); console.log('TS_SYNTAX_TRANSFORM_OK: 1 file; no test execution or typecheck');" packages/edge/test/edge-gateway.spec.ts
```

Exit 0; stdout: `TS_SYNTAX_TRANSFORM_OK: 1 file; no test execution or typecheck`.
Node also printed its experimental stripTypeScriptTypes warning. This is not
TypeScript typechecking, a build or a test pass.

Actual project Vitest capability check:

```sh
node -e "try { console.log(require.resolve('vitest/package.json')) } catch(e) { console.log('VITEST_UNAVAILABLE: '+e.code); process.exitCode=2 }"
```

Exit 2; stdout: `VITEST_UNAVAILABLE: MODULE_NOT_FOUND`.
R1 Vitest/build/typecheck: **NOT_RUN**. R1 business-test execution counts are
0 executed, 0 passed, 0 failed, 0 skipped. No substitute runner was used.

## Controller reception command

Apply the R1 incremental patch on the exact parent, then run:

```sh
pnpm exec vitest run packages/edge/test/edge-gateway.spec.ts
```

Retain actual exit code and executed/pass/fail/skip counts. Reuse R0 build and
typecheck evidence for the unchanged product files; the previous seven-case
gate need not be rerun merely to manufacture new evidence. If a new failure
appears, retain its exact candidate and raw output before a named correction.

Publication of this increment is pending the controller's existing authorized
channel. The known Chat connector write denial was not retried. Draft/REWORK
remains until controller reception. No merge, release, deployment or external
channel call occurred. Real API/PG/device/site and independent R6 acceptance
remain unverified. The other fourteen PRs remain in the same authorized batch.
