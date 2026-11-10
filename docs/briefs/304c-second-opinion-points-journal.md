# Brief: second-opinion (Codex) for the loyalty points journal, PSAK 72 (legend-msqvi)

Do not run before the CTO decides. Tier K (money). Effort: xhigh. Required before the release gate. It does not block the next slice.

## Role

Read `~/.agents/team/roles/second-opinion.md`, then follow it. Read and report only; do not edit.

## Repo

`/Users/ifanshori99/Projects/legend super app/legend`, worktree `.worktrees/msqvi-points-journal`. Branch `ws/msqvi-points-journal`:

```
git diff milestone/m1...ws/msqvi-points-journal
```

## Context

- Policy (authority): `docs/briefs/sub-304c-arch-decision.md`; slices and engineer overrides: `docs/briefs/sub-304c-points-journal.md`; decisions: `docs/DECISIONS.md` (WS-08 loyalty points journal section).
- Code: `packages/shared/src/accounting/coa.ts`, `packages/shared/src/accounting/posting-rules.ts`, `apps/api/src/services/accounting-auto-journal-amounts.ts`, `apps/api/src/services/accounting-auto-journal-consumer.ts`, `apps/api/src/services/point-ledger.service.ts` (read only, unchanged), `apps/api/src/db/backfill-tenant-defaults.ts`.
- Tests: `apps/api/src/test/loyalty-journal.test.ts`.

## Questions to answer

1. **Double count with `order.paid` / `order.refunded`.** Does any path journal the same points movement twice? The consumer must journal `points.redeemed` only for ledger rows with `source_type = 'reward_redemption'`. Points tender is refused today, so `paidPointsIdr` and `refundPointsIdr` stay 0; is the pin test enough if tender ever ships?
2. **Sign handling.** The amount is the signed `liability_idr` of the `point_ledger` row, never the payload. Check earn, reverse (exact mirror of the reversed amount, partial and void), redeem, restore, manual + and -, expire. Does a negative `pointsValueIdr` flip the sides correctly in `buildJournalLinesFromRule`? Can any entry post with the wrong sign or a zero amount?
3. **Idempotency.** The ledger entry id is parsed from `event.idempotencyKey` (`"<event name>:<ledgerEntryId>"`, after the first `:`); there is no payload change. Key `aj:loyalty:<ledgerEntryId>`. Does a replay give one journal? Is the lock plus lookup-first as strong as in `settleAutoJournal`? Are missing or unparseable keys and a missing ledger row parked as `AUTO_JOURNAL_PAYLOAD_INVALID`? Can two different events resolve to the same ledger row?
4. **Training and tenant isolation.** Training orders are skipped for earn with an order source and for reverse (order of the reversed earn row). Every ledger lookup must be filtered by tenant: can a tenant B event read or post against a tenant A row? Known gap: `loyalty-earn-consumer.ts` awards points for training orders; confirm it is outside this diff.
5. **Legal entity.** One entity posts there; more than one parks non-retryable `LOYALTY_LEGAL_ENTITY_AMBIGUOUS`. Check outlet choice (ledger outlet for earn, reversed row outlet for reverse, else null), the anchor outlet (oldest of that entity) for business date and parking, and that `auto_journal_parked.outlet_id` is never null.
6. **PSAK 72 policy.** Review against the decision: points as a material right, 100% redemption rate in v1, allocation at face value (1.00% vs 0.990% relative SSP), recognition at `points.redeemed`, breakage only at `points.expired`, bonus points as consideration payable to the customer. Is the use of 4105 (not 4101 or 4103) coherent in the trial balance? Note that PSAK 72 is PSAK 115 since 2024 and Q7 (accountant) still has to confirm the standard.
7. **Provisioning.** Role `loyalty_points_deferral` and account 4105: do new and existing tenants get it, idempotently? When code 4105 is taken, does posting park retryable `ACCOUNT_MAPPING_MISSING`? Confirm there is no migration and `pnpm db:generate` stays empty.
8. **Gating.** Only accounting enabled gates the journal, not `loyalty_programs.is_active`. Does that leave no stranded liability when a program is switched off?
9. Known gaps, confirm they are acceptable: pending redemptions recognised early at period end; `adjustment` bonus rows emit no event; 2105 opening balance when accounting starts after points exist; multi-entity tenants parked.

## Report

Findings with `file:line`, severity, and a concrete failure scenario. Say "clean" for an invariant that holds.
