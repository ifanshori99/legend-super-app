// The cashier's read of one dearer-swap charge before taking the money
// (legend-f1mmf; contract @starter/shared/pos `getPosIssueCharge`).
//
// - 404 for a charge of another tenant, of an outlet outside the caller's
//   scope, of another outlet than the acting cashier's, or of an outlet where
//   the caller may not take payments: no probing of ids.
// - The amount, the swap lines and the difference are the server's. The
//   replacement line is the original line plus the charge's difference, so
//   the screen never shows a gap the charge does not hold.
// - The code shown is the one that can still take money: a `paid` intent of
//   the charge's link first, then a `pending` one, else the last code the
//   charge pointed at. A code past its expiry is read as `expired` only once
//   its margin (`HOLD_CLOSE_MARGIN_MS`) passed AND the provider holds no money
//   for it (`confirmLinkUnpaidAtProvider`); until then it stays `pending`, so
//   the till keeps the method locked. Money the provider already holds is
//   applied once there, and the charge is read again.
// - EDC: every sale of the outlet whose reference is this charge, newest
//   first (a charge has at most one unresolved and one approved sale: the EDC
//   agent refuses a new one for the reference until the earlier is final).

import { and, desc, eq, inArray } from "drizzle-orm";
import {
  isOutletInScope,
  CoreError,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import {
  edcBankSchema,
  edcMethodSchema,
  edcTransactionStatusSchema,
} from "@starter/shared/edc";
import {
  posEdcAttemptSchema,
  posIssueChargeDetailSchema,
  type PosIssueChargeDetail,
} from "@starter/shared/pos";
import type { GuestPayment } from "@starter/shared/qr-order";
import { db } from "../db/index.ts";
import { edcTransactions } from "../db/schema/edc.ts";
import { tables, tableSessions } from "../db/schema/floor.ts";
import { orderIssueCharges, orderIssues } from "../db/schema/kds-issues.ts";
import { menuItems } from "../db/schema/menu.ts";
import { paymentEdcTerminals } from "../db/schema/payment-admin.ts";
import { paymentIntents } from "../db/schema/payment.ts";
import { orderItems, orders } from "../db/schema/qr-order.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { openSecret } from "../lib/secrets.ts";
import type { Tx } from "./menu-internals.ts";
import { accessSnapshotInTransaction } from "./permission-resolver.ts";
import { readIntentView } from "./payment.service.ts";
import { confirmLinkUnpaidAtProvider } from "./payment-provider-proof.ts";
import { HOLD_CLOSE_MARGIN_MS } from "./pos-qris-hold.ts";
import { chargeLinkSealAad, guestPaymentDto } from "./qr-order-payment.ts";

const PAY = "pos.payment.accept";
const EDC_SALES_SHOWN = 50;

type ChargeRow = typeof orderIssueCharges.$inferSelect;

export type PosChargeReader = {
  readonly userId: UserId;
  /** The acting cashier's outlet on a shared device, else null. */
  readonly actingOutletId: string | null;
};

const notFound = () =>
  new CoreError("NOT_FOUND", "Tagihan selisih tidak ditemukan.");

const iso = (at: Date | null) => (at ? at.toISOString() : null);

/** True while a lapsed code may still take money (expiry + margin not passed). */
export function codeInMargin(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() + HOLD_CLOSE_MARGIN_MS > now.getTime();
}

async function chargeInReach(
  tx: Tx,
  context: ScopedTenantContext,
  reader: PosChargeReader,
  chargeId: string,
  now: Date,
): Promise<ChargeRow> {
  const [charge] = await tx
    .select()
    .from(orderIssueCharges)
    .where(
      and(
        eq(orderIssueCharges.tenantId, context.tenant.tenantId),
        eq(orderIssueCharges.id, chargeId),
      ),
    )
    .limit(1);
  if (!charge || !isOutletInScope(context.outletScope, charge.outletId))
    throw notFound();
  if (
    reader.actingOutletId !== null &&
    reader.actingOutletId.toLowerCase() !== charge.outletId.toLowerCase()
  )
    throw notFound();
  const snapshot = await accessSnapshotInTransaction(
    tx,
    context,
    reader.userId,
    now,
  );
  if (!snapshot.allows(PAY, { type: "outlet", id: charge.outletId }))
    throw notFound();
  return charge;
}

/** The intent that can still take money, else the charge's last code. */
async function shownIntentOf(
  tx: Tx,
  context: ScopedTenantContext,
  charge: ChargeRow,
): Promise<{ id: string; status: string; expiresAt: Date } | null> {
  const tenantId = context.tenant.tenantId;
  const columns = {
    id: paymentIntents.id,
    status: paymentIntents.status,
    expiresAt: paymentIntents.expiresAt,
  };
  if (charge.paymentLinkId !== null) {
    const live = await tx
      .select(columns)
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, tenantId),
          eq(paymentIntents.paymentLinkId, charge.paymentLinkId),
          inArray(paymentIntents.status, ["paid", "pending"]),
        ),
      )
      .orderBy(desc(paymentIntents.createdAt), desc(paymentIntents.id));
    const shown =
      live.find((row) => row.status === "paid") ??
      live.find((row) => row.id === charge.paymentIntentId) ??
      live[0];
    if (shown) return shown;
  }
  if (charge.paymentIntentId === null) return null;
  const [last] = await tx
    .select(columns)
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.id, charge.paymentIntentId),
      ),
    )
    .limit(1);
  return last ?? null;
}

async function edcSalesOf(
  tx: Tx,
  context: ScopedTenantContext,
  charge: ChargeRow,
) {
  const rows = await tx
    .select({
      id: edcTransactions.id,
      status: edcTransactions.status,
      amountIdr: edcTransactions.amountIdr,
      terminalId: edcTransactions.terminalId,
      terminalLabel: paymentEdcTerminals.terminalId,
      responseCode: edcTransactions.responseCode,
      bank: edcTransactions.bank,
      method: edcTransactions.method,
      mode: edcTransactions.mode,
      message: edcTransactions.message,
      needsReconciliation: edcTransactions.needsReconciliation,
      createdAt: edcTransactions.createdAt,
      completedAt: edcTransactions.completedAt,
    })
    .from(edcTransactions)
    .leftJoin(
      paymentEdcTerminals,
      and(
        eq(paymentEdcTerminals.tenantId, edcTransactions.tenantId),
        eq(paymentEdcTerminals.outletId, edcTransactions.outletId),
        eq(paymentEdcTerminals.id, edcTransactions.terminalId),
      ),
    )
    .where(
      and(
        eq(edcTransactions.tenantId, context.tenant.tenantId),
        eq(edcTransactions.outletId, charge.outletId),
        eq(edcTransactions.type, "sale"),
        eq(edcTransactions.reference, charge.id),
      ),
    )
    .orderBy(desc(edcTransactions.createdAt), desc(edcTransactions.id))
    .limit(EDC_SALES_SHOWN);
  return rows.map((row) => ({
    id: row.id,
    status: edcTransactionStatusSchema.parse(row.status),
    amountIdr: row.amountIdr,
    terminalId: row.terminalId,
    terminalLabel: row.terminalLabel,
    declineReason: row.status === "declined" ? row.message : null,
    responseCode: row.responseCode,
    bank: edcBankSchema.parse(row.bank),
    method: edcMethodSchema.parse(row.method),
    mode: posEdcAttemptSchema.shape.mode.parse(row.mode),
    needsReconciliation: row.needsReconciliation,
    createdAt: row.createdAt.toISOString(),
    completedAt: iso(row.completedAt),
  }));
}

async function swapLinesOf(
  tx: Tx,
  context: ScopedTenantContext,
  charge: ChargeRow,
) {
  const tenantId = context.tenant.tenantId;
  const [issue] = await tx
    .select({
      orderItemId: orderIssues.orderItemId,
      replacementOrderItemId: orderIssues.replacementOrderItemId,
      replacementItemId: orderIssues.replacementItemId,
    })
    .from(orderIssues)
    .where(
      and(
        eq(orderIssues.tenantId, tenantId),
        eq(orderIssues.id, charge.orderIssueId),
      ),
    )
    .limit(1);
  if (!issue) throw notFound();
  const lineOf = async (id: string | null) => {
    if (id === null) return undefined;
    const [line] = await tx
      .select({
        name: orderItems.name,
        quantity: orderItems.quantity,
        lineTotalIdr: orderItems.lineTotalIdr,
      })
      .from(orderItems)
      .where(and(eq(orderItems.tenantId, tenantId), eq(orderItems.id, id)))
      .limit(1);
    return line;
  };
  const original = await lineOf(issue.orderItemId);
  if (!original) throw notFound();
  let replacementName = (await lineOf(issue.replacementOrderItemId))?.name;
  if (replacementName === undefined && issue.replacementItemId !== null) {
    const [menu] = await tx
      .select({ name: menuItems.name })
      .from(menuItems)
      .where(
        and(
          eq(menuItems.tenantId, tenantId),
          eq(menuItems.id, issue.replacementItemId),
        ),
      )
      .limit(1);
    replacementName = menu?.name;
  }
  return {
    original: {
      name: original.name,
      quantity: original.quantity,
      lineTotalIdr: original.lineTotalIdr,
    },
    replacement: {
      name: replacementName ?? original.name,
      quantity: original.quantity,
      lineTotalIdr: original.lineTotalIdr + charge.differenceIdr,
    },
  };
}

async function orderOf(
  tx: Tx,
  context: ScopedTenantContext,
  charge: ChargeRow,
) {
  const tenantId = context.tenant.tenantId;
  const [order] = await tx
    .select({ number: orders.number, tableLabel: tables.code })
    .from(orders)
    .leftJoin(
      tableSessions,
      and(
        eq(tableSessions.tenantId, orders.tenantId),
        eq(tableSessions.id, orders.tableSessionId),
      ),
    )
    .leftJoin(
      tables,
      and(
        eq(tables.tenantId, orders.tenantId),
        eq(tables.id, tableSessions.tableId),
      ),
    )
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, charge.orderId)))
    .limit(1);
  if (!order) throw notFound();
  return order;
}

/** Whether the provider says a lapsed code holds nothing (an unclear answer: no). */
async function providerSaysUnpaid(
  context: ScopedTenantContext,
  linkId: string,
  now: Date,
): Promise<"unpaid" | "settled" | "unsure"> {
  try {
    return await confirmLinkUnpaidAtProvider(context, linkId, now);
  } catch (error) {
    if (
      error instanceof HttpError &&
      error.code === "PAYMENT_PROVIDER_UNCONFIRMED"
    )
      return "unsure";
    throw error;
  }
}

export async function readPosIssueCharge(
  context: ScopedTenantContext,
  reader: PosChargeReader,
  chargeId: string,
  now = new Date(),
): Promise<PosIssueChargeDetail> {
  // A lapsed code of a still-open charge: the provider is asked first, outside
  // any transaction (network I/O), and only then is the charge read.
  let lapsedVerdict: "unpaid" | "settled" | "unsure" | null = null;
  const probe = await withTenant(db, context, async (tx) => {
    const charge = await chargeInReach(tx, context, reader, chargeId, now);
    const shown =
      charge.status === "open" || charge.status === "routed_pos"
        ? await shownIntentOf(tx, context, charge)
        : null;
    return { charge, shown };
  });
  if (
    probe.shown?.status === "pending" &&
    probe.shown.expiresAt <= now &&
    !codeInMargin(probe.shown.expiresAt, now) &&
    probe.charge.paymentLinkId !== null
  )
    lapsedVerdict = await providerSaysUnpaid(
      context,
      probe.charge.paymentLinkId,
      now,
    );

  const read = await withTenant(db, context, async (tx) => {
    const charge = await chargeInReach(tx, context, reader, chargeId, now);
    const shown = await shownIntentOf(tx, context, charge);
    const order = await orderOf(tx, context, charge);
    const lines = await swapLinesOf(tx, context, charge);
    const edcSales = await edcSalesOf(tx, context, charge);
    return { charge, shown, order, lines, edcSales };
  });
  const { charge, shown, order, lines, edcSales } = read;

  let payment: GuestPayment | null = null;
  if (shown && charge.paymentLinkTokenSealed !== null) {
    const token = openSecret(
      charge.paymentLinkTokenSealed,
      chargeLinkSealAad(context.tenant.tenantId, charge.id),
    );
    const view = await readIntentView(context, token, shown.id, now);
    payment = guestPaymentDto(view, { kind: "issue_charge", chargeId });
    // A lapsed code is dead only after its margin and the provider's word.
    const stillPayable =
      shown.status === "pending" &&
      (codeInMargin(shown.expiresAt, now) ||
        lapsedVerdict !== "unpaid" ||
        probe.shown?.id !== shown.id);
    if (stillPayable && payment.status === "expired")
      payment = { ...payment, status: "pending" };
  }

  return posIssueChargeDetailSchema.parse({
    id: charge.id,
    orderId: charge.orderId,
    status: charge.status,
    differenceIdr: charge.differenceIdr,
    amountIdr: charge.amountIdr,
    paidAt: iso(charge.paidAt),
    orderNumber: order.number,
    tableLabel: order.tableLabel ?? null,
    original: lines.original,
    replacement: lines.replacement,
    payment,
    edcSales,
  });
}
