// A paid dearer-swap charge when its order is voided (legend-s61sg, brief 982).
//
// The POS void gives the sale back, so the guest's swap charge goes back too, in
// the SAME transaction as the void; if that cannot be done the void is refused
// (409, nothing changes: block, never release the money). Never returned twice:
// the charge leaves `paid` (cash) or the refund request counts against the
// intent (gateway), and the order cannot be voided or refunded again.
//
// - Cash charge (cash_movement_id): the drawer gives the cash back as a
//   `cash_out` movement of the cashier's shift (key `void-charge:<chargeId>`,
//   one per charge) and the charge becomes `voided` (closed_at / closed_by set).
//   `order_issue.charge_refunded` (method pos_cash, refundId = that movement)
//   lets the auto-journal reverse the charge revenue. The cash_out itself is
//   not journalled by `cash_movement.recorded` (no such event is appended).
//   A void held for the drawer (needs_approval) pays no cash out now: no
//   movement is inserted (it would count in the drawer figures and queue for
//   cash approval, which journals again); the charge cash is held correction
//   cash (heldCorrectionCashIdrOf) and the refund id is derived per charge
//   from the void row (heldVoidChargeRefundId).
// - A gateway charge with nothing left to refund (intent fully refunded) is
//   skipped: its money is already out.
// - Charge paid through an intent (gateway, QRIS at the till): the nsvu0 refund
//   (`refundPaidChargeInTx`) of what is still refundable; 409 when nothing is.
// - EDC charge (no intent, no cash): the till cannot return card money, 409.
//
// Lock order of the void: issues of the order, the order, the charges (the
// module's issue -> order -> charge). `lockIssuesOfOrder` runs BEFORE the order
// lock, `paidChargesOfOrder` after it.

import { and, asc, eq, sql } from "drizzle-orm";
import {
  CoreError,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { orderIssueCharges, orderIssues } from "../db/schema/kds-issues.ts";
import { paymentRefunds } from "../db/schema/index.ts";
import { cashMovements } from "../db/schema/pos-shift.ts";
import { HttpError } from "../lib/http-error.ts";
import { auditCharge } from "./order-recovery-charge.ts";
import {
  appendChargeRefundedEvent,
  refundPaidChargeInTx,
} from "./order-recovery-charge-refund.ts";
import { heldVoidChargeRefundId } from "./order-recovery-charge-void-id.ts";
import { recoveryChargeRefundSplit } from "./order-recovery-refund-amount.ts";
import {
  auditShift,
  shiftFingerprint,
  type ShiftCaller,
} from "./pos-shift-support.ts";
import type { Tx } from "./permission-resolver.ts";

type ChargeRow = typeof orderIssueCharges.$inferSelect;

const AUDIT_CHARGE_VOIDED = "order_issue.charge_voided_with_order";
const VOID_REASON = "Pesanan di-void; selisih swap dikembalikan";

export type PaidChargesOfOrder = {
  /** Paid through a payment intent: refunded by the nsvu0 path. */
  gateway: ChargeRow[];
  /** Paid in cash at the till: given back from the drawer. */
  cash: ChargeRow[];
  /** Cash the drawer gives back for the cash charges. */
  cashIdr: number;
};

/** Locks the issues of the order (first lock of the void). */
export async function lockIssuesOfOrder(
  tx: Tx,
  context: ScopedTenantContext,
  orderId: string,
): Promise<void> {
  await tx
    .select({ id: orderIssues.id })
    .from(orderIssues)
    .where(
      and(
        eq(orderIssues.tenantId, context.tenant.tenantId),
        eq(orderIssues.orderId, orderId),
      ),
    )
    .orderBy(asc(orderIssues.id))
    .for("update");
}

/**
 * The `paid` charges of the order, row locked. Refuses (409) one the void
 * cannot give back: an EDC charge has neither an intent nor cash.
 */
export async function paidChargesOfOrder(
  tx: Tx,
  context: ScopedTenantContext,
  orderId: string,
): Promise<PaidChargesOfOrder> {
  const rows = await tx
    .select()
    .from(orderIssueCharges)
    .where(
      and(
        eq(orderIssueCharges.tenantId, context.tenant.tenantId),
        eq(orderIssueCharges.orderId, orderId),
        eq(orderIssueCharges.status, "paid"),
      ),
    )
    .orderBy(asc(orderIssueCharges.id))
    .for("update");
  // A gateway charge with nothing left to give back (its intent is already
  // fully refunded) is skipped: its money is out, the void is not blocked.
  const gateway: ChargeRow[] = [];
  for (const row of rows)
    if (
      row.paymentIntentId !== null &&
      (await refundableOfGatewayCharge(tx, context, row)) > 0
    )
      gateway.push(row);
  const cash = rows.filter(
    (row) => row.paymentIntentId === null && row.cashMovementId !== null,
  );
  const skipped = rows.filter(
    (row) => row.paymentIntentId !== null && !gateway.includes(row),
  ).length;
  if (gateway.length + cash.length + skipped !== rows.length)
    throw new HttpError(
      409,
      "CONFLICT",
      "Selisih swap pesanan ini dibayar dengan kartu EDC dan tidak bisa dikembalikan lewat void; hubungi admin.",
    );
  return {
    gateway,
    cash,
    cashIdr: cash.reduce((sum, row) => sum + Number(row.amountIdr), 0),
  };
}

/**
 * Gives the paid charges back inside the void transaction. `shift` is the
 * drawer that pays the cash charges (locked by the caller, already checked for
 * the whole outflow). A gateway charge is refunded in full (what is left of
 * it); any refusal aborts the whole void.
 */
export async function returnPaidChargesOfVoidedOrder(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    charges: PaidChargesOfOrder;
    shift: { id: string; deviceId: string | null } | null;
    /** The void row; the refund id of a held void's cash charge. */
    voidId: string;
    /** The void is held for the drawer: its cash is not paid out now. */
    held: boolean;
    caller: ShiftCaller;
    orderNumber: string;
    now: Date;
  },
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const { charges, caller, now } = input;
  for (const charge of charges.gateway)
    await refundPaidChargeInTx(tx, context, {
      chargeId: charge.id,
      amountIdr: await refundableOfGatewayChargeOrBlock(tx, context, charge),
      reason: VOID_REASON,
      requestedBy: caller.userId,
      actor: { type: "user", id: caller.userId },
      now,
    });
  if (charges.cash.length === 0) return;
  if (input.shift === null)
    throw new CoreError(
      "CONFLICT",
      "Kas selisih swap tidak bisa dikembalikan tanpa shift kasir yang terbuka.",
    );
  const shift = input.shift;
  for (const charge of charges.cash) {
    // A held void pays no cash out now: the charge cash is held correction
    // cash (heldCorrectionCashIdrOf, from the void row), not a movement that
    // the drawer counts or the cash-approval queue journals again.
    const movement = input.held
      ? null
      : await insertCashReturn(tx, charge, {
          shift,
          caller,
          orderNumber: input.orderNumber,
          now,
        });
    // Conditional on `paid`: the charge is closed by exactly one return.
    const [closed] = await tx
      .update(orderIssueCharges)
      .set({
        status: "voided",
        closedAt: now,
        closedBy: caller.userId,
        closeReason: VOID_REASON,
        updatedAt: now,
      })
      .where(
        and(
          eq(orderIssueCharges.tenantId, tenantId),
          eq(orderIssueCharges.id, charge.id),
          eq(orderIssueCharges.status, "paid"),
        ),
      )
      .returning({ id: orderIssueCharges.id });
    if (!closed)
      throw new HttpError(
        409,
        "CONFLICT",
        "Selisih swap pesanan ini berubah selama void; ulangi.",
      );
    await appendChargeRefundedEvent(tx, context, {
      charge: { ...charge, status: "voided" },
      refundId: movement?.id ?? heldVoidChargeRefundId(input.voidId, charge.id),
      intentId: null,
      method: "pos_cash",
      amountIdr: Number(charge.amountIdr),
      split: recoveryChargeRefundSplit({
        charge,
        priorIdr: 0,
        refundIdr: Number(charge.amountIdr),
      }),
      at: now,
    });
    await auditCharge(tx, context, {
      outletId: charge.outletId,
      issueId: charge.orderIssueId,
      action: AUDIT_CHARGE_VOIDED,
      actorUserId: caller.userId,
      reason: VOID_REASON,
      after: {
        id: charge.orderIssueId,
        orderId: charge.orderId,
        chargeId: charge.id,
        status: "voided",
        amountIdr: Number(charge.amountIdr),
        ...(movement ? { cashMovementId: movement.id } : {}),
        voidId: input.voidId,
      },
      at: now,
    });
    if (movement)
      await auditShift(
        tx,
        context,
        {
          action: "pos_shift.cash_movement_recorded",
          outletId: outletIdSchema.parse(charge.outletId),
          objectType: "cash_movement",
          objectId: movement.id,
          caller,
          before: null,
          after: {
            id: movement.id,
            shiftId: shift.id,
            type: "cash_out",
            amountIdr: movement.amountIdr,
          },
          reason: movement.reasonNote,
        },
        now,
      );
  }
}

async function insertCashReturn(
  tx: Tx,
  charge: ChargeRow,
  input: {
    shift: { id: string };
    caller: ShiftCaller;
    orderNumber: string;
    now: Date;
  },
) {
  const { shift, caller, now } = input;
  const [movement] = await tx
    .insert(cashMovements)
    .values({
      tenantId: charge.tenantId,
      outletId: charge.outletId,
      shiftId: shift.id,
      type: "cash_out",
      amountIdr: charge.amountIdr,
      reasonNote:
        `Void pesanan ${input.orderNumber}: selisih swap dikembalikan`.slice(
          0,
          500,
        ),
      recordedBy: caller.userId,
      recordedAt: now,
      approvedBy: null,
      needsApproval: false,
      idempotencyKey: `void-charge:${charge.id}`,
      requestFingerprint: shiftFingerprint({
        op: "issue_charge.void_return",
        outletId: charge.outletId,
        shiftId: shift.id,
        userId: caller.userId,
        body: { chargeId: charge.id },
      }),
    })
    .returning();
  if (!movement) throw new Error("Cash return insert returned no row");
  return movement;
}

// What the charge still gives back: its amount less the non-failed refunds of
// its intent (<= 0: nothing left). refundPaidChargeInTx re-reads this under the
// locks and refuses (409) an amount over what is left.
async function refundableOfGatewayCharge(
  tx: Tx,
  context: ScopedTenantContext,
  charge: ChargeRow,
): Promise<number> {
  const [row] = await tx
    .select({
      total: sql<string>`coalesce(sum(${paymentRefunds.amountIdr}), 0)::text`,
    })
    .from(paymentRefunds)
    .where(
      and(
        eq(paymentRefunds.tenantId, context.tenant.tenantId),
        eq(paymentRefunds.paymentIntentId, charge.paymentIntentId!),
        sql`${paymentRefunds.status} <> 'failed'`,
      ),
    );
  return Number(charge.amountIdr) - Number(row?.total ?? "0");
}

// The same, re-read right before the refund: a refund that took the rest after
// the charges were listed blocks the void (money: when in doubt, block).
async function refundableOfGatewayChargeOrBlock(
  tx: Tx,
  context: ScopedTenantContext,
  charge: ChargeRow,
): Promise<number> {
  const left = await refundableOfGatewayCharge(tx, context, charge);
  if (left <= 0)
    throw new HttpError(
      409,
      "CONFLICT",
      "Selisih swap pesanan ini berubah selama void; ulangi.",
    );
  return left;
}
