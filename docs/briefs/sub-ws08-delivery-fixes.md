# WS-08 delivery review fixes (Opus review of D2 + D5)

Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/ws08-site`. Shared rules: `docs/briefs/sub-ws08.md` "Shared rules" (targeted tests via `LEGEND_TEST_FILES=... heavy node scripts/test.mjs unit` from worktree root; no full suite; no commit; never pkill). Edit only your files.

## F-D2 (files: `apps/api/src/worker-main.ts` delivery hook, `services/delivery-sync-consumer.ts`, `services/delivery-channels.service.ts`, `test/delivery-channels-api.test.ts`)

1. HIGH worker-main.ts:143 / sync-consumer.ts:98: an adapter error on `item.sold_out`/`item.restored` throws inside the shared outbox consumption tx, retries and dead-letters the event, so the 86 never reaches POS/KDS/QR. Adapter failures must never fail the outbox event: catch per channel, mark that channel `syncStatus` error/stale (for the sweep), continue. Use a savepoint if a DB write may fail.
2. HIGH sync-consumer.ts:159: `menu.updated`/`menu_item.updated` are brand-scoped; `appendMenuEvent` sets only the brand's first outlet or `null` (menu-internals.ts:499-525). Resolve all outlets of the brand the way `menu-print.service.ts:314-340` does and mark/sync each one's open channels; `null` outlet must not return early.
3. MED sync-consumer.ts:168: `syncStaleDeliveryChannels` (debounce trailing edge) is wired to no sweep. Wire it in the worker/relay sweep for active tenants, next to similar sweeps in `worker-main.ts` (own try/catch).
4. MED sync-consumer.ts:92: 86/restore on a closed/paused channel must mark it `stale`; reopening (`delivery-channels.service.ts:272`) must push the menu (or leave it stale for the sweep, which must then run).
5. MED channels.service.ts:199: `pushDeliveryMenu` must never throw: move `buildMenuPayload` inside the try and record failure as `syncStatus` error.
6. LOW channels.service.ts:176: `safeSyncError` stores the raw adapter message. Store a fixed code/message only (no raw text in DB or DTO).
7. Tests: outlet-scoped user calling another outlet's `/delivery-channels` → 403; consumer test where the fake adapter fails on sold_out → event consumed, channel marked error/stale; brand-scoped menu event marks channels of every outlet of the brand.

## F-D5 (files: `services/delivery-reconciliation.service.ts`, `routes/delivery-reconciliation.routes.ts`, `test/delivery-reconciliation-db.test.ts`)

1. MED service:168: existing settlement line lookup has no outlet filter and the unique key has no outlet. If an existing line's `outletId !== input.outletId` → reject/skip that line with an explicit error result (no overwrite, no 500 from a unique violation hidden by RLS).
2. LOW service:232: the order's `settledNetIdr` is overwritten per line. Recompute it as the sum of its matched lines; clear `settledAt` when no matched line remains.
3. Tests: cross-outlet line rejected; two lines for one order sum; HTTP: outlet-scoped user reading another outlet's reconciliation → 403, and permission `accounting.reconcile` required.

Report: files changed, tests run + result, max 25 lines.

## F-D3 (files: `services/delivery-ingest.service.ts`, `services/delivery-inject.ts`, `db/schema/delivery.ts`, `db/schema/delivery.custom.sql`, `drizzle/0096_delivery_store_index.sql` + `0097_delivery_store_index_rls.sql` + their snapshots (edit in place; uncommitted), `test/delivery-webhook-db.test.ts`)

1. MED ingest:526-547: changed hash on an injected order overwrites money with no status/order check. Keep seen hashes (or per-order `(hash, signedAt)` list); any seen hash → `duplicate`; ignore payloads older than stored `signedAt`; refuse money updates on terminal statuses (cancelled/rejected/picked_up/delivered).
2. MED ingest:505-507: `order.cancelled` on an already cancelled/rejected order with a new hash → record hash, return `cancelled` no-op (no 409 retry loop).
3. MED inject:204-216: webhook for an order the cashier already entered via manual-ojol POS (`pos-order.ts:83` external_ref) → store a delivery row linked to that twin `orderId` (no second pos order) and answer 200; map `pos_orders_external_ref_key` unique violation to `DELIVERY_ORDER_DUPLICATE`, never a raw 500.
4. LOW ingest:498-503: exact retry of a duplicate still `received` with `orderId` set on an open channel → retry auto-accept.
5. LOW 0096/0097: FK of `delivery_store_index` must include `store_external_id` → `delivery_channels(tenant_id, outlet_id, platform, store_external_id)` (add the matching unique key); app role SELECT only on the index, writes via a SECURITY DEFINER trigger fn (`SET search_path`, tenant from NEW row only); backfill from existing `delivery_channels`. Keep `provision-roles.ts`/`rls.test.ts` exception consistent (write-policy check: if you drop the write policies, the exception still only needs RLS enabled).
   Tests for 1-4.

## F-D4 (files: `services/delivery-orders.service.ts`, `routes/delivery-orders.routes.ts`, `test/delivery-orders-api.test.ts`)

1. HIGH service:517: a `needs_review` platform order (`order_id` null) can be moved to `accepted`/`ready`, kitchen never sees it. When `row.orderId === null` allow only `rejected`/`cancelled`; call `assertDeliveryOrderInjectable(row)` otherwise.
2. MED service:566-594: adapter network call runs inside the tx with the row locked. Move platform calls after commit (outbox/intent like `autoAccept` in delivery-ingest does), or at minimum last before commit with a recorded reconcile path when commit fails. Do not leave platform cancelled while our row rolls back.
   Tests for 1-2.
