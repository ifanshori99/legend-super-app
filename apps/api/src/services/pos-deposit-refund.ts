import { idr, type ScopedTenantContext } from "@starter/shared/core";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  journalEntries,
  paymentIntents,
  posDepositRefunds,
} from "../db/schema/index.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  backingStateOf,
  postedIntentReceiptCreditOf,
} from "./accounting-auto-journal-guards.ts";
import { receiptKeyOf } from "./accounting-auto-journal-amounts.ts";
import { lockIntentsForFact } from "./payment-refund-fact-time.ts";
import type { Tx } from "./permission-resolver.ts";
import {
  posRefundGatewayKey,
  requestPosRefundGatewayPart,
} from "./pos-refund-gateway.ts";
import { listSessionDepositSources } from "./reservation-deposit-credit.ts";

const sourceFailure = () =>
  new HttpError(
    409,
    "DP_REFUND_SOURCE_UNVERIFIED",
    "Sumber pembayaran DP belum dapat diverifikasi; refund DP harus melalui pembayaran asal.",
  );

/** Permanent release, including a failed payout awaiting original-route retry. */
export async function depositRefundedOfOrder(
  tx: Tx,
  context: ScopedTenantContext,
  orderId: string,
): Promise<number> {
  const rows = await tx
    .select({ amountIdr: posDepositRefunds.amountIdr })
    .from(posDepositRefunds)
    .where(
      and(
        eq(posDepositRefunds.tenantId, context.tenant.tenantId),
        eq(posDepositRefunds.orderId, orderId),
      ),
    );
  return rows.reduce((total, row) => total + Number(row.amountIdr), 0);
}

/** Deposit part each POS refund of the order released, keyed by refund id. */
export async function depositRefundedByPosRefund(
  tx: Tx,
  context: ScopedTenantContext,
  orderId: string,
): Promise<Map<string, number>> {
  const rows = await tx
    .select({
      posRefundId: posDepositRefunds.posRefundId,
      amountIdr: posDepositRefunds.amountIdr,
    })
    .from(posDepositRefunds)
    .where(
      and(
        eq(posDepositRefunds.tenantId, context.tenant.tenantId),
        eq(posDepositRefunds.orderId, orderId),
      ),
    );
  const byRefund = new Map<string, number>();
  for (const row of rows)
    byRefund.set(
      row.posRefundId,
      (byRefund.get(row.posRefundId) ?? 0) + Number(row.amountIdr),
    );
  return byRefund;
}

/** Source fact lock precedes approval and the immutable native return row. */
export async function depositRefundFactTime(
  tx: Tx,
  context: ScopedTenantContext,
  order: { tableSessionId: string | null },
  now: Date,
): Promise<Date> {
  if (!order.tableSessionId) throw sourceFailure();
  const sources = (
    await listSessionDepositSources(
      tx,
      context.tenant.tenantId,
      order.tableSessionId,
    )
  ).filter((source) => source.amountIdr > 0);
  const ids = [...new Set(sources.map((source) => source.paymentIntentId))];
  if (ids.length !== 1) throw sourceFailure();
  return lockIntentsForFact(tx, context.tenant.tenantId, ids, now);
}

/**
 * Releases DP only together with an exact WS-05 request on its original intent.
 * The caller holds the order lock and has inserted the immutable POS return.
 * A source/evidence shortfall rolls back the entire return, including cash.
 */
export async function requestPosRefundDepositPart(
  tx: Tx,
  context: ScopedTenantContext,
  input: Parameters<typeof requestPosRefundGatewayPart>[2] & {
    order: Parameters<typeof requestPosRefundGatewayPart>[2]["order"] & {
      tableSessionId: string | null;
      depositAppliedIdr: number;
    };
    amountIdr: number;
  },
): Promise<{ method: string; amountIdr: number }[]> {
  if (input.amountIdr <= 0) return [];
  if (!input.order.tableSessionId) throw sourceFailure();
  const tenantId = context.tenant.tenantId;
  const sources = (
    await listSessionDepositSources(tx, tenantId, input.order.tableSessionId)
  ).filter((source) => source.amountIdr > 0);
  if (
    sources.reduce((total, row) => total + row.amountIdr, 0) <
    input.order.depositAppliedIdr
  )
    throw sourceFailure();
  const ids = [
    ...new Set(sources.map((source) => source.paymentIntentId)),
  ].sort();
  // The order records its total DP, without a per-intent payer allocation.
  // More than one original receipt cannot prove which payer funded this order.
  if (ids.length !== 1) throw sourceFailure();
  // Fact time was frozen before the native return row was inserted. Re-lock
  // here without advancing from that same transaction's own return fact.
  const intents = await tx
    .select()
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        inArray(paymentIntents.id, ids),
      ),
    )
    .orderBy(paymentIntents.id)
    .for("update");
  const prior = await tx
    .select()
    .from(posDepositRefunds)
    .where(
      and(
        eq(posDepositRefunds.tenantId, tenantId),
        eq(posDepositRefunds.orderId, input.order.id),
      ),
    );
  let left = input.amountIdr;
  const depositLines: { method: string; amountIdr: number }[] = [];
  for (const source of sources) {
    if (left <= 0) break;
    const used = prior
      .filter((row) => row.paymentIntentId === source.paymentIntentId)
      .reduce((total, row) => total + Number(row.amountIdr), 0);
    const amount = Math.min(left, Math.max(0, source.amountIdr - used));
    if (amount <= 0) continue;
    const intent = intents.find((row) => row.id === source.paymentIntentId);
    if (
      !intent ||
      intent.outletId !== input.order.outletId ||
      intent.edcTransactionId !== null ||
      !intent.paidAt ||
      !["paid", "partially_refunded"].includes(intent.status) ||
      !["qris", "card", "ewallet", "va", "bank_transfer", "paylater"].includes(
        intent.method,
      ) ||
      input.lines.some(
        (line) => line.paymentIntentId === intent.id && line.amountIdr > 0,
      ) ||
      (await backingStateOf(tx, tenantId, {
        kind: "intent",
        intentId: intent.id,
      })) !== "posted"
    )
      throw sourceFailure();
    // Reversals lock their source entry too. Keep the original receipt stable
    // until this refund commitment is durable, then reject any reversed source.
    const [receipt] = await tx
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.tenantId, tenantId),
          eq(journalEntries.idempotencyKey, receiptKeyOf(intent.id)),
        ),
      )
      .for("share");
    if (!receipt) throw sourceFailure();
    const [reversal] = await tx
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.tenantId, tenantId),
          eq(journalEntries.reversalOf, receipt.id),
        ),
      )
      .limit(1);
    if (
      reversal ||
      (await postedIntentReceiptCreditOf(tx, tenantId, intent.id)) <
        BigInt(input.order.depositAppliedIdr)
    )
      throw sourceFailure();
    await tx.insert(posDepositRefunds).values({
      tenantId,
      outletId: input.order.outletId,
      orderId: input.order.id,
      posRefundId: input.posRefundId,
      paymentIntentId: intent.id,
      amountIdr: idr(amount),
      releasedAt: input.now,
    });
    await requestPosRefundGatewayPart(tx, context, {
      ...input,
      lines: [],
      depositParts: [{ paymentIntentId: intent.id, amountIdr: amount }],
    });
    const result = await tx.execute(sql`
      SELECT r.amount_idr::text AS amount
        FROM payment_admin_idempotency k
        JOIN payment_refunds r ON r.tenant_id = k.tenant_id
          AND r.id::text = k.response->>'refundId'
       WHERE k.tenant_id = ${tenantId}
         AND k.key = ${posRefundGatewayKey(input.posRefundId, intent.id)}
         AND r.payment_intent_id = ${intent.id}::uuid
         AND r.status <> 'failed'
    `);
    if (BigInt(String(result.rows[0]?.amount ?? "0")) !== BigInt(amount))
      throw sourceFailure();
    left -= amount;
    depositLines.push({ method: intent.method, amountIdr: amount });
  }
  if (left !== 0) throw sourceFailure();
  return depositLines;
}
