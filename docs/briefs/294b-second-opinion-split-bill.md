# Brief: second-opinion (Codex) for WS-03 split bill and per-guest payment (legend-ms3)

Do not run before the CTO decides. Tier K (money and migration). Effort: xhigh. Required before the release gate. It does not block the next slice.

## Role

Read `~/.agents/team/roles/second-opinion.md`, then follow it. Read and report only; do not edit.

## Repo

`/Users/ifanshori99/Projects/legend super app/legend`. Worktree `.worktrees/split-bill`.

Branch to review: `ws/split-bill`, compared with the merge-base of `milestone/m1`:

```
git diff $(git merge-base milestone/m1 ws/split-bill)..ws/split-bill
```

## Context

- PRD v1.7 §3 F10 Split Bill and "Klaim Poin per Orang" (`docs/PRD.md` around line 608), §6.D `bill_splits` (around line 1771), criterion ORD-06.
- Decisions: `docs/DECISIONS.md`, entry 2026-11-10 "Split bill per order, per-part payment and claim tokens", points 1 to 7.
- Design brief: `docs/briefs/sub-split-bill-design.md` (D1 to D5).
- Migration `0202_bill_splits` (`when` 1794281000000, prevId = snapshot of 0186), `apps/api/src/db/schema/bill-splits.ts`, `bill-splits.custom.sql`, FK `payment_intents_bill_split_fk`.
- Code: `apps/api/src/services/bill-split.service.ts` (new), `payment.service.ts` (`createIntentCore`, `createSplitPartIntent`, `supersedePending` filter, fingerprint), `qr-order-payment.ts` (`split` branch), `qr-order-consumers.ts` (part paid hook, attempts per part, refund each paid intent on void), `qr-order.service.ts` (`getSessionBill` splits), `routes/qr-order.routes.ts`, `packages/shared/src/qr-order/guest.ts` (`splitClaimSchema`, `getSplitClaim`).
- Tests: `apps/api/src/test/bill-split*.test.ts`, `tests/split-bill-contract.test.mjs`.
- Cards: `bd show legend-ms3`, follow-ups `legend-90na8` (token redemption, waits legend-111j), `legend-arp35` (UI wiring).

## Invariants to check

1. ORD-06: for every method the parts sum exactly to `orders.total_idr` (tax, service and rounding included), with no zero part, also when the total does not divide.
2. The order turns paid only when the payment link is fully paid; a part turns paid only from its own paid intent, and a replayed webhook or outbox event changes nothing.
3. Several guests can hold live codes for different parts of one link at the same time. A new code for a part supersedes only that part's pending code. The old order-level path (`createIntent`) behaves exactly as before.
4. A part's intent amount never exceeds the link's outstanding balance, checked again under the link lock. Money paid above the total (stale code paid late on a voided part) ends up in the existing double-payment refund path.
5. Re-split is refused once any part is paid, any money reached the link, or any code on the link is still payable (including the late-payment grace). A paid part can never be voided or re-split.
6. Idempotency: same request key and same part returns one intent; the same key for another part is refused; split creation replays to the same set.
7. Lock order and deadlocks: session → order → bill_splits → payment link. `bill_splits` rows are locked `FOR NO KEY UPDATE` because the intent insert on another connection takes `KEY SHARE` through the FK. Look for any remaining path that could self-deadlock or race (two concurrent splits, split vs pay, pay vs settle, sweep vs settle).
8. Unpaid-order sweep: a split order with some parts paid is not voided for payment attempts; when an order with money on it is voided, every paid intent of the link gets exactly one refund request.
9. Claim token: only for a paid part, valid 24 hours from the part's payment, stored as sha256 hash plus sealed copy (AAD bound to tenant and part), single use by a conditional update, never logged, no public redeem route yet.
10. Tenant and outlet isolation of `bill_splits` (FORCE RLS, tenant and outlet policies, composite FKs); guest session credential checks on every new route; a guest of one session cannot read or pay another session's part.
11. Migration: additive only, FORCE RLS lifted and restored correctly around the `payment_intents` FK, second `db:generate` empty, journal and snapshot chain.

## Report

Findings ranked by severity with file:line, a concrete failure scenario for each, and a fix suggestion. Say plainly which invariants you verified and which you could not.
