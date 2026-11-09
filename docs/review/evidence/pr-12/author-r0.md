# Cadenza PR12 R0 — I13 / I14 / I15; E02 unresolved

SOURCE_READY / RUNTIME_NOT_RUN / E02_BLOCKED / CONTROLLER_PENDING.
Original PR https://github.com/yeemio/Cadenza/pull/12; branch `codex/fix-12-backup-upgrade-safety`.
Exact parent `f398f40ab1ef24574927441ab661c60c9ffa086d`; source/test/config digest `94b494190d806fe2a7785f902921a14a9706ec22a0e3181584d5c861d9094ea8` (not a Git commit). No code prerequisites; no other PR product code is carried.

## Application

The full patch and incremental patch both apply directly to the recorded head and are equivalent. Apply exactly one. Complete per-file hunks and postimages are included; all hashes and original Git executable modes are recorded. Each route is independently applied before postimage verification.

## Product change

Backup/restore now use one canonical DATABASE_URL for metadata, native dump/restore and recreation. Ambiguous URL endpoint overrides and inherited PG service/endpoint/password-file defaults are excluded from the native client environment. PG_CONTAINER/--pg-container is explicitly rejected before dump/recreation, removing the old split-locator path; native clients must be installed in the script's execution environment. Container use requires running the whole script there with a single reachable URL, not selecting a second local same-name database.

Before side effects, Node and psql identities must agree on cluster system_identifier, instance start time, database name and OID. A missing identity privilege blocks rather than expands permissions. Backup metadata/migration fingerprint and pg_dump share an exported repeatable-read read-only snapshot. A format-2 manifest carries instance identity without connection URI/credentials. Restore first validates every media hash, required artifacts and pg_restore list readability; then the same canonical target connection controls recreation and import. It keeps cadenza_dops_* and exact target-confirm guards. Post-restore identity and migration checks precede object/config restoration. Successful fingerprint recovery still requires reconciliation and site acceptance.

Configuration export uses a tiny non-secret value allowlist: valid NODE_ENV/LOG_LEVEL/ports/WORKER_ENABLED. All other values, including TOKEN/PASSWORD/SECRET/KEY, URLs, comments and multiline contents, become references or are omitted. Raw database/native-tool error text is not saved into backup media. Object trees containing the selected env file, .env files, symlinks or special files are refused. This is not a promise to erase legitimate business data inside database dumps or arbitrary attachments. Object media capture is separate from the DB snapshot. SHA256 is integrity checking, not authenticity certification.

Upgrade preflight now has only a server-enforced READ ONLY repeatable-read transaction, SELECT queries and final ROLLBACK. It never imports/calls applyMigrations or migrateStatus (the latter creates the registry table). Unknown/downgrade/gapped/missing registry and unverified per-hop paths are rejected before migration. The upgrade script runs this read-only gate before creating backup media and before its separately explicit migration step. Old --no-reentrancy remains accepted but never enables mutation; no mutating preflight flag exists.

The registry top is correctly recorded as 0031, separately from evidence. 0030->0031 is UNVERIFIED/E02 until an authorized isolated historical sample with old hashes, receipts, stock, outbox and UNKNOWN facts is validated. Source registration is not proof of historical-data compatibility. Existing shipped 0009->0010 matrix entry is preserved, without claiming a new runtime test. No frozen contract or migration is rewritten.

## Evidence and remaining acceptance

41 final local Node tests PASS, test TypeScript check PASS, 8 JavaScript syntax checks and Bash syntax check PASS. These cover parsing/binding rejection, actual CLI rejection before connection, redaction sentinels, media corruption/path/hash checks and compatibility decisions. The initial 40-case run and later path-normalization assertion failure are preserved; the final 41-case run passes. The default output root is this repository, not its parent. Identity-coordinator fixtures are explicitly doubles; they do not prove native PG behavior.

10 mandatory real-PG/native-client cases authored, executed 0, NOT_RUN. They require A and B on different instances with same-name fresh empty cadenza_dops_pr12_* DBs and a separate fresh restore target. They verify distinct sentinels, mismatch-before-dump/recreate, before/after schema/data/version digests for latest/0030/downgrade/unknown/gapped/missing-registry preflight, actual backup secret absence, wrong-target early refusal and real restoration of A while B stays unchanged. No runtime skip, shared DB fallback or existing business database is used. Source records are explicitly synthetic; these tests cannot close E02.

Native client availability, identity read privileges, actual dual-instance/restore behavior, approved legacy sample, reconciliation/RPO/RTO and controller acceptance remain unverified. No database/container/upgrade/restore command was executed in this author environment.
