// Purchasing domain events (bead legend-ejk). Registered on the WS-06 line of
// the WS-00 event catalog (packages/shared/src/events/catalog.ts) and emitted
// through the transactional outbox (`eventEnvelopeSchema`, D-CORE event rules:
// ULID event ids, payload schema ref `<name>.v1`).
//
// - purchase_order.created / purchase_order.approved: PRD §4 Alur I step 2.
//   `approved` is what unlocking a PO to the supplier means; the approved
//   payload carries the money the approval matrix checked.
// - goods_receipt.recorded: PRD §4 Alur I step 3 + INV-05. `receivedValueIdr`
//   is the accepted (after-QC) value, which is also what WS-07 posts
//   (accounting posting-rules: debit inventory / credit GRNI).
// - supplier_invoice.recorded: PRD §4 Alur I step 4. The amount keys match the
//   WS-07 posting rule exactly (goods, price variance, services, PPN, PPh 23,
//   payable) so one event posts once.
// - supplier_invoice.matched: the three-way match result (PRD §3.18).
// - supplier_payment.paid: PRD §3.18 "pembayaran supplier disetujui dan
//   dijurnal otomatis"; WS-07 posts it as a document rule, so it carries the
//   amount and approval, not the journal.

import {
  businessDateSchema,
  idr,
  idrSchema,
  isoDateTimeSchema,
  outletIdSchema,
  userIdSchema,
  z,
} from "../../core/index.ts";
import { defineDomainEvent, eventEnvelopeSchema } from "../../events/index.ts";
import type { EventCatalogEntry, EventEnvelope } from "../../events/index.ts";
import {
  goodsReceiptIdSchema,
  purchaseDocumentNumberSchema,
  purchaseOrderIdSchema,
  purchaseOrderSourceSchema,
  pettyPurchaseIdSchema,
  purchaseReturnIdSchema,
  supplierIdSchema,
  supplierInvoiceIdSchema,
  supplierInvoiceMatchStatusSchema,
  supplierPaymentIdSchema,
  supplierPaymentMethodSchema,
} from "./schemas.ts";

const nonNegativeIdrSchema = idrSchema.refine(
  (value) => value >= 0,
  "Amount must be >= 0",
);

export const purchasingEventNames = [
  "purchase_order.created",
  "purchase_order.approved",
  "goods_receipt.recorded",
  "supplier_invoice.recorded",
  "supplier_invoice.matched",
  "supplier_payment.paid",
  "purchase_return.recorded",
  "petty_purchase.recorded",
] as const;
export type PurchasingEventName = (typeof purchasingEventNames)[number];

export const purchaseOrderCreatedEventPayloadSchema = z.strictObject({
  purchaseOrderId: purchaseOrderIdSchema,
  supplierId: supplierIdSchema,
  outletId: outletIdSchema,
  number: purchaseDocumentNumberSchema,
  source: purchaseOrderSourceSchema,
  totalIdr: idrSchema,
  createdBy: userIdSchema,
  createdAt: isoDateTimeSchema,
});
export type PurchaseOrderCreatedEventPayload = z.infer<
  typeof purchaseOrderCreatedEventPayloadSchema
>;

export const purchaseOrderApprovedEventPayloadSchema = z.strictObject({
  purchaseOrderId: purchaseOrderIdSchema,
  supplierId: supplierIdSchema,
  number: purchaseDocumentNumberSchema,
  totalIdr: idrSchema,
  approvedBy: userIdSchema,
  approvedAt: isoDateTimeSchema,
});
export type PurchaseOrderApprovedEventPayload = z.infer<
  typeof purchaseOrderApprovedEventPayloadSchema
>;

/**
 * INV-05: `receivedValueIdr` covers the accepted quantity only; QC-rejected
 * quantities never entered stock, so they are not valued here.
 */
export const goodsReceiptRecordedEventPayloadSchema = z.strictObject({
  goodsReceiptId: goodsReceiptIdSchema,
  purchaseOrderId: purchaseOrderIdSchema,
  supplierId: supplierIdSchema,
  number: purchaseDocumentNumberSchema,
  receivedValueIdr: idrSchema,
  lineCount: z.number().int().positive(),
  receivedBy: userIdSchema,
  receivedAt: isoDateTimeSchema,
});
export type GoodsReceiptRecordedEventPayload = z.infer<
  typeof goodsReceiptRecordedEventPayloadSchema
>;

export const supplierInvoiceRecordedEventPayloadSchema = z
  .strictObject({
    supplierInvoiceId: supplierInvoiceIdSchema,
    supplierId: supplierIdSchema,
    purchaseOrderId: purchaseOrderIdSchema,
    number: z.string().min(1).max(60),
    goodsIdr: idrSchema,
    priceVarianceIdr: idrSchema,
    servicesIdr: idrSchema,
    ppnIdr: idrSchema,
    pph23Idr: idrSchema,
    payableIdr: idrSchema,
    totalIdr: idrSchema,
    recordedBy: userIdSchema,
    recordedAt: isoDateTimeSchema,
  })
  // The accounting posting rule consumes these keys; refuse a split whose
  // journal would not balance.
  .refine(
    (payload) =>
      payload.goodsIdr +
        payload.priceVarianceIdr +
        payload.servicesIdr +
        payload.ppnIdr ===
        payload.totalIdr &&
      payload.totalIdr - payload.pph23Idr === payload.payableIdr,
    {
      path: ["payableIdr"],
      message:
        "total = goods + variance + services + ppn and payable = total - pph23",
    },
  );
export type SupplierInvoiceRecordedEventPayload = z.infer<
  typeof supplierInvoiceRecordedEventPayloadSchema
>;

export const supplierInvoiceMatchedEventPayloadSchema = z.strictObject({
  supplierInvoiceId: supplierInvoiceIdSchema,
  purchaseOrderId: purchaseOrderIdSchema,
  status: supplierInvoiceMatchStatusSchema,
  priceVarianceIdr: idrSchema,
  matchedAt: isoDateTimeSchema,
});
export type SupplierInvoiceMatchedEventPayload = z.infer<
  typeof supplierInvoiceMatchedEventPayloadSchema
>;

export const supplierPaymentPaidEventPayloadSchema = z.strictObject({
  supplierPaymentId: supplierPaymentIdSchema,
  supplierInvoiceId: supplierInvoiceIdSchema,
  supplierId: supplierIdSchema,
  amountIdr: idrSchema,
  method: supplierPaymentMethodSchema,
  approvedBy: userIdSchema,
  paidAt: isoDateTimeSchema,
});
export type SupplierPaymentPaidEventPayload = z.infer<
  typeof supplierPaymentPaidEventPayloadSchema
>;

/**
 * Id-only payload for the return note (PRD §3.18 Retur Pembelian); the
 * stock-ledger rows themselves travel as `stock.moved` from the inventory
 * contract, so a consumer that needs the movement subscribes there.
 */
export const purchaseReturnRecordedEventPayloadSchema = z
  .strictObject({
    purchaseReturnId: purchaseReturnIdSchema,
    supplierId: supplierIdSchema,
    outletId: outletIdSchema,
    number: purchaseDocumentNumberSchema,
    valueIdr: idrSchema,
    /** Part of `valueIdr` still on GRNI (goods received, not yet invoiced). */
    uninvoicedValueIdr: nonNegativeIdrSchema,
    /** Part of `valueIdr` already on a supplier invoice (debit note against AP). */
    invoicedValueIdr: nonNegativeIdrSchema,
    /**
     * Billed value minus order-price value of the invoiced part (signed): the
     * debit note clears the payable at the billed value, so the price variance
     * the invoice booked to 5105 is reversed. Absent on events recorded before
     * legend-5b7uf, which replay as 0.
     */
    returnPriceVarianceIdr: idrSchema.default(idr(0)),
    /**
     * Signed sum over the lines of (line value at receipt cost minus
     * round(qty x moving average before the return)). The stock leaves at
     * receipt cost but the average does not move, so the journal books
     * Dr inventory / Cr 5106 for a positive value (flipped for a negative one)
     * to keep GL inventory at qty x average. Absent on events recorded before
     * legend-uloj6, which replay as 0.
     */
    movingAvgVarianceIdr: idrSchema.optional(),
    /** PPN masukan reversed on the invoiced part. */
    ppnIdr: nonNegativeIdrSchema,
    returnedBy: userIdSchema,
    returnedAt: isoDateTimeSchema,
  })
  // The accounting posting rule consumes these keys; refuse a split whose
  // journal would not balance, or PPN with no invoiced part to reverse it from.
  .refine(
    (payload) =>
      payload.valueIdr ===
      payload.uninvoicedValueIdr + payload.invoicedValueIdr,
    {
      path: ["valueIdr"],
      message: "valueIdr = uninvoicedValueIdr + invoicedValueIdr",
    },
  )
  .refine((payload) => payload.ppnIdr === 0 || payload.invoicedValueIdr > 0, {
    path: ["ppnIdr"],
    message: "ppnIdr needs an invoiced value",
  })
  .refine(
    (payload) =>
      payload.returnPriceVarianceIdr === 0 || payload.invoicedValueIdr > 0,
    {
      path: ["returnPriceVarianceIdr"],
      message: "returnPriceVarianceIdr needs an invoiced value",
    },
  )
  // The debit note (invoiced + variance + PPN) is never negative.
  .refine(
    (payload) => payload.invoicedValueIdr + payload.returnPriceVarianceIdr >= 0,
    {
      path: ["returnPriceVarianceIdr"],
      message: "the billed value of the invoiced part cannot be negative",
    },
  );
export type PurchaseReturnRecordedEventPayload = z.infer<
  typeof purchaseReturnRecordedEventPayloadSchema
>;

/**
 * Id-only payload for a simple purchase paid from petty cash (PRD §3.18
 * Pembelian Sederhana); WS-07 posts Dr petty purchase expense / Cr petty cash.
 */
export const pettyPurchaseRecordedEventPayloadSchema = z.strictObject({
  pettyPurchaseId: pettyPurchaseIdSchema,
  outletId: outletIdSchema,
  amountIdr: idrSchema.refine(
    (amount) => amount > 0,
    "The amount must be greater than zero",
  ),
  businessDate: businessDateSchema,
  paidBy: userIdSchema,
  paidAt: isoDateTimeSchema,
});
export type PettyPurchaseRecordedEventPayload = z.infer<
  typeof pettyPurchaseRecordedEventPayloadSchema
>;

/** Payload schema per event name, for the outbox writer and consumers. */
export const purchasingEventPayloadSchemas = {
  "purchase_order.created": purchaseOrderCreatedEventPayloadSchema,
  "purchase_order.approved": purchaseOrderApprovedEventPayloadSchema,
  "goods_receipt.recorded": goodsReceiptRecordedEventPayloadSchema,
  "supplier_invoice.recorded": supplierInvoiceRecordedEventPayloadSchema,
  "supplier_invoice.matched": supplierInvoiceMatchedEventPayloadSchema,
  "supplier_payment.paid": supplierPaymentPaidEventPayloadSchema,
  "purchase_return.recorded": purchaseReturnRecordedEventPayloadSchema,
  "petty_purchase.recorded": pettyPurchaseRecordedEventPayloadSchema,
} as const;

/**
 * Catalog-bound definitions (contracts.md "One catalog, typed payloads"):
 * defineDomainEvent throws at module load for an uncatalogued name, and each
 * `envelopeSchema` validates name, version, schema ref and payload together.
 */
export const purchasingEvents = Object.fromEntries(
  purchasingEventNames.map((name) => [
    name,
    defineDomainEvent({
      name,
      payload: purchasingEventPayloadSchemas[name] as z.ZodType<
        Record<string, unknown>
      >,
    }),
  ]),
) as Record<PurchasingEventName, ReturnType<typeof defineDomainEvent>>;

export const purchasingEventCatalogEntries: readonly EventCatalogEntry[] =
  purchasingEventNames.map((name) => purchasingEvents[name].entry);

/** Envelope whose name and payload belong to this domain. */
export const purchasingEventSchema = eventEnvelopeSchema
  .refine(
    (event) => (purchasingEventNames as readonly string[]).includes(event.name),
    { path: ["name"], message: "Not a purchasing event" },
  )
  .refine(
    (event) =>
      purchasingEvents[
        event.name as PurchasingEventName
      ]?.envelopeSchema.safeParse(event).success === true,
    {
      path: ["payload"],
      message: "Event does not match its catalogued schema",
    },
  );
export type PurchasingEvent = EventEnvelope;
