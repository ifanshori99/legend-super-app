// Edge side of the return from a failover window (1271 F4; docs/briefs/
// 1271-edge-failover-cards.md D2). The window-closing event lists one
// switchover count C1 per device. The edge closes the device's interrupted
// edge shift with that count, in the link's receive transaction, through the
// normal close (writeClose): count row, closing UPDATE, `cashier_shift.closed`
// with the E3 close detail, audit. The variance C1 - expected stays with the
// edge shift; the cloud's failover shift opened with float C1, and the next
// edge shift opens with the failover shift's count C2. Every rupiah sits in
// exactly one shift; no bridge cash movement.
//
// Never guesses (D2): a shift with any sale, cash row, count or opening after
// the switchover count time ran on the edge while the cloud sold (split
// brain), and a shift no manager of the window can approve cannot be closed.
// Both are returned as refusals and NOTHING is written: the caller keeps the
// window copy open (edge POS stays blocked) and alerts the managers.
//
// Replay: the close key is `failover:<window id>`; a device whose shift is
// already closed with it is skipped, so a redelivered event closes nothing
// twice.
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  CoreError,
  toIsoDateTime,
  uuidToUlid,
  type Idr,
  type OutletId,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import type {
  FailoverEdgeRefusedPayload,
  FailoverSwitchoverShift,
} from "@starter/shared/edge";
import {
  blindCountTotalIdr,
  closeShift,
  posShiftIdSchema,
  shiftExpectedCashIdr,
  type PosShiftWithFigures,
} from "@starter/shared/pos";
import { user } from "../db/schema/user.ts";
import { posShiftCounts, posShifts } from "../db/schema/pos-shift.ts";
import type { Tx } from "./permission-resolver.ts";
import { writeClose, type CloseApproval } from "./pos-shift.service.ts";
import {
  cashWatermarkOf,
  computeShiftAggregates,
  heldCashOutIdrOf,
  heldCorrectionCashIdrOf,
  shiftFiguresDto,
  type ShiftCaller,
  type ShiftRow,
} from "./pos-shift-support.ts";

export type FailoverCloseRefusal = FailoverEdgeRefusedPayload["shifts"][number];

/** Stored on the closed edge shift (the drawer moved to the cloud). */
export const FAILOVER_CLOSE_NOTE =
  "Ditutup otomatis saat kembali dari mode cloud: laci dihitung saat pindah ke mode cloud.";

export const failoverCloseKey = (windowId: string): string =>
  `failover:${windowId}`;

function hashUuid(text: string): string {
  const hex = createHash("sha256").update(text).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** True when the shift moved on the edge after the switchover count. */
async function activityAfter(
  tx: Tx,
  shift: ShiftRow,
  countedAt: Date,
): Promise<boolean> {
  const at = countedAt.toISOString();
  const result = await tx.execute(
    sql`SELECT (
      ${shift.openedAt.toISOString()}::timestamptz > ${at}::timestamptz
      OR EXISTS (SELECT 1 FROM pos_orders o WHERE o.tenant_id = ${shift.tenantId}::uuid AND o.shift_id = ${shift.id}::uuid
        AND (o.created_at > ${at}::timestamptz OR o.submitted_at > ${at}::timestamptz OR o.completed_at > ${at}::timestamptz))
      OR EXISTS (SELECT 1 FROM pos_order_tenders t WHERE t.tenant_id = ${shift.tenantId}::uuid AND t.shift_id = ${shift.id}::uuid
        AND (t.created_at > ${at}::timestamptz OR t.requested_at > ${at}::timestamptz OR t.resolved_at > ${at}::timestamptz))
      OR EXISTS (SELECT 1 FROM pos_order_refunds r WHERE r.tenant_id = ${shift.tenantId}::uuid AND r.shift_id = ${shift.id}::uuid
        AND (r.created_at > ${at}::timestamptz OR r.refunded_at > ${at}::timestamptz))
      OR EXISTS (SELECT 1 FROM pos_order_voids v WHERE v.tenant_id = ${shift.tenantId}::uuid AND v.shift_id = ${shift.id}::uuid
        AND (v.created_at > ${at}::timestamptz OR v.voided_at > ${at}::timestamptz))
      OR EXISTS (SELECT 1 FROM cash_movements m WHERE m.tenant_id = ${shift.tenantId}::uuid AND m.shift_id = ${shift.id}::uuid
        AND m.recorded_at > ${at}::timestamptz)
      OR EXISTS (SELECT 1 FROM cash_movement_outcomes d WHERE d.tenant_id = ${shift.tenantId}::uuid AND d.shift_id = ${shift.id}::uuid
        AND d.decided_at > ${at}::timestamptz)
      OR EXISTS (SELECT 1 FROM pos_shift_counts c WHERE c.tenant_id = ${shift.tenantId}::uuid AND c.shift_id = ${shift.id}::uuid
        AND c.submitted_at > ${at}::timestamptz)
    ) AS moved`,
  );
  return result.rows[0]?.moved === true;
}

/** Users of `ids` the edge's people snapshot holds (lower-cased). */
async function knownUsers(tx: Tx, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await tx
    .select({ id: user.id })
    .from(user)
    .where(inArray(user.id, ids));
  return new Set(rows.map((row) => row.id.toLowerCase()));
}

type Plan = {
  shift: ShiftRow;
  count: FailoverSwitchoverShift;
  approver: string;
  submittedBy: string;
};

/**
 * Closes the interrupted edge shift of every listed device with its
 * switchover count, or returns the refusals and writes nothing.
 * `managers`: who may approve, in order (activating manager first).
 */
export async function closeShiftsForFailoverReturn(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    outletId: OutletId;
    windowId: string;
    /** uuid of the window-closing event. */
    closingEventId: string;
    managers: readonly string[];
    shifts: readonly FailoverSwitchoverShift[];
    now: Date;
  },
): Promise<{ closedShiftIds: string[]; refused: FailoverCloseRefusal[] }> {
  const tenantId = context.tenant.tenantId;
  const closeKey = failoverCloseKey(input.windowId);
  const known = await knownUsers(tx, [
    ...input.managers,
    ...input.shifts.map((count) => count.cashierId),
  ]);
  const plans: Plan[] = [];
  const refused: FailoverCloseRefusal[] = [];
  for (const count of input.shifts) {
    // The device's edge shift (never a cloud failover shift). Locked like
    // every close; at most one is open per device.
    const [open] = await tx
      .select()
      .from(posShifts)
      .where(
        and(
          eq(posShifts.tenantId, tenantId),
          eq(posShifts.outletId, input.outletId),
          eq(posShifts.deviceId, count.deviceId),
          eq(posShifts.status, "open"),
          isNull(posShifts.failoverWindowId),
        ),
      )
      .orderBy(desc(posShifts.openedAt))
      .limit(1)
      .for("update");
    // No open shift: already closed by this window (replay) or the device
    // had none at the outage. Nothing to close either way.
    if (!open) continue;
    if (await activityAfter(tx, open, new Date(count.countedAt))) {
      refused.push({
        deviceId: count.deviceId,
        shiftId: posShiftIdSchema.parse(open.id),
        reason: "shift_activity",
      });
      continue;
    }
    const approver = input.managers.find(
      (id) => known.has(id.toLowerCase()) && !same(id, open.cashierId),
    );
    if (approver === undefined) {
      refused.push({
        deviceId: count.deviceId,
        shiftId: posShiftIdSchema.parse(open.id),
        reason: "no_approver",
      });
      continue;
    }
    // Whoever counted in the cloud submits the count; unknown here = the
    // approver (a forced count, U9).
    const submittedBy = known.has(count.cashierId.toLowerCase())
      ? count.cashierId
      : approver;
    plans.push({ shift: open, count, approver, submittedBy });
  }
  if (refused.length > 0) return { closedShiftIds: [], refused };

  const closedShiftIds: string[] = [];
  for (const plan of plans) {
    await closeOne(tx, context, input, plan, closeKey);
    closedShiftIds.push(plan.shift.id);
  }
  return { closedShiftIds, refused: [] };
}

async function closeOne(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    outletId: OutletId;
    windowId: string;
    closingEventId: string;
    now: Date;
  },
  plan: Plan,
  closeKey: string,
): Promise<void> {
  const { shift, count, approver, submittedBy } = plan;
  const tenantId = context.tenant.tenantId;
  const now = input.now;
  const counts = count.counts.map((line) => ({
    denominationIdr: line.denominationIdr,
    quantity: line.quantity,
  }));
  const countedIdr = Number(blindCountTotalIdr(counts));
  if (countedIdr !== count.totalIdr)
    throw new CoreError("VALIDATION_ERROR", "Switchover count total differs");
  const aggregates = await computeShiftAggregates(tx, shift);
  const figures = shiftFiguresDto(shift, aggregates);
  let expectedIdr: number;
  try {
    expectedIdr = Number(shiftExpectedCashIdr(figures));
  } catch (error) {
    if (error instanceof RangeError)
      throw new CoreError("CONFLICT", error.message);
    throw error;
  }
  const heldCashOutIdr = await heldCashOutIdrOf(tx, shift);
  const heldCorrectionIdr = await heldCorrectionCashIdrOf(tx, shift);
  const cashWatermark = await cashWatermarkOf(tx, shift);
  const [last] = await tx
    .select({ sequence: posShiftCounts.sequence })
    .from(posShiftCounts)
    .where(
      and(
        eq(posShiftCounts.tenantId, tenantId),
        eq(posShiftCounts.shiftId, shift.id),
      ),
    )
    .orderBy(desc(posShiftCounts.sequence))
    .limit(1);
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        op: "shift.failover_close",
        windowId: input.windowId,
        shiftId: shift.id,
        counts,
      }),
    )
    .digest("hex");
  const [countRow] = await tx
    .insert(posShiftCounts)
    .values({
      tenantId,
      outletId: input.outletId,
      shiftId: shift.id,
      sequence: (last?.sequence ?? 0) + 1,
      counts,
      countsFingerprint: createHash("sha256")
        .update(
          JSON.stringify(
            [...counts]
              .map((line) => [line.denominationIdr, line.quantity] as const)
              .sort((a, b) => b[0] - a[0]),
          ),
        )
        .digest("hex"),
      countedIdr: countedIdr as Idr,
      expectedIdr: expectedIdr as Idr,
      varianceIdr: (countedIdr - expectedIdr) as Idr,
      heldCashOutIdr: heldCashOutIdr as Idr,
      heldCorrectionIdr: heldCorrectionIdr as Idr,
      cashWatermark,
      submittedBy,
      submittedAt: new Date(count.countedAt),
      forced: !same(submittedBy, shift.cashierId),
      idempotencyKey: closeKey,
      requestFingerprint: fingerprint,
    })
    .returning();
  if (!countRow) throw new Error("pos_shift_counts insert returned no row");
  // The window is the approval: the activating manager approves, the
  // closing event is the request. One approval id per window and shift.
  const approval: CloseApproval = {
    id: uuidToUlid(hashUuid(`failover-close:${input.windowId}:${shift.id}`)),
    approvedBy: approver,
    approvalRequestId: input.closingEventId,
    resolvedAt: now,
    createdAt: now,
  };
  let closed: PosShiftWithFigures;
  try {
    closed = closeShift(figures, {
      counts,
      countId: countRow.id,
      heldCashOutIdr: heldCorrectionIdr,
      varianceNote: FAILOVER_CLOSE_NOTE,
      approvedBy: approver,
      approvalRequestId: input.closingEventId,
      approvedAt: toIsoDateTime(now),
      closedAt: toIsoDateTime(now),
    });
  } catch (error) {
    if (error instanceof RangeError)
      throw new CoreError("CONFLICT", error.message);
    throw error;
  }
  const caller: ShiftCaller = { userId: approver as UserId, deviceId: null };
  await writeClose(tx, context, caller, {
    outletId: input.outletId,
    shift,
    aggregates,
    count: countRow,
    closed,
    heldCorrectionIdr,
    override: approval,
    idempotencyKey: closeKey,
    fingerprint,
    now,
    auditAction: "pos_shift.failover_closed",
  });
}
