# Cadenza PR15 R0 — M01 Web/PDA initial loading

SOURCE_READY / BUILD_UI_DEVICE_NOT_RUN / CONTROLLER_PENDING.
Original PR https://github.com/yeemio/Cadenza/pull/15; branch codex/fix-15-frontend-loading.
Exact recorded and rechecked parent: 1dd796cd329c752733811ef3ac413739cab214db.
Source/test/config digest: 811cc44d9f4d968f2273f6240f3576a974a3d733aa735bbff264cb04816bfc7c (not a Git commit).

## Application and candidate boundary

Apply the full from-recorded-head patch to the recorded PR15 head, OR apply the supplied exact PR13 prerequisite followed by the PR15 incremental patch. Do not apply both. The prerequisite is the complete 55-postimage PR13 R0 candidate, full patch SHA256 9e319407e1fba558b2ee6c4a21d44d6f487a9a31d00c9777591d49b170a77e43, source digest faee16d466852b2c968a2c08040f281d896fbb27c0599a3d650f46acd360e632. PR13 is not accepted and its full cold build is NOT_RUN; carrying its code does not inherit a pass. PR1's accepted idempotency-test lineage is included only through that prerequisite. PR8 or other independent product changes are not silently included.

All own changed paths remain within the PR15 contract: both App.tsx files, both Vite configs, existing P2/P3/P4 mount.tsx files, new per-app loading/mount.tsx files, tests/ui and this evidence directory. No scope extension is needed. Authentication, API clients, pages, permission helpers, route URLs and navigation definitions are preserved.

## Product behavior

Each business page now uses a named-export React.lazy dynamic import. Web has 65 lazy page imports and PDA 26. This includes the P2/P3/P4 mount modules, which previously pulled business pages into the entry through navigation imports. The static TypeScript import closure from each App now reaches LoginPage only. Login remains immediately available without waiting for a business page chunk.

The protected route hierarchy keeps RequireAuth and the existing AppLayout/PdaLayout outside a page-only Suspense boundary. A selected lazy page can load while navigation remains mounted. Loading and failure messages support Chinese and Korean. A chunk/render failure displays an explicit reload button; it does not automatically reload or retry a business command. Navigation to a different path resets that page boundary. Existing locale-provider/auth lifecycle behavior is retained, not redesigned.

All 85 Web and 34 PDA original route records, aliases, parameters and redirects match the pre-edit source contract. Those are AST checks, not substitutes for browser behavior. Vite now emits a build manifest for measurement; the existing chunk warning threshold is neither raised nor suppressed. No arbitrary vendor grouping or unmeasured performance claim is introduced.

## Baseline and measurements

Before UI edits, baseline-binding.json recorded the exact original head, PR13 prerequisite, App/mount/config hashes and historical build-log hash. The immutable historical log at public main cb25076d99cda0ac359151ff9eea65507de8cc4d reports Web main JS 1,473.61 kB / gzip 425.42 kB and PDA 1,059.41 kB / gzip 319.36 kB. These are historical rounded figures, not current candidate sizes or clean-build evidence.

Both actual pre-edit local Vite attempts failed on missing @vitejs/plugin-react. The candidate measurement tool returned NOT_MEASURED because available pnpm 11.25.0 differs from pinned 11.28.5. Therefore current bytes, byte reduction, first-screen time, memory and interaction improvement remain unknown. No React 18 substitution or synthetic bundle is presented as the locked React 19 application.

The runnable measurement script builds each candidate into a fresh preserved directory. It records source/lock/recipe/toolchain hashes, computes the unique transitive static import closure of index.html, distinguishes lazy chunks, and reports total-size overhead alongside initial-size changes. Gzip is per-file level 9. Comparison rejects differing lock/toolchain/recipe, absent successful cold receipts, source changed since the receipt, missing data, non-decreasing initial bytes/gzip or supposedly lazy entries in the initial closure. Even a successful byte comparison explicitly makes no real-device claim. MEASUREMENT.md gives the exact controller recipe and separate browser/device evidence fields.

## Actual verification

23 local Node tests PASS; zero failed/skipped. They verify original route records, literal lazy exports, RequireAuth/layout ancestry, TSX syntax, static page-import closure, manifest accounting, failed/missing chunks, comparable measurement guards and cold-receipt source mutation. Synthetic manifests are clearly test fixtures, not measured application output. Three JavaScript syntax checks and the UI test-file TSX parse check also pass.

Sixteen React/jsdom behavior tests are authored: anonymous direct-URL login, real existing mock-login return flow, authenticated query retention, P2/P3 direct URLs, inventory/SPC/AI permission refusal, PDA scanner input in Chinese/Korean, navigation during a delayed chunk, explicit failure action, and recovery by navigating away. The actual Vitest attempt failed before collecting/executing tests because jsdom is missing; executed 0, NOT_RUN. The attempted UI type check exited 2 for absent React/router/testing and related project dependencies; its full original output is preserved. No server authorization, hardware scanner or real PDA behavior pass is inferred.

## Pending acceptance

The controller must validate the same exact candidates with the complete pinned dependencies: PR13 clean build, current before/after build-byte comparison, the 16 UI cases and UI type checking. Physical PDA/real browser performance is a separate NOT_RUN boundary. No claim is made that a site fault has been fixed. Original-controller acceptance and original-PR publication remain pending; no merge, deployment or remote write was performed here.
