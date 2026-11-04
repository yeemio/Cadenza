# Controller PR03 R0 — REWORK

The original branch/head is preserved; accepted PR02 head `0df991eac99a61132e50c10d8931d3532945dab2` was brought in through an actual two-parent Git merge, cumulative parent `c5f1ca6a85e866bd3aa9e974897ae8d7fca6fc3b`. Every target preimage of the frozen PR03 increment matches exactly, and all 24 owned postimages match. Increment SHA256 `e5b66e32d71244ba938ac95a22d695f3b2b386936585aa184800a916de53c143`, owned source/test SHA256 `5cd5ded5590fa2e08726850278dcb29b56113562a088bbd43029f48081cdaf90`.

49/50 original combined postimages match; the one intentional inherited difference is the already accepted PR02 R1 PG fixture, retained byte-for-byte from source commit `05b5913688cf028dd09784eba7294284522d1a15`, SHA256 `a3837bda73906e216c31c04ecb2912da98ef31afb1a0749fc5d76069bad1f0b1`. This is not an internally rewritten test. Original PR03-owned files are unchanged.

The controller allows the named minimum scope extension `packages/persistence/src/inventory-repositories.ts`: the actual delta is a read-only active quality-hold query in the existing repository and mapping of existing reservation.created_by. It introduces no schema, role, historical mutation or independent business-release policy. Product/PG acceptance remains pending.

Fresh application/persistence/test-source type checks pass. The 22 availability rules plus 24 existing domain regression cases pass: 46/46, no failed/skipped cases. These are not PG behavior acceptance.

Static canonical-schema inspection proves the current PG initialization cannot reach its business tests: warehouse INSERT omits dept_id and nonempty material_types, warehouse code PR03-W violates four numeric digits, and PR03-L1/L2 location codes violate six/eight numeric digits. The helper stock() refers to the same fixture location and must remain consistent after correction. The existing real PR02 failure and identical schema establish this cause; PR03 PG was not invoked to repeat an already determined setup failure. Planned 32 PG cases remain unexecuted, not skipped or passed. No PR03 database was created.

Return a narrow same-author fixture correction without changing product code, 32 business cases, schema/migrations or contracts. Then execute real PR03 behavior and relevant PR02 authorization regression in separate newly named task databases. PR02 acceptance at its own exact head remains valid; it is not automatically acceptance of this new shared-product candidate.
