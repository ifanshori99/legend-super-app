// Approve / reject a held cash out or drop (legend-3l4q, legend-ym2kr).
//
// A cash out or drop larger than the expected drawer cash is recorded but held
// (`needs_approval`, legend-67dt): it stays out of the drawer figures and
// posts no journal. A supervisor of the outlet decides it while the shift is
// still open:
// - approved: counts in the drawer like any other cash out / drop, exactly
//   once, and the `cash_movement.approved` event lets accounting post its
//   journal (same `aj:cash-movement:<id>` key as the recorded event, so a
//   replay never posts twice);
// - rejected: stays out of the drawer, no event, no journal.
// Nothing is paid out of a drawer that does not hold the cash: an approval
// above the expected cash is refused. The decider is never the recorder. The
// outcome row is append-only and the database trigger refuses a decision on a
// closed shift, so a closed shift's figures never move.
//
// Route: POST /pos/shifts/:shiftId/cash-movements/:movementId/decision
// (routes/pos-shift.routes.ts), guarded by the approver permission below.

import { and, eq } from "drizzle-orm";
import {
  CoreError,
  toIsoDateTime,
  uuidSchema,
  z,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { db } from "../db/index.ts";
import { cashMovementOutcomes, cashMovements } from "../db/schema/pos-shift.ts";
import { withTenant } from "../db/tenant.ts";
import { loadOutlet } from "./pos-order-support.ts";
import {
  appendShiftEvent,
  assertOutletPermission,
  auditShift,
  computeShiftAggregates,
  findShift,
  heldCorrectionCashIdrOf,
  parseShiftId,
  type ShiftCaller,
} from "./pos-shift-support.ts";

/** CTO decision (15 Nov): the shift approver decides; one constant. */
export const HELD_CASH_MOVEMENT_APPROVE_PERMISSION = "shift.cash.approve_close";

const decisionInputSchema = z.strictObject({
  decision: z.enum(["approved", "rejected"]),
});

export type HeldCashMovementDecision = {
  movementId: string;
  outcome: "approved" | "rejected";
  decidedBy: string;
  decidedAt: string;
};

const sameUser = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const movementNotFound = () =>
  new CoreError("NOT_FOUND", "Kas keluar yang ditahan tidak ditemukan.");

export async function decideHeldCashMovement(
  context: ScopedTenantContext,
  caller: ShiftCaller,
  outletId: OutletId,
  shiftId: string,
  movementId: string,
  input: { decision: "approved" | "rejected" },
): Promise<HeldCashMovementDecision> {
  const { decision } = decisionInputSchema.parse(input);
  const parsedId = uuidSchema.safeParse(movementId);
  if (!parsedId.success) throw movementNotFound();
  const id = parsedId.data;
  const tenantId = context.tenant.tenantId;
  const now = new Date();
  return withTenant(db, context, async (tx) => {
    await loadOutlet(tx, context, outletId);
    await assertOutletPermission(
      tx,
      context,
      caller.userId,
      outletId,
      HELD_CASH_MOVEMENT_APPROVE_PERMISSION,
    );
    // Movement rows are immutable (trigger), so reading before the shift lock
    // is safe; the outcome is re-read under the lock.
    const [movement] = await tx
      .select()
      .from(cashMovements)
      .where(
        and(
          eq(cashMovements.tenantId, tenantId),
          eq(cashMovements.outletId, outletId),
          eq(cashMovements.id, id),
          eq(cashMovements.shiftId, parseShiftId(shiftId)),
        ),
      );
    if (!movement || !movement.needsApproval) throw movementNotFound();
    if (sameUser(movement.recordedBy, caller.userId))
      throw new CoreError(
        "FORBIDDEN",
        "Kas keluar tidak dapat disetujui atau ditolak oleh pencatatnya.",
      );
    const shift = await findShift(tx, context, outletId, shiftId, true);
    const [existing] = await tx
      .select()
      .from(cashMovementOutcomes)
      .where(
        and(
          eq(cashMovementOutcomes.tenantId, tenantId),
          eq(cashMovementOutcomes.movementId, id),
        ),
      );
    if (existing) {
      if (
        existing.outcome === decision &&
        existing.decidedBy !== null &&
        sameUser(existing.decidedBy, caller.userId)
      )
        return {
          movementId: id,
          outcome: decision,
          decidedBy: existing.decidedBy,
          decidedAt: toIsoDateTime(existing.decidedAt),
        };
      throw new CoreError(
        "CONFLICT",
        "Kas keluar ini sudah diputuskan dengan hasil lain.",
      );
    }
    if (shift.status !== "open")
      throw new CoreError(
        "CONFLICT",
        "Shift sudah tidak terbuka; kas keluar ini tidak dapat diputuskan.",
      );
    if (decision === "approved") {
      // The held row is not in the figures yet, so this is the cash the drawer
      // holds now: approving more than that would pay out cash that is not
      // there (same formula as recordCashMovement). Cash of a held refund or
      // void has already left the drawer though the figures leave it out, so
      // it is taken off too: the physical cash is what bounds the approval.
      const live = await computeShiftAggregates(tx, shift);
      const expected =
        Number(shift.openingFloatIdr) +
        live.cashSalesIdr -
        live.cashRefundsIdr +
        live.cashInIdr -
        live.cashOutIdr -
        live.cashDropIdr;
      const physical = expected - (await heldCorrectionCashIdrOf(tx, shift));
      if (movement.amountIdr > physical)
        throw new CoreError(
          "CONFLICT",
          "Jumlah kas keluar melebihi kas yang tersedia di laci saat ini.",
        );
    }
    const [row] = await tx
      .insert(cashMovementOutcomes)
      .values({
        tenantId,
        outletId,
        shiftId: shift.id,
        movementId: id,
        outcome: decision,
        decidedBy: caller.userId,
        decidedAt: now,
      })
      .returning();
    if (!row) throw new Error("Cash movement outcome insert returned no row");
    if (decision === "approved")
      await appendShiftEvent(tx, context, "cash_movement.approved", {
        aggregateId: id,
        outletId,
        payload: {
          movementId: id,
          shiftId: shift.id,
          outletId,
          deviceId: shift.deviceId,
          type: movement.type,
          amountIdr: movement.amountIdr,
          reasonNote: movement.reasonNote,
          recordedBy: movement.recordedBy,
          recordedAt: toIsoDateTime(movement.recordedAt),
          approvedBy: caller.userId,
          approvedAt: toIsoDateTime(now),
        },
        caller,
        now,
      });
    await auditShift(
      tx,
      context,
      {
        action:
          decision === "approved"
            ? "pos_shift.cash_movement_approved"
            : "pos_shift.cash_movement_rejected",
        outletId,
        objectType: "cash_movement",
        objectId: id,
        caller,
        before: null,
        after: {
          id,
          shiftId: shift.id,
          type: movement.type,
          amountIdr: movement.amountIdr,
          outcome: decision,
        },
        reason: null,
      },
      now,
    );
    return {
      movementId: id,
      outcome: decision,
      decidedBy: caller.userId,
      decidedAt: toIsoDateTime(row.decidedAt),
    };
  });
}
