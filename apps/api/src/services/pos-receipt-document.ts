// Receipt, kuitansi and invoice documents (POS-07, PRD v1.7 §3 F11 "Struk &
// Kuitansi"; contract receiptDocumentSchema / invoiceDocumentSchema).
//
// The document is a snapshot of the order: amounts are read, never recomputed,
// and the result must satisfy the contract schema (totals equal the order).
// The outlet name and address are printed on every document, read from the
// receipt's frozen `outlet_snapshot` (never from `outlets`, so a later rename
// does not change an issued receipt); a snapshot without a usable address
// refuses to print (POS-07).

import { and, eq, gt, inArray, or, sql } from "drizzle-orm";
import { CoreError, idr, type ScopedTenantContext } from "@starter/shared/core";
import {
  invoiceDocumentSchema,
  receiptDocumentSchema,
  type InvoiceDocument,
  type PosReceipt,
  type ReceiptDocument,
} from "@starter/shared/pos";
import { serviceChargeRules, taxRules, user } from "../db/schema/index.ts";
import { posOrderRefunds, posOrders } from "../db/schema/pos-order.ts";
import { posReceipts, type posInvoices } from "../db/schema/pos-receipt.ts";
import { orders } from "../db/schema/qr-order.ts";
import type { Tx } from "./permission-resolver.ts";
import {
  itemsOf,
  liveDiscountsOf,
  swapLinksOf,
  tendersOf,
} from "./pos-order-support.ts";

/** Contract: outletAddress is 10..300 characters. */
const MIN_ADDRESS = 10;
const MAX_ADDRESS = 300;

const DISCOUNT_LABELS = {
  promo: "Promo",
  voucher: "Voucher",
  manual: "Diskon manual",
} as const;

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function conflict(message: string): CoreError {
  return new CoreError("CONFLICT", message);
}

/** The printable address, or a refusal: never print without one (POS-07). */
function printableAddress(address: string): string {
  const trimmed = address.trim();
  if (trimmed.length < MIN_ADDRESS)
    throw conflict(
      "Alamat outlet belum diisi. Lengkapi alamat outlet sebelum mencetak struk.",
    );
  return trimmed.slice(0, MAX_ADDRESS);
}

/** Receipt or kuitansi built from the order of `receipt`. */
export async function buildReceiptDocument(
  tx: Tx,
  context: ScopedTenantContext,
  receipt: PosReceipt,
  kind: "receipt" | "kuitansi" = "receipt",
): Promise<ReceiptDocument> {
  const tenantId = context.tenant.tenantId;
  const [order] = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, receipt.orderId)));
  if (!order) throw new CoreError("NOT_FOUND", "Pesanan tidak ditemukan.");
  const [row] = await tx
    .select({ outletSnapshot: posReceipts.outletSnapshot })
    .from(posReceipts)
    .where(
      and(eq(posReceipts.tenantId, tenantId), eq(posReceipts.id, receipt.id)),
    );
  if (!row) throw new CoreError("NOT_FOUND", "Struk tidak ditemukan.");
  const outlet = row.outletSnapshot;
  const address = printableAddress(outlet.outletAddress);

  const [pos] = await tx
    .select({ cashierId: posOrders.cashierId })
    .from(posOrders)
    .where(
      and(eq(posOrders.tenantId, tenantId), eq(posOrders.orderId, order.id)),
    );
  let cashierName: string | null = null;
  if (pos?.cashierId) {
    const [cashier] = await tx
      .select({ name: user.name })
      .from(user)
      .where(eq(user.id, pos.cashierId));
    cashierName = cashier?.name.trim().slice(0, 150) || null;
  }

  const [items, tenders, discounts, swaps] = await Promise.all([
    itemsOf(tx, context, order.id),
    tendersOf(tx, context, order.id),
    liveDiscountsOf(tx, context, order.id),
    swapLinksOf(tx, context, order.id),
  ]);

  const result = order.taxResult;
  if (!result)
    throw conflict("Rincian pajak pesanan belum tersedia untuk struk.");
  // Founder decision Q4 (legend-93a): a tax-free order (non-PPN/PB1 outlet or
  // exempt items) prints without tax rows; a zero tax line is never shown.
  const taxes =
    Number(order.taxIdr) === 0
      ? []
      : result.taxes.filter((summary) => Number(summary.taxIdr) > 0);
  const ruleIds = taxes.map((summary) => summary.taxRuleId);
  const names = new Map(
    ruleIds.length === 0
      ? []
      : (
          await tx
            .select({ id: taxRules.id, name: taxRules.name })
            .from(taxRules)
            .where(
              and(
                eq(taxRules.tenantId, tenantId),
                inArray(taxRules.id, ruleIds),
              ),
            )
        ).map((row) => [row.id as string, row.name]),
  );

  let serviceCharge: ReceiptDocument["serviceCharge"] = null;
  if (order.serviceChargeIdr > 0) {
    const serviceLines = result.lines.filter(
      (line) => line.serviceChargeIdr > 0,
    );
    const baseIdr = sum(serviceLines.map((line) => line.baseIdr));
    const ruleId = serviceLines.find(
      (line) => line.serviceChargeRuleId !== null,
    )?.serviceChargeRuleId;
    let rateBp =
      baseIdr > 0
        ? Math.min(
            10_000,
            Math.round((order.serviceChargeIdr * 10_000) / baseIdr),
          )
        : 0;
    if (ruleId) {
      const [rule] = await tx
        .select({ rateBp: serviceChargeRules.rateBp })
        .from(serviceChargeRules)
        .where(
          and(
            eq(serviceChargeRules.tenantId, tenantId),
            eq(serviceChargeRules.id, ruleId),
          ),
        );
      if (rule) rateBp = rule.rateBp;
    }
    serviceCharge = {
      rateBp,
      baseIdr: idr(baseIdr),
      amountIdr: order.serviceChargeIdr,
    };
  }

  return receiptDocumentSchema.parse({
    id: receipt.id,
    tenantId: order.tenantId,
    outletId: order.outletId,
    receiptNumber: receipt.number,
    orderNumber: order.number,
    documentKind: kind,
    status: receipt.status,
    reprint: receipt.reprintCount > 0,
    outletName: outlet.outletName,
    outletAddress: address,
    issuedAt: receipt.issuedAt,
    items: items
      .filter(({ item }) => item.status !== "voided")
      .map(({ item }) => {
        // legend-135b4: a kitchen-swap replacement is recorded at zero.
        const replacement = swaps.replacementIds.has(item.id);
        return {
          name: replacement
            ? `Pengganti: ${item.name}`.slice(0, 150)
            : item.name,
          quantity: item.quantity,
          unitPriceIdr: item.unitPriceIdr,
          modifiersTotalIdr: item.modifiersTotalIdr,
          lineTotalIdr: item.lineTotalIdr,
          note: item.note,
          swapRole: replacement ? ("replacement" as const) : ("none" as const),
        };
      }),
    discounts: discounts.map((row) => ({
      label: (row.promoCode ?? DISCOUNT_LABELS[row.source as never]) as string,
      source: row.source,
      amountIdr: row.amountIdr,
    })),
    serviceCharge,
    taxLines: taxes.map((summary) => ({
      taxRuleId: summary.taxRuleId,
      name: (names.get(summary.taxRuleId) ?? summary.code).slice(0, 150),
      rateBp: summary.rateBp,
      baseIdr: summary.taxBaseIdr,
      amountIdr: summary.taxIdr,
    })),
    subtotalIdr: order.subtotalIdr,
    discountIdr: order.discountIdr,
    serviceChargeIdr: order.serviceChargeIdr,
    taxIdr: order.taxIdr,
    roundingIdr: order.roundingIdr,
    totalIdr: order.totalIdr,
    pricesIncludeTax: order.pricesIncludeTax,
    tenders: tenders
      .filter((tender) => tender.status === "captured")
      .map((tender) => ({
        method: tender.method,
        amountIdr: tender.amountIdr,
        reference: tender.reference,
      })),
    cashierName,
    // The customer profile is not read: the document never needs a name (POS-07).
    customerName: null,
  });
}

/** F11 invoice: the receipt's amounts plus who is billed. */
export async function buildInvoiceDocument(
  tx: Tx,
  context: ScopedTenantContext,
  invoice: typeof posInvoices.$inferSelect,
  receipt: PosReceipt,
): Promise<InvoiceDocument> {
  const base = await buildReceiptDocument(tx, context, receipt, "receipt");
  const [refunds] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(posOrderRefunds)
    .where(
      and(
        eq(posOrderRefunds.tenantId, context.tenant.tenantId),
        eq(posOrderRefunds.orderId, invoice.orderId),
        // A zero-tender return may refund DP to its original payer. Only a
        // goods-only return with no durable DP obligation leaves it paid.
        or(
          gt(posOrderRefunds.amountIdr, idr(0)),
          sql`EXISTS (SELECT 1 FROM pos_deposit_refunds d
            WHERE d.tenant_id = ${posOrderRefunds.tenantId}
              AND d.pos_refund_id = ${posOrderRefunds.id}
              AND d.amount_idr > 0)`,
        ),
      ),
    );
  const refunded = receipt.status === "voided" || (refunds?.count ?? 0) > 0;
  return invoiceDocumentSchema.parse({
    ...base,
    documentKind: "invoice",
    // A reprint of the receipt does not make the invoice a reprint; the
    // invoice keeps no print counter of its own.
    reprint: false,
    billedTo: {
      name: invoice.billedToName,
      address: invoice.billedToAddress,
      npwp: invoice.billedToNpwp,
    },
    dueDate: invoice.dueDate,
    paymentStatus: refunded ? "refunded" : "paid",
    notes: invoice.notes,
  });
}
