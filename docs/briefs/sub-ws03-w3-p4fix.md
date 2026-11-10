# P4 fix round (legend-3160 VA, K tier) after Opus review + architect

Worktree `.worktrees/ws03-pay`. Do NOT commit. Rules from `docs/briefs/sub-ws03-w3.md` apply. P4 is commit 1f898989.
Other agents run now: P3-fix edits the `subtotalIdr` hunk (~171) in `qr-order-payment.ts`, `qr-order.service.ts`, POS files, 0088; P5 edits web files. Do not touch those parts. Re-read a file if an edit fails because it changed.

## Fix

1. HIGH, paid after table closed. A VA lives 180 min; a session can close meanwhile and `handleQrOrderPaymentPaid` (`qr-order-consumers.ts` ~309-341) fires the order to the kitchen anyway. Fix: when the order's table session is no longer active (or the order was voided), do not fire; route the money to the existing late-payment refund path (`requestQrLatePaymentRefund` or equivalent). Also add an optional `expiresAt` to the WS-05 intent input (`createPaymentIntentInputSchema` / `createIntent` in `payment.service.ts`, capped at the method default) — m1 DOIT `createIntent` takes one — and pass it from QR payments where a cap is known. Test: close session with pending VA, webhook paid, order not fired, refund request filed.
2. MED, superseded VA still payable. Add an optional `cancel?(context, intent)` to the gateway port in `payment-gateway.ts`; the test gateway implements it; call it after `supersedePending` commits (failure logged, not fatal). When a superseded/old intent of an order that is already paid (or fired) gets paid, file a system refund request like the late-payment path instead of leaving it only in `unallocated_funds`. Test: switch bank, pay both, second payment gets a refund request.
3. MED, `getGuestPayment` 404 for an old intent after a switch. Resolve the order through the intent's `paymentLinkId` = `orders.paymentLinkId` (session scoped) and return the old intent with its real status (`expired` once superseded). No contract change. Test.
4. LOW, superseded intents count toward `MAX_QR_PAYMENT_ATTEMPTS` (`qr-order-consumers.ts` ~58). Exclude superseded ones. Test: 3 bank switches then expiry does not void as `payment_attempts_exhausted`.
5. Outlet scope for m1 merge: the gateway port `channels`/`health` take an optional `outletId`; `assertVaBank` and `getGuestPaymentOptions` pass `session.outletId` (`assertVaBank` after the session lock or from it). Test gateway ignores it.
6. Fixtures: test gateway and tests use DOIT bank codes (`bmri`, `bnia`, `brin`, `permata`...; list `git show milestone/m1:apps/api/src/services/payment-doit-wire.ts`, `DOIT_VA_BANKS`), not `BCA`.
7. `guestPaymentOptionSchema.unavailableReason` gains `no_channels` (gateway up, routing on, no VA banks) in `packages/shared/src/qr-order/guest.ts`; server uses it.

## Verify

`LEGEND_TEST_FILES="src/test/ws03-guest-va.test.ts src/test/qr-order-api.test.ts" pnpm test` plus test files covering `qr-order-consumers` late payment and `payment.service` intents (grep `src/test/`). `heavy pnpm --filter @starter/api typecheck`, `heavy pnpm --filter @starter/shared typecheck`, eslint touched files. Result max 12 lines.
