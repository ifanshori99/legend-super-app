// The cashier takes a dearer-swap charge in cash at the till (legend-800h1).
//
// Cash only; EDC / QRIS at the till is a later step. A POS tender can never
// carry charge money (`remainingIdr` caps it at the order), so the charge is
// collected by this explicit action:
//
// - ONE transaction. Lock order: issue, order, charge row (`lockChargeChain`),
//   then the cancelled link and its intents, and the cashier's shift LAST
//   (`lockCashierShiftForCash`, the cash tender's lock).
// - Status `open` (QR bill) or `routed_pos` (cashier bill) only. The cash goes
//   into the drawer of the device it was taken on as a `cash_in` movement of
//   the shift; the charge points at it (`cash_movement_id`) and is `paid`.
// - Replay: the same idempotency key on a charge that this movement paid
//   returns the same answer and writes nothing; a different body under the
//   key is IDEMPOTENCY_KEY_REUSED; any other paid / closed charge is a 409.
// - The guest's payment link is cancelled in the same transaction. A guest who
//   still pays the old code is a `double_payment` of the charge consumer and
//   gets the money back.
// - `order_issue.charge_paid` (method pos_cash) lets the journal recognise
//   revenue; the cash_in itself is not journalled.

import { and, eq } from "drizzle-orm";
import { AccessError } from "@starter/shared/access";
import {
  assertOutletInScope,
  CoreError,
  createUlid,
  outletIdSchema,
  toIsoDateTime,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import { assertCashMovementAllowed } from "@starter/shared/pos";
import type { CollectChargeAtPosInput } from "@starter/shared/qr-order";
import { db } from "../db/index.ts";
import { orderIssueCharges } from "../db/schema/kds-issues.ts";
import { cashMovements } from "../db/schema/pos-shift.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  appendChargePaidEvent,
  auditCharge,
  AUDIT_PAID,
  chargeAudit,
  lockChargeChain,
} from "./order-recovery-charge.ts";
import { toView, type IssueChargeView } from "./order-recovery-charge-staff.ts";
import { accessSnapshotInTransaction } from "./permission-resolver.ts";
import { cancelPaymentLinkInTx } from "./payment.service.ts";
import { lockCashierShiftForCash } from "./pos-cash-guard.ts";
import {
  appendShiftEvent,
  auditShift,
  shiftFingerprint,
} from "./pos-shift-support.ts";
import { notifyQrOrderChange } from "./qr-order-realtime-signal.ts";

const PAY = "pos.payment.accept";

export type CollectChargeAtPosCaller = {
  readonly userId: UserId;
  readonly deviceId: string | null;
};

export type CollectedChargeAtPos = {
  charge: IssueChargeView;
  changeIdr: number;
};

export async function collectChargeAtPos(
  context: ScopedTenantContext,
  caller: CollectChargeAtPosCaller,
  chargeId: string,
  input: CollectChargeAtPosInput,
  now = new Date(),
): Promise<CollectedChargeAtPos> {
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const snapshot = await accessSnapshotInTransaction(
      tx,
      context,
      caller.userId,
      now,
    );
    const locked = await lockChargeChain(tx, tenantId, { chargeId });
    if (!locked)
      throw new CoreError("NOT_FOUND", "Tagihan selisih tidak ditemukan.");
    const { charge, issue, order } = locked;
    assertOutletInScope(context.outletScope, charge.outletId);
    if (!snapshot.allows(PAY, { type: "outlet", id: charge.outletId }))
      throw new AccessError(
        "PERMISSION_DENIED",
        "Anda tidak dapat menerima pembayaran di outlet ini.",
      );
    const outletId = outletIdSchema.parse(charge.outletId);
    const fingerprint = shiftFingerprint({
      op: "issue_charge.collect_at_pos",
      outletId,
      userId: caller.userId,
      body: { chargeId, method: input.method, receivedIdr: input.receivedIdr },
    });
    const changeIdr = input.receivedIdr - charge.amountIdr;

    if (charge.status === "paid" && charge.cashMovementId !== null) {
      const [movement] = await tx
        .select()
        .from(cashMovements)
        .where(
          and(
            eq(cashMovements.tenantId, tenantId),
            eq(cashMovements.id, charge.cashMovementId),
          ),
        );
      if (movement && movement.idempotencyKey === input.idempotencyKey) {
        if (movement.requestFingerprint !== fingerprint)
          throw new CoreError(
            "IDEMPOTENCY_KEY_REUSED",
            "Kunci idempotensi sudah dipakai untuk permintaan lain.",
          );
        return { charge: toView(charge), changeIdr };
      }
    }
    if (charge.status !== "open" && charge.status !== "routed_pos")
      throw new HttpError(
        409,
        "CONFLICT",
        "Hanya tagihan selisih yang masih terbuka yang dapat dibayar di kasir.",
      );
    if (input.receivedIdr < charge.amountIdr)
      throw new CoreError(
        "VALIDATION_ERROR",
        "Uang diterima kurang dari tagihan selisih.",
      );

    // Shift last (after the issue, order, charge chain): SHIFT_NOT_OPEN when
    // the cashier has no open shift on this device.
    const shift = await lockCashierShiftForCash(tx, context, {
      outletId,
      cashierId: caller.userId,
      deviceId: caller.deviceId,
      mode: "in",
      at: now,
    });
    assertCashMovementAllowed(shift);

    const [movement] = await tx
      .insert(cashMovements)
      .values({
        tenantId,
        outletId: charge.outletId,
        shiftId: shift.id,
        type: "cash_in",
        amountIdr: charge.amountIdr,
        reasonNote: `Selisih swap pesanan ${order.number}`.slice(0, 500),
        recordedBy: caller.userId,
        recordedAt: now,
        approvedBy: null,
        needsApproval: false,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint,
      })
      .returning();
    if (!movement) throw new Error("Cash movement insert returned no row");

    const [updated] = await tx
      .update(orderIssueCharges)
      .set({
        status: "paid",
        paidAt: now,
        paidBy: caller.userId,
        // The pointer to the guest's code goes (its intent is expired below);
        // a cash-paid charge has no gateway intent.
        paymentIntentId: null,
        cashMovementId: movement.id,
        updatedAt: now,
      })
      .where(
        and(
          eq(orderIssueCharges.tenantId, tenantId),
          eq(orderIssueCharges.id, charge.id),
        ),
      )
      .returning();
    if (!updated) throw new Error("Charge update returned no row");

    // The guest can no longer pay the code (the gateway has no cancel: a late
    // payment is a double_payment of the charge consumer and is refunded).
    if (charge.paymentLinkId !== null)
      await cancelPaymentLinkInTx(tx, context, {
        linkId: charge.paymentLinkId,
        now,
        reason: "issue_charge_paid_at_pos",
      });

    await appendChargePaidEvent(tx, context, {
      charge,
      intentId: null,
      cashMovementId: movement.id,
      paidAt: now,
      at: now,
    });
    await auditCharge(tx, context, {
      outletId: charge.outletId,
      issueId: issue.id,
      action: AUDIT_PAID,
      actorUserId: caller.userId,
      reason: "Selisih swap dibayar tunai di kasir",
      after: { ...chargeAudit(charge), status: "paid" },
      at: now,
    });
    await appendShiftEvent(tx, context, "cash_movement.recorded", {
      aggregateId: movement.id,
      outletId,
      payload: {
        movementId: movement.id,
        shiftId: shift.id,
        outletId,
        deviceId: shift.deviceId,
        type: "cash_in",
        amountIdr: movement.amountIdr,
        reasonNote: movement.reasonNote,
        recordedBy: caller.userId,
        recordedAt: toIsoDateTime(now),
      },
      caller,
      now,
    });
    await auditShift(
      tx,
      context,
      {
        action: "pos_shift.cash_movement_recorded",
        outletId,
        objectType: "cash_movement",
        objectId: movement.id,
        caller,
        before: null,
        after: {
          id: movement.id,
          shiftId: shift.id,
          type: "cash_in",
          amountIdr: movement.amountIdr,
        },
        reason: movement.reasonNote,
      },
      now,
    );

    // The guest's bill changed: wake the table's phones.
    if (charge.tableSessionId !== null)
      await notifyQrOrderChange(tx, context, {
        sessionId: charge.tableSessionId,
        orderId: charge.orderId,
        status: "sent",
      });
    return { charge: toView(updated), changeIdr };
  });
}
