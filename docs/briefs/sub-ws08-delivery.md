# WS-08 delivery channel framework (legend-5bn3)

Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/ws08-site`, branch `ws/ws08-site`. Card: `docs/briefs/sub-ws08-5bn3-card.md`. Shared rules: `docs/briefs/sub-ws08.md` "Shared rules" (tests via `LEGEND_TEST_FILES=... node scripts/test.mjs unit`; tsc/lint only via `heavy`; do not commit unless told; edit only your files).

PRD: `../../../PRD_Legend_Super_App_v1.7.md` :829 (Integrasi Ojek Online), :1186-1192 (Alur G), :1911 (`delivery_channel_orders`), :1374 (DeliveryChannel adapter).
Contract (source of truth, do not change shapes without reporting): `packages/shared/src/delivery/{schemas,endpoints,machines,events,errors,fixtures}.ts`; adapter `packages/shared/src/adapters/providers.ts:121-135,294`, fake `adapters/fakes.ts:326 FakeDeliveryChannel`, webhook verify pattern `adapters/webhook.ts:101` + `apps/api/src/routes/identity-wa-webhook.routes.ts:35-61`, mount `apps/api/src/app.ts:225-231`.
FE already built against mocks: `apps/web/src/features/ws08-delivery/` (do not edit).
Existing: `ORDER_CHANNELS` includes gofood/grabfood/shopeefood (`packages/shared/src/pos/schemas.ts:127`); `pos_orders.channel` + `external_ref` with manual-ojol unique guard (`apps/api/src/db/schema/pos-order.ts:83-85`); QR fire to KDS = set sent/fired + append `order.placed` (`qr-order.service.ts:1364-1420`); menu/price/86 outbox events (`packages/shared/src/menu/events.ts`, `menu-pricing.service.ts:1190-1215`); outbox consumer routing (`worker-main.ts:100-155`, `core-outbox.ts`).

Invariants: tenant_id NOT NULL + enforced RLS + outlet_id on operational tables; unique (tenant_id, platform, external_order_id); webhook import idempotent (same external id + same payload hash → same result; different payload hash → update via state machine, never a second order); prices on injected orders come from the platform payload (gross) but lines map to menu items via a mapping (unmapped → `mapping_status` needs_review, order still reaches KDS with the platform's item name); commission stored per order; no money moves through our gateway (platform-paid); every state change goes through `packages/shared/src/delivery/machines.ts`; audit + outbox events from `delivery/events.ts`. No secrets in logs.

## D1 — foundation (runs first, alone)

Files: `apps/api/src/db/schema/delivery.ts` (+ index export), `delivery.custom.sql` RLS, migration 0094 (+0095 custom RLS if that is the pattern), `apps/api/src/services/delivery-store.ts` (row↔DTO mappers parsing with the contract schemas, `lockDeliveryOrder`, `findByExternalId`), stub routers `apps/api/src/routes/delivery-channels.routes.ts`, `delivery-orders.routes.ts`, `delivery-reconciliation.routes.ts`, `delivery-webhook.routes.ts` (each `export const xRouter = Router()` with requireAuth/requireTrustedOrigin/tenant middleware like neighbours; webhook one without auth), registered in `routes/index.ts` and webhook mounted in `app.ts` like the WhatsApp webhook. Tables mirror the contract DTOs 1:1 (snake_case): `delivery_channels` (per outlet+platform: state open/closed/paused, sync status, last sync, store external id, commission rate bps), `delivery_channel_orders` (PRD :1911 + DTO fields, `order_id` FK to pos_orders nullable until injected, `pickup_number`, `payload_hash`, `source` platform|manual_pos, status, lines jsonb, gross/commission/net idr), `delivery_settlement_lines`. Commit when the migration applies and an empty test passes; report table + export names.

## D2 — channels + menu/86 sync (after D1)

Files: `services/delivery-channels.service.ts`, `services/delivery-sync-consumer.ts`, `routes/delivery-channels.routes.ts`, `worker-main.ts` (one consumer hook only), `services/delivery-ports.ts` (adapter registry: platform → DeliveryChannel; FakeDeliveryChannel when no real adapter; real adapters = legend-im8n, not here). GET list, PATCH open/close/pause (adapter `open`/`close`), POST sync (`sync_menu`, result `deliveryMenuSyncResultSchema`), outbox consumer: `item.sold_out`/`item.restored` → `sold_out`, price/menu updated → debounced `sync_menu` per outlet+platform for open channels. Permission: find the existing delivery/ojol or menu-channel permission in `packages/shared/src/access/permissions.ts`; report if none. Test `src/test/delivery-channels-api.test.ts`.

## D3 — webhook ingest + KDS injection (after D1)

Files: `routes/delivery-webhook.routes.ts`, `services/delivery-ingest.service.ts`, `services/delivery-inject.ts` (exports `injectDeliveryOrder(tx, context, input)` → `{deliveryOrderId, orderId, pickupNumber}`; D4 reuses it for manual orders), `packages/shared/src/adapters/delivery-webhook.ts` (generic per-platform HMAC verify reusing `adapters/hmac.ts`, timestamp tolerance), `apps/api/src/config/env.ts` + `.env.example` (per-platform webhook secret names, optional; platform disabled when unset). Route `POST /api/webhooks/delivery/:platform`: raw body, verify, resolve tenant+outlet from the platform store id on `delivery_channels`, idempotent import, create the pos order with channel tag + `external_ref` and fire it to the KDS exactly like QR fire (`order.placed`), allocate pickup number, auto-accept via adapter when the channel is open, reject when closed/paused. Test `src/test/delivery-webhook-db.test.ts` (bad signature 401, replay idempotent, payload change, unknown store 404, closed channel, cross-tenant).

## D4 — orders API (after D1; imports D3's `injectDeliveryOrder`)

Files: `services/delivery-orders.service.ts`, `routes/delivery-orders.routes.ts`. List (query schema, paging), detail, manual order (`createManualDeliveryOrderInputSchema`, source manual_pos, unique external ref, reuse inject; check the existing manual-ojol POS path at pos-order.ts:83 and do not duplicate it — report overlap), status update via machine (ready/picked_up/cancelled; cancel before cook voids KDS items the way POS void does; adapter `update_order`/`cancel_order` for platform orders). Idempotency-Key like other routes. Test `src/test/delivery-orders-api.test.ts`.

## D5 — commission reconciliation (after D1)

Files: `services/delivery-reconciliation.service.ts`, `routes/delivery-reconciliation.routes.ts`, test `src/test/delivery-reconciliation-db.test.ts`. GET per outlet+period (`deliveryReconciliationQuerySchema` → `deliveryReconciliationSchema`): expected (gross − commission per order) vs settlement lines; statuses per `deliverySettlementStatusSchema`; settlement lines import path = an internal service fn (adapter/CSV later), no new public endpoint unless the contract has one.

## D6 — test-writer (parallel with D2-D5)

`src/test/delivery-acceptance-db.test.ts`: from PRD Alur G + contract: webhook order appears in KDS with channel tag and pickup number; duplicate webhook = one order; tenant A cannot see tenant B delivery orders/channels; sold-out item triggers `sold_out` call on the fake adapter for open channels; manual order unique external ref; reconciliation matches gross − commission. Use the D1 table names (read `apps/api/src/db/schema/delivery.ts`).

## D1 result (878b604b) — use these names

- Tables `delivery_channels`, `delivery_channel_orders`, `delivery_settlement_lines`; drizzle `deliveryChannels`, `deliveryChannelOrders`, `deliverySettlementLines` in `apps/api/src/db/schema/delivery.ts`.
- Store (`services/delivery-store.ts`): `toDeliveryChannel`, `toDeliveryChannelOrder`, `toDeliverySettlementLine`, `lockDeliveryOrder(tx, tenantId, id)`, `findByExternalId(tx, tenantId, platform, extId, {lock})`.
- Routers (already registered; fill them, do not re-register): `deliveryChannelsRouter`, `deliveryOrdersRouter`, `deliveryReconciliationRouter` under `/outlets/:outletId/...`; `deliveryWebhookRouter` at `/api/webhooks/delivery`.
- Channel state per contract: `is_open` + `closed_until` (paused = closed with closed_until). No enum.
- `delivery_channels` unique (platform, store_external_id) across tenants: D3 resolves the channel before tenant context — follow the existing tenant-less lookup pattern (how the WhatsApp/Kirim webhook or tenant_domains resolve a tenant under RLS: SECURITY DEFINER fn or platform-role read); never bypass RLS with the owner role in app code.
- Orders/settlement rows cannot be deleted by the app role.
- Migrations up to 0095 used. New migration needed? Generate after pulling; agent renumbers at merge.
