# Sub-brief 304c: points journal slices (legend-msqvi)

Worktree: `.worktrees/msqvi-points-journal`, branch `ws/msqvi-points-journal` (base `milestone/m1` 7d388b02).
Policy (authority): `docs/briefs/sub-304c-arch-decision.md` (architect, xhigh). Read it fully first.
Card brief: `docs/briefs/290f-loyalty-journal.md`; `docs/briefs/304-wave2-loyalty.md` part C.
Do not commit, push or merge. Do not edit files outside your slice. Do not run `pnpm test` or `pnpm check` in full.

## Engineer overrides of the decision record

- NO payload change in `packages/shared/src/crm/events.ts` or `point-ledger.service.ts`. The ledger entry id comes from the event envelope: `event.idempotencyKey` is `"<event name>:<ledgerEntryId>"` (see `point-ledger.service.ts` `appendPointsEvent`). Parse after the first `:`. Missing/unparseable or ledger row not found for the tenant: park `AUTO_JOURNAL_PAYLOAD_INVALID`.
- Amount = signed `liability_idr` read from the `point_ledger` row (authority), never the payload.
- `points.redeemed` journals only when the ledger row `source_type = 'reward_redemption'`; other redeem rows are ignored (points tender is covered by `order.paid` `paidPointsIdr`).
- Do not gate on `loyalty_programs.is_active` (decision §6). Gate on accounting enabled, like other auto-journal events.

## Slice 1: CoA + provisioning (implementer)

Files: `packages/shared/src/accounting/coa.ts`, `apps/api/src/db/backfill-tenant-defaults.ts`, `apps/api/src/services/accounting-provisioning.service.ts` (only if needed).

- Add role `loyalty_points_deferral` (type revenue) and seed account `4105` "Penangguhan Pendapatan Poin Loyalty", parent `4100`, role `loyalty_points_deferral`.
- Make sure new tenants get it and existing tenants get it through the backfill (check whether `provisionStandardChart` already inserts missing seed rows idempotently; if yes, no backfill code). Skip when code 4105 is taken by another account. Mark added blocks with comment `legend-msqvi`.
- No migration. `pnpm db:generate` must stay empty.

## Slice 2: rules + amounts + consumer (implementer, opus)

Files: `packages/shared/src/accounting/posting-rules.ts`, `apps/api/src/services/accounting-auto-journal-amounts.ts`, `apps/api/src/services/accounting-auto-journal-consumer.ts`.

- Rules per decision §3: replace `points.earned` (Dr `loyalty_points_deferral`, Cr `loyalty_liability`), add `points.reversed` and `points.redeemed` (Dr liability, Cr deferral), one `points.adjusted` rule (Dr deferral, Cr liability, signed amount flips sides), keep `points.expired` (Dr liability, Cr breakage). Source type `loyalty`. Amount field `pointsValueIdr`.
- Add the 5 events to `AUTO_JOURNAL_EVENTS`; key `aj:loyalty:<ledgerEntryId>`; journal `source_type='loyalty'`, `source_id` = ledger id. Same lock + lookup-first + savepoint + park path as other events.
- Guards: training orders skipped (earn with source order: `isTrainingOrder(sourceId)`; reverse: the reversed earn row's order). Legal entity: tenant with exactly one legal entity posts there; outlet = ledger outlet (earn), reversed row outlet (reverse), else null; anchor for date/park = oldest outlet of that entity. More than one entity: park non-retryable `LOYALTY_LEGAL_ENTITY_AMBIGUOUS`.
- Event reaches the consumer through `worker-main.ts` `deliverAutoJournalEvent` (already called for every cloud-sync event); verify, do not edit worker-main unless required.

## Slice 3: tests (test-writer)

File: `apps/api/src/test/loyalty-journal.test.ts` (new). Reuse `apps/api/src/test/member-loyalty-helpers.ts` (createWorld, seedProgram, seedMember, seedOrder) and patterns of `accounting-auto-journal.test.ts` (`linesOf`, `expectBalanced`). Own data only in the fixture tenant, clean only your own rows; new outlets need valid `opening_hours`.
Drive through the public path: post ledger entries (`postLedgerEntry` / existing services), read the emitted outbox event, call `deliverAutoJournalEvent(context, event, tx)`.
Cases (must fail before slice 2): earn 1 000 points journals Dr 4105 = Cr 2105 = liabilityIdr, balanced; partial reverse mirrors exactly the reversed amount; reverse `source_type='void'` mirrors; replay same event = one journal; redeem (reward_redemption) Dr 2105 = Cr 4105; expire Dr 2105 = Cr 4104; restore (`points.adjusted` kind restore) mirrors redeem; manual adjust + and -; `source_type='loyalty'` written and other journals untouched; tenant isolation (tenant B sees no tenant A loyalty journal; tenant B event does not post in A); training order earn not journaled; accounting disabled tenant = nothing posted; multi-entity tenant parks `LOYALTY_LEGAL_ENTITY_AMBIGUOUS`.
Run: `cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/loyalty-journal.test.ts" pnpm test`. Report failing list only.

## Slice 4: docs (doc-writer)

- `docs/DECISIONS.md`: append section "WS-08: loyalty points journal, PSAK 72 (legend-msqvi)" in the same style as nearby sections, from the decision record plus the overrides above. Note the 100% redemption-rate assumption, PSAK 72 = PSAK 115 renumbering, Q7 accountant check before enabling, known gaps.
- `docs/briefs/304c-second-opinion-points-journal.md`: brief for a Codex second opinion (xhigh, money), modelled on `docs/briefs/117-second-opinion-doit-refund.md` or `30-second-opinion-pos-receipt.md` in style. Scope: branch `ws/msqvi-points-journal` diff vs `milestone/m1`; questions to answer (double count with order.paid, sign handling, idempotency, training/tenant isolation, legal entity, PSAK 72 policy). Do not run it.
