# Sub-brief: refund approval + provider payout (legend-hvvn, legend-rbjw, PAY-04)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/refund-approval` (branch `ws/refund-approval`). Deps installed. Never read `.env*`. Do not touch `pos-order*.ts`, `qr-order.service.ts`, `apps/web/`, DOIT adapter files. Do not commit (lead commits). Money is integer IDR.

## Current state (verified)

- `apps/api/src/services/payment-admin.service.ts`: `createRefund` locks intent FOR UPDATE, checks `reserved + amount <= cap` (`refundableBalance`, reserved = non-`failed` refunds with `unallocated_fund_id IS NULL`), inserts `pending`. `approveRefund` (:356) is a 503 stub.
- `apps/api/src/services/payment-admin-funds.service.ts` `resolveUnallocatedFund`: inserts a `pending` refund with `unallocated_fund_id` (one live refund per fund). Already a request, not a direct action (legend-hvvn part 1).
- Schema `apps/api/src/db/schema/payment-admin.ts:124` `paymentRefunds`; statuses `pending|approved|completed|failed`; check `approved_by <> requested_by`.
- Requesters can be a user uuid or a system actor (`system:reservation`; branch ws/pos-payment-fixes adds `system:pos`). Must handle any source.
- Approval matrix: `apps/api/src/services/platform-approval.service.ts` — `openApprovalRequest(tx, ctx, input)` :491, `getApprovalChainOutcome(tx,{chainId,sourceModule})` :697, `decideApprovalRequest(tenant, actorId, requestId, {decision, reason}, {mfaVerified, idempotencyKey})` :972 (own transaction; enforces matrix role per level, order, approver≠requester, replay). `approval.resolved` payload: chainId, requestId, sourceModule, actionType, objectType, objectId, outcome, level, requiredLevels, requestedBy, decidedBy, amountIdr. Consumer example: `services/staff-override-consumers.ts` `handleApprovalResolved`, wired in `apps/api/src/worker-main.ts:114`.
- Gateway port `services/payment-gateway.ts` has no refund method; tests use local `FakeGateway` classes. Do NOT add a method to `PaymentGatewayPort` (would break those fakes and the unmerged DOIT branch).

## Decisions (lead)

- Status lifecycle: `pending` → `approved` (approved, payout in flight or awaiting provider) → `completed` | `failed`. Rejection/expiry of approval → `failed` with `failure_reason`. Keep the status enum unchanged (web has exhaustive `Record<RefundStatus,…>`; web out of scope). `failed` already releases the reservation.
- `failure_reason` values: `rejected` | `approval_expired` | `provider_declined`.
- Provider throw/timeout = unknown outcome: stay `approved`, increment attempts, store short error code, retry later with the SAME idempotency key. Never mark `completed` without provider success; never mark `failed` on a throw.
- Approval chain opened lazily on first approve/reject call (one code path for every source). `requestedBy` = refund.requestedBy when it is a uuid; for system actors the first human acting becomes the chain requester (their call only submits; another person must approve). `{required:false}` (below every tier) → a single approver with `payment.reconcile` who is not the requester decides directly. `APPROVAL_POLICY_MISSING` propagates (fail closed).
- Chain input: sourceModule `payment`, actionType `refund`, objectType `payment_refund`, objectId refund.id, amountIdr refund.amountIdr, outletId refund.outletId, source `user`, requestReason = refund.reason (pad/trim to 3..500), payload `{paymentIntentId, unallocatedFundId}`, deadlineMinutes 1440.
- On settle, verify the chain's rows: sourceModule/actionType/objectType/objectId/amountIdr match the refund (bound to value + payment; single use via unique approval_chain_id).
- Lock order everywhere: payment intent → unallocated fund (if any) → refund. Claim tx locks only the refund.
- Provider idempotency key: `refund:<refund.id>`.

## Section A — schema, migration, shared contract (implementer)

Files: `apps/api/src/db/schema/payment-admin.ts`, new migration via `pnpm db:generate` (never edit `_journal.json` by hand), `packages/shared/src/payment/admin.ts`.

1. `paymentRefunds` add columns: `approvalChainId: uuid("approval_chain_id")` (nullable), `failureReason: varchar("failure_reason",{length:40})` nullable + check IN ('rejected','approval_expired','provider_declined') and `(status='failed') = (failure_reason IS NOT NULL)` is NOT required (legacy failed rows) — instead check `failure_reason IS NULL OR status='failed'`; `payoutAttempts: integer("payout_attempts").notNull().default(0)` with check >= 0; `payoutClaimedUntil: timestamp("payout_claimed_until",{withTimezone:true})`; `lastPayoutError: varchar("last_payout_error",{length:100})`; `completedAt: timestamp("completed_at",{withTimezone:true})`. Unique index `payment_refunds_approval_chain_uq` on (tenant_id, approval_chain_id) where approval_chain_id IS NOT NULL. Index on (tenant_id, provider_ref) where provider_ref is not null for webhook lookup.
2. Generate migration (`pnpm db:generate` at repo root; check the SQL is only these changes; name it sensibly if drizzle-kit allows `--name refund_approval_payout`). No new RLS needed (same table) — confirm existing RLS covers the table.
3. Shared `packages/shared/src/payment/admin.ts` (refund section only): `refundFailureReasonSchema` enum; add to `refundViewSchema`: `failureReason: refundFailureReasonSchema.nullable().optional()`, `payoutAttempts: z.number().int().nonnegative().optional()`, `lastPayoutError: z.string().max(100).nullable().optional()`, `completedAt: isoDateTimeSchema.nullable().optional()` (optional so web fixtures compile — grep `apps/web` for RefundView literals to confirm). `rejectRefundInputSchema = clientInputSchema({ idempotencyKey, reason: z.string().trim().min(3).max(500) })`; endpoints `rejectRefund` POST `${ADMIN}/refunds/:refundId/reject` and `retryRefundPayout` POST `${ADMIN}/refunds/:refundId/retry` (body `clientInputSchema({ idempotencyKey })`), both response `dataResponseSchema(refundViewSchema)`. Update the doc comment on `approveRefund`. Export types.
   Done when: `pnpm --filter @starter/shared typecheck` (or the package's check script) passes and migration SQL reviewed.

## Section B — refund provider port + fake (implementer)

Files: new `apps/api/src/services/payment-refund-gateway.ts`, new `apps/api/src/test/refund-fake-gateway.ts`.

```ts
export type GatewayRefundRequest = {
  readonly context: ScopedTenantContext;
  readonly refundId: string;
  readonly idempotencyKey: string; // `refund:<refundId>`; provider MUST dedupe on it
  readonly paymentIntentId: string;
  readonly paymentProviderRef: string | null; // provider ref of the original payment/evidence
  readonly amountIdr: number;
  readonly reason: string;
};
export type GatewayRefundResult =
  | { readonly status: "succeeded"; readonly providerRef: string }
  | { readonly status: "pending"; readonly providerRef: string } // async, webhook/poll finishes
  | {
      readonly status: "failed";
      readonly providerRef: string | null;
      readonly code: string;
    }; // definitive decline
export interface PaymentRefundPort {
  readonly provider: string;
  refund(input: GatewayRefundRequest): Promise<GatewayRefundResult>; // throw = unknown outcome
  getRefundStatus(input: {
    context: ScopedTenantContext;
    idempotencyKey: string;
    providerRef: string | null;
  }): Promise<GatewayRefundResult>;
}
export const unconfiguredRefundGateway: PaymentRefundPort; // throws CoreError("SERVICE_UNAVAILABLE", Indonesian message) — fail closed
export function setPaymentRefundGateway(next: PaymentRefundPort | null): void;
export function paymentRefundGateway(): PaymentRefundPort;
```

Mirror style/comments of `payment-gateway.ts`. Note in header: DOIT adapter implements this after `ws/doit-provider` merges.
Fake (`FakeRefundGateway implements PaymentRefundPort`): records calls; dedupes by idempotencyKey (same key returns the first stored result, counts provider-side executions separately from calls); scriptable next outcomes queue (`succeeded` | `pending` | `failed` | `throw`); optional async gate (a promise to await inside `refund`) for concurrency tests; `getRefundStatus` returns stored result or a settable one.

## Section C — refund service, routes, consumer (implementer)

Files: new `apps/api/src/services/payment-refund.service.ts`; edit `payment-admin.service.ts` (approveRefund delegates; export helpers you need, e.g. `refundView`, `audit` generalised for action names), `apps/api/src/routes/payment-admin.routes.ts`, one-line consumer wiring in `apps/api/src/worker-main.ts`. Use column/type names from sections A and B exactly (they are being written in parallel; code against this spec).
Functions (all use `withTenant(db, context, …)`, tenant filter in every query, `authorize(..., "payment.reconcile", refund.outletId)`):

- `approveRefund(context, actor, {refundId}, input, key, opts:{mfaVerified})` and `rejectRefund(context, actor, {refundId}, {reason}, key, opts)`:
  - tx1: lock refund; authorize; requester === actor → `AccessError("APPROVER_IS_REQUESTER")`; status not `pending` → return current view (replay-safe; reject on non-pending → 409). Ensure chain (Decisions). If `{required:false}`: decide directly in this tx (approve → `approved`, approvedBy=actor, decidedAt; reject → `failed`/`rejected`), audit + payment event. If chain was just opened with a system requester and actor as chain requester → return pending view. Else read the current `pending` level row of the chain (lowest level) → requestId.
  - `decideApprovalRequest(context.tenant, actor, requestId, {decision:"approve"|"reject", reason}, {mfaVerified, idempotencyKey:key})` (approve reason = input.note or "Refund disetujui.").
  - tx2 `settleRefundFromChain(scoped, refundId)`: lock intent → fund → refund; still `pending` → outcome via `getApprovalChainOutcome`; verify chain binding; `approved` → re-check under intent lock that non-failed non-unallocated refunds ≤ cap (non-unallocated refunds) else fail closed 409; set `approved`, approvedBy = last decider, decidedAt. `rejected`→failed/rejected, `expired`/cancelled→failed/approval_expired. Audit (`payment.refund_approved` / `payment.refund_rejected`) + `appendPaymentEvent` only with event names that exist in the payment event registry (check; add to the registry only if it lives in the refund/payment contract you may edit, else skip and note).
  - approved → `runRefundPayout(scoped, refundId)`; return fresh view.
- `runRefundPayout(context, refundId, now?)`: claim tx (lock refund; must be `approved`; skip if `payout_claimed_until > now`; set claim now+120s, attempts+1). Outside any tx call `paymentRefundGateway().refund({... idempotencyKey:"refund:"+id, paymentProviderRef: fund evidence ref for unallocated refunds else intent.providerRef})`. Record tx (lock intent → fund → refund; only if still `approved`): succeeded → `completed`, providerRef, completedAt, clear claim, intent status `refunded` when completed non-unallocated sum ≥ intent.amountIdr else `partially_refunded`; unallocated refund completed → mark fund resolution `refund` (+ resolved fields that exist). pending → keep `approved`, store providerRef, clear claim. failed → `failed`/`provider_declined`, clear claim. throw → keep `approved`, `last_payout_error` = error code only (no message/PII), clear claim; do not rethrow to the approve caller (view shows approved + error).
- `retryRefundPayout(context, actor, {refundId}, key)`: authorize; refund must be `approved` else 409; `runRefundPayout`; return view.
- `applyRefundProviderUpdate(context, {providerRef?, idempotencyKey?, status:"succeeded"|"failed", code?, amountIdr?})`: for webhook/poll (DOIT webhook wiring is a follow-up bead). Find refund by tenant + providerRef or id from key; amount mismatch → refuse; only transitions from `approved`; replay of same terminal state is a no-op; contradicting a terminal state → refuse without write.
- `handleRefundApprovalResolved(context, event)`: like `handleApprovalResolved` — ignore other events/sources; parse envelope; tenant match; objectType `payment_refund`; find refund by approval_chain_id; settle + payout. Wire in worker-main right after `handleApprovalResolved`.
- Routes: add reject + retry routes (same guards as approve: `jsonBody`, `reconcileRecord`); pass `mfaVerified` the way the approvals route does (find it in `apps/api/src/routes/*approval*`).
  Done when: `pnpm --filter api typecheck` (or repo check for api) passes.

## Section D — acceptance tests (test-writer)

File: new `apps/api/src/test/payment-refund-approval.test.ts` (reuse seeding style of `apps/api/src/test/payment-admin-api.test.ts`; seed an approval policy for `refund` if fixtures lack one — see `platform-approval.test.ts`). Install `FakeRefundGateway` via `setPaymentRefundGateway`, reset in afterEach. Cases:

1. Request → approve (other user) → provider succeeded → `completed`, providerRef set, intent `partially_refunded`/`refunded`.
2. Reject → `failed` + failureReason `rejected`; refundable amount restored.
3. Provider throws → stays `approved` with lastPayoutError; retry → `completed`; provider executed once per key.
4. Replay: same approve call/key twice → one decision, one provider execution.
5. Two concurrent approvals of the same refund → exactly one provider execution, final `completed`.
6. Pending refund holds back refundable amount (second refund over remaining → 409; `listRefundablePayments` numbers).
7. Unallocated fund resolve → `pending` refund, not counted against the bill; approve → completed → fund resolved.
8. Tenant isolation: other tenant cannot approve/reject/retry/see (404).
9. Requester cannot approve (APPROVER_IS_REQUESTER); multi-level matrix needs a second distinct approver before payout.
10. System-requested pending refund (`requested_by='system:reservation'`, inserted directly) is processed.
11. Provider definitive decline → `failed`/`provider_declined`, reservation released.
12. `applyRefundProviderUpdate`: pending provider result then webhook succeeded → completed; replay no-op; contradicting update refused.
    How to run one file: read `scripts/test.mjs` (DB tests need its disposable DB; Docker via `~/.claude/scripts/colima-up` if needed; heavy commands via `heavy`).

## Section E — fixes after review + first test run (lead)

Test run: `LEGEND_TEST_FILES="src/test/payment-refund-approval.test.ts src/test/payment-admin-api.test.ts src/test/payment-admin-rls.test.ts" heavy pnpm test` (32/37 passed). Do not edit the test file (lead owns it).

### E1 — `apps/api/src/services/payment-refund.service.ts` + schema index (implementer 1)

1. `applyRefundProviderUpdate` (~:846-892): if the refund already has a providerRef and the update's differs → refuse without write; lookup by providerRef must match exactly one row (refuse if ambiguous). Make `payment_refunds_provider_ref_idx` a UNIQUE partial index on (tenant_id, provider_ref) in `db/schema/payment-admin.ts`; migration 0063 is uncommitted and unapplied: `git checkout apps/api/drizzle/meta/_journal.json`, delete `apps/api/drizzle/0063_refund_approval_payout.sql` + `meta/0063_snapshot.json`, re-run `pnpm db:generate --name refund_approval_payout`, review SQL.
2. Reject must never approve/pay: in `decideRefund`, after settle, if decision is `rejected` and the result is not `failed` → 409 conflict without payout. Approve on a refund that is `failed` → 409; approve on `approved`/`completed` → 200 replay view. Reject on any non-pending refund → 409 (tests expect this).
3. Stuck pending: when the chain is approved but `applyApproval`'s cap/fund check fails, end the refund `failed` (failure_reason `approval_expired` is wrong; add nothing to the enum — use `rejected`? NO: use a new value is not allowed without migration — since 0063 is being regenerated anyway, add `cap_exceeded` to the failure_reason check + shared `refundFailureReasonSchema`) with audit, instead of throwing forever. Return 409 to the approve caller after recording the failure (commit the failure first).
4. System-requested refunds (requested_by not a uuid): reject by any human with `payment.reconcile` decides directly → `failed`/`rejected` (cancel the chain via `cancelApprovalRequest` if one is open). Approve: first human submits (chain opened with them as requester, 200 pending view); a later approve by that same submitter → `AccessError("APPROVER_IS_REQUESTER")` (403), not a silent 200.
   Done: api typecheck + eslint clean.

### E2 — `payment-admin.service.ts` refundView + `payment-admin-funds.service.ts` lock order (implementer 2)

1. `viewerCanApprove` (refundView hard-codes false; listRefunds/createRefund/approve views must compute it for the signed-in viewer): true only when status `pending`, viewer ≠ requestedBy, viewer holds `payment.reconcile` at the refund outlet (reuse the permission resolver non-throwing, or catch), viewer is not the system-refund chain submitter (chain level 1 `requested_by`), and viewer has not decided an earlier level of the chain. Keep `refundView` signature change minimal (add `viewerId` param); update all callers incl. `payment-refund.service.ts` `loadView` ONLY by passing the actor through — coordinate: implementer 1 owns that file, so instead export a `refundViewFor(tx, refund, viewerId)` and leave `refundView(tx, refund)` as is computing false; implementer 1 will not call the new one — lead wires it.
2. `resolveUnallocatedFund`: lock the payment intent `FOR UPDATE` before the fund (global order intent → fund → refund) to avoid the deadlock with `lockRefundGraph`.
   Done: api typecheck + eslint clean.

## Section F — architect fixes (payout robustness)

Targeted tests currently 69/69 green: `LEGEND_TEST_FILES="src/test/payment-refund-approval.test.ts src/test/payment-admin-api.test.ts src/test/payment-admin-rls.test.ts src/test/reservation-deposit-db.test.ts src/test/platform-approval.test.ts" heavy pnpm test` from the REPO ROOT (not apps/api).

### F1 — implementer (files: db/schema/payment-admin.ts, regenerated 0063, payment-refund-gateway.ts, payment-refund.service.ts, worker-main.ts, test/refund-fake-gateway.ts)

1. Claim token: add `payout_claim_token uuid` nullable. Claim sets a fresh token; record step / error step only clears the lease or writes when `payout_claim_token` matches the caller's token (else no-op for lease fields, still never downgrade a terminal state). Regenerate uncommitted 0063 like before (`git checkout apps/api/drizzle/meta/_journal.json`, delete 0063 sql+snapshot, `pnpm db:generate --name refund_approval_payout`).
2. Port: `GatewayRefundRequest.signal: AbortSignal`; `getRefundStatus` may return `{ status: "not_found" }` (extend `GatewayRefundResult` lookup type separately, e.g. `GatewayRefundLookup = GatewayRefundResult | {status:"not_found"}`). Provider call wrapped with `AbortSignal.timeout(30_000)`; a timeout = unknown outcome.
3. Re-send safety: when `payoutAttempts > 0` before this claim (a previous attempt happened) → call `getRefundStatus({idempotencyKey, providerRef})` first; only `not_found` → `refund()`; otherwise apply the looked-up result.
4. Late `succeeded` for a refund already terminal-`failed`: no state write, but record an audit (`payment.refund_provider_conflict`) and `logger.error` (ids only) so ops reconcile; same for `applyRefundProviderUpdate` contradictions. Refuse `applyRefundProviderUpdate` while a claim lease is live? NO — instead apply it under the refund lock (it is authoritative) and the in-flight record step then sees a terminal state and no-ops.
5. Consumer `handleRefundApprovalResolved`: settle only (status transition), no provider call.
6. Add `sweepApprovedRefundPayouts(context, now = new Date(), limit = 20)`: picks `approved` refunds whose lease is free, ordered by updated_at, with backoff by attempts (e.g. next try ≥ updated_at + min(2^attempts min, 60 min)), stops after 8 attempts (leave `approved`, set `last_payout_error = 'MANUAL_RECONCILIATION'`, log error). Model on `retryPendingRefunds` in `services/reservation-refunds.ts:367` (how it iterates tenants/contexts). Wire it in `worker-main.ts` relay tick next to the reservation refund retry, own try/catch.
7. Fake gateway: support `signal`, `not_found` lookups, and a `delayMs` / gate so lease tests work.
   Done: api typecheck + eslint clean; then the lead reruns tests.
