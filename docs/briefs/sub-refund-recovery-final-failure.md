# Sub-brief: refund recovery fixes (legend-iu91r, legend-8kilj)

Worktree: `.worktrees/refund-recovery-fix`, branch `ws/refund-recovery-fix` (base 3b94e7ad).
Paths below are under `apps/api/src/`. Do not touch Duitku, profit share, web UI,
routes, `packages/shared`. No migration planned.

Every fix: write the failing test first, run it and see it fail, then fix, then
run it green. Tests run from the worktree root:
`LEGEND_TEST_FILES="src/test/<file>.test.ts" pnpm test` (path relative to
`apps/api`). Do not run lint/typecheck/tsc (the agent runs them once).

## R1 worker edge (agent does it)

`worker-main.ts`: `deliverOrderRecoveryRefundEvent` runs ungated. Refunds are
cloud-only (legend-jm5c): gate it with `sweepsRefunds`. Test: source regex in
`test/edge-worker-refund-gate.test.ts`.

## R2 final failure of a recovery refund (decision)

Today (`order-recovery-refund.ts` `refileRecoveryRefundAfterFailure`):
`rejected` appends `order_issue.refund_reversal_requested` (journal
`aj:order-refund:<issueId>` reversed, loyalty points restored) and the sale holds
the money again (`payment-admin.service.ts` `qrSaleInUseOfIntent`, HAVING
excludes issues with a `rejected` refund). Final failures (`provider_declined`,
`cap_exceeded`, `source_document`, the `refile_limit` and `no_first_filing`
blocks) only audit: journal stays, hold stays released, points stay deducted,
and a person cannot refund by hand (`payment-refund.service.ts` `applyApproval`
fails a user-filed refund of a source-document intent with `source_document`).
Money is stuck.

Decision, part 1 (implemented here): a final failure is treated like
`rejected`.
- Keep the `order_issue.refund_refile_blocked` audit (same `blockedReason`).
- Call `requestRecoveryRefundReversal` too (once per issue, only when an
  `order.refunded` of the issue exists, so open-bill refunds append nothing).
  The auto-journal consumer reverses the refund journal; the loyalty consumer
  restores the points (check `loyalty-earn-consumer.ts` handles the event for
  any failure reason, not only `rejected`).
- Hold: in `qrSaleInUseOfIntent` an issue releases its amount only while it has
  a live refund (`status <> 'failed'`). `rejected` keeps its behaviour; a final
  failure now also gives the money back to the sale. A failure that is re-filed
  in the same transaction (`approval_expired`, `approver_unauthorized`) still
  has a live refund, so nothing changes for it. The journal guard
  (`accounting-auto-journal-guards.ts` `releasedOf`) follows the journal state
  (reversed = "none"), so it already agrees.

Decision, part 2 (manual follow-up path): open, see "Follow-up options" below.
The per-issue keys (`aj:order-refund:<issueId>`,
`aj:order-refund-reversal:<issueId>`, reversal once per issue, loyalty restore
per issue) mean that after a reversal a second revenue reversal for the same
issue cannot be journalled without new per-attempt keys, and a person action
needs a route plus a shared schema field (both outside this scope).

Follow-up options (for the CTO):
1. Per-attempt journal keys: a person (payment.reconcile, not resolver or any
   ORD-09 approver) re-files a `system:recovery` refund for the issue with a
   fresh `order.refunded` keyed by the new refund id. Needs guard, auto-journal
   reversal and loyalty changes plus a route. Large.
2. Delay the reversal: a final failure parks the issue as "needs person" with
   journal and hold as they are (the money is still owed). The person either
   re-files (new `system:recovery` refund with `order_issue_id`, no new
   journal: exempt from `source_document`, four-eyes kept) or closes it (same
   reversal as `rejected`). Smaller and keeps the books right while the guest
   is owed, but contradicts "final failure = rejected". Still needs a route.

## R3 four-eyes payout (implementer)

`payment-refund.service.ts` `isRecoveryRefundParty` excludes only
`order_issues.approved_by` and the idempotency row's `resolvedBy`/`approvedBy`
(both the last ORD-09 approver). Also treat as a party every `decided_by` of
the ORD-09 approval rows of the issue (`approval_requests`,
`db/schema/platform-approval.ts`: verify how the issue links to its chain,
e.g. `order_issues.approval_request_id` -> `chain_id`, or `object_type` /
`object_id`; take all levels, any chain of the issue). Fail closed as today.
Fix the header comment in `order-recovery-refund.ts` only if wording is wrong
(do not edit other parts of that file: R2 edits it).
Test: `test/order-recovery-refund-four-eyes.test.ts`, two-level chain
(`setLevels(2)`, `filedTwoLevel`, `decide`): the level-1 ORD-09 approver
approving the payout is refused `APPROVER_IS_REQUESTER`; a third person passes.

## R4 releasedOf on non-pinned codes (implementer)

`accounting-auto-journal-guards.ts` `intentBackedAt` (~836-880): `releasedOf`
is subtracted for every code of the link; `qrSaleInUseOfIntent` releases only
on the pinned code (`orders.payment_intent_id = intentId`). Subtract
`releasedOf` only when `orders.payment_intent_id = intentId` (both CASE
branches for the pinned code, nothing for other codes).
Test: `test/accounting-auto-journal-split-qr-guard.test.ts`: split order on a
link, a posted recovery refund journal for an issue of the order, guard on a
non-pinned code must not count the release (payout over its own evidence is
still refused / sale guard holds full share). Seed `order_issues` +
`payment_refunds.order_issue_id` + posted `aj:order-refund:<issueId>` the way
`order-recovery-refund-four-eyes.test.ts` does.

## R2 part 1 tests (implementer)

New file `test/order-recovery-refund-final-failure.test.ts` (copy fixtures
from `test/order-recovery-refund-reject.test.ts`). For each of
`provider_declined`, `cap_exceeded`, `source_document`, and the
`refile_limit` block: one `order_issue.refund_reversal_requested` appended,
auto-journal reverses `aj:order-refund:<issueId>` (entry balanced: debits =
credits, reverses the refund entry), loyalty points restored, and
`refundableBalance` / hold shows the sale holds the money again.
`approval_expired` with re-file: no reversal, hold still released.
