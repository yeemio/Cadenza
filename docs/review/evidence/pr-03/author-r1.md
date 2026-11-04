# PR03 R1 — canonical-schema PG fixture initialization

Status: **SOURCE_READY_PG_NOT_RUN_CONTROLLER_PENDING**.

## Binding

- Repository / original PR / branch: `yeemio/Cadenza` / #3 / `codex/fix-03-quality-availability`.
- Exact increment parent: `62b95cab58c249e88d52481605fa293686cae87d`. It already includes accepted PR02 `0df991eac99a61132e50c10d8931d3532945dab2` through cumulative parent `c5f1ca6a85e866bd3aa9e974897ae8d7fca6fc3b` and the frozen PR03 increment.
- R0 owned source/test fingerprint: `5cd5ded5590fa2e08726850278dcb29b56113562a088bbd43029f48081cdaf90`.
- R1 owned source/test fingerprint: `13326aea32477a1f100eff2180f541879e3fc3bee0ae757076736b080d035848`; same 16-file sorted path/TAB/SHA256/LF algorithm, not a Git commit SHA.
- Changed PG test SHA256: `701a421a03853afb8799e3ad6dfe934445a083e1d9f14cdc745eb2be2bf7a549` -> `a725cf13f9bae612a7a3cee2ba618b5ad4ce9cd637550eb1824ba1dc5b2e5184`.

## Exact fixture and reference changes

1. Add shared constants: warehouse `0301`, first NORMAL location `03010001`, second NORMAL location `03010002`. Both location codes derive from the same four-digit warehouse code.
2. Read the real seeded users' `dept_id` through active `org_node` department and plant joins; require identical enterprise and department path under each user's plant, then require both users in the same enterprise/factory. Fail setup explicitly on a missing/mismatched seed. The permission array, grant INSERTs and verified auth construction are byte-identical.
3. Supply warehouse `dept_id` from `szqc01`'s actual `DEPT-SZ-QC`, and `material_types=ARRAY[3]::integer[]`, matching unchanged material fixture `material_type=3`. Use the legal warehouse-code parameter. Name/type remain unchanged.
4. Replace both location INSERT code literals with parameters from the shared constants, retaining two distinct NORMAL rows under the same warehouse.
5. Resolve `locationId` and `location2Id` by those same constants. The existing malformed-reservation-at-another-location test still points to the second actual row.
6. In `stock()`'s `inventory.receive-goods` payload, change only `locationCode: 'PR03-L1'` to the shared `locationCode` (`03010001`), matching the actual first location ID. This payload reference is explicitly changed; its bytes are not claimed unchanged.
7. Resolve the production `deptId` from the validated `szws01` seed. This is the same `DEPT-SZ-JZ` department as the old code-only lookup, now bound to the current factory; the inventory/AI consistency business fixtures retain their original department semantics.

All changes stay in this test's constants, `stock()` reference and `beforeAll()` initialization. All three business `describe` bodies, all assertions, all eleven other helper functions, the empty-DB refusal and full-table snapshot builder are byte-identical. No product, schema/migration, role, permission policy, frozen contract, PR02 or other PR change is included.

## Actual verification

- Changed test-source typecheck: `node node_modules/typescript/bin/tsc -p tests/pr03/tsconfig.json --noEmit`, exit 0. Raw successful output is empty and retained in `author-r1-tests-typecheck.log`; timestamps/command/hash are in `author-r1.json`.
- TypeScript parse: 0 diagnostics. Static case registration remains 32 (21 `it` source sites expanded by the original loops). This is source inventory, not PG execution.
- Business-body SHA256 is unchanged: `42d86b55dc25cd23878e88e5fca161ff5158b5dd55d436a1e16f8d4989642bd6`. Static checks separately verify the explicitly changed stock payload and setup, rather than claiming the entire test file is unchanged.
- The first local case-count checker mistakenly inspected a runtime helper loop. Its corrected scope counts only `describe` registration bodies; the candidate was not changed to fix that checker. The initial tool error is retained in the JSON receipt.
- All 50 inherited combined postimages match the immutable current parent. Relative to the original frozen PR03 package, the only inherited difference is the accepted PR02 R1 test SHA256 `a3837bda73906e216c31c04ecb2912da98ef31afb1a0749fc5d76069bad1f0b1`. This revision leaves it unchanged, and preserves all other 49 combined parent postimages and all R0 evidence.
- Reuse only controller R0's unchanged 46 rule/domain passes and application/persistence type checks. The changed test-source check above is fresh. No rule count is called PG PASS.
- **PR03 32 actual PG cases: NOT_RUN.** No dedicated URL or postgres/psql/Docker exists here, no suite was invoked, and no database was contacted. Controller R0 was also NOT_RUN_STATIC_FIXTURE_BLOCKED with 0 executed / 0 runtime skipped; no executed PR03 failure is invented.
- **PR02 real authorization regression on this cumulative candidate: NOT_RUN.** PR02 acceptance at its own exact head remains valid, but does not establish behavior after PR03's shared-product changes.

## Controller continuation

Apply this R1 increment once to exact parent `62b95cab58c249e88d52481605fa293686cae87d`; verify all four changed-file postimages. Do not reapply the old PR03 or PR02 patches. First use a NEW empty exclusive `cadenza_pr03_*` database through `CADENZA_PR03_TEST_DB_URL` for the 32-case suite. Use a different NEW empty exclusive `cadenza_pr02_*` database through `CADENZA_PR02_TEST_DB_URL` for cumulative authorization regression. Retain all existing databases and evidence.

```sh
pnpm exec tsc -p tests/pr03/tsconfig.json --noEmit
pnpm exec vitest run --config tests/pr03/vitest.config.ts tests/pr03/quality-availability.pg.spec.ts --reporter=verbose
pnpm exec vitest run --config tests/pr02/vitest.config.ts tests/pr02/object-write-scope.pg.spec.ts --reporter=verbose
```

Engineering acceptance, installation, old-database, external/site and independent-R6 boundaries remain with their original gates. No GitHub write, main merge, release or deployment occurred.
