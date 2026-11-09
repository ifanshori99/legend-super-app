# WS-08: merge milestone/m1 into ws/ws08-site, then wire KDS into delivery

Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/ws08-site`, branch `ws/ws08-site`. Shared rules: `docs/briefs/sub-ws08.md` "Shared rules". tsc/lint/full tests only via `heavy`. Never pkill. No push.

## M1: merge + migration regen (one implementer, alone)
1. `git merge --no-ff --no-commit milestone/m1`. Resolve conflicts by keeping both sides (routes/index.ts, worker-main.ts, schema/index.ts, env.ts, .env.example, adapters/index.ts, rls/outlet-rls test allowlists, provision-roles.ts exceptions).
2. Migrations: m1 owns 0091-0098. Ours (branch-only) are `0091_brand_websites`, `0092_flat_rogue`, `0093_promo_idempotency_rls`, `0094_*` + `0095_*` (delivery), `0096_delivery_store_index`, `0097_delivery_store_index_rls` (check `git diff --name-only milestone/m1...HEAD -- apps/api/drizzle`). Follow the merge-train pattern (see `git show 07130a4e --stat`, `git show 07130a4e -- apps/api/drizzle/0094_curious_living_tribunal.sql`):
   - Take m1's `_journal.json` and snapshots; remove our generated SQL + snapshots.
   - Order: website (generated) → website custom parts, promo (generated) → promo RLS custom, delivery (generated) → delivery RLS custom, store index (generated) → store index RLS custom. Generated ones: `pnpm --filter @starter/api db:generate --name <name>` one feature at a time is not possible from TS schema alone, so a single generate for all our tables is acceptable; then re-apply our hand edits to generated SQL (FORCE RLS lift during FK validation, `tenant_wide_only` restrictive policy on brand_websites, etc.: diff the old generated files against a fresh generate to find them).
   - Custom files: rename to the next numbers, content unchanged; journal entries + snapshot copies with new ids like 07130a4e did.
3. Prove: `LEGEND_TEST_FILES="src/db/rls.test.ts src/db/outlet-rls.test.ts src/test/public-site-api.test.ts src/test/delivery-webhook-db.test.ts" heavy node scripts/test.mjs unit` migrates from zero and passes; `heavy pnpm --filter @starter/api exec tsc --noEmit` clean.
4. Commit: `merge milestone/m1 into ws/ws08-site (ws-08 migrations regenerated on top of m1 0098)`.

## M2: KDS wiring (after M1)
- `services/delivery-inject.ts` TODO at ~:377 and ~:465: call `routeFiredItemsToKitchen(tx, context, {outletId, orderId, itemIds, actor, now, onUnresolved})` from `kds.service.ts` in the same tx, the way POS/QR fire does (grep its callers). Event name must match POS/QR fire (acceptance test expects `order.placed`; check what QR fire emits on m1 and use the same).
- `services/delivery-ingest.service.ts` ~:373 and `delivery-orders.service.ts` cancel/reject path: void queued KDS lines via `cancelKitchenItemsForVoidedLines` like POS void does.
- `test/delivery-acceptance-db.test.ts`: replace the `it.todo` cases (webhook idempotency = one order + one KDS fire; sold_out via `deliverDeliveryChannelEvent` + `recordedDeliveryCalls`; payload change updates, no second order) with real tests.
- Prove: the four delivery test files + `src/test/kds*.test.ts` pass (targeted run). Do not commit; report files + results (max 30 lines).

## M2 additions (architect review, tier K — Q3-1 blocks release)
1. HIGH `delivery-ingest.service.ts:388-440` `cancelFromPlatform`: platform cancel of an injected order never voids the POS twin lines (twin stays `sent`, lines `queued`, daily-limit reservation held). Move `voidQueuedKdsLines` from `delivery-orders.service.ts:~388` into `delivery-inject.ts` (null/system actor for `voidedBy`), call it from `cancelFromPlatform` and D4 cancel, plus `cancelKitchenItemsForVoidedLines` for KDS. DB test: twin voided, lines voided, reservation released.
2. MED `delivery-ingest.service.ts:639-665`: updated payload changes gross/commission with no audit/outbox; changed lines silently dropped. Append event + audit (gross before/after); line-hash change → flag needs_review.
3. MED `delivery-inject.ts:624-637` `linkManualTwin`: voided twin → keep needs_review, skip auto-accept.
4. MED `delivery-orders.service.ts:629` + `delivery-ports.ts`: adapter call timeout (AbortSignal ~8s) and `SET LOCAL lock_timeout` in ingest.
5. LOW `delivery-orders.service.ts:665-684`: adapter throw (ambiguous) → record desync with outcome "unknown".
6. LOW hygiene: store index trigger DELETE uses `OLD.*`; `REVOKE EXECUTE ON FUNCTION app.sync_delivery_store_index() FROM PUBLIC`; replace open SELECT with SECURITY DEFINER `app.resolve_delivery_store(platform, store_id)` returning one row + REVOKE SELECT (update provision-roles/rls.test exception + comments: say "approved for review by CTO pending", consistent in both tests). These go in the regenerated custom migration.
7. Site test gaps: service-level test calling `getBrandWebsiteContent`/`saveBrandWebsiteContent` with outlet scope → `AccessError`; `public-site-api.test.ts` raw body must not contain the platform name; `outlet-rls.test.ts` allowlist comment for brand_websites must mention the `tenant_wide_only` restrictive policy and the policy test must assert `polqual` contains `outlet_scope_is_tenant`.
