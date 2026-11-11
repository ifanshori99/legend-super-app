# 526 WS-05 payment admin implementation plan

Goal: resolve CTO-approved findings 523 and founder Q63 in `ws/ws05-pay-admin`, with fail-first regressions and explicit payout conservation proof. Durable work tracking: `legend-xoxim`.

Scope and decisions: preserve the existing Express/Drizzle services, response contracts, approval chain and gateway payout flow. Clear cashier defaults using current tenant/terminal/method predicates in a single DELETE. Mock refund resolution creates exactly one linked pending refund, keeps funds open until payout, stores same-key responses and rejects another live request. Invalid mock defaults disappear without deleting the cashier roster. Server refund approval authority uses active scoped supervisor (Rp200,000), outlet_manager (Rp1,000,000), general_manager (Rp5,000,000) and owner (unlimited) roles, against cumulative per-order refund exposure. Existing paid-amount limits remain mandatory for every role.

Execution: two read-only investigations, one API test writer and three implementers run in parallel with disjoint files. API test writer owns race and authority regressions; config implementer owns payment-admin-config.service.ts; refund implementer owns payment-refund.service.ts and necessary approval route handling; mock implementer owns payment-admin/mock.ts and a dedicated API Vitest import test. Root owns integration, heavy execution, docs and commit/push. Production edits wait for observed expected test failures.

Verification: use root `LEGEND_TEST_FILES="..." heavy pnpm test` for new regressions, then related payment/refund/config suites; sequential API and web `heavy pnpm --filter ... typecheck`; changed-file eslint and prettier; schema generation must remain empty. No full test, merge, force push, release or architect gate in this session. CTO schedules fresh architect review after 00:45.

Review focus: deterministic two-connection stale deletion, current terminal-method validity, replay without repeated side effects, approval-inbox bypass, cross-intent refunds on one order, rejection before gateway calls, exact paid totals and active outlet-specific role scope.
