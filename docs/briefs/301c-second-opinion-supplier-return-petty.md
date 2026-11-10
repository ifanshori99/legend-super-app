# Brief: second-opinion (Codex) for supplier return and petty purchase backend (legend-65mgw)

Do not run before the CTO decides. Tier K (money, migration, access). Effort: xhigh. Required before the release gate. It does not block the next slice. Combine with `docs/briefs/298b-second-opinion-purchase-return-posting.md` (the journal rules that consume these events) as one review of the WS-07/WS-06 purchasing return area.

## Role

Read `~/.agents/team/roles/second-opinion.md`, then follow it. Read and report only; do not edit.

## Repo

`/Users/ifanshori99/Projects/legend super app/legend`, worktree `.worktrees/purchase-return-posting`. Branch `ws/supplier-return-petty` (stacked on `ws/purchase-return-posting`):

```
git diff milestone/m1...ws/supplier-return-petty -- . ':!apps/api/drizzle/meta/0205_snapshot.json' ':!apps/api/drizzle/meta/0208_snapshot.json'
```

## Context

- Design: `docs/briefs/301b-sub-return-petty-design.md`; map: `docs/briefs/301a-sub-return-petty-context.md`; decisions: `docs/DECISIONS.md` (WS-07 purchase return section).
- Code: `apps/api/src/services/purchase-return.service.ts`, `petty-purchase.service.ts`, routes, schema `purchase-returns.ts`, `petty-purchases.ts`, migration `0208_supplier_return_petty` (`when` 1794287000000, prevId = 0205 snapshot).
- Tests: `purchase-return.test.ts`, `petty-purchase.test.ts`, `purchase-return-petty-e2e.test.ts`, `db/rls.test.ts`.

## Invariants to check

1. Over-return: accepted qty minus earlier returns caps each receipt line; two parallel returns cannot both pass (lock on the PO row, because `legend_app` cannot UPDATE goods_receipts). Does every return path take the lock before reading prior returns? Empty lock result refused.
2. Cumulative rounding: sum of line values equals receipt line value after full return; `valueIdr` equals the stock ledger value of the return's rows and the event's `uninvoicedValueIdr`.
3. Stock: movement is negative, receipt cost (not moving average), receipt batch, one posting per line key `purchase_return:<id>:<line>`; custom balance check under the location lock prevents negative stock. Any path where a retry posts stock twice?
4. Gate: `PURCHASE_RETURN_POSTING_ENABLED` default off refuses the whole POST (403 `FEATURE_DISABLED`) before the idempotency claim. Can a return still be created through another route or service entry?
5. Petty: no policy denies; over the limit rejected; photo linked once (unique), purpose receipt, same outlet, uploader = actor; back-dating refused; fingerprint covers all inputs.
6. Idempotency: same key and same input replays; same key and different input answers 409 `IDEMPOTENCY_KEY_REUSED`; keys scoped by tenant and outlet.
7. Tenant and outlet isolation on every query; RLS and revokes on history tables (no UPDATE/DELETE/TRUNCATE for `legend_app`); policy table allows UPDATE only.
8. Migration 0208: constraint swaps (`purchasing_document_sequences_kind_check`, `core_storage_objects_source_kind_check`), idempotent role backfill, snapshot vs schema, merge-order risk with other migrations numbered 0206/0207.
9. Permissions: `purchasing.return.create`, `purchasing.petty.record`, `purchasing.petty_policy.manage` assigned to the intended roles only; owner gets them; reads need the stated alternatives.
10. Known gaps, confirm they are acceptable: moving average not re-averaged on return; petty limit per transaction only; invoiced split always 0 (no supplier invoice tables); returns of receipts before GRNI posting go live (legend-29vw cutover).

## Report

Findings with `file:line`, severity, and a concrete failure scenario. Say "clean" for an invariant that holds.
