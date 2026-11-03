# PR01 controller R0: REWORK

Source candidate `6c611b5ea0b8bdb8016bf8064ac3555a94e1df9a`; original Chat message `eeae4aec-221b-5b72-840b-20e46b0f243f`.
Original author code/test postimages match byte for byte (17 files including compatibility).
PR02 prerequisite `70fe34fa654e50ff9b8f41aacc5aef825118a9ed` was carried as `6a223bec6853f8b9c94b7191287f2de8924d3555`. C2 is not closed.

Six real-PG suites ran: 71 executed, 71 passed, 0 failed, 0 skipped. See controller-r0.json and raw logs. New dedicated container and anonymous volume; only the recorded database whitelist was used. Cadence/Lyra/Metis and old Cadenza data were not used.

Initial targeted API dependency build failed at the existing I16 IM workspace omission. Contracts/domain/application/persistence compiled before that failure. Explicitly building the existing IM package, then the API, succeeded; application/persistence typechecks succeeded. This is not a complete cold-build acceptance and does not close PR13/I16. The initial failure log remains intact.

Two named R1 gaps prevent C1 ACCEPT:

1. `tests/integration/rework-flow.spec.ts:874` directly changes stock_balance from retained 500 to 499 with SQL and no ledger transaction. This fault injection is honest but does not demonstrate the required legal source-retention consumption path. Replace it with an actual lawful business command and prove the late refusal after child reversal writes, with no child downstream business and complete rollback/replay assertions.
2. Preserve sanitized raw before/after observations for four shipping modes and the legal rework refusal. The current assertions passed, but the acceptance report requires the actual query observations. Add evidence logging without removing assertions, loosening rules or skipping cases. Only these affected cases need replay after the incremental change.

The product source is not rejected by the passing results; the required behavior evidence is incomplete. Return to the same Chat author with this exact source candidate. No internal substitute writer, main merge, release, deploy, real external call or old database mutation is authorized. R6 remains separate and unresolved. PR14 remains ACCEPT; batch accepted count remains 1/15.
