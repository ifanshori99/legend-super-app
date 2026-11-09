# Sub-brief: HPP POS → stock movements (legend-9w46, tier K)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/hpp-pos`, branch `ws/hpp-pos` (m1 + merged ws/recipe-bom). Do not switch branch, do not commit (engineer commits).

## Context (already done by engineer)

- ws/recipe-bom (legend-db6) merged in: `apps/api/src/services/recipe-deduction.service.ts` consumes `order.paid` → `recordRecipeDeduction` (key `sale:order:<orderId>`) → real_time posts ledger rows `movementType sale / sourceType order / sourceId orderId`, close_of_day leaves `pending` until `day.closed`. Worker wiring in `apps/api/src/worker-main.ts` (`deliverRecipeDeductionEvent`).
- GL bridge on m1: `apps/api/src/services/inventory-gl-consumer.ts` maps `order` + `sale`/`return` → `stock.deducted` (Dr cogs / Cr inventory; negative amount flips sides). Each ledger row emits `stock.moved` (outbox) → `deliverInventoryGlEvent`.
- Schema already extended (`apps/api/src/db/schema/recipe.ts`, migration `0101_recipe_bom.sql`): `recipe_deductions.status` adds `'reversed'`; new columns `reversed_at`, `reversal_reason ('void'|'refund')`, `reversal_source_id` (text); CHECK `recipe_deductions_reversed_check`: status='reversed' ⇔ all three non-null. `posted_at` stays set when a posted deduction is reversed. Shared contract `packages/shared/src/inventory/recipe-bom.ts`: `recipeDeductionReversalReasonSchema`, `recipeDeductionSchema` gains `reversedAt`, `reversalReason` (nullable).

## Rules for reversal (the feature)

Events (payloads in `packages/shared/src/pos/events.ts`):

- `order.voided` with `voidedFinalOrder: true` and `voidId` (emitted by `voidPosOrderCorrection`, `services/pos-order-corrections.ts`) → reverse, reason `void`, sourceId = voidId. `voidedFinalOrder: false` (pre-payment void) → nothing.
- `order.refunded` (`refundId`, `amountIdr`) → reverse, reason `refund`, sourceId = refundId, ONLY when the order is now fully refunded (sum of `pos_order_refunds` amounts for the order ≥ the order's paid total; read inside the tx). Partial refund → no stock change (money-only; no line data to map).
  Reversal of the `sale` deduction of that order (key `sale:order:<orderId>`), row locked `FOR UPDATE`:
- `posted` → one ledger row per deduction line: `movementType 'return'`, `sourceType 'order'`, `sourceId` = same as the sale (the order id), `quantity` = +line.quantity, `unitCostIdr` = the line's stored `unit_cost_idr` (NOT the current average), `locationId` = line's, idempotency key `recipe-reversal:<deductionId>:<inventoryItemId>`, occurredAt = the void/refund time. Then set status `reversed` + reversed_at/reason/source_id.
- `pending` (close_of_day, not yet posted) → set `reversed` without ledger rows; `postRecipeDeduction`/`postPendingDeductions` must never post a reversed row (status guard already returns non-pending unchanged; keep it).
- `skipped` → nothing. Already `reversed` → no-op (second void, void then refund, replay).
- No sale deduction yet (reversal consumed before order.paid) → insert tombstone row: kind `sale`, status `reversed`, sourceType `order`, sourceId orderId, key `sale:order:<orderId>`, no lines, costIdr null, mode from config, onConflictDoNothing on (tenant, key); if conflict, re-run the locked path. A later `order.paid` then finds the key and draws nothing.
- remake/comp (`order_issue`) and duty_meal deductions are never reversed.
- Never throw for business gaps inside the consumer (would block the aggregate); malformed payload → return.

## Invariants

- Idempotent per event: edge may resend `order.paid`/`order.voided`/`order.refunded`; one reversal per order max; ledger keys unique.
- Journal value = value actually posted: return row value = original line qty × original unit cost → GL journal exactly offsets the HPP journal.
- No negative amounts in journals (GL consumer already flips sides).
- Fiscal period lock: handled by existing GL consumer (parks); do not add new paths.
- Do not touch: `pos-order.service.ts`, `payment-refund.service.ts`, DOIT/EDC files (`services/payment-doit*`, `edge/edc/*`, `posEdcTenderPort`).

## Pieces (files do not overlap)

- P1 implementer: `apps/api/src/services/recipe-deduction.service.ts` only (+ `toDeduction` mapping of new fields, `RECIPE_DEDUCTION_EVENT_NAMES` add `order.voided`, `order.refunded`; new exported `reverseOrderSaleDeduction(tx, context, { outletId, orderId, reason, reversalSourceId, occurredAt })`). If `apps/api/src/services/inventory.service.ts` refuses an inbound `return/order` with explicit cost, report — do not change it without asking.
- P2 test-writer: new file `apps/api/src/test/recipe-pos-hpp.test.ts` (copy fixture style from `apps/api/src/test/recipe-bom.test.ts` and `apps/api/src/test/inventory-gl.test.ts`). Cases: (a) paid order → sale/order ledger rows −qty → deliver stock.moved → GL journal Dr cogs / Cr inventory = cost; (b) order.paid delivered twice → one deduction, one ledger set, one journal; (c) final void → return/order rows +qty at ORIGINAL cost even after a receipt changed the average; GL reversal journal Dr inventory / Cr cogs equal to the HPP journal; replay void → no-op; then full refund → no-op; (d) partial refund → no stock change; full refund (cumulative) → reversal; (e) close_of_day: void before day close → status reversed, day.closed posts nothing; (f) void consumed before order.paid → tombstone, later order.paid draws nothing; (g) pre-payment void (`voidedFinalOrder:false`) → nothing; (h) remake deduction untouched by void. Use synthetic event envelopes through `deliverRecipeDeductionEvent` where driving real POS is heavy, but at least (a) should go through the real POS complete path if a helper exists.
- Run tests: from worktree root `LEGEND_TEST_FILES="src/test/recipe-pos-hpp.test.ts" pnpm test` (needs Docker/Colima; start with `~/.claude/scripts/colima-up` if down). Never kill other sessions' processes.

## Done

- P1: `pnpm --filter @starter/api exec tsc --noEmit -p .` clean for touched files (run via `heavy`).
- P2: test file compiles; report which cases pass/fail against P1.

## Round 2 (review fixes)

Schema now has `recipe_deductions.reversal_failed_at` (migration 0103). CHECKs: status='reversed' ⇔ reversed_at set; (reversed_at OR reversal_failed_at set) ⇔ reason AND source set; reversal_failed_at only while status='posted'.

- P3 implementer (`recipe-deduction.service.ts` only): in `reverseSafely` catch (HttpError/InventoryError), after the savepoint rolled back, update the posted sale row (key `sale:order:<orderId>`, status still 'posted', not yet failed) setting reversal_failed_at=now, reversal_reason, reversal_source_id (keep first values if already failed) + logger.warn. Successful reversal clears reversal_failed_at. On `day.closed` (consumer branch, after postPendingDeductions) retry parked reversals of that outlet (status posted AND reversal_failed_at NOT NULL), each in its own savepoint via reverseOrderSaleDeduction with stored reason/source and occurredAt = the stored failure's original event time is not stored, so use reversal_failed_at; a retry that fails again only bumps reversal_failed_at. Map `reversalFailedAt` is NOT exposed in shared DTO (internal). Keep typecheck clean.
- P4 test-writer (`apps/api/src/test/recipe-pos-hpp.test.ts` only): add case (i): void whose return is refused (e.g. make the sale location/item unavailable so recordStockMovementInTransaction throws an HttpError/InventoryError) → deduction stays posted with reversal_failed_at + reason/source set, no return rows; fix the cause, deliver day.closed → return rows posted at original cost, status reversed, reversal_failed_at null. Also tighten (c): assert reversal journal lines exactly equal the HPP journal amounts swapped.
