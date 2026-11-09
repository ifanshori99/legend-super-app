# Sub-brief: ws/pos-shift review-K fixes (legend-6c0)

Worktree: `legend/.worktrees/pos-shift` (branch `ws/pos-shift`, main already merged at c87fb5e).
Do NOT read `.env*`. Do NOT `pkill`/`killall`. Do NOT generate drizzle migrations (the engineer does that once at the end). Do NOT commit.
Edit ONLY the files listed for your slice. Add regression tests in the listed test files.
Run only your own test files: `LEGEND_TEST_FILES="src/test/<file>.test.ts" heavy pnpm test` from the worktree root (disposable PostgreSQL; needs Colima: `~/.claude/scripts/colima-up`). Typecheck: `pnpm --filter @starter/api exec tsc --noEmit -p .`. Report what you ran.

Shared column names (fixed contract between slices):

- `pos_order_tenders.shift_id`, `pos_order_refunds.shift_id`, `pos_order_voids.shift_id`: `uuid`, nullable, composite FK `(tenant_id, shift_id)` -> `pos_shifts(tenant_id, id)` (drizzle: `shiftId`). Slice A.
- `pos_shift_counts.forced`: `boolean NOT NULL DEFAULT false` (drizzle: `forced`). Slice C adds it; slice B uses it.

## Slice A — cash per device/drawer (review 1, architect 2) + refund/void drawer check (review 2)

Files: `apps/api/src/services/pos-cash-guard.ts`, `apps/api/src/routes/pos-order.routes.ts`, new `apps/api/src/routes/device-id.ts`, `apps/api/src/services/pos-order-payment.ts`, `apps/api/src/services/pos-order-corrections.ts`, `apps/api/src/db/schema/pos-order.ts`, `apps/api/src/services/pos-shift-support.ts` (only `computeShiftAggregates` and a new helper), tests `apps/api/src/test/pos-cash-guard.test.ts`, `apps/api/src/test/pos-order.test.ts`.

1. Move `deviceIdOf` (signed `X-Device-Token`, tenant must match; see `routes/pos-shift.routes.ts:106`) into `routes/device-id.ts` and use it in `pos-order.routes.ts` `caller()` (now `deviceId: null`). Leave `pos-shift.routes.ts` untouched (engineer dedupes).
2. `lockCashierShiftForCash`: input gains `deviceId: string | null` and `mode: "in" | "out"`. `deviceId === null` -> `SHIFT_NOT_OPEN`. Filter also `posShifts.deviceId = deviceId`. `mode "in"` (tender) locks FOR SHARE; `"out"` (refund, void) locks FOR UPDATE. Return `{ id, ...shift row needed by aggregates }`.
3. Store the returned shift id in `shift_id` on cash tender insert (payment), cash refund insert and void insert (corrections). Non-cash rows keep null.
4. `computeShiftAggregates`: cash sales/refunds/voids by `shift_id = shift.id` (drop cashier + time window filters). Keep movements as is.
5. Refund/void with cash out (mode "out"): inside the lock, compute expected drawer cash (opening + sales − refunds + in − out − drop, same formula as `pos-shift.service.ts:518-525`; add a helper `liveExpectedCashIdr(tx, shift, now)` in support) and if cash out > expected throw `CoreError("CONFLICT", "Tunai di laci tidak cukup untuk transaksi ini. Minta bantuan supervisor.")` before any insert. Message must not reveal the expected amount.
6. Check every other tender/refund/void insert in payment/corrections/pos-order.service for a cash path that skips the guard.
   Tests: cash tender without device token -> 409 SHIFT_NOT_OPEN; same cashier, shift on device A, cash via device B -> SHIFT_NOT_OPEN; aggregates count only that shift's rows; refund/void cash larger than drawer -> 409 and nothing inserted, shift still closable (count + close OK). Update existing cash tests to send the device header.

## Slice B — pos-shift.service fixes (review 3, 4; architect 3, 4, 6)

Files: `apps/api/src/services/pos-shift.service.ts`, `apps/api/src/services/pos-day.service.ts` (only if needed), `apps/api/src/routes/pos-shift.routes.ts`, `packages/shared/src/pos/schemas.ts`, `packages/shared/src/pos/endpoints.ts`, `packages/shared/src/pos/errors.ts`, `tests/pos-contract.test.mjs`, test `apps/api/src/test/pos-shift.test.ts`.

1. PIN approval storage (`:886`, `:1172`, `:1221` area): store `approvalRequestId: override.approvalRequestId ?? ulidToUuid(override.id)` (the verified override's id, never the raw client value).
2. Cash out/drop over drawer (`:517-531`): message generic `"Kas keluar ini perlu persetujuan supervisor."` (no mention of drawer amount), and write an audit row (`auditShift`, action `pos_shift.cash_movement_refused`, fields: type, amountIdr, no expected figure) in a way that survives the refusal (separate tx/after rollback, follow existing audit patterns).
3. `"Selisih sebesar ini butuh persetujuan berjenjang..."` (`:1004-1008`): generic `"Penutupan shift ini perlu persetujuan supervisor lewat ponsel."` — must not depend on variance size wording.
4. Count limit: max 3 counts per shift by the cashier (non-forced). 4th -> new PosError `SHIFT_COUNT_LIMIT` (409, "Batas hitung ulang tercapai. Minta supervisor menutup shift.") in shared errors.
5. Force close (U9): new endpoint `POST /outlets/:outletId/pos/shifts/:shiftId/force-close`, permission `shift.cash.approve_close`, caller ≠ shift cashier. Body: `countedIdr`, denominations/counts like the count input, `note` (required, min 10), `approvedBy` (witness: ≠ caller, ≠ cashier, holds `shift.cash.approve_close`), `approvalRequestId` (witness PIN override, verified like `verifyCloseApproval` with valueIdr = variance), `idempotencyKey`. In one tx: lock shift FOR UPDATE, insert count with `forced: true, submittedBy: caller`, close the shift with that count (closed_by = caller, note = body note), event `shift.force_closed`, audit `pos_shift.force_closed`. Idempotent replay like close. Response = same as close. Add contract entry in endpoints.ts + schema in schemas.ts + contract test.
   Tests: each item above, incl. force close lets Tutup Hari proceed.

## Slice C — DB integrity (architect 5) + forced count column

Files: `apps/api/src/db/schema/pos-shift.ts`, `apps/api/src/db/schema/pos-shift.custom.sql`, test `apps/api/src/test/pos-shift-db.test.ts` (new) or a new describe in an existing db test.

1. `pos_shifts.count_id`: composite FK `(tenant_id, count_id)` -> `pos_shift_counts(tenant_id, id)`. Watch the circular reference (counts -> shifts already); use `foreignKey()` with a lazy column reference.
2. `pos_shifts_open_check`: also require `count_id IS NULL` when open.
3. Trigger in custom.sql (extend `app.pos_shifts_guard` or new): on transition to closed, the count row must have `shift_id = NEW.id` and `counted_idr = NEW.counted_idr`.
4. `pos_shift_counts.forced boolean NOT NULL DEFAULT false`; in `app.pos_shift_counts_guard`: non-forced -> submitted_by must be the shift cashier (as today); forced -> submitted_by must differ from the shift cashier.
   Tests: raw SQL inserts/updates violating each rule fail.
