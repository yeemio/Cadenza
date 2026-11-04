# Cadenza PR09 R0 — I10

Status: SOURCE_READY / PG_NOT_RUN / CONTROLLER_PENDING.
Original PR https://github.com/yeemio/Cadenza/pull/9; branch `codex/fix-09-group-kitting`.
Exact recorded parent `b30eba3e364d32fb26f97f458c61eb3d464d5943`.
Source/test candidate digest `3669c18adb85a2b62ab714474f3de9fc1cf809640d6c34add62d683973d00eba` (not a Git commit).

## Exact application

Apply `pr09-r0-from-recorded-head.patch`, OR the exact PR01/02/03 prerequisite patch then `pr09-r0-increment.patch`. The cumulative prerequisite is the 50 PR03 postimages, with accepted PR01 and pending PR02/03 SHA bindings in the receipt. No PR04–08/14 code is carried. Do not combine application routes or overwrite a differing shared candidate. Manifest includes all parent/postimage hashes and independent application verification.

## Behavior

The fixed empty-result path is replaced by a single PostgreSQL statement snapshot of the authorized factory's order, its current settings/operation BOM references, the exact published/frozen BOM, component master data and conversion versions, and real inventory balances/reservations/quality/business-hold facts. Same-grant group.post authorization binds the actual factory; no read-grant/write-permission combination. Result listing also binds the authenticated enterprise.

The returned outcomes are KIT_COMPLETE, SHORTAGE, ORDER_NOT_FOUND, MISSING_DATA and UNCONVERTIBLE. Persisted check_status keeps the frozen allowed ok/shortage/error values; the full calculation, reasons, versions and quantities are stored inside shortage_lines JSON and in the idempotent command receipt. No new empty result means computed zero shortage. A zero-stock valid BOM produces positive shortage; missing order/BOM/quantity basis/measurement cannot be reported as complete.

The declared scope is FULL_ORDER_BOM requirement against CURRENT_FACTORY_UNRESERVED stock, a point-in-time calculation. It does not reserve stock or deduct previously consumed materials as if full-order and remaining-order demand were interchangeable. BOM basis must be explicitly configured by exact revision UUID via CADENZA_KITTING_BOM_BASES (outputQuantity, outputUom). Existing BOM data has no basis field, so there is deliberately no assumed per-one multiplier. No historical schema/contracts are modified and no real factory basis is configured here.

Demand uses fixed-point BigInt arithmetic and rounds up; availability rounds down. Duplicate component demand aggregates once. Quality-held, business-held, non-qualified and non-stock units are excluded; active unexpired reservations are subtracted once per unit. Invalid/missing/ambiguous conversions yield UNCONVERTIBLE. Non-base stock with a bound frozen conversion uses that revision, not a new active factor; already converted base-unit balances are never multiplied twice. Mixed active-balance measurement facts are not guessed.

## Evidence

28 pure calculation cases PASS (no PG claim), including exact/shortage, unavailable states, reservation expiry, duplicate BOM lines, missing data, historical frozen BOM, conversions, frozen conversion identity, no double conversion, conservative rounding and large integer arithmetic. Application, persistence and PR09-test typechecks PASS. Earlier successful 25-case logs are retained, followed by the three added measurement cases on final source.

16 mandatory real PG cases authored; executed 0, NOT_RUN. They require CADENZA_PR09_TEST_DB_URL naming a NEW empty cadenza_pr09_* DB, apply actual migrations/fixtures and real command buses, query stored computation/stock, test same-key concurrency, factory/enterprise isolation, holds/reservation expiry, missing facts and converted units. No database drop/recreation, shared DATABASE_URL fallback or runtime skip. Existing insert-only/fresh fixture helpers are used without invoking their database-recreation functions; local test grants are plant-scoped on non-admin actors.

One minimal scope extension: `packages/application/src/group-queries.ts`, to propagate caller enterprise ID only for the shortage-result query. Announced before editing; controller review pending.

Cached Node24/TypeScript5.9.3/Vitest3.2.7 checks are not a cold installation/build or live business acceptance. Original controller acceptance and publication remain pending.
