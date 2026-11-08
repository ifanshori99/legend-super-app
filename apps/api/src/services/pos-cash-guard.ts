// Guards that keep POS money writes inside an open business day and an open
// cashier shift (bead legend-6c0, round 2 findings 1, 2 and 5).
//
// - A closed business day is history: `closePosDay` freezes the recap under
//   an exclusive advisory lock on (tenant, outlet, date). Every order or
//   correction write of that date takes the SAME lock in shared mode first,
//   so a write either commits before the close reads its figures or waits
//   for the close and then sees the `pos_daily_closes` row and is refused.
// - Cash goes into an open drawer: a cash tender, refund or void locks the
//   caller's open shift row FOR SHARE. `closePosShift` and
//   `recordCashMovement` lock that row FOR UPDATE, so cash taken while a
//   shift is closing waits for the close and then finds no open shift.
//
// Lock order: idempotency lock -> order row -> day lock (shared) -> shift row
// (share). The day and shift closes take no order row locks, so no cycle.

import { and, eq, inArray, sql } from "drizzle-orm";
import type { OutletId, ScopedTenantContext } from "@starter/shared/core";
import { PosError } from "@starter/shared/pos";
import { posDailyCloses, posShifts } from "../db/schema/pos-shift.ts";
import type { Tx } from "./menu-internals.ts";

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
  const tenantId = context.tenant.tenantId;
  const dates = [...new Set(input.businessDates)].sort();
  if (dates.length === 0) return;
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
  if (closed) throw new PosError("BUSINESS_DAY_ALREADY_CLOSED");
}

/**
 * Locks the cashier's open shift on the outlet FOR SHARE and returns its id;
 * refuses with SHIFT_NOT_OPEN when the cashier has no open shift there (cash
 * without a drawer, or a drawer that closed while the request waited).
 * `at` is the time the cash is recorded under; it is taken before the locks,
 * so when the shift found was opened after `at` (S1 closed and S2 opened
 * while the request waited) the cash would fall in neither shift's figures
 * and is refused with SHIFT_NOT_OPEN too.
 */
export async function lockCashierShiftForCash(
  tx: Tx,
  context: ScopedTenantContext,
  input: { outletId: OutletId; cashierId: string; at: Date },
): Promise<string> {
  const [shift] = await tx
    .select({ id: posShifts.id, openedAt: posShifts.openedAt })
    .from(posShifts)
    .where(
      and(
        eq(posShifts.tenantId, context.tenant.tenantId),
        eq(posShifts.outletId, input.outletId),
        sql`lower(${posShifts.cashierId}) = lower(${input.cashierId})`,
        eq(posShifts.status, "open"),
      ),
    )
    .limit(1)
    .for("share");
  if (!shift || input.at < shift.openedAt) throw new PosError("SHIFT_NOT_OPEN");
  return shift.id;
}
