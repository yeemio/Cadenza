# PR #14 code candidate and verification

Identity: `same_family_external_advisory`.
Product baseline: `cb25076d99cda0ac359151ff9eea65507de8cc4d`.
Exact PR parent: `7be58404771da78b41d4019e7dcff041476891e8`.
Branch: `codex/fix-14-edge-delivery-ack`. Prerequisites: none.

## Publication and candidate state

`BLOCKED_DELIVERY_PUBLICATION`: the GitHub create-blob write attempt returned HTTP 403
`Resource not accessible by integration`. No remote commit or ref was created.
PR #14 was read again at delivery and still has the exact parent above.
The two product files were fetched at that parent and byte-compared with the pinned product baseline.
The delivered unified patch and its SHA256 identify the local candidate; they are not a published Git SHA.

## Implementation

- Every tick buffers samples and checkpoints sequence/sample identity before transmission.
- No transport or offline state returns `flushed: 0` and preserves pending samples and overflow.
- A flight freezes both its sample IDs and payload before awaiting its pre-send checkpoint.
  New arrivals during storage or transport remain pending for another batch.
- Overlapping flush calls share one send. Only complete acknowledgments remove that flight's IDs.
  Business rejection, partial/absent acknowledgment and send exceptions retain data.
- Overflow is inspected without consuming it, survives checkpoints, and is merged back after failure.
  New overflow during a flight is retained separately until that later batch is acknowledged.
- Checkpoint writes are ordered. Old checkpoints without the additive overflow property still load.
- Acknowledgment loss permits replay of the same event IDs; no exactly-once receiver claim is made.

## Actual verification

Environment: Node v24.22.1, isolated scratch filesystem; see `environment.json`.
Command, from the repository root:

```sh
node --import ./tests/pr14/ts-source-loader.mjs --test tests/pr14/delivery.test.mjs
```

Final candidate: exit 0, tests 7, passed 7, failed 0, skipped 0, cancelled 0.
Raw final output: `node-test.log`.
One named narrow correction after the initial six-case candidate fixed the checkpoint-await window;
its added regression proves an arriving sample is absent from the earlier outgoing snapshot and remains
in the persisted backlog. The initial run is retained in `initial-node-test.log`, not added to final-candidate counts.

The loader transforms actual TypeScript source with Node and resolves the domain dist bridge to the
same domain source. This is source execution, not TypeScript typechecking or a workspace build.
Tests use controlled transport implementations and a real temporary JSON-file checkpoint.
The receiver in the acknowledgment-loss test is a Set-based test port, not PostgreSQL or the real API.

## Remaining boundaries and precise scope blocker

- Whole workspace build/typecheck: NOT_RUN; project dependencies are not installed.
- Real API/PG deduplication, durable server overflow accounting, real device delivery/performance: NOT_RUN.
- `packages/edge/test/edge-gateway.spec.ts:60-72` still expects an offline, transport-less flush to
  remove all data. That expectation contradicts I17. The file is outside all supplied permitted paths
  for this fix and remains unchanged. Root `vitest.config.ts` DOES include `packages/*/test/**/*.spec.ts`;
  therefore a full root test run is not claimed to pass and needs this one-file scope extension.
  Minimal update: assert retention while offline/no transport, then use MemoryTransport plus
  setOnline(true) for the separately acknowledged-delivery/restart path. Do not delete or skip the case.
- Delivery is at least once. Transport/API contracts for exactly-once overflow counters are outside scope.
- Process restart with a readable checkpoint is covered. Power loss/fsync guarantees or corrupted-checkpoint
  recovery are not covered; the existing FileCheckpointStore implementation is unchanged.
- Independent R6 acceptance and real field acceptance remain UNVERIFIED.

This is a reviewable code candidate with a passing seven-case local gate, not ACCEPT, merged or deployed.
