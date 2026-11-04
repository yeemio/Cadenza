# Cadenza PR13 R0 — I16 / M02 / E01 / E03

SOURCE_READY / COLD_BUILD_AND_RUNTIME_BLOCKED / CONTROLLER_PENDING.
Original PR https://github.com/yeemio/Cadenza/pull/13; original branch codex/fix-13-reproducible-delivery.
Exact recorded parent: 7b6d3ed98d48e87c6b83cad51b7d57eaee4c617e.
Source/test/config digest: faee16d466852b2c968a2c08040f281d896fbb27c0599a3d650f46acd360e632 (not a Git commit).

## Apply exact candidate

Apply the complete from-recorded-head patch directly to that head, OR the supplied one-file PR1 prerequisite and incremental patch in order. Do not apply both routes. The prerequisite is the accepted PR1 command-idempotency test file at 956d9e1bd4192943e1095e03884d4c58435de710; its exact SHA256 is in the manifest. Original business assertions are preserved. No other PR product change or accepted PR14 implementation is carried.

The API package dependency, new build scripts and PR13 tests are the three minimal announced scope extensions. All remaining changes are within the original contract. Per-file postimages, full hunks and all hashes are supplied. Existing migration files and frozen business contracts are untouched.

## Build behavior

AI is now a workspace package using its existing co-emission of dsh; its declared entry remains dist/apps/ai/src/main.js. Nested IM joins the workspace. API declares @cadenza/im as a workspace dependency and imports the package, so the topological build order includes IM before API. Lock importer entries mirror these local workspace relationships without changing external dependency resolutions. The exact package-manager pin remains pnpm 11.28.5.

pnpm build now checks all 12 required built entries, nested IM included. The verifier checks local Web/PDA entry assets, JavaScript syntax and literal Node import resolution and records file hashes; it never starts a service. Source-only integrations/testkit packages do not falsely claim dist outputs. Dynamic/runtime paths still require the separate runtime checks.

pnpm build:cold requires the exact pinned pnpm, Node >=24 and a clean committed isolated checkout. It copies tracked source into a newly created temporary directory, excludes every dist/node_modules/cache/local environment file, runs frozen-lockfile install and the complete workspace build, then records entry hashes and source commit. It does not delete or alter an old workspace. The temporary source and receipt are preserved. A successful gate identifies that exact built snapshot; it does not constitute site acceptance.

## Mandatory test behavior and portability

pnpm test retains the full Vitest include scope through a strict JSON-result gate. pnpm test:required selects the two command-idempotency cases and four new exclusive-database cases. Missing explicit CADENZA_TEST_ADMIN_URL fails before runner start. The authorized role must already be allowed to create a fresh database on its designated isolated test server; no role is granted extra privileges. Each affected engine/recon/idempotency lane gets a new UUID database. Existing databases are never reused, reset or dropped. The full-suite default DATABASE_URL is also a fresh gate-owned database. Original recon fixture seed/grants are confined to that fresh database.

The gate refuses nonzero runner exits, absent mandatory files, duplicates, zero cases, failures, any skip/todo/unknown result, suite errors and counter disagreements. It records individual status counts. A failed hook remains a runner failure, not proof of business assertions. Calling Vitest directly is a diagnostic action, not formal acceptance.

Frozen CSV paths resolve from the repository or an explicit absolute CADENZA_SIM_CSV_DIR; a wrong explicit path fails rather than falling back. The original rows, amounts and attempt ordering are not regenerated. Resume requires the exact explicit run nonce, endpoint and a marker read from the same newly created recon database; historical databases are not silently selected. The marker is test infrastructure, not a historical migration or business fact.

## Metadata and evidence boundaries

The historical 20261027 T table and 20261029 release anchor are preserved. The current matrix maps all 29 T IDs and 14 A scenarios to source presence and relevant original PRs. Source presence is not acceptance. PR1 and PR14 retain only their accepted local boundaries; no T/A scenario is mechanically marked complete. Other PR candidates are separate, not included in this PR13 source candidate.

The current anchor records migrations 0001–0031 as source registrations, the actual changed lock hash and configuration-example hash. Current dist/image digests are null because the full cold build has not run. The old APP-DELIVERABLE-DIGEST remains historical and is explicitly not current evidence. This source anchor does not authorize install, release or deployment.

E01 is only indexed: the controller owns the latest original SIM, whose exact latest original ID/hash is not available here. Neither is fabricated; the old 65-attempt main run was not rerun. The inherited initial IM/dist build failure and the manual IM-before-API workaround are retained as owner-reported history, not newly observed raw logs or cold acceptance. E04 independent R6 text and recipient identity remain missing.

## Actual verification

28 local Node tests passed; zero failed/skipped. Type checking of the targeted PG infrastructure, unchanged idempotency business assertions and engine suites passed. AI and IM compiled into separate scratch cache directories using available dependencies; literal import/entry verification found 15 AI modules and 9 IM modules. No service was started. pnpm 11.25.0 read-only workspace discovery found all 15 projects including root, AI and nested IM. Seven JS syntax checks, shell syntax and Python AST checks passed.

The actual cold gate exited 1 because available pnpm 11.25.0 differs from pinned 11.28.5: installation/build NOT_RUN. An isolated offline frozen-lock-only attempt failed ERR_PNPM_NO_OFFLINE_META for @adobe/css-tools during supply-chain policy validation. No registry/network bypass or replacement lock acceptance is claimed. Recon type checking exited 2 for missing @nestjs/config and express dependencies; the log is preserved.

The actual mandatory-PG gate exited 1 before Vitest, with business executions 0 and runtime skips 0, because CADENZA_TEST_ADMIN_URL is absent. Six targeted real-PG cases and three built runtime-entry cases are authored and NOT_RUN. Existing SIM suites are not rerun for E01. No API startup, real model, enterprise channel, device or site-performance claim is made.

## Controller verification order

On the exact committed candidate and authorized test environment: run pnpm build:cold with the pinned toolchain and locked dependencies. In the preserved cold snapshot's source directory, use the explicit isolated test admin URL to run pnpm test:required and pnpm test:delivery-runtime. The runtime suite starts only its own built children against a new test database; API authenticates and reads organization nodes while the AI service is offline, worker processes an empty scoped batch, and AI starts in mock mode without a DB credential. It kills only those owned processes and preserves the fresh DB. These checks are necessary pending evidence, not claims already passed.

Full historical SIM evidence is reused through the controller's existing index; do not rerun its old main 65 merely for visibility. Installation, historical upgrade compatibility, physical PDA/site operation, independent review and original-controller acceptance remain separate gates.
