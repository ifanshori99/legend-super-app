# Sub-brief 92: Codex second-opinion fixes on refund (tier K: money)

Worktree `.worktrees/refund-approval`, branch `ws/refund-approval`, base SHA 09385266.
Service: `apps/api/src/services/payment-refund.service.ts` (named "svc" below).
Tests run: `LEGEND_TEST_FILES="src/test/<file>.test.ts" pnpm test` from repo root.
Never `pkill vitest` or `killall node`. Stop only your own PIDs.

## F1. Supervisor authority is required (engineer does this part in svc)

PRD `docs/PRD.md:541` says: "Void, diskon di atas ambang, refund, ... memerlukan PIN supervisor atau approval dari ponsel supervisor".
PRD D14 (`:260`) says: "refund wajib PIN supervisor".
"Supervisor authority" means permission `pos.refund.approve` at the refund outlet.
The supervisor, outlet_manager, general_manager and owner roles hold it. Finance does not.

New rules:

- Single-approver path (matrix `required:false`): the decider must hold `payment.reconcile` AND `pos.refund.approve`.
  Otherwise the call throws `AccessError("PERMISSION_DENIED")`, and the refund stays `pending` with no chain row.
- Chain settle (`settleFromChain`, svc ~455-490): each approved row's decider must hold `payment.reconcile` OR `pos.refund.approve`.
  At least one approved decider must hold `pos.refund.approve`.
  Otherwise `failRefund` runs with reason `approver_unauthorized` and note `supervisor_required`.
- Approver != requester stays as it is.

## F2. A fund without its own evidence never pays out (implementer)

Files: svc `runRefundPayout` claim (~913-944), svc `retryRefundPayout` (~1185-1210), and `packages/shared/src/payment/admin.ts` (`retryRefundPayoutInputSchema`).

Source evidence rule, for a refund with `unallocatedFundId`:

- If `fund.evidenceId` is set, select exactly that evidence (tenant + intent + id).
  If no row is found, HOLD. Never fall back to `intent.providerRef`.
- If `fund.evidenceId` is null, count the evidence rows of the intent (`limit 2`).
  Exactly 1 row: use it, because the mapping is certain.
  0 rows or 2+ rows: HOLD.
- HOLD means:
  - Do not claim and do not call the gateway.
  - Do not increment `payoutAttempts`.
  - Set `lastPayoutError = "EVIDENCE_MAPPING_REQUIRED"` (export a const) and set `updatedAt = now`.
  - `logger.warn` with the refundId.
  - Return `{ run:false, refund }`.
  - The sweep may pick the refund again. That is cheap, and it keeps holding until the fund is mapped.
- Retry body: add optional `sourceEvidenceId: uuid` to `retryRefundPayoutInputSchema`.
  In `retryRefundPayout`, inside the existing tx, after authorize, and only when `sourceEvidenceId` is given:
  - The refund must have `unallocatedFundId`. Otherwise return 409.
  - The evidence must belong to the same tenant and the same `paymentIntentId`. Otherwise return 409.
  - No other `payment_unallocated_funds` row may have `evidence_id` = it. Otherwise return 409.
  - If the fund already has a different `evidenceId`, return 409. Remapping is not allowed.
  - If the fund already has the same `evidenceId`, do nothing.
  - Otherwise, update `fund.evidence_id` and record an audit row with action `payment.refund_fund_evidence_mapped` (the existing `refundAudit`/`recordAudit` pattern).
  - Clear `lastPayoutError` when it was `EVIDENCE_MAPPING_REQUIRED`.
- After `runRefundPayout` in retry: if the refund is still `approved` with `lastPayoutError === EVIDENCE_MAPPING_REQUIRED`, throw `new HttpError(409, "EVIDENCE_MAPPING_REQUIRED", ...)`.
- No migration. Single-evidence rows resolve at runtime. A NOT NULL constraint cannot hold for ambiguous legacy rows.

## Tests (test-writer): new file `apps/api/src/test/payment-refund-codex-fix.test.ts`

Copy the seeding helpers from `payment-refund-review-fix.test.ts` (`signedIn`, `roleIdOf`, `setPolicy`, `seedPaid`, `insertPendingRefund`, `seedApprovedRefund`) and the `FakeRefundGateway`.

Scenarios:

1. Finance A requests Rp50.000, below every tier. Finance B approves and is refused with 403 PERMISSION_DENIED. The refund stays pending and the gateway is never called.
2. Same setup, but a user holding both `payment.reconcile` and `pos.refund.approve` (owner) approves. The refund pays out.
3. A matrix chain where every approver is finance resolves approved. The refund fails with `approver_unauthorized` and the gateway is not called.
4. A chain with a supervisor-role approver plus finance resolves approved. The refund pays out.
5. A fund with `evidence_id` NULL on an intent that has 2 evidence rows (A, B), and an approved refund. The payout holds: `lastPayoutError` is `EVIDENCE_MAPPING_REQUIRED`, the gateway gets 0 calls, and attempts stay 0.
6. Same setup as 5. Retry without `sourceEvidenceId` returns 409 EVIDENCE_MAPPING_REQUIRED. Retry with `sourceEvidenceId` = A maps the fund, and the gateway gets A's providerRef, never B's.
7. A fund with NULL evidence on an intent that has exactly 1 evidence row pays out with that ref.
8. Retry mapping to evidence of another intent returns 409. Retry mapping to evidence already used by another fund returns 409.

Tests for F1 and F2 may fail until the code lands. Write them against this spec, not against the code.

## Test update after F1 (round 2)

F1 changes the rule: a finance-only approval no longer pays out. Older tests that expect a finance approver to pay out now encode the old rule.

- Update them: give the deciding approver supervisor authority too. Add an extra role assignment, for example the `supervisor` template scoped to the outlet, next to finance.
  Keep every assertion. Do not delete, skip, or weaken any test.
- When a test checks the finance-only behaviour itself, flip its expectation to the new rule: 403 PERMISSION_DENIED on the direct path, or `approver_unauthorized` with note `supervisor_required` on a chain.
- New file scenarios 1 and 2: the matrix must have NO tier covering Rp50.000. The direct path needs `opened.required === false`, so do not seed `setPolicy(null,"finance",1)` for those cases. Use a separate describe or tenant if needed.
- Route `retry` now forwards `sourceEvidenceId`.
