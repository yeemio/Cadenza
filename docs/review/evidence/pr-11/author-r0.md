# Cadenza PR11 R0 — I12

SOURCE_READY / PG_NOT_RUN / CONTROLLER_PENDING.
Original PR https://github.com/yeemio/Cadenza/pull/11; branch `codex/fix-11-equipment-oee`.
Exact parent `17328a1c06e9ec56f9babf556539703141a6dc6c`; source/test digest `d28425c9f88151e4c307ad4ecd419f615cb5e1c55a977e3d7c4144ce0cb08159` (not a commit).
Prerequisite: exact cumulative PR02 31 postimages, including necessary accepted PR01 code, with hashes in receipt. PR10 and other independent candidates are not carried.

## Applying

Use the full recorded-head patch OR the exact prerequisite plus increment. Both routes are applied separately and every postimage SHA is verified by the manifest. Complete hunks, individual file patches and full postimages are included. Do not overwrite a different cumulative parent.

## Behavior

OEE selects source output for the actual device, enterprise and factory through consistent report/session equipment UUIDs. It does not use plantOutputTotals. Other-device output is excluded; code-only, absent or conflicting ownership is explicitly missing. The read uses one PostgreSQL statement snapshot for output and maintenance intervals. It returns source output IDs, exact basis identity and missing reasons. Submitted reports with cancelled review are excluded. These are reported business-time production facts, not independently verified physical/QA acceptance.

Output and downtime use the half-open query window [start,end), and both are intersected with explicit planned production intervals. Downtime that begins before the window, ends after it or remains open is clipped correctly. Interval union avoids double counting. Invalid/reversed/timezone-free/nonexistent-date windows cannot become plan denominators.

Equipment has only untyped std_rate_text and no device planned-time fact. CADENZA_OEE_BASES therefore accepts an explicit per-equipment basis (basisId, outputUomId, outputUomCode, standardSpeedPerHour, plannedIntervals with fromAt/toAt). It does not infer quantity units, per-hour meaning or planned time from arbitrary display text or the entire query duration. No real site basis was installed. Mixed output units, missing mapping, missing plan/rate and missing downtime remain null metrics with reasons. A recorded interval is not proof of complete telemetry coverage; no event remains downtime_missing.

Ratios use fixed-point BigInt and round each displayed result only once. Zero runtime or zero-output quality denominator yields missing, not synthetic zero percentages. Negative/impossible quantities and qualified quantity above total are rejected as invalid data. Example verified by pure tests: planned 480 min, downtime 60 min, standard 200 units/hour, output 1400 and qualified 1330 -> availability 0.8750, performance 1.0000, quality 0.9500 and OEE 0.8313. It does not multiply already rounded display ratios to compute final OEE.

## Verification

41 pure cases PASS and domain/application/persistence/test typechecks PASS. The original 39-case passing log remains alongside the final 41-case run with nonexistent-date and rate precision validation. No scope extension is required.

14 actual PostgreSQL cases authored, executed 0, NOT_RUN. They require a new empty cadenza_pr11_* DB via CADENZA_PR11_TEST_DB_URL, use actual migrations and clearly identified isolated source fixtures, and query the real cost service. Cases cover B production leaving A unchanged, four cross-window/open intervals, report boundary exclusion, mixed units, missing/conflicting attribution, missing basis/downtime, cancelled review, enterprise binding and read-only source stability. There is no database reset, production/shared URL fallback or runtime skip. Business-entry lifecycle coverage is not claimed by these seeded query cases.

Old all-factory OEE expectations are not reused as evidence of the corrected device metric. Cached dependencies are not a cold build. Real site measurements/configuration and controller acceptance remain pending.
