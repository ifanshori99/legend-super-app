# WS-03 slices (brief 94, wave 1)

Worktree: `.worktrees/ws03-menu`, branch `ws/ws03-menu` (from milestone/m1 4a040820). Do NOT commit; the engineer commits.
Card text: `bd show legend-<id>`. Explore notes: `docs/briefs/sub-ws03-cards.txt`.

## Rules for every slice
- Edit ONLY the files your slice owns (list below). New files allowed if they are clearly yours (`apps/api/src/test/<slice>-*.test.ts`, new service file). Need another file: stop and say so in your result.
- Payment methods: online QRIS + VA via DOIT; at cashier cash, EDC, QRIS. No bank transfer. No online card.
- No migration except slice S3 (next number 0086, `apps/api/drizzle`; follow how 0085 was generated: `pnpm db:generate` + RLS SQL style of neighbours).
- RAM rule (CTO, 9 Nov): typecheck/tsc, lint, full suites MUST run via `heavy` (e.g. `heavy pnpm --filter @starter/api typecheck`). Targeted per-file tests between steps run without heavy: `LEGEND_TEST_FILES="src/test/<file>.test.ts" pnpm test` from the worktree root (if a hook refuses it, prefix `heavy`). Never run the full suite or `pnpm check`; the engineer runs the gate once.
- Never kill global test processes (no pkill vitest / killall node).
- Result (max 15 lines): files changed, tests added, exact test command + pass/fail counts, anything left undone.

## S1 guest context + public limiter (cards legend-7csf, legend-6ipw, legend-fpi9, legend-khiv part 4) — K tier
Own: `apps/api/src/routes/qr.routes.ts`, `apps/api/src/routes/public-site.routes.ts`, `apps/api/src/middleware/public-rate-limit.ts`, `apps/api/src/app.ts` (limiter mount lines only), the outlet-rls catalog guard test (7csf NOTES), new `src/test/ws03-guest-context.test.ts`.
- 7csf: after token verification mint an outlet-scoped context (same two-step as `routes/payment.routes.ts`). Public site: outlet/brand scope only where the host pins it; else keep tenant. Tighten outlet-rls catalog guard (`polqual IS NOT NULL AND polwithcheck IS NOT NULL`).
- 6ipw/fpi9/khiv(4): guest `/api/table-sessions` routes (and any guest QR order route not under `/api/qr`) under the shared per-IP public limiter. Keep existing limit values style; do not block a whole venue on one NAT (per-IP + per-session).
- Do not touch `table-session.service.ts` (S2).

## S2 table session: secondary-table join + close cancels requests (legend-rml8, legend-khiv part 1) — K tier
Own: `apps/api/src/services/table-session.service.ts`, new `src/test/ws03-table-session.test.ts`.
- rml8: a guest scanning the QR of a SECONDARY table of a multi-table party joins the party's open session (look at party seating ~866-923 and how secondary tables are recorded). If no stored link exists to find the party: stop and report (no migration in S2).
- khiv(1): close/void table session cancels its `pending` service_requests; `acknowledged` ones also cancelled (the guest left; a stale request must not absorb the next session's call). Same transaction as the close.

## S3 zone-waiter management API + resolve by other staff (legend-xlzl, legend-khiv parts 2-3)
Own: `apps/api/src/routes/service-request.routes.ts`, `apps/api/src/services/service-request.service.ts`, `apps/api/src/db/schema/service-request.ts`, migration 0086, permission catalog entry in packages/shared (one key, e.g. `service_request.zone.manage`, follow existing permission naming), shared contract file for the new endpoints (new file under `packages/shared/src/qr-order/` or the service-request contract file), `src/test/service-request-api.test.ts` (append) or new `src/test/ws03-zone-waiter.test.ts`.
- CRUD for zone_waiter_assignments (list/assign/remove) for outlet managers; user_id must be an active member of the tenant with access to that outlet (reject otherwise).
- khiv(3): add `resolved_by`; resolving an already-resolved request by a different staff returns 200 idempotent with the original resolver (no 409).
- xlzl: overdue sweep already scheduled (`worker-main.ts:281`); only verify. Notification preferences read: if a preferences store exists use it, else note it.
- Do not touch `worker-main.ts` (S5).

## S4 guest menu tax + availability + inclusive quote (legend-lf8g, legend-nx3f, legend-49pw) — K tier (money)
Own: `apps/api/src/services/guest-menu.service.ts`, `packages/shared/src/qr-order/guest.ts`, `packages/shared/src/qr-order/pricing.ts` (+ its test), tax.service row-mapper export only, QR menu FE label for nx3f (`apps/web/src/features/ws03-qr-order/` component that renders sold_out; mock fixture if needed), new `src/test/ws03-guest-menu-tax.test.ts`.
- lf8g: guest tax note uses WS-05 `resolveTaxRule` (`packages/shared/src/tax/calculate.ts`) per the menu context instead of listing every rule.
- nx3f: add `unavailable_until` status (with next window start) to the QR menu contract; set it in guest-menu.service when outside schedule; FE label `Tersedia mulai HH:mm` (outlet timezone).
- 49pw: computeQuote supports inclusive prices (tax_settings.prices_include_tax): back out tax/service instead of adding; contract `pricesIncludeTaxAndService` no longer pinned to false; server passes the tenant setting. Integer IDR, exact rounding, totals must equal what POS/WS-05 computes for the same lines. Tests for both modes.

## S5 worker 86 sweep + availability seed (legend-1am2, legend-2nb9)
Own: `apps/api/src/worker/worker-main.ts`, `apps/api/src/services/org.service.ts` (createOutlet only) or `menu-availability.ts` lazy upsert (pick one, prefer hook in createOutlet inside the same tx), new `src/test/ws03-availability-sweep.test.ts`.
- 1am2: worker sweeps every active tenant with `restoreExpiredSoldOut` (try/catch per tenant, like neighbours ~255-285), broadcast as the board does.
- 2nb9: new outlet gets item_availability rows for every existing item of its brand.

## S6 QR payment event + realtime schema to shared (legend-8pye) — K tier (payment)
Own: `apps/api/src/services/qr-order-payment.ts`, `apps/api/src/services/qr-order-realtime*.ts`, new `packages/shared/src/qr-order/realtime.ts` (+ barrel export line in the qr-order index), `src/test/qr-order-api.test.ts` only if the delegate needs it.
- `deliverQrOrderPaymentEvent` delegates to `deliverOrderPaymentEvent` / `handleQrOrderPaymentPaid` (stricter checks win). Behaviour of existing tests must hold.
- Move `qrRealtimeMessageSchema` + QR signal schemas to shared; API imports from shared.
- Barrel: export realtime schemas only; do not pull fixtures into the client bundle.

## Test-writer T1 (independent of implementers)
Own: new `apps/api/src/test/ws03-acceptance.test.ts` only. From card text + PRD §3 F9/F10, write black-box API tests: (a) QR guest reads run under an outlet-scoped context (another outlet's rows invisible even if the service filter were removed: assert via `current_setting`/RLS probe the existing tests use), (b) inclusive vs exclusive QR quote totals for one line with PB1 10% + service 5%, (c) secondary-table scan joins party session, (d) close session cancels pending service request. Tests may fail until slices land; report which.

## S7 remove online card from QR checkout (legend-vbzu) — founder 9 Nov
Starts after S4 finishes (shares checkout-page.tsx). Own: `apps/web/src/features/ws03-qr-order/components/cart/{payment-methods,checkout-page,online-pay-page,payment-success}.tsx`, `apps/web/src/routes/_customer/t.$token.bayar.$orderId.tsx`, qr-order i18n keys `qrGlass.pay.card.*` (shared i18n messages), mock-engine card branch if any, e2e mock specs `e2e/legend-{b6r,r1bu,fzx,uxh6}.mock.spec.ts` (card steps only). Never edit `e2e/acceptance/` or `e2e/visual/`: if they cover card, stop and report.
- Online methods offered: QRIS, VA, "Bayar di kasir". Leave e-wallet as is (question open to CTO).
- Route `metode` enum: `va` only (old `kartu` links fall back to `va`).
- Remove CardBody + card i18n keys no longer used.
- Verify: `pnpm --filter @starter/web typecheck`, `pnpm --filter @starter/web test` if present for these files; e2e mock run of the 4 specs: `heavy pnpm exec playwright test --config=playwright.mock.config.ts e2e/legend-b6r.mock.spec.ts e2e/legend-r1bu.mock.spec.ts e2e/legend-fzx.mock.spec.ts e2e/legend-uxh6.mock.spec.ts`.
