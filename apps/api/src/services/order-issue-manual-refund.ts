// legend-uyw0v (980): what a manual refund of one order line may pay, and when
// it is refused. Called by `reportOrderIssue` before the approval is spent, in
// the report's transaction. "Jangan sampai rugi": every doubt refuses.
//
// - The line must be billed (not voided) and the order paid: a POS bill is
//   `completed` and has a captured tender.
// - Amount = what the guest paid for the line, not `line_total_idr`: the line's
//   cumulative pro-rata share of the order's gross, discount, service and PBJT
//   (founder Q85, the same `recoveryRefundSplit` rule as the ORD-09 refund), so a
//   discounted order refunds less than the sticker price. The share is
//   cumulative over the order's other live manual refunds (telescoping), so
//   all of them together never exceed the bill. The approval is bound to
//   exactly this amount.
// - Exclusive with the POS refund per order (restrictive, founder to review):
//   an order with any POS refund, or any non-failed ORD-09 refund that is not
//   one of its live route manual refunds, refuses a manual refund (409); the
//   POS refund and the cash void refuse an order with a live route manual
//   refund (pos-order-corrections). A route refund is one made here, not an
//   ORD-09 failed-item manual issue (order-issue-route-refund.ts): that one
//   sends the guest to the POS refund, so it does not block it.
//   So a line is never refunded twice, once by items and once manually.
// - Room: the amount, the order's other live manual refunds and the ORD-09
//   refunds of those issues never exceed what the order took in. ORD-09
//   refunds belong to manual-refund issues, so those count once, as the larger
//   of the two.
// - A live CRM promo re-prices the order when its lines return
//   (`recomputeAfterPartialRefund`, which writes); the amount cannot be
//   previewed without that write, so the line goes through the POS refund.

import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  CoreError,
  ulidToUuid,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import { orderIssues } from "../db/schema/kds-issues.ts";
import { accessTickets } from "../db/schema/facility.ts";
import { facilityTicketPosLines } from "../db/schema/facility-pos-ticket.ts";
import { posOrderRefunds } from "../db/schema/pos-order.ts";
import { orderItems, orders } from "../db/schema/qr-order.ts";
import { HttpError } from "../lib/http-error.ts";
import type { Tx } from "./menu-internals.ts";
import { orderPromoPartialRefundPort } from "./order-promo-refund.ts";
import { liveRouteManualRefundWhere } from "./order-issue-route-refund.ts";
import { recoveryRefundSplit } from "./order-recovery-refund-amount.ts";
import { OrderRevenueMismatch } from "./order-revenue.ts";
import { providerRefundedForeignIdrSql } from "./payment-provider-refunded-foreign-sql.ts";

const refuse = (message: string) =>
  new HttpError(422, "VALIDATION_ERROR", message);

const conflict = (message: string) =>
  new HttpError(409, "REFUND_CONFLICT", message);

const asNumber = (value: unknown): number => Number(String(value ?? "0"));

/**
 * 936 (legend-hpgyw, F2): a line that sold a facility ticket not refunded or
 * cancelled (access ticket `issued`, `in_use`, `completed`, `no_show`, ...) is
 * not refunded by hand: the guest would keep or use the ticket and get the
 * money back. Refused 409, nothing
 * written. The ticket row is locked FOR UPDATE after its POS line (the order of
 * the ticket refund hook), and the door check locks the same ticket row, so a
 * door check cannot slip between this check and the end of the transaction.
 * A refunded or cancelled ticket, or a line with no ticket, is unaffected.
 */
export async function assertNoLiveTicketOnLine(
  tx: Tx,
  tenantId: TenantId,
  orderItemId: string,
): Promise<void> {
  const [linked] = await tx
    .select({ accessTicketId: facilityTicketPosLines.accessTicketId })
    .from(facilityTicketPosLines)
    .where(
      and(
        eq(facilityTicketPosLines.tenantId, tenantId),
        eq(facilityTicketPosLines.orderItemId, orderItemId),
      ),
    )
    .limit(1)
    .for("update");
  if (!linked) return;
  const [ticket] = await tx
    .select({ status: accessTickets.status })
    .from(accessTickets)
    .where(
      and(
        eq(accessTickets.tenantId, tenantId),
        eq(accessTickets.id, linked.accessTicketId),
      ),
    )
    .limit(1)
    .for("update");
  if (ticket && ticket.status !== "refunded" && ticket.status !== "cancelled")
    throw new HttpError(
      409,
      "TICKET_LIVE_NO_MANUAL_REFUND",
      "Tiket fasilitas pada item ini masih berlaku. Refund manual ditolak; batalkan tiketnya lewat refund kasir.",
    );
}

/**
 * The exact amount a manual refund of this line pays. Throws 422 (nothing
 * written) when the refund is not allowed. Locks the order row, so two manual
 * refunds of one order are checked one after the other against the same room.
 */
export async function manualRefundAmountIdr(
  tx: Tx,
  context: ScopedTenantContext,
  orderId: string,
  line: { lineTotalIdr: number; voided: boolean },
): Promise<number> {
  const tenantId = context.tenant.tenantId;
  if (line.voided)
    throw refuse(
      "Item yang sudah di-void tidak bisa direfund: tidak ada uang yang dibayar untuk item ini.",
    );
  const [order] = await tx
    .select({
      status: orders.status,
      subtotalIdr: orders.subtotalIdr,
      discountIdr: orders.discountIdr,
      serviceChargeIdr: orders.serviceChargeIdr,
      taxIdr: orders.taxIdr,
      roundingIdr: orders.roundingIdr,
      totalIdr: orders.totalIdr,
      pricesIncludeTax: orders.pricesIncludeTax,
      depositAppliedIdr: orders.depositAppliedIdr,
    })
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)))
    .for("update");
  if (!order || order.status !== "completed")
    throw refuse("Refund manual hanya untuk pesanan yang sudah dibayar.");

  // Money the guest paid for the order, per tender. A tender backed by a
  // payment intent loses what the provider refunded on its own (967, a refund
  // in the provider dashboard): `providerRefundedForeignIdrSql`, the same rule
  // `netAllocatedIdrSql` reads. Net per intent, never below 0. An intent the
  // provider answered refunded (`provider_refunded_at`, or
  // `provider_refunded_after_paid_at`) with no recorded amount is uncertain:
  // refused (restrictive).
  // 936 (legend-hpgyw, decision 1): a points tender is not money. It is left
  // out here, so a bill paid fully with points has nothing to refund by hand
  // and a mixed bill is bound by its non-points part only.
  const tenderRows = await tx.execute(sql`
    SELECT sum(t.amount_idr)::text AS amount,
           t.payment_intent_id IS NOT NULL AS has_intent,
           ${providerRefundedForeignIdrSql(sql`${tenantId}::uuid`, sql`t.payment_intent_id`)}::text AS provider_refunded,
           coalesce(bool_or(i.provider_refunded_after_paid_at IS NOT NULL
                            OR i.provider_refunded_at IS NOT NULL), false) AS refunded_flag
      FROM pos_order_tenders t
      LEFT JOIN payment_intents i
        ON i.tenant_id = t.tenant_id AND i.id = t.payment_intent_id
     WHERE t.tenant_id = ${tenantId}
       AND t.order_id = ${ulidToUuid(orderId)}::uuid
       AND t.status = 'captured'
       AND t.method <> 'points'
     GROUP BY t.payment_intent_id
  `);
  let grossPaidIdr = 0;
  let paidIdr = 0;
  let uncertain = false;
  for (const row of tenderRows.rows) {
    const amount = asNumber(row.amount);
    const providerRefunded = asNumber(row.provider_refunded);
    grossPaidIdr += amount;
    if (row.has_intent !== true) {
      paidIdr += amount;
      continue;
    }
    // The flag means "no second refund may be paid" and is also set by paths
    // that record no amount (full `refunded` answer, cap exceeded), so it
    // blocks whatever amount is recorded.
    if (row.refunded_flag === true) uncertain = true;
    paidIdr += Math.max(amount - providerRefunded, 0);
  }
  if (grossPaidIdr <= 0)
    throw refuse("Refund manual hanya untuk pesanan yang sudah dibayar.");
  if (uncertain)
    throw new HttpError(
      409,
      "PROVIDER_REFUND_STATUS_UNKNOWN",
      "Penyedia pembayaran sudah mengembalikan uang pesanan ini, tetapi jumlahnya belum tercatat. Refund manual ditolak; hubungi penyedia pembayaran untuk memastikan, lalu coba lagi.",
    );
  if (paidIdr <= 0)
    throw conflict(
      "Penyedia pembayaran sudah mengembalikan seluruh uang pesanan ini. Refund manual ditolak agar uang yang sama tidak dikembalikan dua kali.",
    );

  if (
    await orderPromoPartialRefundPort.livePromoApplicationOf(
      tx,
      context,
      orderId,
    )
  )
    throw refuse(
      "Pesanan berpromo direfund lewat refund kasir, bukan refund manual.",
    );

  // Mutually exclusive with the POS refund per order (legend-980, restrictive):
  // a POS refund counts items and amounts by its own rules, so a manual refund
  // after one could pay a line, or the service charge and PBJT of it, twice.
  const [posRefundRow] = await tx
    .select({ id: posOrderRefunds.id })
    .from(posOrderRefunds)
    .where(
      and(
        eq(posOrderRefunds.tenantId, tenantId),
        eq(posOrderRefunds.orderId, orderId),
      ),
    )
    .limit(1);
  if (posRefundRow)
    throw conflict(
      "Pesanan ini sudah punya refund kasir. Refund manual per item ditolak agar uang yang sama tidak dikembalikan dua kali.",
    );

  // A provider or payout refund (ORD-09) that is not one of this order's live
  // route manual refunds (a failed-item refund, an ORD-09 manual issue's, a
  // rejected or cancelled issue's) may have moved money for the same lines:
  // refused, same reason. A failed refund paid nothing.
  const foreignOrd09 = await tx.execute(sql`
    SELECT 1
      FROM payment_refunds r
      JOIN order_issues i
        ON i.tenant_id = r.tenant_id AND i.id = r.order_issue_id
     WHERE r.tenant_id = ${tenantId}
       AND i.order_id = ${ulidToUuid(orderId)}::uuid
       AND r.status <> 'failed'
       AND NOT (i.resolution = 'manual_refund'
                AND i.approval_request_id IS NULL
                AND i.status <> 'cancelled'
                AND i.refund_rejected_at IS NULL)
     LIMIT 1
  `);
  if (foreignOrd09.rows.length > 0)
    throw conflict(
      "Pesanan ini sudah punya refund ke penyedia pembayaran untuk item lain. Refund manual per item ditolak agar uang yang sama tidak dikembalikan dua kali.",
    );

  // ORD-09: per issue the largest refund that is not failed (same rule as the
  // failed-item refund's `released`).
  const ord09Result = await tx.execute(sql`
    SELECT coalesce(sum(m.amt), 0)::text AS released
      FROM (
      SELECT max(r.amount_idr) AS amt
        FROM payment_refunds r
        JOIN order_issues i
          ON i.tenant_id = r.tenant_id AND i.id = r.order_issue_id
       WHERE r.tenant_id = ${tenantId}
         AND i.order_id = ${ulidToUuid(orderId)}::uuid
       GROUP BY r.order_issue_id
      HAVING coalesce(bool_or(r.status <> 'failed'), false)) m
  `);
  const ord09Idr = asNumber(ord09Result.rows[0]?.released);

  // The order's other live route manual refunds (not ORD-09 ones, which the
  // cashier refunds, see order-issue-route-refund.ts): their lines, as one
  // cumulative base.
  const [others] = await tx
    .select({
      lines: sql<string>`coalesce(sum(${orderItems.lineTotalIdr}), 0)::text`,
    })
    .from(orderIssues)
    .innerJoin(
      orderItems,
      and(
        eq(orderItems.tenantId, orderIssues.tenantId),
        eq(orderItems.id, orderIssues.orderItemId),
      ),
    )
    .where(
      and(
        liveRouteManualRefundWhere(tenantId),
        eq(orderIssues.orderId, orderId),
      ),
    );
  const priorLinesIdr = asNumber(others?.lines);

  let amountIdr: number;
  let othersIdr = 0;
  try {
    const share = (lineTotalIdr: number, prior: number) =>
      recoveryRefundSplit({
        order,
        lineTotalIdr,
        priorLinesIdr: prior,
        releasedIdr: 0,
      }).wantedIdr;
    if (priorLinesIdr > 0) othersIdr = share(priorLinesIdr, 0);
    amountIdr = share(line.lineTotalIdr, priorLinesIdr);
  } catch (error) {
    // Amounts that fail their tax-mode identity: never guessed into a refund.
    if (error instanceof OrderRevenueMismatch)
      throw refuse("Jumlah pesanan tidak konsisten; refund manual ditolak.");
    throw error;
  }
  if (amountIdr <= 0)
    throw refuse("Tidak ada uang yang dibayar untuk item ini.");

  const committedIdr = Math.max(othersIdr, ord09Idr);
  if (committedIdr + amountIdr > paidIdr)
    throw refuse(
      "Refund manual melebihi uang yang dibayar untuk pesanan ini setelah refund yang sudah ada.",
    );
  return amountIdr;
}

/**
 * legend-980: a line that already has a live manual refund (any issue type,
 * from the approval route or ORD-09) is paid back: a voucher, a swap or a new
 * failed-item report on it would pay the guest a second time. Live = not
 * cancelled, refund not rejected (a rejected one gave nothing back). Locks the
 * order row, the lock `manualRefundAmountIdr` takes, so a manual refund
 * racing this check is serialized with it. Shared by the ORD-08 settlement and
 * the staff apology voucher.
 */
export async function assertLineNotManuallyRefunded(
  tx: Tx,
  tenantId: TenantId,
  orderId: string,
  orderItemId: string,
): Promise<void> {
  await tx
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)))
    .for("update");
  const [refunded] = await tx
    .select({ id: orderIssues.id })
    .from(orderIssues)
    .where(
      and(
        eq(orderIssues.tenantId, tenantId),
        eq(orderIssues.orderItemId, orderItemId),
        eq(orderIssues.resolution, "manual_refund"),
        ne(orderIssues.status, "cancelled"),
        isNull(orderIssues.refundRejectedAt),
      ),
    )
    .limit(1);
  if (refunded)
    throw new CoreError(
      "CONFLICT",
      "Item ini sudah direfund manual; tidak bisa dilaporkan lagi atau diganti voucher atau swap.",
    );
}

/**
 * legend-980 (M1, M2): the report route's manual refund is refused for a line
 * that has any issue not cancelled which is still open (a failed-item report
 * waiting for its voucher or swap) or already settled by a voucher or a swap:
 * the guest gets one compensation per line (restrictive). Takes the order row
 * lock first, the same lock the apology voucher and the ORD-08 settlement take
 * before they check the line, so the check and the refund are serialized with
 * them; the check is read after the lock.
 */
export async function assertLineHasNoOtherCompensation(
  tx: Tx,
  tenantId: TenantId,
  orderId: string,
  orderItemId: string,
): Promise<void> {
  await tx
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)))
    .for("update");
  const [other] = await tx
    .select({ id: orderIssues.id })
    .from(orderIssues)
    .where(
      and(
        eq(orderIssues.tenantId, tenantId),
        eq(orderIssues.orderItemId, orderItemId),
        ne(orderIssues.status, "cancelled"),
        or(
          eq(orderIssues.status, "open"),
          inArray(orderIssues.resolution, ["voucher", "swap"]),
        ),
      ),
    )
    .limit(1);
  if (other)
    throw conflict(
      "Item ini punya laporan yang masih terbuka atau sudah diganti voucher atau swap; refund manual ditolak agar tidak dibayar dua kali.",
    );
}
