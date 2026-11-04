# Controller PR02 R0 — REWORK

The author candidate was applied unchanged against `70fe34fa654e50ff9b8f41aacc5aef825118a9ed`. All 31 postimages match the frozen manifest; the 11 prerequisite files match accepted PR1 `956d9e1bd4192943e1095e03884d4c58435de710`. The patch SHA256 is `e91b61c9f9ef72d781f353ea11df320f471300a961f3ae0e5e84a57779120ccc`; source/test fingerprint is `660219c18ece4492c05dd3b062c3a7a371096d03cdad209dfe3fa87deb42803d`.

Application, persistence and test-source type checks pass. The rule unit suite passes 16/16 with no skip. The actual PostgreSQL suite fails in `beforeAll` at the warehouse fixture INSERT (`object-write-scope.pg.spec.ts:126`): SQLSTATE 23502, mandatory `warehouse.dept_id` omitted. Vitest reports 16 passed and 129 skipped; no PG business case ran. This is not PG acceptance and the raw skipped count is retained.

The canonical `0003-master-data.ts` additionally requires nonempty `warehouse.material_types`, four numeric digits for warehouse code and six/eight numeric digits for storage-location code. The fixture also omits/violates these; correct the narrow setup coherently using real seeded department ancestry and existing schema. Do not relax migrations, remove assertions or substitute doubles/skips. R1 remains with the same author; the controller has not changed source/tests.

A new exclusive PG database `cadenza_pr02_scope_r0_20261104` was created only in the existing task-owned container; it and all failed logs are preserved. The resumed instance is now at 127.0.0.1:32768. The pinned pnpm 11.28.5 offline frozen install completed. This is not the PR13 full cold-build gate. Original author NOT_RUN evidence remains unchanged. Real external/site/old-DB/independent-R6 boundaries remain unverified.
