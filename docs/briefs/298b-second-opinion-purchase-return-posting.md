# Brief: second-opinion (Codex) for purchase return and petty purchase journals (WS-07)

Do not run before the CTO decides. Tier K (money, migration). Effort: xhigh. Required before the release gate. It does not block the next slice.

## Role

Read `~/.agents/team/roles/second-opinion.md`, then follow it. Read and report only; do not edit.

## Repo

`/Users/ifanshori99/Projects/legend super app/legend`. Worktree `.worktrees/purchase-return-posting`.

Branch to review: `ws/purchase-return-posting`, compared with `milestone/m1`:

```
git diff milestone/m1...ws/purchase-return-posting -- . ':!apps/api/drizzle/meta/0205_snapshot.json'
```

## Context

- Decision: `docs/DECISIONS.md`, last section "WS-07: purchase return and petty purchase journals" (points 1 to 6). Design brief: `docs/briefs/298a-sub-purchase-return-posting-design.md`.
- Cards: `bd show legend-1xbs`, `bd show legend-v3lh`. PRD §3.18 (Retur Pembelian, Pembelian Sederhana), §3.19 (Jurnal Otomatis).
- Migration `0205_purchase_return_posting` (`when` 1794284000000): widens `journal_entries_source_type_check`, backfills account 5104 and the `petty_purchase_expense` mapping.
- Tests: `apps/api/src/test/accounting-purchase-return-journal.test.ts`, `tests/purchase-return-posting-contract.test.mjs`.

## Invariants to check

1. Return journal balances for every split: Dr `grni` `uninvoicedValueIdr`, Dr `accounts_payable` `invoicedValueIdr + ppnIdr`, Cr `inventory` `valueIdr`, Cr `ppn_input` `ppnIdr`. Check that `valueIdr = uninvoiced + invoiced` holds and the PPN credit is matched by the AP debit.
2. Zero amount: `valueIdr = 0` posts nothing and does not park or throw. A malformed split throws `AutoJournalPayloadInvalid` (not a silent mis-post).
3. Petty purchase is an expense and never stock; credit goes to `petty_cash` (1102), not `cash_on_hand`. Is that right for the PRD wording "kredit kas"? Say if the founder should decide.
4. Idempotency keys `aj:purchase-return:<id>` and `aj:petty-purchase:<id>`: collisions with other keys, replay, concurrent delivery (advisory lock).
5. Tenant and outlet isolation: foreign-tenant event ignored; envelope outlet equals payload outlet; entry date uses the outlet business date.
6. Migration safety: constraint drop and add in one transaction, FORCE RLS restored, backfill idempotent, custom 5104 kept, snapshot matches `schema/accounting.ts`.
7. Double posting: `stock.moved` rows of `purchase_return` stay ignored by `inventory-gl-consumer.ts`.
8. GRNI dependency: `goods_receipt.recorded` is still not posted (legend-29vw). Confirm the return rule must not go live before that, and that nothing posts today because no emitter exists.
9. Contract drift: `purchase_return.recorded` payload changed (breaking for any emitter) and `petty_purchase.recorded` added to the event catalog. Look for other consumers or fixtures that parse the old payload.

## Report

Findings with `file:line`, severity, and a concrete failure scenario. Say "clean" for an invariant that holds.
