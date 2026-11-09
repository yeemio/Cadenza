# Controller PR14 R0 reception

Decision: **REWORK**, not accepted. Parent `7be58404771da78b41d4019e7dcff041476891e8`; received patch SHA256 `981e8e9a6dc7437e96d1e78e01a24d8e2f400de2dcd3203800910750c7358425`. Code author: the Owner-selected ordinary ChatGPT Pro conversation `6ae983a9-f128-83e8-a5b4-d5539c933fee`, message `294be63d-f7a7-5e35-bca0-234d95b31f5c`. Controller applied the exact downloaded nine-file patch after raw-byte SHA and allowed-path checks; no product code was rewritten by the controller.

The seven-case source test, targeted contracts/domain/edge build and edge typecheck passed locally. The existing five-case edge regression executed all cases and failed one: `edge-gateway.spec.ts:71` expects three flushed samples despite having no transport and remaining offline. This old expectation contradicts the I17 contract. Raw command output is retained separately; no full-suite PASS is claimed.

The controller approves the minimal same-fix scope addition `packages/edge/test/edge-gateway.spec.ts`: retain explicit no-channel/offline retention checks, and use `MemoryTransport` plus online recovery for the successful flush/restart case. The original Chat must supply that change and updated evidence. Do not delete or skip the scenario, weaken acknowledgment handling, change frozen product contracts or add unrelated work.

The receiver's actual OT command handler uses `received: parsed.length`, matching the new COMMITTED receipt check. Concurrent samples, overflow restoration and checkpoint ordering were inspected against the bound source and seven-case proof. Real API/PG, hardware and field behavior remain unverified; this does not close independent R6.
