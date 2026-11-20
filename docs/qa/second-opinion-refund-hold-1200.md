# Second opinion: refund hold hardening (1191), 20 Nov 2026

Diff: `431cb2c04...48da44a3f` (int/batch97 base -> ws/1191-refund-hold-hardening), apps/api only.
Production files: `payment-webhook.service.ts` (echo skip, legend-tbygu), `payment.service.ts` (own-failed poller backoff plus reminder, legend-rdg29), `payment-provider-refunded-alert.ts` (daily reminder alert). The rest is tests.

## What I checked and found sound

- Double refund / refund > paid: the echo skip adds no booking. It only skips filing a hold, and only when the completed own refunds (with provider_ref, not settled by hand) on THIS provider transaction sum to at least the whole payment and the reported amount is at most that sum. At that point the refund room is already 0, so no refund in Legend can pay again.
- `completed` is final: `failRefund` only moves `pending|approved` (payment-refund.service.ts:666-680), so the unlocked read in `transactionClosedByOwnRefunds` cannot go stale toward "closed".
- Skip is never used with a refund id, mapping by reference, a reference to another intent, the switch off, or an OPEN hold already filed for the event (`openHoldOfEvent` uses the same key derivation as `holdSwitchedOffRefundSuccess`, wh.ts:1377-1384 vs 1493-1512). Races between two passes of one event resolve in the restrictive direction: a hold that was filed stays filed.
- Tenant scope: every new query filters `tenant_id` and runs under `withTenant`. Outlet narrowing for the gateway call is unchanged.
- Poller: the backoff uses app `now` against `flagged_at`, which is also written from app `now`, so the clocks agree. The lease is still wall-clock with skip-locked. The poller never closes or changes a hold. The reminder goes through a savepoint with a (hold, Jakarta day) dedup id, and failures are swallowed.
- Race test r1-04 (DP credit vs atomic conflict hold) runs truly concurrently (advisory-lock barriers, pg_locks wait checks), and no production fix was needed.

## Findings

P0: none. P1: none. P2: none.

### P3-1 The "whole payment" used by the echo skip can be smaller than the provider transaction
- Where: apps/api/src/services/payment-webhook.service.ts:1718-1720 (`full = max(intent.amountIdr, owner.evidenceAmountIdr ?? 0)`), used at 1775-1781 and 1565.
- Scenario: on the known-intent path (`unmatched(false, intent)`, wh.ts:3314), or whenever `candidate` does not map to the owner, `evidenceAmountIdr` is null and `full` = intent amount. If the provider transaction is larger (an overpayment or surplus on the same transaction), own refunds equal to the intent amount count as "closed". A dashboard refund of the surplus (no refund id, amount at most own sum) is then skipped with no hold and no alert. If that surplus is also parked as a fund that Legend refunds later, the surplus is paid twice.
- Fix: take the transaction size from the DB (max evidence amount of this provider + provider_ref for the intent), or skip only when `evidenceAmountIdr` is known.
- Test: intent 100k, evidence 120k on the same provider_ref, own refund 100k completed. A no-refund-id success of 20k via the known path must leave one open hold.

### P3-2 The echo is checked against the sum of refunds, not against one refund
- Where: payment-webhook.service.ts:1565.
- Scenario: own refunds of 50k + 50k close 100k. A refund-shaped echo of 100k without a refund id (a single 100k refund, which matches neither of ours) is skipped. This is only safe if the provider caps refunds at the transaction amount. When finance checks, the payout of that transaction is already 0, so the only thing lost is the alert.
- Fix (optional): when `reported` comes from a refund-shaped object, require it to be at most the largest single own refund on that transaction.
- Test: the 50k + 50k case above; expect a hold, or document that it is accepted.

### P3-3 The daily reminder misses own-failed holds on a fund's other transaction
- Where: apps/api/src/services/payment.service.ts:4451 (claim) and 4560 (reminder filter `providerPaymentRef = intent.providerRef`), plus 4428 (no registered provider = no pass).
- Scenario: an `own_refund_failed_unverified` hold on a parked fund's transaction, or one left while DOIT is unregistered, gets the first alert only. It is never reminded. The hold stays closed (no money risk), but legend-rdg29's "alert ulang" does not cover it.
- Fix: run the reminder as its own tenant-wide query over open own-failed holds older than 1 hour, independent of the claim.
- Test: an own-failed hold with `provider_payment_ref` != intent.providerRef, flagged 2 hours ago. The poller must create one `payment.own_refund_failed_still_open` notification per day.

### P3-4 The echo skip now also covers the ambiguous-match path
- Where: payment-webhook.service.ts:3010 (ambiguous target calls `holdUnmatchedRefundSuccess`), skip at 1765-1783.
- Scenario: before, an ambiguous success (two own refunds match) was always held. Now it is silently ignored when the transaction is closed. Money is safe because the room is 0, but the conflict is no longer seen. Confirm this is intended.
- Test: two completed own refunds that close the transaction plus an ambiguous no-id success; assert the chosen behaviour.

Verdict: LOLOS

## Keputusan CTO 20 Nov (sesudah 1205a, legend-3tyl1)

- P3-1 ditutup oleh ws/1205a-refund-echo 92ccbfcf6: skip echo hanya bila refund Legend sendiri >= ukuran transaksi (max tagihan, evidence DB intent+ref, payment.amount); evidence hilang/milik intent lain = hold. Architect: bersih.
- P3-a (echo pada transaksi parkir dibanding tagihan, selalu hold): DITERIMA apa adanya. Lebih banyak hold untuk finance, tidak ada uang hilang. Arah aman.
- P3-2 / P3-b (bandingkan dengan jumlah semua refund kita, bukan satu refund): DITERIMA dengan dasar provider menolak refund melebihi jumlah ditagih. Bila provider baru tanpa batas ini ditambahkan, kartu ini wajib dibuka ulang.
