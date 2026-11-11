# POS refund Q63 implementation

Spec: task 530 / legend-qrfv8, origin/ws/ws05-pay-admin a4dae5fb.

Reuse payment-refund-approval-limits.ts for scoped named-role authority and cumulative commitments, including standalone admin refunds, native POS and gateway mirrors exactly once. Native POS uses its locked order as the subject even when there is no payment intent. Preserve existing admin behavior and locking order: POS locks order then pos_orders, admin locks group then pos_orders; do not acquire group locks after the POS row.

POS service resolves authority from the verified consumed override's approver, reloads scoped grants server-side, and checks cumulative Q63 ceiling before money, stock or gateway writes. Apply cumulative commitments to the paid cap too; owner is unlimited only for role authority, never for amount paid.

Edge decision: refuse native POS refund creation on edge (including connected edge) because its local database has no authoritative cloud/admin refund history. A local Rp200,000 cap cannot establish remaining paid funds or stop split-path refunds. Refunds must be handled by the central API until authoritative history and serialization exist.

Verification sequence: new central and edge integration tests fail on original production behavior; only then edit helper/service. Run targeted new tests and existing admin/POS/gateway/cash/promo regressions through heavy from this worktree. Run API tsc, changed-file ESLint and Prettier; no schema change or migration anticipated. Commit and push ws/pos-refund-ceilings, preserving final test results and review limitation in docs/PROGRESS.md.

Ownership: refund_tests writes new central tests; explore_edge writes new edge tests; explore_admin owns payment-refund-approval-limits.ts after RED; explore_pos owns pos-order-corrections.ts after RED; parent integrates, verifies and publishes branch. Architect review is scheduled by CTO after 00:45.
