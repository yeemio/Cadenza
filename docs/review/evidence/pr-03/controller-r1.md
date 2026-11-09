# PR03 R1 — REWORK

Tested source `c57980c53e0bd5003a1367f0d16c46d8861aca37`, fingerprint `13326aea32477a1f100eff2180f541879e3fc3bee0ae757076736b080d035848`. Author patch `c8ecf37c3ce8db4c64ebd3b15c9364447c6ccf342e95bb514d2dfc229256840f` applied unchanged on exact62b95ca parent;4/4postimages match, product/other tests unchanged, all32business test bodies preserved.

Real new PG:31passed /1failed /0skipped. The failing legal own-reservation case raises SQLSTATE22P02 for `PR03-task` at stock_transaction.ref_id UUID (parameter23). Newly introduced issueMaterial fallback copies text reservation.holderRef into this UUID sink. Existing schema/domain accept nonempty text holder references; changing fixture to UUID would hide the product regression.

Fresh C2 regression on this cumulative product:129passed /0failed /0skipped,123actual before=after=replay observations across177tables, unique denial receipt each.23successful PR03denial query observations and4inventory/AI availability observations retained. Changed test-source typecheckPASS.46rules/domain andapp/persistence types reused from unchanged R0source. No product acceptance claimed.

Controller explicitly authorizes one bounded same-author R2 in inventory-posting.ts and relevant PR03proof to correct reference type semantics without weakening ownership/quality checks, changing schema, or introducing UUID-only holder policy. Preserve all32cases and original failure logs/databases. All main/release/deploy/oldDB/real external/R6boundaries unchanged.
