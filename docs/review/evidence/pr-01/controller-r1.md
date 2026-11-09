# PR01 controller final: ACCEPT

Accepted boundary: C1 source and real isolated PostgreSQL command-transaction behavior.
Exact R1 source/test candidate: `d6cc96aa64fec40323ea40dde917ac8a2759fd06`. Product source remains `6c611b5ea0b8bdb8016bf8064ac3555a94e1df9a`; incremental parent `39f7d1212bbbcd7d3a1f1d3ebf4781b8f636380a`.
Original Chat reply `e85806ba-2863-578c-ad9e-c35f728aab02`, complete patch SHA256 `6dc8e4652dd105caf566c18307c5ac8ba736870e9e20b1a81812ed18716ccaad`. Six original author postimages applied byte for byte. No product source was changed in R1.

## Proof and evidence reuse

Fresh R1: shipping 4 selected/passed and rework 1 selected/passed, 0 selected failures, 0 selected runtime skips. Vitest honestly reports 21+21 skipped because the name filters excluded those previous cases; all42 are filtered cases, not silently skipped required R1 behavior. Raw logs preserve the actual totals. The remaining66 R0 test cases and unchanged-product type/build results remain valid: unaffected test bodies, product input bytes and all R0 raw-log hashes were checked unchanged. Effective unique coverage is71 cases (66 reused +5 fresh), not76 new cases.

The new dedicated PG16.15 task container/volume remains the same; only its cadenza_shp and cadenza_rework test databases were rebuilt by existing helpers. No Cadence/Lyra/Metis/old Cadenza data was used.

Two R1 gaps are closed by actual execution:

- Actual inventory.issue-material commits source consumption500→499, with a real issue transaction and entry of-1; all five child-downstream predicates are false. A call-through observer on the real transaction client reads child0/closed and source499/active after child reversal writes and before the source-retained check. The actual RS-12 refusal occurs there. After rollback, full business snapshots equal the pre-refusal snapshot; the original key replays the same sole refusal receipt without rerunning the observed method.
- All four shipping modes and legal rework now emit actual, sanitized queries. Seventeen JSON observations are preserved in controller-r1-query-observations.jsonl and the raw logs. Business-hold/reservation refuse with no changed business rows and one replayable receipt; quality throws A-T12-3, leaves no receipt and repeats safely with the same key; successful two-axis shipping changes transaction/entry/audit/outbox counts by2/2/1/2 exactly once and replays with no increments.

R0 initial targeted API build failure remains unchanged: existing I16 IM workspace omission. Explicit IM compilation then API build passed; application/persistence types passed. Those unchanged-product results are reused. Complete cold-build acceptance remains with PR13, not closed here.

## Scope and limits

PR02 compatibility commit70fe34fa654e50ff9b8f41aacc5aef825118a9ed is carried as6a223bec6853f8b9c94b7191287f2de8924d3555. It preserves legitimate procurement quarantine diagnostics and does not close C2. Previous R0 REWORK and all its raw outputs remain valid historical records; this final receipt closes only the two named R1 gaps.

No actual network-disconnect experiment, production/old DB upgrade, real SAP/model/channel/device/site, independent R6, main merge, release or deployment is claimed. Batch accepted count becomes2/15 (PR1 and14); the other13 require their own code/behavior acceptance.
