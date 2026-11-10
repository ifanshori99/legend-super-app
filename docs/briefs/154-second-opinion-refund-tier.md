# Brief 154: second-opinion — default refund approval from Rp0 (legend-zi9o)

Tier K (money, approval). Codex second opinion before the release gate. This brief deliberately leaves out the Claude review findings.

## Range

- Repo `/Users/ifanshori99/Projects/legend super app/legend`, branch `ws/refund-tier` (local only, not pushed), worktree `.worktrees/refund-tier`.
- Diff: `git diff 21edd29b..7620d1e6` (base `integ/m1-batch5`).
- One run: about 240 non-test lines, under the 800-line limit. Skip `apps/api/drizzle/meta/0134_snapshot.json` (generated, no table change).

## Files at risk

1. `apps/api/src/services/payment-refund.service.ts`: `refundApprovalInput`, `setRefundChain`, `openRefundChainAtRequest`, `decideRefund` (chain-open path), `escalateStaleRefunds` (`pending_unapproved` case).
2. `apps/api/src/services/payment-admin.service.ts` (`createRefund`) and `apps/api/src/services/payment-admin-funds.service.ts` (`resolveUnallocatedFund`): these now open the chain inside the request transaction.
3. `apps/api/drizzle/0134_refund_approval_policies_data.sql`: data migration across all tenants, with RLS FORCE lifted for the duration.
4. `apps/api/src/services/access.service.ts` (`seedTenantRoleTemplates`), `apps/api/src/db/seed-dev-tenant.ts`, `packages/shared/src/access/approval.ts` (`DEFAULT_REFUND_APPROVAL_POLICIES`).

## Invariants to attack

- I1: A refund is never approved or paid unless a supervisor authority (`pos.refund.approve`) decided it. A user who holds only `payment.reconcile` must never approve alone.
- I2: A supervisor without `payment.reconcile` can decide only through the approval inbox (`decideApprovalRequest`). The direct path (`approveRefund` / `decideRefund`) still refuses that user.
- I3: The requester never approves their own refund, at any level.
- I4: A chain belongs to exactly one refund. Neither a replayed `approval.resolved` event nor a second decision produces a second payout or settles another refund.
- I5: Tenant isolation. The seed, the migration and the inbox never read or write another tenant's rows.
- I6: A tenant that already has any `refund` row in `approval_policies` is never changed by the seed or by 0134. Re-running either one is a no-op.
- I7: A swallowed `APPROVAL_POLICY_MISSING` in `openRefundChainAtRequest` never leaves the request transaction aborted or half-written.
- I8: An idempotent replay of `createRefund` or `resolveUnallocatedFund` never opens a second chain.
- I9: Escalating a refund that has an open chain changes only `escalated_at` and `escalation_reason`, plus one audit row and one outbox row. It never changes status, the chain or the money.

## Design choices to judge (not bugs in themselves)

- The chain opens at request time with a 7-day deadline. The decide-time lazy open still uses 24 hours.
- The default matrix is a single row (Rp0, level 1, supervisor). The PRD names no amounts, so higher tiers are tenant configuration. The same `refund` matrix also feeds POS phone overrides (`staff-override.service.ts`).
- System-requested refunds (late payment, reservation, QR) and refunds left pending from before the deploy still open their chain lazily. This is tracked in legend-2dnh.

## Output

Findings only, each with file:line, a concrete scenario and a severity. State it plainly when an invariant holds.

---

# Run 2: system refunds and pre-deploy pending refunds open their chain (legend-2dnh)

Tier K (money, approval). Same rules as run 1: findings only, no Claude review findings included.

## Range

- Diff: `git diff 7620d1e6..ceaab8fe` (already reviewed by Codex; findings fixed in run 3) on `ws/refund-tier`. Skip `apps/api/drizzle/meta/0135_snapshot.json` (generated).
- About 160 non-test lines, under the 800-line limit.

## What changed

- Migration 0135 inserts a reserved system user (`00000000-0000-4000-8000-000000000002`, `Sistem`, `system@legend.invalid`, `banned = true`, no `account` row, no roles). It is the approval-chain requester for refunds created by the system.
- Refunds created by the system (POS and QR late payment, reservation deposit) open their approval chain at creation, inside a savepoint (`openRefundChainSafely`). A failure is logged and never rolls back the caller.
- Refunds that were already pending before the deploy (status `pending`, no chain) are backfilled by `openPendingRefundChains`. It is called at the start of `sweepApprovedRefundPayouts`, at most 50 per tenant per sweep, and does one short transaction per refund using `lockRefundGraph`.
- `decideRefund` lazy path: a system refund with no chain now opens with the system requester, and the acting human decides level 1. Before, the first human only submitted and a second human decided. A chain opened by a human submitter under the old flow keeps the self-approval guard.

## Files at risk

1. `apps/api/src/services/payment-refund.service.ts`: `SYSTEM_APPROVAL_REQUESTER`, `openRefundChainAtRequest`, `openRefundChainSafely`, `openPendingRefundChains`, `sweepApprovedRefundPayouts`, `decideRefund` (lazy-open branch).
2. `apps/api/src/services/pos-order-late-payment.ts`, `qr-order-late-payment.ts` (two call sites), `reservation-refunds.ts`: the chain opens inside the caller's transaction, only on first creation.
3. `apps/api/drizzle/0135_system_approval_requester.sql`: writes into the auth `user` table.

## Invariants to attack

- I1 to I9 from run 1 still hold.
- I10: The system user can never sign in, hold a role, or decide any approval step.
- I11: A failure while opening a chain for a system refund never aborts or half-writes the caller's transaction (for example a POS payment). The refund is never left with a chain id and no chain, or the reverse.
- I12: The backfill never opens a second chain for a refund. It never touches another tenant, a refund that is not pending, or a refund below every tier. It cannot deadlock against payout, webhook or decide paths (lock order intent, fund, refund).
- I13: A refund that always fails to open does not stop the rest of the batch or block payouts.
- I14: A legacy chain whose requester is a human submitter cannot be approved by that same human.

## Design choices to judge

- A system refund now needs one supervisor approval, not two people. PRD D14 names only the supervisor, and a tenant can configure a second level.
- The backfill runs from the payout sweep instead of a one-off migration, because opening a chain needs the application's matrix resolver.

---

# Run 3: fixes for the run 2 findings (legend-2dnh)

Tier K. Check only that the four run 2 findings are fixed and that the fixes add no new defect. No Claude review findings included.

## Range

- Diff: `git diff ceaab8fe..b169986a` on `ws/refund-tier`. Skip test files except to confirm a test exists per finding (`apps/api/src/test/payment-refund-system-chain.test.ts`).

## What changed

1. Migration 0135 (edited; never pushed or applied outside local test DBs): the system user's email is `system-approval-<random uuid>@legend.invalid`, inserted with `ON CONFLICT (id) DO NOTHING`. A DO block fails the migration unless the row holding the id is the system account (name, email pattern, banned, no ban expiry, no role, no sign-in account), so a human row is never adopted.
2. Triggers in 0135: `user_role_guard` (the system row stays banned with no role and no ban expiry; an account under an active ban never gets a new global role) and `role_assignments_grantee_guard` (no tenant role assignment to the system id or an account under an active ban). An active ban follows Better Auth: `banned` and no expiry or an expiry still ahead. `grantRoleAssignment` (`access.service.ts`) answers 422 for the same cases, and `src/set-role.ts` refuses them.
3. `openPendingRefundChains` (`payment-refund.service.ts`): a rotating per-tenant cursor, held in process memory, that resumes after the last refund tried. `requestReasonOf` counts code points for the 3-character minimum and caps at 500 code points and 500 UTF-16 units.
4. Each backfill candidate runs with `SET LOCAL lock_timeout = '2000ms'`. The backfill uses at most half of the sweep budget and stops on `shouldStop`.

## Invariants to attack

- I15: No path gives a tenant role or a global role to the system account or to an account under an active ban: API, Better Auth admin plugin, CLI, provisioning, raw SQL.
- I16: The migration never fails on a clean or existing production database because of an email clash, and never adopts a human row.
- I17: A refund that permanently fails to open, or a refund whose locks are held, never stops newer refunds from getting a chain or payouts from running in the same sweep.

---

# Run 4: fix for the run 3 findings (I15)

Tier K. Same rules: findings only, no Claude review findings included.

## Range

- Diff: `git diff b169986a..40800ce2` on `ws/refund-tier`. Only `apps/api/drizzle/0135_system_approval_requester.sql` (0135 is not in m1 yet, so it was edited in place) and its tests.

## What changed

- `legend_user_role_guard` now runs `BEFORE INSERT OR UPDATE`. On INSERT, an account under an active ban (banned, no expiry or an expiry still ahead) with a role is refused. On UPDATE only a changed role is refused.
- `legend_role_assignment_grantee_guard` now runs on every UPDATE. For the system account or an account under an active ban, INSERT is refused, and UPDATE is allowed only when user, tenant, role, scope type and scope id are unchanged, `valid_from` is unchanged or later, and `valid_until` is unchanged, newly set or earlier.

## Invariants to attack

- I15 (again): no path gives the system account or an account under an active ban a global role or a tenant role, or widens one it holds.
- I18: revoking or shortening an existing assignment of a banned account still works; banning an account that already has a role still works.
- I19: the triggers never refuse an ordinary (not banned) account's insert, update or grant.
