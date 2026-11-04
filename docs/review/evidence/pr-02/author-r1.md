# PR02 R1 — real PostgreSQL fixture initialization

Status: **SOURCE_READY_PG_NOT_RUN_CONTROLLER_PENDING**. This narrow author correction addresses the R0 fixture failure; it does not claim actual PostgreSQL acceptance.

## Exact binding

- Repository / original PR: `yeemio/Cadenza` / #2.
- Original branch: `codex/fix-02-object-write-scope`.
- Exact parent: `0925e19cb9542c425fe70b05b1d8eb7db7019ecc`.
- Parent already contains the accepted PR1 prerequisite from `956d9e1bd4192943e1095e03884d4c58435de710` (tested source/test `d6cc96aa64fec40323ea40dde917ac8a2759fd06`). Do not reapply the PR1 or R0 patches.
- R0 source/test fingerprint: `660219c18ece4492c05dd3b062c3a7a371096d03cdad209dfe3fa87deb42803d`.
- R1 source/test fingerprint: `49c5649c415f8cdaa2f31aea1d9dbc3a05f146fa32d6c4a81963d558e637f021`. This is the SHA256 of the same 12 sorted path/file-hash entries, not a Git commit.
- Changed PG test preimage: `448acab0cfda3cd8b646ba20851387b7729c78c317f60ce3ab9a50c081bd8631`; postimage: `a3837bda73906e216c31c04ecb2912da98ef31afb1a0749fc5d76069bad1f0b1`.

## Narrow correction

Only `factory()` in `tests/pr02/object-write-scope.pg.spec.ts` changes. It resolves the actual seeded user's department through `user_account.dept_id` and verifies an active department and plant in the same enterprise, with the department's real organization path under that plant. A missing/mismatched department fails setup explicitly; no organization or permission record is rewritten.

The warehouse INSERT now supplies `dept_id` and `ARRAY[1]::integer[]` for `material_types`, matching the unchanged material fixture's `material_type=1`. Four-digit warehouse codes A/B/C are `0201` / `0202` / `0203`; distinct names remain `PR02-WH-A/B/C`. NORMAL location codes are the corresponding warehouse code plus `0001`: `02010001` / `02020001` / `02030001`. All values follow the existing canonical `0003-master-data.ts` constraints. No schema/migration change is included.

## Validation and retained failure

- New test-source check: `node node_modules/typescript/bin/tsc -p tests/pr02/tsconfig.json --noEmit`, exit 0. Raw output is `author-r1-tests-typecheck.log` (empty on success); command metadata is in `author-r1.json`.
- TypeScript parse: 0 diagnostics. Static checks prove every byte before `factory()` and from `beforeAll` through the end of the test is unchanged. The original 29 command/locator cases x 4 contexts plus 13 additional cases remain **129 planned PG cases**, not executed passes. Zero-change, replay, receipt and real-lock assertions are unchanged.
- All 31 frozen R0 postimages match the immutable parent tree. R1 retains the other 30 postimages unchanged. The three controller R0 receipt/log files, canonical organization/master-data migrations and seed file also remain byte-identical.
- Controller R0 application/persistence types and 16 unit passes are reused only for unchanged source. They were not rerun here and do not prove PG behavior.
- Original controller failure remains: SQLSTATE `23502`, `warehouse.dept_id`, factory A in `beforeAll`; raw Vitest summary **16 passed / 129 skipped**, one failed suite and **0 PG business cases executed**. Original raw log SHA256: `4a1e7bafcb9001f75462b83d1daa493f34d50ba13b0b6ce32b670a5f1202ea20`.
- **R1 actual PostgreSQL: NOT_RUN.** This author environment has no `CADENZA_PR02_TEST_DB_URL`, postgres, psql or Docker. No database was contacted and the suite was not invoked. Runtime counts are unavailable; no skipped/pass claim replaces execution.

## Controller continuation

Apply the complete R1 increment once to exact parent `0925e19cb9542c425fe70b05b1d8eb7db7019ecc`, then verify all four postimages from the delivery manifest. Use a different NEW empty exclusive database named `cadenza_pr02_*`, with only this suite's `CADENZA_PR02_TEST_DB_URL`; retain the failed R0 database and its logs. The existing nonempty-schema refusal remains unchanged.

```sh
pnpm exec tsc -p tests/pr02/tsconfig.json --noEmit
pnpm exec vitest run --config tests/pr02/vitest.config.ts tests/pr02/object-write-scope.pg.spec.ts --reporter=verbose
```

This increment changes one test file and adds this receipt, the JSON receipt and the raw typecheck log. Product/permission policy, all migrations and frozen contracts, other PRs, R0 author evidence and controller evidence are unchanged. PR2 engineering acceptance awaits the controller's real PG result and receipt. PR1/14 acceptance is preserved without rerun or extrapolation.
