# Cadenza PR10 R0 — I11

SOURCE_READY / PG_NOT_RUN / CONTROLLER_PENDING.
Original PR https://github.com/yeemio/Cadenza/pull/10; original branch `codex/fix-10-maintenance-scheduling`.
Exact parent `59ee963106d1ad731cce8b33923eb7774ca95c91`; source/test digest `0ab5ae25496d5d43a005e40c3e0b0aa5a1dc5b1953e3d6172e2671a98279fc3a` (not a commit).
Prerequisite: the 31 exact cumulative PR02 postimages, including the already accepted PR01 required source; see receipt SHA bindings. No PR03–09/14 code carried.

## Application

Apply the complete recorded-head patch OR prerequisite then incremental patch. Both routes are independently applied and all postimage hashes compared in DELIVERY-MANIFEST.json. Never apply both routes or overwrite a differing shared candidate. This package includes every hunk, file-boundary patches, full postimages and hashes.

## Change and boundaries

Scheduling calibration now reads real append-only spc_calibration_record via an explicit equipment-to-gauge UUID binding. It verifies gauge/record enterprise and factory, reads only already known/effective records, retains exact certificate timestamps/record identity and reports absent/mismatched facts as UNKNOWN. There is no equipment/gauge relationship in the source schema: CADENZA_EQUIPMENT_GAUGES is an explicit server configuration and no real factory mapping is invented. Qualified/limited/invalid/expiry gates remain; UNKNOWN preserves the frozen non-blocking policy and must not be presented as proof of qualification. SPC timestamps are checked over a complete UTC scheduling day, not rounded up to a full extra day. No factory shift-calendar claim is made.

Scheduling downtime now reads downtime_event produced by maintenance business commands. Open intervals retain null end times; closed intervals still reduce capacity for their actual historical period. Multiple intervals are unioned rather than taking only the largest outage or double-counting overlap. Closed events expose plan-review prompts and actual affected/future slots without changing the schedule. Calibration changes likewise return flags/review slots rather than deleting existing plans.

Proposal, commit and readiness use these same facts. Commit rereads calibration, equipment repair status and full-day outages and recomputes daily load against capacity after current downtime, requiring existing explicit soft-override confirmation where necessary. It retains existing slot adjustments and zero-quantity deletion behavior. The three obsolete CSW shadow-write commands explicitly reject and point to maintenance/SPC business commands; repositories also refuse independent shadow writes. Historical shadow tables/rows are untouched but not authoritative.

One minimal scope extension, announced before edit: packages/application/src/csw-queries.ts, needed to keep readiness and list results on the same source and bind touched lists to enterprise/factory. No migration, frozen contract, site data or unrelated PR source changed.

## Verification

31 local cases PASS: exact expiry/day boundaries, unknown and failed states, limited positive gate, new/existing/zero slot gates, real-interval interpretation, overlap/disjoint union, explicit mapping and refusal of shadow writes. Application, persistence and tests typecheck PASS. The initial nullable-capacity compiler error and all initial outputs are preserved, followed by final passing logs.

12 real PostgreSQL cases are authored but executed 0: NOT_RUN. They create only a new empty cadenza_pr10_* database supplied through CADENZA_PR10_TEST_DB_URL, apply actual migrations/fixtures and invoke real maintenance/SPC/CSW command buses. Cases cover append-only qualification, expiry/future record exclusion, stale-proposal recheck, maintenance open/restart history, retained slots, actual recovery prompts, positive restoration and zero shadow writes. They abort if the dedicated URL is absent or the DB is nonempty; no shared URL, destructive reset, runtime skip or SQL injection of maintenance/calibration facts is used.

Cached Node/TypeScript/Vitest checks are not a cold build or business-runtime pass. Physical equipment, real gauge mapping, factory calendars, exact concurrent SPC insertion serialization and controller acceptance remain unverified.
