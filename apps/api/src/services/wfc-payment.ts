// A WFC sale must match a real, unused payment capture (legend-bz9h round 2
// item 1, round 3 C1/C2/H1/H2). Nobody types an amount: the caller names a
// payment reference and this helper proves, inside the sale's own transaction,
// that it is money the outlet really received for THIS product.
//
// Signature (shared by seat reservations, day passes and bundles):
//   requireCapturedPayment(tx, context, {
//     outletId, paymentRef, priceIdr,
//     menuItemId,        // menu item of the product/bundle (null/undefined: never payable)
//     saleKind,          // 'seat_reservation' | 'day_pass' | 'bundle'
//     saleId,            // id the sale row will be inserted with (generate it first)
//     customerProfileId, // informational; the caller does its own replay lookup
//   })
// `findLedgerSale(tx, context, {outletId, paymentRef})` answers "which sale did
// this payment (any alias/case) already fund?" for replay handling.
// `productMenuItemId` is accepted as an alias of `menuItemId`. When `saleKind`
// and `saleId` are both given the capture is written to the ledger in the same
// transaction (insert the sale with that `saleId` afterwards, in the same
// transaction); without them the call only checks.
//
// Only a POS tender proves payment (`payment_intents` never do: nothing ties an
// intent to its use). A usable tender is, for the same tenant AND outlet:
// status 'captured', amount_idr >= price, on a non-training POS order that has
// a NON-voided order line for the product's menu item (409
// PAYMENT_NOT_CAPTURED otherwise, one generic message, so the answer never
// reveals whether a reference exists elsewhere). The reference is matched by
// tender id or by tender reference, in any letter case.
//
// One capture funds ONE sale (409 PAYMENT_ALREADY_USED): the ledger
// `wfc_payment_captures` is keyed by tenant + capture_key, where capture_key =
// lowercase(coalesce(tender.payment_intent_id, tender.id)), so every alias of a
// payment maps to one row, across all three sale kinds. One order line cannot
// fund more sales than its quantity (H1): ledger rows of the same
// (tenant, order, menu item) must stay below the sum of the non-voided
// quantities. Two transaction-scoped advisory locks (capture key, then order
// line) serialize concurrent sales so the loser sees the winner's committed
// row; the primary key of the ledger is the last line of defence.
import { sql } from "drizzle-orm";
import {
  outletIdSchema,
  type ScopedTenantContext,
  ulidToUuid,
  uuidToUlid,
} from "@starter/shared/core";
import { wfcPaymentCaptures } from "../db/schema/wfc-payment-capture.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  PG_UNIQUE_VIOLATION,
  pgErrorCode,
  type Tx,
} from "./facility-shared.ts";
import { lockPosOrder } from "./pos-order-support.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type WfcSaleKind = "seat_reservation" | "day_pass" | "bundle";

export type RequireCapturedPaymentInput = {
  outletId: string;
  paymentRef: string;
  /** The server price the capture must cover. */
  priceIdr: number;
  /** Menu item of the product or bundle; without it nothing can be bought. */
  menuItemId?: string | null;
  /** Alias of `menuItemId`. */
  productMenuItemId?: string | null;
  /** With `saleId`: write the ledger row in this transaction. */
  saleKind?: WfcSaleKind;
  saleId?: string;
  customerProfileId?: string;
};

export type CapturedPayment = {
  source: "pos_tender";
  /** Row id of the tender. */
  captureId: string;
  /** Lowercase ledger key (payment intent id when linked, else tender id). */
  captureKey: string;
  /** POS order (uuid form) and menu item the capture paid for. */
  orderId: string;
  menuItemId: string;
};

export const paymentNotCaptured = () =>
  new HttpError(
    409,
    "PAYMENT_NOT_CAPTURED",
    "Pembayaran belum diterima atau tidak valid untuk transaksi ini.",
  );

export const paymentAlreadyUsed = () =>
  new HttpError(
    409,
    "PAYMENT_ALREADY_USED",
    "Pembayaran ini sudah dipakai untuk transaksi lain.",
  );

type TenderMatch = {
  id: string;
  order_id: string;
  capture_key: string;
  quantity: number;
};

/** SQL condition: tender `t` is the one `ref` names (id or reference, any case). */
const tenderRefMatch = (ref: string) =>
  UUID_PATTERN.test(ref)
    ? sql`(t.id = ${ref}::uuid OR lower(t.reference) = lower(${ref}))`
    : sql`lower(t.reference) = lower(${ref})`;

/**
 * The sale (if any) already recorded in the ledger for the payment `paymentRef`
 * names, whatever alias or letter case was used. Callers use it to answer a
 * replay (same product/bundle + customer) with the first sale; the tender need
 * not be usable for the new request.
 */
export async function findLedgerSale(
  tx: Tx,
  context: ScopedTenantContext,
  input: { outletId: string; paymentRef: string },
): Promise<{ saleKind: WfcSaleKind; saleId: string } | null> {
  const result = await tx.execute(sql`
    SELECT c.sale_kind AS "saleKind", c.sale_id::text AS "saleId"
      FROM pos_order_tenders t
      JOIN wfc_payment_captures c
        ON c.tenant_id = t.tenant_id
       AND c.capture_key = lower(coalesce(t.payment_intent_id, t.id)::text)
     WHERE t.tenant_id = ${context.tenant.tenantId}
       AND t.outlet_id = ${outletIdSchema.parse(input.outletId)}
       AND ${tenderRefMatch(input.paymentRef)}
     ORDER BY t.id
     LIMIT 1`);
  return (
    (result.rows[0] as { saleKind: WfcSaleKind; saleId: string } | undefined) ??
    null
  );
}

async function findTender(
  tx: Tx,
  context: ScopedTenantContext,
  input: RequireCapturedPaymentInput,
  menuItemId: string,
): Promise<TenderMatch | null> {
  const outletId = outletIdSchema.parse(input.outletId);
  const refMatch = tenderRefMatch(input.paymentRef);
  const result = await tx.execute(sql`
    SELECT t.id::text AS id,
           t.order_id::text AS order_id,
           lower(coalesce(t.payment_intent_id, t.id)::text) AS capture_key,
           (SELECT coalesce(sum(oi.quantity), 0)::int
              FROM order_items oi
             WHERE oi.tenant_id = t.tenant_id
               AND oi.order_id = t.order_id
               AND oi.menu_item_id = ${menuItemId}::uuid
               AND oi.status <> 'voided'
               AND oi.line_total_idr >= ${input.priceIdr}::bigint * oi.quantity) AS quantity
      FROM pos_order_tenders t
      JOIN pos_orders po
        ON po.tenant_id = t.tenant_id AND po.order_id = t.order_id
      JOIN orders o
        ON o.tenant_id = t.tenant_id AND o.id = t.order_id
     WHERE t.tenant_id = ${context.tenant.tenantId}
       AND t.outlet_id = ${outletId}
       AND t.status = 'captured'
       -- D1: only an order paid in full and final proves the payment.
       AND o.status = 'completed'
       AND t.amount_idr >= ${input.priceIdr}
       AND po.is_training = false
       AND ${refMatch}
       AND EXISTS (
         SELECT 1 FROM order_items oi
          WHERE oi.tenant_id = t.tenant_id
            AND oi.order_id = t.order_id
            AND oi.menu_item_id = ${menuItemId}::uuid
            AND oi.status <> 'voided'
            AND oi.line_total_idr >= ${input.priceIdr}::bigint * oi.quantity)
       -- A corrected sale stays captured with live lines (POS-04 only adds a
       -- void/refund row), so any void or refund of the order disqualifies it.
       AND NOT EXISTS (
         SELECT 1 FROM pos_order_voids v
          WHERE v.tenant_id = t.tenant_id AND v.order_id = t.order_id)
       AND NOT EXISTS (
         SELECT 1 FROM pos_order_refunds r
          WHERE r.tenant_id = t.tenant_id AND r.order_id = t.order_id)
       -- A discounted order paid less than its line prices: refuse (cap payment).
       AND NOT EXISTS (
         SELECT 1 FROM pos_order_discounts d
          WHERE d.tenant_id = t.tenant_id AND d.order_id = t.order_id
            AND d.removed_at IS NULL)
     ORDER BY t.id
     LIMIT 1`);
  return (result.rows[0] as TenderMatch | undefined) ?? null;
}

/**
 * Proves, inside the caller's transaction, that `paymentRef` is a real
 * captured POS tender of at least `priceIdr` for the product's menu item that
 * no WFC sale has used yet, and (given `saleKind` + `saleId`) records it in the
 * ledger. Throws 409 PAYMENT_NOT_CAPTURED or PAYMENT_ALREADY_USED. The caller
 * stores the price (never the captured amount) as paid.
 */
export async function requireCapturedPayment(
  tx: Tx,
  context: ScopedTenantContext,
  input: RequireCapturedPaymentInput,
): Promise<CapturedPayment> {
  const menuItemId = input.menuItemId ?? input.productMenuItemId;
  if (!menuItemId) throw paymentNotCaptured();
  const candidate = await findTender(tx, context, input, menuItemId);
  if (!candidate) throw paymentNotCaptured();
  const tenantId = context.tenant.tenantId;

  // D2: take the SAME lock as the POS corrections (orders, then pos_orders FOR
  // UPDATE; lock order in pos-order-support.ts) before any WFC advisory lock,
  // then re-check: a void/refund that committed while we waited disqualifies
  // the tender.
  await lockPosOrder(
    tx,
    context,
    outletIdSchema.parse(input.outletId),
    uuidToUlid(candidate.order_id),
  );
  const tender = await findTender(tx, context, input, menuItemId);
  // The re-check must land on the order that was locked (two tenders can share
  // an EDC reference): any other order is not locked, so it proves nothing.
  if (!tender || tender.order_id !== candidate.order_id)
    throw paymentNotCaptured();

  // Serialize every sale funded by this capture, then by this order line.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`wfc-capture:${tenantId}:${tender.capture_key}`}, 0))`,
  );
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`wfc-line:${tenantId}:${tender.order_id}:${menuItemId}`}, 0))`,
  );

  const used = await tx.execute(sql`
    SELECT
      EXISTS (SELECT 1 FROM wfc_payment_captures
               WHERE tenant_id = ${tenantId}
                 AND capture_key = ${tender.capture_key}) AS key_used,
      (SELECT count(*)::int FROM wfc_payment_captures
        WHERE tenant_id = ${tenantId}
          AND order_id = ${tender.order_id}::uuid
          AND menu_item_id = ${menuItemId}::uuid) AS line_sales`);
  const { key_used: keyUsed, line_sales: lineSales } = used.rows[0] as {
    key_used: boolean;
    line_sales: number;
  };
  if (keyUsed || lineSales >= tender.quantity) throw paymentAlreadyUsed();

  if (input.saleKind && input.saleId) {
    const { saleKind, saleId } = input;
    try {
      await tx.transaction((savepoint) =>
        savepoint.insert(wfcPaymentCaptures).values({
          tenantId: context.tenant.tenantId,
          outletId: outletIdSchema.parse(input.outletId),
          captureKey: tender.capture_key,
          saleKind,
          saleId,
          orderId: tender.order_id,
          menuItemId,
        }),
      );
    } catch (error) {
      if (pgErrorCode(error) === PG_UNIQUE_VIOLATION)
        throw paymentAlreadyUsed();
      throw error;
    }
  }
  return {
    source: "pos_tender",
    captureId: tender.id,
    captureKey: tender.capture_key,
    orderId: tender.order_id,
    menuItemId,
  };
}

export const wfcSaleActive = () =>
  new HttpError(
    409,
    "WFC_SALE_ACTIVE",
    "Penjualan WFC dari pembayaran ini masih aktif; batalkan dulu.",
  );

/**
 * D11: a POS void/refund of an order must not take back money that funds a
 * live WFC sale. Active = a sale not yet refunded: seat reservation of any
 * status but refunded (a cancelled one still holds its paid money), day pass
 * not refunded, bundle purchase not refunded IN FULL (a partial WFC refund
 * returns only the unused value; the used value stays paid). Call it right
 * after the order is locked, before any money moves. Throws 409 WFC_SALE_ACTIVE.
 */
export async function assertNoActiveWfcSale(
  tx: Tx,
  tenantId: string,
  /** The POS order id, as the POS code carries it: a ULID. */
  orderUlid: string,
): Promise<void> {
  const orderId = ulidToUuid(orderUlid);
  const result = await tx.execute(sql`
    SELECT 1
      FROM wfc_payment_captures c
     WHERE c.tenant_id = ${tenantId}
       AND c.order_id = ${orderId}::uuid
       AND (
         (c.sale_kind = 'seat_reservation' AND EXISTS (
            SELECT 1 FROM wfc_seat_reservations r
             WHERE r.tenant_id = c.tenant_id AND r.id = c.sale_id
               AND r.status <> 'refunded'))
         OR (c.sale_kind = 'day_pass' AND EXISTS (
            SELECT 1 FROM wfc_day_pass_purchases d
             WHERE d.tenant_id = c.tenant_id AND d.id = c.sale_id
               AND d.status <> 'refunded'))
         OR (c.sale_kind = 'bundle' AND EXISTS (
            SELECT 1 FROM wfc_bundle_purchases b
             WHERE b.tenant_id = c.tenant_id AND b.id = c.sale_id
               AND NOT (b.status = 'refunded'
                        AND b.refunded_idr >= b.price_paid_idr)))
       )
     LIMIT 1`);
  if (result.rows.length > 0) throw wfcSaleActive();
}
