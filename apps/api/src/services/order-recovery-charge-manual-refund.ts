// Manual refund of a PAID dearer-swap charge taken at the till (legend-mrwtp,
// brief 985): cash or an EDC card, so there is no payment intent and the nsvu0
// intent refund cannot return it. Two steps, two people.
//
// - Request (`order.recovery.handle` on the charge's outlet): files a
//   `requested` row that RESERVES its amount against the charge. Only a `paid`
//   charge without an intent; the method must match how the guest paid (cash:
//   it has the cash_in movement; EDC: an approved EDC sale of the charge, no
//   cash). A charge whose way of paying cannot be proven is a 409. The amount
//   may not pass what is left: charge amount less the requested + completed
//   manual refunds.
// - Approve (`pos.refund.approve` on the outlet, never the requester:
//   409 APPROVER_IS_REQUESTER): cash needs the shift the money leaves from
//   (`shiftId`). The shift is locked FOR UPDATE, must be open at the charge's
//   outlet and must hold the cash (`cashOutExceedsDrawer`, 409): a `cash_out`
//   movement (key `manual-charge-refund:<id>`) goes on it. EDC pays nothing
//   here: the money went back on the machine, the bank reference is recorded.
//   Both append `order_issue.charge_refunded` (pos_cash with refundId = the
//   cash_out, or edc_manual with refundId = the row) for the reversal journal.
//   The cash_out itself is not journalled by `cash_movement.recorded` (no
//   such event is appended), like the cash return of a voided order.
// - Reject (the requester, or someone with `pos.refund.approve`): only from
//   `requested`; frees the reservation.
// - Race-free without a counter column: every step runs under the charge row
//   lock (`lockChargeChain`: issue, order, charge), and approve then locks the
//   shift (the void's order is order, charge, shift). The row itself is locked
//   FOR UPDATE after the chain, so two approvals of one refund pay once.
// - The charge status is not changed here; voiding the order gives back what
//   is left (order-recovery-charge-void.ts reads the same sums).

import { and, eq } from "drizzle-orm";
import { AccessError } from "@starter/shared/access";
import {
  assertOutletInScope,
  CoreError,
  idr,
  outletIdSchema,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import { db } from "../db/index.ts";
import { edcTransactions } from "../db/schema/edc.ts";
import {
  orderIssueChargeManualRefunds,
  orderIssueCharges,
} from "../db/schema/kds-issues.ts";
import { cashMovements, posShifts } from "../db/schema/pos-shift.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { auditCharge, lockChargeChain } from "./order-recovery-charge.ts";
import { appendChargeRefundedEvent } from "./order-recovery-charge-refund.ts";
import { manualRefundedOfCharge } from "./order-charge-manual-refund-sum.ts";
import { recoveryChargeRefundSplit } from "./order-recovery-refund-amount.ts";
import { accessSnapshotInTransaction } from "./permission-resolver.ts";
import type { Tx } from "./permission-resolver.ts";
import { cashOutExceedsDrawer } from "./pos-cash-guard.ts";
import {
  assertShiftOutflowBound,
  auditShift,
  shiftFingerprint,
  uniqueViolationOf,
  type ShiftCaller,
} from "./pos-shift-support.ts";

const HANDLE = "order.recovery.handle";
const APPROVE = "pos.refund.approve";
const AUDIT_REQUESTED = "order_issue.charge_manual_refund_requested";
const AUDIT_COMPLETED = "order_issue.charge_manual_refund_completed";
const AUDIT_REJECTED = "order_issue.charge_manual_refund_rejected";
const EDC_REFERENCE_INDEX =
  "order_issue_charge_manual_refunds_edc_reference_once_idx";

type ChargeRow = typeof orderIssueCharges.$inferSelect;
type ManualRefundRow = typeof orderIssueChargeManualRefunds.$inferSelect;
type TenantId = ScopedTenantContext["tenant"]["tenantId"];

export type ManualRefundMethod = "cash" | "edc";

export type ChargeManualRefundView = {
  id: string;
  chargeId: string;
  method: ManualRefundMethod;
  amountIdr: number;
  reference: string | null;
  status: string;
  /** What the charge can still give back after this step. */
  remainingIdr: number;
};

const conflict = (message: string) => new HttpError(409, "CONFLICT", message);

const denied = (message: string) =>
  new AccessError("PERMISSION_DENIED", message);

/**
 * How the guest paid a till charge: `cash` (the cash_in movement), `edc` (an
 * approved EDC sale of exactly the charge, the journal's own proof), or null
 * when it cannot be told (then the refund is refused).
 */
async function paidMethodOf(
  tx: Tx,
  tenantId: TenantId,
  charge: ChargeRow,
): Promise<ManualRefundMethod | null> {
  if (charge.paymentIntentId !== null) return null;
  if (charge.cashMovementId !== null) return "cash";
  const sales = await tx
    .select({ amountIdr: edcTransactions.amountIdr })
    .from(edcTransactions)
    .where(
      and(
        eq(edcTransactions.tenantId, tenantId),
        eq(edcTransactions.outletId, outletIdSchema.parse(charge.outletId)),
        eq(edcTransactions.reference, charge.id),
        eq(edcTransactions.type, "sale"),
        eq(edcTransactions.status, "approved"),
      ),
    );
  return sales.some(
    (sale) => Number(sale.amountIdr) === Number(charge.amountIdr),
  )
    ? "edc"
    : null;
}

function view(
  row: ManualRefundRow,
  charge: ChargeRow,
  heldIdr: number,
): ChargeManualRefundView {
  return {
    id: row.id,
    chargeId: row.chargeId,
    method: row.method as ManualRefundMethod,
    amountIdr: Number(row.amountIdr),
    reference: row.reference,
    status: row.status,
    remainingIdr: Math.max(0, Number(charge.amountIdr) - heldIdr),
  };
}

/** Files the refund request of a paid till charge; the amount is reserved. */
export async function requestChargeManualRefund(
  context: ScopedTenantContext,
  actorUserId: UserId,
  chargeId: string,
  input: {
    amountIdr: number;
    reason: string;
    method: ManualRefundMethod;
    reference?: string;
  },
  now = new Date(),
): Promise<ChargeManualRefundView> {
  const tenantId = context.tenant.tenantId;
  try {
    return await withTenant(db, context, async (tx) => {
      const snapshot = await accessSnapshotInTransaction(
        tx,
        context,
        actorUserId,
        now,
      );
      const locked = await lockChargeChain(tx, tenantId, { chargeId });
      if (!locked)
        throw new CoreError("NOT_FOUND", "Tagihan selisih tidak ditemukan.");
      const { charge } = locked;
      assertOutletInScope(context.outletScope, charge.outletId);
      if (!snapshot.allows(HANDLE, { type: "outlet", id: charge.outletId }))
        throw denied(
          "Anda tidak dapat menangani tagihan selisih di outlet ini.",
        );

      if (charge.status !== "paid")
        throw conflict(
          "Hanya tagihan selisih yang sudah dibayar yang dapat direfund.",
        );
      if (charge.paymentIntentId !== null)
        throw conflict(
          "Tagihan ini dibayar online; refund lewat refund tagihan biasa.",
        );
      const paidWith = await paidMethodOf(tx, tenantId, charge);
      if (paidWith === null)
        throw conflict(
          "Cara pembayaran tagihan ini tidak dapat dipastikan; hubungi admin.",
        );
      if (paidWith !== input.method)
        throw conflict(
          paidWith === "cash"
            ? "Tagihan ini dibayar tunai; refund harus tunai."
            : "Tagihan ini dibayar kartu EDC; refund harus lewat EDC.",
        );

      const held = await manualRefundedOfCharge(tx, tenantId, charge.id);
      const heldIdr = held.reserved + held.completed;
      const remaining = Number(charge.amountIdr) - heldIdr;
      if (input.amountIdr > remaining)
        throw conflict(
          `Refund melebihi sisa tagihan yang dibayar; paling banyak ${Math.max(0, remaining)} IDR.`,
        );
      const reference = input.method === "edc" ? input.reference! : null;
      if (reference !== null && (await referenceLive(tx, tenantId, reference)))
        throw conflict("Referensi EDC ini sudah dipakai refund lain.");

      const [inserted] = await tx
        .insert(orderIssueChargeManualRefunds)
        .values({
          tenantId,
          outletId: charge.outletId as ManualRefundRow["outletId"],
          chargeId: charge.id,
          method: input.method,
          amountIdr: idr(input.amountIdr),
          reason: input.reason,
          reference,
          status: "requested",
          requestedBy: actorUserId,
          requestedAt: now,
        })
        .returning();
      if (!inserted) throw new Error("Manual refund insert returned no row");
      await auditCharge(tx, context, {
        outletId: charge.outletId,
        issueId: charge.orderIssueId,
        action: AUDIT_REQUESTED,
        actorUserId,
        reason: input.reason,
        after: {
          id: charge.orderIssueId,
          orderId: charge.orderId,
          chargeId: charge.id,
          status: "requested",
          amountIdr: input.amountIdr,
          manualRefundId: inserted.id,
          method: input.method,
        },
        at: now,
      });
      return view(inserted, charge, heldIdr + input.amountIdr);
    });
  } catch (error) {
    // Two charges asked with one slip at the same time: the unique index wins.
    if (uniqueViolationOf(error) === EDC_REFERENCE_INDEX)
      throw conflict("Referensi EDC ini sudah dipakai refund lain.");
    throw error;
  }
}

/** True when a non-rejected EDC refund holds `reference` (the unique key). */
async function referenceLive(
  tx: Tx,
  tenantId: TenantId,
  reference: string,
): Promise<boolean> {
  const rows = await tx
    .select({ status: orderIssueChargeManualRefunds.status })
    .from(orderIssueChargeManualRefunds)
    .where(
      and(
        eq(orderIssueChargeManualRefunds.tenantId, tenantId),
        eq(orderIssueChargeManualRefunds.method, "edc"),
        eq(orderIssueChargeManualRefunds.reference, reference),
      ),
    );
  return rows.some((row) => row.status !== "rejected");
}

/**
 * Locks the chain of the refund's charge, then the refund row. Both a missing
 * row and one the caller cannot see are 404.
 */
async function lockManualRefund(
  tx: Tx,
  context: ScopedTenantContext,
  manualRefundId: string,
) {
  const tenantId = context.tenant.tenantId;
  const [probe] = await tx
    .select({ chargeId: orderIssueChargeManualRefunds.chargeId })
    .from(orderIssueChargeManualRefunds)
    .where(
      and(
        eq(orderIssueChargeManualRefunds.tenantId, tenantId),
        eq(orderIssueChargeManualRefunds.id, manualRefundId),
      ),
    );
  if (!probe)
    throw new CoreError("NOT_FOUND", "Refund manual tidak ditemukan.");
  const locked = await lockChargeChain(tx, tenantId, {
    chargeId: probe.chargeId,
  });
  if (!locked)
    throw new CoreError("NOT_FOUND", "Tagihan selisih tidak ditemukan.");
  const [row] = await tx
    .select()
    .from(orderIssueChargeManualRefunds)
    .where(
      and(
        eq(orderIssueChargeManualRefunds.tenantId, tenantId),
        eq(orderIssueChargeManualRefunds.id, manualRefundId),
      ),
    )
    .for("update");
  if (!row) throw new CoreError("NOT_FOUND", "Refund manual tidak ditemukan.");
  assertOutletInScope(context.outletScope, locked.charge.outletId);
  return { row, ...locked };
}

/** A second person approves; cash leaves the shift drawer, EDC is recorded. */
export async function approveChargeManualRefund(
  context: ScopedTenantContext,
  actorUserId: UserId,
  manualRefundId: string,
  input: { shiftId?: string },
  now = new Date(),
): Promise<ChargeManualRefundView> {
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const snapshot = await accessSnapshotInTransaction(
      tx,
      context,
      actorUserId,
      now,
    );
    const { row, charge, order } = await lockManualRefund(
      tx,
      context,
      manualRefundId,
    );
    if (!snapshot.allows(APPROVE, { type: "outlet", id: charge.outletId }))
      throw denied("Anda tidak dapat menyetujui refund di outlet ini.");
    if (row.status !== "requested")
      throw conflict("Refund manual ini sudah diputuskan.");
    if (row.requestedBy === actorUserId)
      throw new HttpError(
        409,
        "APPROVER_IS_REQUESTER",
        "Penyetuju tidak boleh sama dengan pemohon.",
      );
    if (charge.status !== "paid")
      throw conflict("Tagihan selisih ini sudah tidak berstatus dibayar.");
    if (charge.paymentIntentId !== null)
      throw conflict("Tagihan ini dibayar online; refund manual dibatalkan.");

    const outletId = outletIdSchema.parse(charge.outletId);
    const amountIdr = Number(row.amountIdr);
    const held = await manualRefundedOfCharge(tx, tenantId, charge.id);
    // The row itself is in `reserved`; what is already paid is `completed`.
    if (held.completed + amountIdr > Number(charge.amountIdr))
      throw conflict("Refund manual melebihi tagihan yang dibayar.");

    let movement: typeof cashMovements.$inferSelect | null = null;
    let shiftId: string | null = null;
    if (row.method === "cash") {
      if (!input.shiftId)
        throw new CoreError(
          "VALIDATION_ERROR",
          "Pilih shift kasir tempat uang dikembalikan.",
        );
      if (charge.cashMovementId === null)
        throw conflict("Tagihan ini bukan tagihan tunai.");
      // The shift last (after issue, order, charge): FOR UPDATE, so the
      // drawer figures cannot move between the check and the cash_out.
      const [shift] = await tx
        .select()
        .from(posShifts)
        .where(
          and(
            eq(posShifts.tenantId, tenantId),
            eq(posShifts.id, input.shiftId),
          ),
        )
        .for("update");
      if (
        !shift ||
        shift.outletId !== charge.outletId ||
        shift.status !== "open" ||
        now < shift.openedAt
      )
        throw conflict(
          "Shift kasir tidak terbuka di outlet tagihan ini; pilih shift yang terbuka.",
        );
      // The approver picks the shift (the requester may not be on shift now).
      // That is allowed because the approver holds `pos.refund.approve` at this
      // outlet and the cash_out is audited with their id; the shift must still
      // be open here, of this outlet, within the safe-integer bound and hold
      // the cash, the same guards as the void's and the POS refund's cash_out.
      await assertShiftOutflowBound(tx, shift, amountIdr);
      if (await cashOutExceedsDrawer(tx, shift, amountIdr))
        throw conflict("Kas di laci shift ini tidak cukup untuk refund.");
      shiftId = shift.id;
      const caller: ShiftCaller = { userId: actorUserId, deviceId: null };
      const [inserted] = await tx
        .insert(cashMovements)
        .values({
          tenantId,
          outletId: charge.outletId,
          shiftId: shift.id,
          type: "cash_out",
          amountIdr: idr(amountIdr),
          reasonNote:
            `Refund manual selisih swap pesanan ${order.number}`.slice(0, 500),
          recordedBy: actorUserId,
          recordedAt: now,
          approvedBy: null,
          needsApproval: false,
          idempotencyKey: `manual-charge-refund:${row.id}`,
          requestFingerprint: shiftFingerprint({
            op: "issue_charge.manual_refund",
            outletId: charge.outletId,
            shiftId: shift.id,
            userId: actorUserId,
            body: { manualRefundId: row.id, chargeId: charge.id },
          }),
        })
        .returning();
      if (!inserted) throw new Error("Cash movement insert returned no row");
      movement = inserted;
      await auditShift(
        tx,
        context,
        {
          action: "pos_shift.cash_movement_recorded",
          outletId,
          objectType: "cash_movement",
          objectId: inserted.id,
          caller,
          before: null,
          after: {
            id: inserted.id,
            shiftId: shift.id,
            type: "cash_out",
            amountIdr,
          },
          reason: inserted.reasonNote,
        },
        now,
      );
    } else if (input.shiftId)
      throw new CoreError(
        "VALIDATION_ERROR",
        "Refund EDC tidak memakai shift kasir.",
      );

    // Conditional on `requested`: decided by exactly one approval.
    const [done] = await tx
      .update(orderIssueChargeManualRefunds)
      .set({
        status: "completed",
        decidedBy: actorUserId,
        decidedAt: now,
        shiftId,
        cashMovementId: movement?.id ?? null,
      })
      .where(
        and(
          eq(orderIssueChargeManualRefunds.tenantId, tenantId),
          eq(orderIssueChargeManualRefunds.id, row.id),
          eq(orderIssueChargeManualRefunds.status, "requested"),
        ),
      )
      .returning();
    if (!done)
      throw conflict("Refund manual ini berubah selama persetujuan; ulangi.");

    await appendChargeRefundedEvent(tx, context, {
      charge,
      refundId: movement?.id ?? row.id,
      intentId: null,
      method: movement ? "pos_cash" : "edc_manual",
      amountIdr,
      split: recoveryChargeRefundSplit({
        charge,
        priorIdr: held.completed,
        refundIdr: amountIdr,
      }),
      at: now,
    });
    await auditCharge(tx, context, {
      outletId: charge.outletId,
      issueId: charge.orderIssueId,
      action: AUDIT_COMPLETED,
      actorUserId,
      reason: row.reason,
      after: {
        id: charge.orderIssueId,
        orderId: charge.orderId,
        chargeId: charge.id,
        status: "completed",
        amountIdr,
        manualRefundId: row.id,
        method: row.method,
        ...(movement ? { cashMovementId: movement.id } : {}),
      },
      at: now,
    });
    return view(
      done,
      charge,
      held.reserved + held.completed, // the row stays held, now as completed
    );
  });
}

/** Drops a request (the requester or an approver): the reservation is freed. */
export async function rejectChargeManualRefund(
  context: ScopedTenantContext,
  actorUserId: UserId,
  manualRefundId: string,
  input: { reason: string },
  now = new Date(),
): Promise<ChargeManualRefundView> {
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const snapshot = await accessSnapshotInTransaction(
      tx,
      context,
      actorUserId,
      now,
    );
    const { row, charge } = await lockManualRefund(tx, context, manualRefundId);
    if (
      row.requestedBy !== actorUserId &&
      !snapshot.allows(APPROVE, { type: "outlet", id: charge.outletId })
    )
      throw denied("Anda tidak dapat menolak refund di outlet ini.");
    if (row.status !== "requested")
      throw conflict("Refund manual ini sudah diputuskan.");

    const [done] = await tx
      .update(orderIssueChargeManualRefunds)
      .set({
        status: "rejected",
        decidedBy: actorUserId,
        decidedAt: now,
        rejectReason: input.reason,
      })
      .where(
        and(
          eq(orderIssueChargeManualRefunds.tenantId, tenantId),
          eq(orderIssueChargeManualRefunds.id, row.id),
          eq(orderIssueChargeManualRefunds.status, "requested"),
        ),
      )
      .returning();
    if (!done)
      throw conflict("Refund manual ini berubah selama penolakan; ulangi.");
    await auditCharge(tx, context, {
      outletId: charge.outletId,
      issueId: charge.orderIssueId,
      action: AUDIT_REJECTED,
      actorUserId,
      reason: input.reason,
      after: {
        id: charge.orderIssueId,
        orderId: charge.orderId,
        chargeId: charge.id,
        status: "rejected",
        amountIdr: Number(row.amountIdr),
        manualRefundId: row.id,
        method: row.method,
      },
      at: now,
    });
    const held = await manualRefundedOfCharge(tx, tenantId, charge.id);
    return view(done, charge, held.reserved + held.completed);
  });
}
