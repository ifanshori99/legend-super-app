# WS-03 wave 1 review brief

Worktree `.worktrees/ws03-menu`, uncommitted diff vs HEAD (`git diff` + untracked files). Slices + cards: `docs/briefs/sub-ws03-slices.md`.
Rules: payment online QRIS+VA via DOIT; cashier cash/EDC/QRIS; no bank transfer; no online card.

Report only real defects (correctness, tenant/outlet isolation, auth, money, idempotency, tx boundaries, missing tests for risky paths). Format: `path:line: severity: problem. fix.` Max 25 lines. Read-only.

## Batch R1 (stable now)
- S2: apps/api/src/services/table-session.service.ts, src/test/ws03-table-session.test.ts (legend-rml8, khiv part 1)
- S3: service-request routes/service/schema, drizzle/0086_*, packages/shared/src/qr-order/zone-waiters.ts, schemas.ts resolvedBy, access/permissions.ts + roles.ts (legend-xlzl, khiv 2-3)
- S5: org.service.ts createOutlet, menu-internals.ts appendMenuEvent, menu-availability.ts, worker-main.ts (legend-1am2, 2nb9)
- S6: qr-order-payment.ts, qr-order-realtime*.ts, packages/shared/src/qr-order/realtime.ts (legend-8pye)

## Batch R2 (after S1/S4 land)
- S1: qr.routes.ts, qr-order.routes.ts, public-rate-limit.ts, app.ts, db/outlet-rls.test.ts (legend-7csf, 6ipw, fpi9, khiv 4)
- S4: guest-menu.service.ts, tax.service.ts, qr-order-pricing.ts, qr-order.service.ts assertQuotePlaceable, shared qr-order guest.ts/pricing.ts/schemas.ts orderQuoteSchema, i18n qr-glass-menu.ts, web features/ws03-qr-order item-card/item-sheet/menu-filter/item-options/cart-bar/table-nota/checkout-page, tests/qr-order-contract.test.mjs (legend-lf8g, nx3f, 49pw). Inclusive checkout refused on purpose (follow-up card).
