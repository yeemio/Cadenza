# PR02 R0 — actual object write authorization

Status: **SOURCE_READY_PG_NOT_RUN_CONTROLLER_PENDING**. This is an implementation candidate for C2, not controller ACCEPT.

## Binding and delivery

- Repository: `yeemio/Cadenza`; original branch: `codex/fix-02-object-write-scope`.
- Verified original PR02 head: `70fe34fa654e50ff9b8f41aacc5aef825118a9ed`.
- Prerequisite: the exact 11 source/test postimages of accepted PR01 head `956d9e1bd4192943e1095e03884d4c58435de710` which differ from that PR02 head. Its tested source is `d6cc96aa64fec40323ea40dde917ac8a2759fd06`. All eight hashes in the final PR01 receipt match the cumulative parent. The PR02 purchase QUARANTINED compatibility change is already in both parents.
- The archive contains a complete patch against the verified original PR02 head, a separate prerequisite patch, an incremental PR02-only patch, and every changed file's complete postimage. Apply the cumulative patch OR prerequisite plus increment; never both routes.
- No commit SHA is invented for this local candidate. `author-r0.json` records a deterministic SHA256 of the 12 new source/test files. The external delivery manifest records patch hashes, all preimages/postimages and patch verification.
- No PR14 implementation is carried. All new C2 source, tests and evidence stay inside the original PR02 allowlist. No frozen contract or migration was edited.

## Implemented behavior

1. `object-scope-repositories.ts` verifies the actor, actual active factory, object enterprise, and the **same grant's write permission and scope**. Enterprise read scope cannot widen a separate local write grant. Administrator role labels do not bypass the check. Existing explicitly granted enterprise writes remain bounded to that enterprise; workshop-to-factory scope retains OA-25 behavior.
2. Direct inventory commands resolve and lock actual inventory units. Supplied plantId is an assertion, not the authorization source. Posting rejects a balance belonging to a different unit/enterprise/factory; reservation acquire/release validates its actual unit and balance organization. Internal callers from other domains retain their originating permission contract, while shared posting also validates actual inventory identity.
3. Quality mutations lock the inspection order or hold, validate its actual organization and bound unit, and reject mismatched stock projections. Hold operations lock the unit before the hold, matching registration. Natural unit numbers and barcode lookup lead to the same actual-unit check. Legitimate not-yet-received inspection units remain supported.
4. Purchase writes validate order, line, batch, detail, material and inventory binding relationships. UUID and natural-key receipt routes validate the locked line and its persisted parent. Existing inbound natural keys and line mappings cannot redirect a local request to another enterprise/factory. Batch mutations use a row lock before authorization and updates.
5. The accepted PR01 rollback/receipt implementation remains the prerequisite. A late association rejection therefore uses its business savepoint; the new PG suite checks all public business tables before/after/replay, with only the deliberate command receipt excluded. The legitimate unmapped purchase QUARANTINED diagnostic path is preserved.

## Validation actually performed

| Check | Result | Boundary |
| --- | --- | --- |
| Application TypeScript check | Exit 0 | Current source; local cached dependencies |
| Persistence TypeScript check | Exit 0 | Current source; local cached dependencies |
| PR02 test-source TypeScript check | Exit 0 | Test code compiles; does not prove PG behavior |
| Authorization-decision unit tests | 16 passed, 0 failed, 0 skipped | Repository doubles; no business/PG PASS claimed |
| PostgreSQL suite invocation | Exit 1 at explicit environment gate; 0 business tests executed | `CADENZA_PR02_TEST_DB_URL` absent; NOT_RUN, no skip |
| Frozen-lock install / full cold build | NOT_RUN | I16 stays with PR13 |
| Controller acceptance | PENDING | Requires actual isolated PG execution and controller receipt |

The initial test-source typecheck failure is retained. It identified incomplete fixture construction and a CommonJS typecheck of the Vite configuration; the test fixture now constructs its full result and the PR02-only test config uses the matching module mode. No product or root build configuration was changed for that correction.

Runtime used: Node 24.22.1, TypeScript 5.9.3, Vitest 3.2.7, Vite 7.3.7, pg 8.23.1, @types/node 24.19.2 and @types/pg 8.23.1. These came from existing local dependency caches. This is not a locked-install or cold-build acceptance.

## Required controller verification

Use a NEW empty PostgreSQL database named `cadenza_pr02_*`, setting only `CADENZA_PR02_TEST_DB_URL` for this suite. It refuses any other database name or a nonempty public schema, does not create/drop databases, and does not read `DATABASE_URL` as fallback. Do not use the legacy test helpers which recreate fixed database names.

```sh
pnpm exec tsc -p packages/application/tsconfig.json --noEmit
pnpm exec tsc -p packages/persistence/tsconfig.json --noEmit
pnpm exec tsc -p tests/pr02/tsconfig.json --noEmit
pnpm exec vitest run --config tests/pr02/vitest.config.ts tests/pr02/object-write-scope.unit.spec.ts --reporter=verbose
pnpm exec vitest run --config tests/pr02/vitest.config.ts tests/pr02/object-write-scope.pg.spec.ts --reporter=verbose
```

Static inventory: 29 command/locator cases × four unauthorized contexts = 116 planned denial tests, plus 13 planned local-success, omitted-field, association, revocation and real-lock checks. **129 is a source inventory, not an executed/PASS count.** Each denial checks unchanged snapshots of every public base table except `command_receipt`, same-key replay and exactly one stored rejection receipt. Query observations are printed as `PR02_QUERY` JSON with per-table row counts and SHA256 digests. The final two-client lock probe expects PostgreSQL `55P03` from `FOR UPDATE NOWAIT`.

The test database is retained for inspection. Any actual failure must return with this candidate identity, test name and the original log; the existing author continues the named correction in this Chat.

## Preserved boundaries

Original Chat access was attempted once via Personal Context search. It returned only a search summary, including the incomplete fragment `PR02 R0：`; it did not supply the original final message, message ID or bound candidate. No complete inheritance is claimed, and no second access attempt was made. This candidate uses the verified GitHub handoff.

No remote commit, GitHub write, merge, release, deployment, old/production database, real SAP/model/channel/device/site call or independent R6 acceptance occurred. The prior PR01/PR14 acceptances remain separate. E04 remains missing; internal author checks do not replace it. The other remaining PRs retain their original authorization and acceptance gates.
