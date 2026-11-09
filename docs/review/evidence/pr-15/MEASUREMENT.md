# PR15 comparable build and browser/device measurements

No current candidate bundle-byte reduction, first-screen time, memory or interaction improvement is claimed in this author environment. The historical BUILD-20261103.log is indexed separately; it must not be treated as a new cold baseline. Current baseline build attempts failed on missing @vitejs/plugin-react. The candidate measurement gate rejected the nonmatching pnpm version before building. No real PDA was measured.

## Exact comparable source pair

The baseline is original PR15 head 1dd796cd329c752733811ef3ac413739cab214db plus the exact PR13 R0 cumulative prerequisite. Its full prerequisite patch SHA256 is 9e319407e1fba558b2ee6c4a21d44d6f487a9a31d00c9777591d49b170a77e43. The candidate adds only the PR15 incremental patch; all input and postimage hashes are in DELIVERY-MANIFEST.json. Do not compare differently rebased or differently configured branches without a new binding.

In separate committed isolated checkouts of those two exact candidates, first run PR13's pnpm build:cold using pinned pnpm 11.28.5 and the complete frozen dependencies. The cold receipt names its preserved source directory and actual commit. Keep both receipts. Do not manually build IM before API or reuse dist as proof of this gate.

Run the same PR15 measurement script against each preserved cold source directory, using an absolute path to the script from this candidate. It can measure the baseline without changing its App or route source:

```bash
node /candidate/tests/ui/pr15-measure-build.mjs --root /baseline-cold/source --cold-receipt /baseline-cold/cold-build-receipt.json --label PR15-BASELINE --out /evidence/pr15-baseline-bytes.json
node /candidate/tests/ui/pr15-measure-build.mjs --root /candidate-cold/source --cold-receipt /candidate-cold/cold-build-receipt.json --label PR15-CANDIDATE --out /evidence/pr15-candidate-bytes.json
node /candidate/tests/ui/pr15-measure-build.mjs --baseline /evidence/pr15-baseline-bytes.json --candidate /evidence/pr15-candidate-bytes.json --out /evidence/pr15-byte-comparison.json
```

Paths above are argument examples, not claimed existing evidence. Each output must be a new file. The script preserves fresh output directories and build logs. It verifies the cold source file digest again, emits production builds with the same controlled VITE settings, computes the complete static import closure from index.html, and separates that closure from dynamic route chunks. It reports raw bytes, per-file level-9 gzip bytes, total JS including lazy chunks, CSS and the largest chunk. It does not raise or suppress Vite's existing chunk warning limit. A smaller initial closure can coexist with greater total JS overhead; both changes are reported.

Comparison refuses unsuccessful/missing measurements, different lock/toolchain/recipe, missing cold receipts, unchanged or greater initial JS/gzip, and dynamic entries accidentally pulled into the initial closure. The comparison result is only BUILD_BYTES_IMPROVED, never a device-performance PASS.

## Browser behavior

With the exact installed React 19 project dependencies, run the targeted jsdom suite:

```bash
pnpm exec vitest run --config tests/ui/pr15.vitest.config.ts
pnpm exec tsc -p tests/ui/pr15.tsconfig.json --noEmit
```

Sixteen cases cover anonymous deep-link login, the actual existing mock-login return flow, authenticated query-string entry, P2/P3 direct URLs, inventory/SPC/AI permission refusals, scan input in both languages, navigation preserved during loading, chunk rejection and moving from a failed page to a healthy route. They use the existing local API fixture; they do not prove server authorization, real scanner hardware or physical PDA behavior. In this author environment Vitest failed before collecting any test because jsdom is absent, and type checking failed for missing React/router/testing dependencies. All original outputs are preserved.

## Actual browser/PDA evidence still required

Record the exact baseline/candidate build digests, browser version, real device model, OS, available memory, network conditions, serving mode, locale and authenticated role. Test the same direct login, dashboard/tasks, scan, inventory query, P2, P3 and AI-permission routes. Separate initial navigation from later route loads; keep warm-cache and cold-cache runs distinct. Record the first usable screen time and browser trace, transferred initial resources, long tasks and memory where the device exposes them. Include navigation while a chunk is delayed and the explicit recovery action after a failed chunk. Use repeated runs on the same device and retain each observation, rather than substituting one desktop average for PDA evidence.

Only an authorized real device/session can close the site boundary. No hardware, performance or site-fault conclusion is inferred from static dependency counts, synthetic manifest fixtures, jsdom or bundle warnings.
