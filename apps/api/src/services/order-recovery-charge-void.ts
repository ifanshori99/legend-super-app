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
// - Manual refunds (legend-mrwtp, brief 985): what a cash or EDC charge already
//   gave back by hand (completed `order_issue_charge_manual_refunds`) is out;
//   the void gives back only the rest (cash_out of the remainder, the journal
//   event of the remainder with the manual part as prior). A request still
//   waiting (`requested`) holds part of the charge: the void is refused (409)
//   until it is approved or rejected. A held void is refused too when a cash
//   charge was refunded by hand (the held cash figure counts the whole charge).
// - A charge with nothing left to give back is closed `voided` with no money
//   and no journal event (the refund already reversed its revenue): a gateway
//   charge whose intent is fully refunded (legend-v5z4h), or a cash or EDC
//   charge fully refunded by hand.
// - A cash charge is also refused (422 REFUND_OVER_ORDER_ROOM, void rolled back)
//   once ORD-09 or a voucher paid on its swap chain (assertChargeChainBudget).
// - Charge paid through an intent (gateway, QRIS at the till): the nsvu0 refund
//   (`refundPaidChargeInTx`) of what is still refundable.
// - EDC charge (no intent, no cash) with a part refunded by hand: the till
//   cannot return card money, 409. Without any manual refund: 409 as well.
//
// Lock order of the void: issues of the order, the order, the charges (the
// module's issue -> order -> charge). `lockIssuesOfOrder` runs BEFORE the order
// lock, `paidChargesOfOrder` after it.

import { and, asc, eq, sql } from "drizzle-orm";
import {
  CoreError,
  idr,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { orderIssueCharges, orderIssues } from "../db/schema/kds-issues.ts";
import { paymentRefunds } from "../db/schema/index.ts";
import { cashMovements } from "../db/schema/pos-shift.ts";
import { HttpError } from "../lib/http-error.ts";
import { manualRefundedOfCharge } from "./order-charge-manual-refund-sum.ts";
import { assertChargeChainBudget } from "./order-given.ts";
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
const SETTLED_REASON =
  "Pesanan di-void; selisih swap sudah dikembalikan sebelumnya";

export type PaidChargesOfOrder = {
  /** Paid through a payment intent: refunded by the nsvu0 path. */
  gateway: ChargeRow[];
  /** Paid in cash at the till: the rest is given back from the drawer. */
  cash: ChargeRow[];
  /** Nothing left to give back (already refunded in full): closed, no money. */
  settled: ChargeRow[];
  /** Completed manual refund of each cash or settled charge (by charge id). */
  manualIdr: Map<string, number>;
  /** Cash the drawer gives back for the cash charges (after manual refunds). */
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
 * The `paid` charges of the order, row locked, sorted by what the void does
 * with each. Refuses (409) one the void cannot give back: an EDC charge (neither
 * an intent nor cash) with something left, or any charge with a manual refund
 * request still waiting.
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
  // fully refunded) is closed without money: its money is out, the void is
  // not blocked. A manual refund still waiting blocks the void (409).
  const tenantId = context.tenant.tenantId;
  const gateway: ChargeRow[] = [];
  const cash: ChargeRow[] = [];
  const settled: ChargeRow[] = [];
  const manualIdr = new Map<string, number>();
  let cashIdr = 0;
  for (const row of rows) {
    if (row.paymentIntentId !== null) {
      // Voided only when the COMPLETED refunds are the whole charge. A refund
      // still pending / requested / approved may yet fail, and then the guest
      // would have got nothing from a charge already closed: block (409).
      const refunded = await refundedOfGatewayCharge(tx, context, row);
      if (refunded.live > refunded.completed)
        throw new HttpError(
          409,
          "CONFLICT",
          "Selisih swap pesanan ini punya refund gateway yang belum selesai; tunggu selesai atau gagal, lalu void ulang.",
        );
      if (Number(row.amountIdr) - refunded.completed > 0) gateway.push(row);
      else settled.push(row);
      continue;
    }
    const manual = await manualRefundedOfCharge(tx, tenantId, row.id);
    if (manual.reserved > 0)
      throw new HttpError(
        409,
        "CONFLICT",
        "Selisih swap pesanan ini punya permintaan refund manual yang belum diputuskan; setujui atau tolak dulu, lalu void ulang.",
      );
    const rest = Number(row.amountIdr) - manual.completed;
    if (rest < 0)
      throw new HttpError(
        409,
        "CONFLICT",
        "Refund manual selisih swap melebihi nilai tagihan; hubungi admin.",
      );
    manualIdr.set(row.id, manual.completed);
    if (rest === 0) settled.push(row);
    else if (row.cashMovementId !== null) {
      cash.push(row);
      cashIdr += rest;
    } else
      throw new HttpError(
        409,
        "CONFLICT",
        "Selisih swap pesanan ini dibayar dengan kartu EDC dan tidak bisa dikembalikan lewat void; hubungi admin.",
      );
  }
  return { gateway, cash, settled, manualIdr, cashIdr };
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
  const { charges, caller, now } = input;
  // The held cash figure (heldCorrectionCashIdrOf) counts a voided cash charge
  // at its whole amount; one refunded by hand would be counted twice: block.
  if (
    input.held &&
    [...charges.cash, ...charges.settled].some(
      (charge) =>
        charge.cashMovementId !== null &&
        (charges.manualIdr.get(charge.id) ?? 0) > 0,
    )
  )
    throw new HttpError(
      409,
      "CONFLICT",
      "Selisih swap pesanan ini sudah direfund manual dan void ini menunggu kas laci; hubungi admin.",
    );
  for (const charge of charges.settled) {
    await closeChargeVoided(tx, context, charge, {
      caller,
      now,
      reason: SETTLED_REASON,
      voidId: input.voidId,
      manualIdr: charges.manualIdr.get(charge.id) ?? 0,
    });
  }
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
    const manualIdr = charges.manualIdr.get(charge.id) ?? 0;
    const restIdr = Number(charge.amountIdr) - manualIdr;
    // A held void pays no cash out now: the charge cash is held correction
    // cash (heldCorrectionCashIdrOf, from the void row), not a movement that
    // the drawer counts or the cash-approval queue journals again.
    const movement = input.held
      ? null
      : await insertCashReturn(tx, charge, {
          amountIdr: restIdr,
          shift,
          caller,
          orderNumber: input.orderNumber,
          now,
        });
    await closeChargeVoided(tx, context, charge, {
      caller,
      now,
      reason: VOID_REASON,
      voidId: input.voidId,
      manualIdr,
      returned: {
        amountIdr: restIdr,
        refundId:
          movement?.id ?? heldVoidChargeRefundId(input.voidId, charge.id),
        movement,
      },
    });
    // 1145 (legend-4yez0): the charge left `paid`, so its money is off the swap
    // chain; when ORD-09 already paid on that chain the cash given back would
    // leave the chain with more out than it paid: refuse (422, the void rolls
    // back). Same check as the gateway charge refund; the order is locked.
    await assertChargeChainBudget(
      tx,
      context.tenant.tenantId,
      charge.orderId,
      charge.orderIssueId,
    );
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

// Closes the paid charge `voided` (conditional on `paid`: exactly one close).
// With `returned` the void gave back that rest (journal event of the rest);
// without it nothing is left to give back, so no money and no event move.
async function closeChargeVoided(
  tx: Tx,
  context: ScopedTenantContext,
  charge: ChargeRow,
  input: {
    caller: ShiftCaller;
    now: Date;
    reason: string;
    voidId: string;
    /** Completed manual refund of the charge before the void. */
    manualIdr: number;
    returned?: {
      amountIdr: number;
      refundId: string;
      movement: { id: string } | null;
    };
  },
): Promise<void> {
  const { caller, now } = input;
  const [closed] = await tx
    .update(orderIssueCharges)
    .set({
      status: "voided",
      closedAt: now,
      closedBy: caller.userId,
      closeReason: input.reason,
      updatedAt: now,
    })
    .where(
      and(
        eq(orderIssueCharges.tenantId, context.tenant.tenantId),
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
  const { returned } = input;
  if (returned)
    await appendChargeRefundedEvent(tx, context, {
      charge: { ...charge, status: "voided" },
      refundId: returned.refundId,
      intentId: null,
      method: "pos_cash",
      amountIdr: returned.amountIdr,
      split: recoveryChargeRefundSplit({
        charge,
        priorIdr: input.manualIdr,
        refundIdr: returned.amountIdr,
      }),
      at: now,
    });
  await auditCharge(tx, context, {
    outletId: charge.outletId,
    issueId: charge.orderIssueId,
    action: AUDIT_CHARGE_VOIDED,
    actorUserId: caller.userId,
    reason: input.reason,
    after: {
      id: charge.orderIssueId,
      orderId: charge.orderId,
      chargeId: charge.id,
      status: "voided",
      amountIdr: Number(charge.amountIdr),
      ...(returned ? { returnedIdr: returned.amountIdr } : {}),
      ...(input.manualIdr > 0 ? { manualRefundedIdr: input.manualIdr } : {}),
      ...(returned?.movement ? { cashMovementId: returned.movement.id } : {}),
      voidId: input.voidId,
    },
    at: now,
  });
}

async function insertCashReturn(
  tx: Tx,
  charge: ChargeRow,
  input: {
    /** The rest of the charge after manual refunds. */
    amountIdr: number;
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
      amountIdr: idr(input.amountIdr),
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

// What the refunds of the charge's intent add up to: all that are not failed
// (live) and those already paid back (completed). live > completed means one is
// still on its way.
async function refundedOfGatewayCharge(
  tx: Tx,
  context: ScopedTenantContext,
  charge: ChargeRow,
): Promise<{ live: number; completed: number }> {
  const [row] = await tx
    .select({
      live: sql<string>`coalesce(sum(${paymentRefunds.amountIdr}), 0)::text`,
      completed: sql<string>`coalesce(sum(${paymentRefunds.amountIdr}) filter (where ${paymentRefunds.status} = 'completed'), 0)::text`,
    })
    .from(paymentRefunds)
    .where(
      and(
        eq(paymentRefunds.tenantId, context.tenant.tenantId),
        eq(paymentRefunds.paymentIntentId, charge.paymentIntentId!),
        sql`${paymentRefunds.status} <> 'failed'`,
      ),
    );
  return {
    live: Number(row?.live ?? "0"),
    completed: Number(row?.completed ?? "0"),
  };
}

// What is left to give back, re-read right before the refund: a refund that took the rest after
// the charges were listed blocks the void (money: when in doubt, block).
async function refundableOfGatewayChargeOrBlock(
  tx: Tx,
  context: ScopedTenantContext,
  charge: ChargeRow,
): Promise<number> {
  const refunded = await refundedOfGatewayCharge(tx, context, charge);
  const left = Number(charge.amountIdr) - refunded.live;
  if (left <= 0 || refunded.live > refunded.completed)
    throw new HttpError(
      409,
      "CONFLICT",
      "Selisih swap pesanan ini berubah selama void; ulangi.",
    );
  return left;
}
