# PR03 R0 — quality custody, reservation allocation and consistent availability

Status: **SOURCE_READY_PG_NOT_RUN_CONTROLLER_PENDING**. This is a source candidate for C3/C7/I09, not controller ACCEPT. PR02 is also a pending candidate; no acceptance is inferred from stacking.

## Exact binding

- Original PR: https://github.com/yeemio/Cadenza/pull/3
- Original branch: `codex/fix-03-quality-availability`.
- Verified original head: `ca1392c721cf071826badb648a4dba15f2c7d866`.
- Accepted PR01 prerequisite: head `956d9e1bd4192943e1095e03884d4c58435de710`, tested source `d6cc96aa64fec40323ea40dde917ac8a2759fd06`; reused without rerunning its accepted proof.
- Exact PR02 R0 prerequisite: source/test SHA256 `660219c18ece4492c05dd3b062c3a7a371096d03cdad209dfe3fa87deb42803d`; complete original-head patch SHA256 `e91b61c9f9ef72d781f353ea11df320f471300a961f3ae0e5e84a57779120ccc`; ZIP SHA256 `aaafa2ae3f781686a927285ee45598109956de0bce1f008bd7b317a7eaeb4fc4`.
- PR03 source/test SHA256: `5cd5ded5590fa2e08726850278dcb29b56113562a088bbd43029f48081cdaf90` over sorted path + TAB + file SHA256 + LF (16 files: 12 source and four tests/config). This is a file-set identity, not an invented Git commit.
- Apply the cumulative original-head patch OR the exact prerequisite patch followed by the PR03 increment. The package includes complete changed-file postimages and preimage/postimage hashes. Do not mix the two application routes.

## Implemented behavior

1. Active `quality_hold` is checked independently of `stock_balance.quality_status`. New test results and concessions keep the active-hold projection suspect. Shipment scan and final confirmation read the actual active hold; a stale qualified projection cannot authorize outbound stock.
2. Restoration reads current effective inspection versions, concessions bound to those versions, and persisted purchase detail quality. A concession for an old version cannot release a newer failure. Existing non-suspect balance facts are considered conservatively. The historical pre-hold value is used only for a single balance with no current fact; absent or ambiguous fallback remains pending inspection. No default-to-qualified path is added.
3. Quality eligibility and independent business custody precede reservation allocation. Valid own reservations are removed from competing allocation rather than added back to a quality-clamped zero. New reservations cannot exceed current eligible availability.
4. Reservation use/release checks persisted issuer, actual unit/enterprise/factory, unique balance/location, unit-of-measure and business reference. Matching holder fields cannot conceal a contradictory posting reference. Missing issuer evidence fails closed. A UUID by itself is not authority. A release rereads the reservation after the unit lock.
5. Inventory and deterministic AI material-shortage queries use the same availability evaluator and expose the same reason codes: `QUALITY_HOLD`, `QUALITY_NOT_RELEASED`, `BUSINESS_HOLD`, `RESERVED`, `NO_STOCK`. AI reports reasons in existing context notes; no frozen response contract is rewritten. Reserved quantity remains truthful while quality is blocked.

## Named minimum scope extension

`packages/persistence/src/inventory-repositories.ts` is the one path outside the original PR03 allowlist. It adds a read-only active quality-hold query to the existing unit repository used by inventory/shipping/query compositions and exposes the existing reservation `created_by` column. This avoids modifying multiple composition roots or adding a second persistence route. The path and reason were reported in this Chat before editing. It changes no schema, migration, role, stored historical fact or business-hold release rule. Controller scope review is pending along with runtime acceptance.

## Actual verification

| Check | Result | Evidence boundary |
| --- | --- | --- |
| Application TypeScript | Exit 0 | Final source, cached local dependencies |
| Persistence TypeScript | Exit 0 | Current persistence/exported interface source |
| PR03 test TypeScript | Exit 0 | Final test source |
| New pure availability rules | 22 passed | Pure rules; no PG/business PASS claim |
| Existing inventory domain regression | 24 passed | Same candidate; 46 total passed, 0 failed, 0 skipped |
| Real PG suite invocation | Exit 1, explicit missing-URL gate | 0 business cases executed; NOT_RUN, no skip |
| Frozen install / cold build | NOT_RUN | PR13 retains I16 |
| Controller acceptance | PENDING | Real isolated PG execution required |

Initial test-source type errors are retained in the package: the fixture used lower-case `web` and extra DataScope keys. The corrected fixture uses the existing `WEB` and exact DataScope contract. No product bypass was introduced. The PG environment failure was observed once; its unchanged gate is reused after the final extra association test was compiled.

Environment: Node 24.22.1, TypeScript 5.9.3, Vitest 3.2.7, Vite 7.3.7, pg 8.23.1 from existing local dependency caches. No locked installation, full API build, real model, device or site proof is claimed.

## Real PG acceptance entry

The controller supplies a NEW empty database named `cadenza_pr03_*` via `CADENZA_PR03_TEST_DB_URL`. The suite rejects a nonempty public schema, has no `DATABASE_URL` fallback, does not create/drop databases and retains the test database.

```sh
pnpm exec tsc -p packages/application/tsconfig.json --noEmit
pnpm exec tsc -p packages/persistence/tsconfig.json --noEmit
pnpm exec tsc -p tests/pr03/tsconfig.json --noEmit
pnpm exec vitest run --config tests/pr03/vitest.config.ts tests/pr03/availability.unit.spec.ts tests/domain/inventory-rules.spec.ts --reporter=verbose
pnpm exec vitest run --config tests/pr03/vitest.config.ts tests/pr03/quality-availability.pg.spec.ts --reporter=verbose
```

The source declares **32 planned real PG cases**, not 32 passes: nine quality/hold/late-shipment cases, 19 reservation cases and four inventory/AI parity cases. It uses real migrations, repositories and command buses. Explicit SQL fixtures for historical corrupt projection, malformed location and expiry are labeled; they are not substituted repository results. Rejection cases compare all public base tables except the deliberately durable command receipt before/after/replay, and check exactly one rejection receipt. `PR03_QUERY` and `PR03_AVAILABILITY` JSON contain the actual observations when executed.

Any runtime failure must be returned with this candidate identity, exact test and original log. The sole code/test author remains this Chat. No GitHub write, original-PR publication, merge, release or deployment occurred here. E04 remains unverified; these author checks do not replace independent R6. PR01/PR14 acceptance boundaries are preserved.
