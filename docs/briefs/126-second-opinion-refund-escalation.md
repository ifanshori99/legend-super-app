# Brief 126: second-opinion (Codex) — refund escalation (legend-n9kn, legend-ix8i)

Tier K (refund). Read-only review. Do not edit, commit, or push.

## Where
- Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/refund-escalation`
- Branch `ws/refund-escalation`, one run: `git diff 5316426a..446d05b3` (three commits: dc4b335d escalation, 07616667 payout_stalled, 446d05b3 evidence mapping re-arms payout_stalled)
- Non-test diff about 470 lines (under 800): exclude `apps/api/src/test/` and `apps/api/drizzle/meta/*_snapshot.json` from line counting.

## What changed
Refunds that wait too long are never cancelled or paid automatically. The worker sweep `sweepApprovedRefundPayouts` first calls `escalateStaleRefunds`, which marks a refund escalated once per reason, writes an audit row, and emits `payment.refund_escalated` to the notification outbox (outlet managers + finance, owners as fallback). Reasons: `pending_unapproved` (pending, no approval chain, default 24 h from `created_at`), `provider_pending` (approved, `payout_pending_polls > 0`, default 72 h from `coalesce(decided_at, created_at)`) and `payout_stalled` (approved, polls = 0, and with a gateway `last_payout_error` in MANUAL_RECONCILIATION/PAYOUT_QUARANTINED/EVIDENCE_MAPPING_REQUIRED, without a gateway any; default 24 h from `payout_stall_detected_at`, a stall clock the escalation module stamps when a stall is first seen and clears when it ends). Thresholds per tenant in `payment_refund_escalation_settings`. `listRefunds` exposes `escalatedAt`/`escalationReason` and an `escalated` filter.

## Risky files
- `apps/api/src/services/payment-refund.service.ts` — `escalateStaleRefunds`, sweep call site, quarantine reopen update, `mapFundEvidence` (clears a payout_stalled escalation and the stall clock; locks the refund after intent and fund).
- `apps/api/drizzle/0103_yellow_gertrude_yorkes.sql`, `0104_payment_refund_escalation_rls.sql`, `apps/api/src/db/schema/payment-admin.ts`.
- `apps/api/src/worker/notification-adapters.ts` — `refundEscalatedRule`.
- `apps/api/src/services/payment-admin.service.ts` — `refundView`, `listRefunds` filter, `refundAudit` allowlist.
- `packages/shared/src/payment/refund-events.ts`, `packages/shared/src/events/catalog.ts`, `packages/shared/src/payment/admin.ts`.

## Invariants to check
1. Escalation writes only `payout_stall_detected_at`, `escalated_at` and `escalation_reason`. Stall stamp/reset has correct NULL logic and cannot flap. Never `status`, `amount_idr`, `updated_at` (payout backoff reads it), lease, attempts, polls, `last_payout_error`, `provider_ref`.
2. Idempotent under repeated and concurrent sweeps: one audit row and one outbox event per refund per reason.
3. Tenant isolation: RLS on the new table; explicit tenant filters; `withTenant`.
4. No deadlock or blocking against the payout lock order (intent → fund → refund).
5. Escalation failure never blocks payouts; escalation runs with no refund gateway installed.
6. Outbox sequence per destination stays gap-free; recipient rule never throws for a valid event; notification text carries no amount or customer data.
7. Migration is additive and safe on a populated `payment_refunds`.

## Output
Findings only: file:line, severity, concrete failure scenario, fix.
