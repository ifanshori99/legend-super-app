// Guards that keep POS money writes inside an open business day and an open
// cashier shift (bead legend-6c0, round 2 findings 1, 2 and 5).
//
// - A closed business day is history: `closePosDay` freezes the recap under
//   an exclusive advisory lock on (tenant, outlet, date). Every order or
//   correction write of that date takes the SAME lock in shared mode first,
//   so a write either commits before the close reads its figures or waits
//   for the close and then sees the `pos_daily_closes` row and is refused.
// - Cash goes into an open drawer of the device it is taken on: a cash
//   tender locks the caller's open shift on that device FOR SHARE; a cash
//   refund or void locks it FOR UPDATE; whether it is more than the drawer
//   should hold is decided by `cashOutExceedsDrawer`, which never refuses.
//   `closePosShift` and `recordCashMovement` lock that row FOR UPDATE, so
//   cash taken while a shift is closing waits for the close and then finds
//   no open shift.
//
// Lock order: idempotency lock -> order row -> day lock (shared) -> shift row
// (share). The day and shift closes take no order row locks, so no cycle.
// The QRIS webhook capture (`handlePosPaymentPaid`, legend-mf0.1) follows
// orders row -> pos_orders row -> tender row -> day lock (shared), through
// `isBusinessDayClosed`; it decides instead of throwing.

import { and, eq, inArray, sql } from "drizzle-orm";
import type { OutletId, ScopedTenantContext } from "@starter/shared/core";
import { PosError } from "@starter/shared/pos";
import { posDailyCloses, posShifts } from "../db/schema/pos-shift.ts";
import type { Tx } from "./menu-internals.ts";
import {
  heldCorrectionCashIdrOf,
  liveExpectedCashIdr,
  type ShiftRow,
} from "./pos-shift-support.ts";

/**
 * Takes the day locks (shared) for `businessDates` and returns whether any of
 * them is closed for the outlet. The locks are held until the transaction
 * ends, so the day cannot close underneath the caller's write. Callers that
 * must not throw (an outbox consumer) decide on the result.
 */
export async function isBusinessDayClosed(
  tx: Tx,
  context: ScopedTenantContext,
  input: { outletId: OutletId; businessDates: readonly string[] },
): Promise<boolean> {
  const tenantId = context.tenant.tenantId;
  const dates = [...new Set(input.businessDates)].sort();
  if (dates.length === 0) return false;
  // Same key and hash as closePosDay's exclusive lock (pos-day.service.ts).
  for (const date of dates)
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock_shared(hashtext(${`pos-day:${tenantId}:${input.outletId}:${date}`}))`,
    );
  const [closed] = await tx
    .select({ id: posDailyCloses.id })
    .from(posDailyCloses)
    .where(
      and(
        eq(posDailyCloses.tenantId, tenantId),
        eq(posDailyCloses.outletId, input.outletId),
        inArray(posDailyCloses.businessDate, dates),
      ),
    )
    .limit(1);
  return Boolean(closed);
}

/**
 * Refuses with BUSINESS_DAY_ALREADY_CLOSED when any of `businessDates` is
 * closed for the outlet; otherwise holds the day locks (shared) until the
 * transaction ends, so the day cannot close underneath the caller's write.
 */
export async function assertBusinessDayOpen(
  tx: Tx,
  context: ScopedTenantContext,
  input: { outletId: OutletId; businessDates: readonly string[] },
): Promise<void> {
  if (await isBusinessDayClosed(tx, context, input))
    throw new PosError("BUSINESS_DAY_ALREADY_CLOSED");
}

/**
 * Locks the cashier's open shift ON THIS DEVICE and returns its row; refuses
 * with SHIFT_NOT_OPEN when the request has no verified device, or the cashier
 * has no open shift on that device (cash without a drawer, cash through
 * another device's till, or a drawer that closed while the request waited).
 * Cash goes into the drawer of the device it was taken on.
 * - `mode "in"` (a cash tender) locks FOR SHARE.
 * - `mode "out"` (a cash refund or void) locks FOR UPDATE. It never refuses
 *   on the drawer: a refusal would let the cashier probe the expected cash
 *   (legend-utqr). The caller holds a too-large cash out for supervisor review
 *   (`cashOutExceedsDrawer`, valid only under this lock).
 * `at` is the time the cash is recorded under; it is taken before the locks,
 * so when the shift found was opened after `at` (S1 closed and S2 opened
 * while the request waited) the cash would fall in neither shift's figures
 * and is refused with SHIFT_NOT_OPEN too.
 */
export async function lockCashierShiftForCash(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    outletId: OutletId;
    cashierId: string;
    deviceId: string | null;
    mode: "in" | "out";
    at: Date;
  },
): Promise<ShiftRow> {
  if (input.deviceId === null) throw new PosError("SHIFT_NOT_OPEN");
  const query = tx
    .select()
    .from(posShifts)
    .where(
      and(
        eq(posShifts.tenantId, context.tenant.tenantId),
        eq(posShifts.outletId, input.outletId),
        sql`lower(${posShifts.cashierId}) = lower(${input.cashierId})`,
        eq(posShifts.deviceId, input.deviceId),
        eq(posShifts.status, "open"),
      ),
    )
    .limit(1);
  const [shift] =
    input.mode === "out" ? await query.for("update") : await query.for("share");
  if (!shift || input.at < shift.openedAt) throw new PosError("SHIFT_NOT_OPEN");
  return shift;
}

/**
 * True when `cashOutIdr` is more than the drawer should hold now: the live
 * expected cash minus the cash of the shift's other held refunds and voids.
 * Call it only
 * under the FOR UPDATE shift lock of `lockCashierShiftForCash` (`out` mode), so
 * no other cash movement changes the figures between the check and the write.
 * The answer must never reach the cashier (legend-utqr).
 */
export async function cashOutExceedsDrawer(
  tx: Tx,
  shift: ShiftRow,
  cashOutIdr: number,
): Promise<boolean> {
  // Cash of the shift's other held refunds and voids already left the drawer
  // (the cashier paid it), so only the physical cash can cover this one.
  const expected = await liveExpectedCashIdr(tx, shift);
  return cashOutIdr > expected - (await heldCorrectionCashIdrOf(tx, shift));
}
