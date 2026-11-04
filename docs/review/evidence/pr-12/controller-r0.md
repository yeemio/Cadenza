# PR12 controller R0: BLOCKED additional instance authority

Exact source `72facaaff169486f8d80eb5bd91ce40a3a3c0ebb` / fingerprint `94b494190d806fe2a7785f902921a14a9706ec22a0e3181584d5c861d9094ea8`; authentic complete patch `81bce8eb0c0478cddbd7fa3a8953117c906d66774e299d612c36df182bbf87ed` at exact original parent,28postimages all match.

41final local Node safety cases, test-source types,8JS syntax and Bash syntax checks reused by exact source/log hashes. Old40case run, path-normalization failure and final41pass all retained. Native clients18.6 are present at /opt/homebrew/opt/libpq/bin, usable via test-only child PATH without global installation/configuration.

10actualPG/native-client cases NOT_RUN,0runtimeSkip, no new DB or container. They require distinct instance system identifiers with same-name fresh DBs; the existing exclusive-instance authorization cannot be silently expanded. Concrete proposal: one cached-image new container/volume cadenza-pr12-pg-b-20261104 / cadenza-pr12-pg-b-data-20261104, loopback ephemeral port, same-name source cadenza_dops_pr12_source_20261104 on A/B and fresh restore cadenza_dops_pr12_restore_20261104 on A. Only this newly empty restore target is recreated by the authored suite. All old DBs/volumes/logs protected.

After approval, run exact10cases once, preserve raw media/logs and all three test DBs. E02 old-hash/0031 historical-sample evidence remains UNVERIFIED even if synthetic tests pass. No production/old database, deployment or historical migration change.
