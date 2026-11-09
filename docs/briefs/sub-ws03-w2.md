# WS-03 wave 2 slices (brief 94)

Worktree: `.worktrees/ws03-menu-w2`, branch `ws/ws03-menu-w2` (from ws/ws03-menu 11b9b775). Do NOT commit; the engineer commits.
Card text: `bd show legend-<id>`. Wave 1 context: `docs/briefs/sub-ws03-slices.md`.

## Rules for every slice

- Edit ONLY the files your slice owns. New files allowed if clearly yours. Need another file: stop and report.
- Payments: online QRIS + VA via DOIT; cashier cash, EDC, QRIS. No bank transfer, no online card (founder 9 Nov).
- Migration: only W3 may add one (next number 0087 in `apps/api/drizzle`, `pnpm db:generate`, RLS like neighbours).
- RAM: typecheck/lint/full suites only via `heavy` (`heavy pnpm --filter <pkg> typecheck`). Targeted tests: `LEGEND_TEST_FILES="src/test/<file>.test.ts" heavy pnpm test` from this worktree root. Never full suite / `pnpm check`. Never kill global test processes.
- Result (max 15 lines): files changed, tests added, exact command + counts, anything left.

## W1 menu contract: modifier link + media scope (legend-un0j, legend-dcz0)

Own: `packages/shared/src/menu/{schemas,fixtures,endpoints}.ts`, `apps/api/src/services/menu.service.ts`, `menu-media.service.ts`, `routes/menu.routes.ts`, `apps/web/src/features/ws03-menu/mock.ts`, new `src/test/ws03-menu-link.test.ts`.

- un0j: link schema + fixture (itemId, groupId, sortOrder) matching the existing `menu_item_modifier_groups` table; mock uses the shared fixture; confirm reorderItems/reorderCategories semantics (document + test).
- dcz0 decision (engineer): media is outlet-level with optional `outletId` in the upload contract; missing → caller's first reachable outlet (TEN-02 fallback, current behaviour); explicit outlet must be reachable (403 otherwise). Test both.
- Do not touch `packages/shared/src/menu/index.ts` (W2 owns it).

## W2 menu import/print contracts + XLSX (legend-l8zb, legend-az32)

Own: `apps/api/src/routes/menu-import.routes.ts`, `routes/index.ts` (menu-import mount only), new `packages/shared/src/menu/import.ts` (+ `menu/index.ts` export line), `apps/api/src/worker/menu-print*` / `menu-print.job.ts`, `apps/web/src/features/ws03-menu/import-*.ts(x)` (not print), tests `menu-import-*.test.ts`, `menu-print-*.test.ts`.

- l8zb: move local Zod schemas to shared; keep wire shapes. Renderer: define `MenuPdfRenderer` adapter interface; no PDF engine dependency (engine choice = later card, keep 503). Wire the menu-print outbox consumer only if it is a small mount; else report.
- az32: XLSX via the existing server-side `/api/menu/import/validate|preview` (send file, server parses). If the server cannot parse XLSX without a new dependency, stop and report the dependency choice.

## W3 open-bill controls (legend-cqrw)

Own: per-outlet policy storage (tenant/outlet settings; migration 0087 only if no settings store fits), new `apps/api/src/services/open-bill-control.service.ts`, `apps/api/src/worker-main.ts` (one sweep block), contract file under `packages/shared/src/qr-order/open-bill.ts` (+ one barrel line in `qr-order/index.ts`), place-order limit check hook in `qr-order.service.ts` (single guarded call), new `src/test/ws03-open-bill.test.ts`.

- Limit: placing an open-bill order that pushes the session over max value → refused with clear error. Inactivity and bill-request SLO alerts to zone waiters via existing service-request/realtime routing. Missing policy never means "no limit": use PRD values if PRD v1.7 line ~613 gives them, else conservative named constants (report the numbers you chose). Audit breaches.

## W4 QR guest read models (legend-cpq2)

Own: `apps/api/src/routes/qr-order.routes.ts` (new GET routes), new `apps/api/src/services/qr-guest-reads.service.ts`, new `src/test/ws03-guest-reads.test.ts`. Do not edit `packages/shared/src/qr-order/index.ts` (W6) or `guest.ts` schemas (contract is ratified as is; report mismatches).

- Serve the `guest.ts` read models not yet served: suggestions (simple rule-based, no AI: top items not in cart; legend-ptd does AI later), order issues, guest payment status, point claim card, order ETA. Same schemas, bearer session credential, outlet-scoped `guestSessionContext`.

## W5 station-aware RBAC (legend-ra7s) — K tier

Own: `apps/api/src/services/permission-resolver.ts`, access context helpers it uses, new `src/test/ws03-station-rbac.test.ts`.

- Load stations in loadTenantAccess; station scope resolves to its outlet; station id passed separately for KDS routes. Fail closed on unknown station. TEN-03 tests: station holder sees only its outlet; other outlet 403.

## W6 QR shared barrel + mock settle (legend-33uj, legend-9pes)

Own: `packages/shared/src/qr-order/index.ts`, new fixtures-free entry (e.g. `qr-order/sample.ts`), `packages/shared/package.json` exports, `apps/web/src/features/ws03-qr-order/mock-engine.ts`, web imports of the sample menu.

- 33uj: barrel must not build the 61-item sample at load; sample behind its own subpath. Evidence: `heavy pnpm --filter @starter/web build` then `grep -rl 'Nasi Goreng Kampung' apps/web/.output/public` → no hits.
- 9pes: mock whole-order/split payment settles the floor bill + reviewEligibility.

## W7 menu back-office FE fixes (legend-ujkf, legend-afig)

Own: `apps/web/src/features/ws03-menu/` restore dialog, item editor, print sheet + its query (not import-* files).

- ujkf: Escape closes the 86 restore dialog after photo error; no PATCH when diff empty.
- afig: print sheet + price-grid read page through `collectAllPages`.
- Verify: heavy web typecheck, eslint, relevant e2e mock specs (`grep -l ws03-menu e2e/*.mock.spec.ts`).

## T2 closures (legend-ogzf, legend-6ohy) — test-writer

Own: new `apps/api/src/test/ws03-media-body-limit.test.ts` only.

- ogzf: POST menu media with a ~700 kB base64 body → accepted (not 413); > 1 MB → 413; other routes still capped at 100 kB.
- 6ohy: confirm `server.ts:83-87` wires `attachQrOrderRealtime` + `listenQrCartWakeups` and `order-payment-consumers-realtime.test.ts` covers the relay; report file:line evidence (no edit).
