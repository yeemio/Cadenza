# Cadenza PR08 R0 — I02 / I03 / I07

Status: SOURCE_READY; real API/PG and browser execution NOT_RUN; controller acceptance pending.
Original PR: https://github.com/yeemio/Cadenza/pull/8
Original branch: `codex/fix-08-operator-intent-calendar`
Exact recorded parent: `be7147b2f0d605e8a4e6da4cc48495fc2e5a63b9`
Source/test digest (not a Git commit): `4645904c52a59ea22b9ebf45288578bdab4f8dccaa7efc7533859fe6b17498d2`.

## Apply the exact candidate

Use `pr08-r0-from-recorded-head.patch` against the exact original head, OR apply `pr08-pr01-pr02-pr03-prerequisite.patch` then `pr08-r0-increment.patch`. Never apply both routes. The prerequisite is exactly the 50 PR03 cumulative postimages, with accepted PR01 and pending PR02/03 bound in author-r0.json. PR04–07/PR14 are not carried. Use the manifest's file hashes to bind a controller cumulative checkout; do not overwrite differing shared candidates by assumption.

## Product changes

PDA feed, Web feed and PDA putaway persist one intent per authenticated enterprise/user/API origin/entry before transmission. Original payload/key survive reload, navigation, network failures, 5xx and truncated responses. Repeated successful taps replay the stored receipt. Pending/unknown operations cannot be cleared or replaced, including a later 4xx after an unknown result. A definite initial rejection or a committed receipt requires the operator's explicit new-operation acknowledgement. No tokens are persisted. Storage failures block the command.

Both feed pages explicitly select a current order and operation and clear old rows on task changes. The backend resolves barcode/actual unit bindings and locks the batch in stable order, derives sales order/line from approved production origins, rejects ambiguity and contradictory client claims, and checks the actual order factory using the same permission/scope grant. Putaway selects actual authorized task factory and master-data rack locations; task locks and actual report/stock ownership replace demo owner fields. Wrong task, owner, enterprise, factory and target claims fail. Existing physical-unit putaway retains its current owner and quantity.

Stock ledger, execution report/labor dates and the existing shift-date query use one explicit server calendar: actual factory ID + persisted dayShiftStart + server UTC offset configuration. UI clock reads that endpoint and preserves unverified status; plant names no longer infer Korea/China. Missing real calendars remain provisional, not site accepted.

Warehouse purpose cannot be invented from MD2 WAREHOUSE. Explicit server mapping `CADENZA_PUTAWAY_WAREHOUSE_KINDS` maps real warehouse IDs to FINISHED/LOGISTICS; missing mapping blocks only the affected putaway as UNKNOWN. UTC offsets use `CADENZA_PLANT_UTC_OFFSETS`, e.g. actual factory UUID mapped to 8 or 9. Fixtures configure test factories only; no real factory settings are claimed or installed.

## Validation

- 26 local cases PASS: 15 durable-intent transport-double cases, 11 calendar/configuration cases. No real business receipt/stock conclusion follows from them.
- Application and persistence typechecks PASS; unit-test source typecheck PASS.
- 7 mandatory actual API/PG cases authored, executed 0, NOT_RUN. They mount actual Nest controllers/Auth guards, use a NEW empty `cadenza_pr08_*` DB, deliberately discard a real COMMITTED HTTP response, retry after client recreation, and query receipts/consumption/balance/ownership/ledger/report/UI dates. Two factories/two non-demo orders/second operations, forged claims and missing facts are covered. No database recreation, shared fallback or skip branch.
- 8 real-page/browser cases authored, executed 0, NOT_RUN: jsdom/testing-library/declared React19 dependencies unavailable.
- Full API/UI/test typecheck exit 2 is retained; absent Nest/React ecosystem dependencies cause unresolved modules and consequent types. This is not a cold install/build pass. Cached React18 only loads pure date helpers; no UI runtime accepted.
- Initial SqlClient generic and Web Locks promise-type errors and calendar dependency collection failure remain in logs, followed by the explicit successful narrow checks.

## Scope extensions (controller review pending)

- `packages/application/src/warehousing-handlers.ts` — Actual putaway task, warehouse/location and ownership validation; pages alone cannot establish trusted ownership.
- `packages/application/src/repositories.ts` — Read existing plant shift_parameter through the org port used by inventory tools.
- `packages/persistence/src/repositories.ts` — Implement the existing persisted day-start lookup without migration changes.
- `packages/application/src/scheduling-queries.ts` — Return the same explicit calendar used by writes through the existing authorized shift-date endpoint.
- `packages/ui/src/api/types.ts` — Calendar DTO and optional putaway owner assertion; ownership derived server-side.
- `apps/pda/src/components/PdaLayout.tsx` — Bind BusinessClock to actual session plant ID and API calendar.
- `apps/web/src/components/AppLayout.tsx` — Bind BusinessClock to actual session plant ID and API calendar.
- `packages/application/src/warehousing-repositories.ts` — Task row-lock and trusted source-owner port; actual warehouse enterprise identity.
- `packages/persistence/src/warehousing-repositories.ts` — Read source report/current stock ownership and lock actual pending task rows.

No frozen migration/contracts or installation/deployment state changed. Unsupported-browser multi-tab behavior, physical PDA, actual timezones/shift schedules and site evidence remain UNVERIFIED. Source is reviewable and locally applicable; acceptance and original-PR publication remain with the original controller.
