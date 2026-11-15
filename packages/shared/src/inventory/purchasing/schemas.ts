// Purchasing contracts (bead legend-ejk, PRD v1.7 §3.18 "Purchasing &
// Supplier", §4 Alur I, §6.E tables suppliers..supplier_payments).
//
// The contract follows docs/plan/contracts.md: tenant/outlet scope, money as
// BIGINT rupiah on the wire (`…Idr`) and NUMERIC(14,4) unit prices/quantities
// (`Decimal4`), UUID ids for documents. PO source is `user | ai | mcp`
// (PRD §6.E purchase_orders.source; AI-08 and TL-13 draft POs through the
// approval matrix, so `ai`/`mcp` POs still need a human approver).
//
// Invariants carried by this file:
// - INV-05: a receipt line stores the quantity received and the quantity
//   rejected by QC; only `quantityReceived - quantityRejected` enters stock,
//   and cumulative accepted receipts never exceed the ordered quantity
//   (`assertGoodsReceiptMatchesOrder`, `goodsReceiptValueIdr`).
// - §3.18 three-way match: invoice goods lines are compared with PO price and
//   accepted receipt quantity (`threeWayMatch`). The tolerance in basis points
//   is tenant configuration, never a constant.
// - §3.7 "Penyetuju selalu berbeda dari pemohon": PR, PO and supplier payment
//   approvals each check the approver against the requester/creator.
// - §3.18 "Pembelian Sederhana ... batas nominal": the petty purchase limit is
//   a per-outlet/tenant policy row (`pettyPurchasePolicySchema`).
//
// Decisions where the PRD is silent (reported to the coordinator):
// - A rejected PO returns to `draft` so purchasing can fix and resubmit; a
//   rejected PR is terminal (`rejected`).
// - Service invoice lines (PPh 23 jasa supplier, §3.19) are recorded but take
//   part in the two-way amount match only: they have no stock receipt.
// - Purchase returns are immutable notes; PRD asks for no approval step.
// - Supplier performance metrics are computed from receipts and the current
//   catalog price; the manual `rating` stays a supplier field.

import {
  addIdr,
  basisPointsSchema,
  businessDateSchema,
  divideRounded,
  extendCostIdr,
  formatDecimal4,
  idr,
  idrSchema,
  isoDateTimeSchema,
  outletIdSchema,
  parseDecimal4,
  subtractIdr,
  sumIdr,
  tenantIdSchema,
  userIdSchema,
  uuidIdSchema,
  uuidSchema,
  z,
} from "../../core/index.ts";
import type {
  BusinessDate,
  Decimal4,
  Idr,
  IsoDateTime,
  RoundingMode,
} from "../../core/index.ts";
import {
  inventoryItemIdSchema,
  nonnegativeDecimal4Schema,
  nonnegativeIdrSchema,
  positiveDecimal4Schema,
  stockLocationIdSchema,
  uomIdSchema,
} from "../schemas.ts";
import { PurchasingError } from "./errors.ts";

// ---- Ids ------------------------------------------------------------------

export const supplierIdSchema = uuidIdSchema<"SupplierId">();
export const supplierContactIdSchema = uuidIdSchema<"SupplierContactId">();
export const supplierCatalogItemIdSchema =
  uuidIdSchema<"SupplierCatalogItemId">();
export const purchaseRequestIdSchema = uuidIdSchema<"PurchaseRequestId">();
export const purchaseRequestLineIdSchema =
  uuidIdSchema<"PurchaseRequestLineId">();
export const purchaseOrderIdSchema = uuidIdSchema<"PurchaseOrderId">();
export const purchaseOrderLineIdSchema = uuidIdSchema<"PurchaseOrderLineId">();
export const goodsReceiptIdSchema = uuidIdSchema<"GoodsReceiptId">();
export const goodsReceiptLineIdSchema = uuidIdSchema<"GoodsReceiptLineId">();
export const supplierInvoiceIdSchema = uuidIdSchema<"SupplierInvoiceId">();
export const supplierInvoiceLineIdSchema =
  uuidIdSchema<"SupplierInvoiceLineId">();
export const supplierPaymentIdSchema = uuidIdSchema<"SupplierPaymentId">();
export const purchaseReturnIdSchema = uuidIdSchema<"PurchaseReturnId">();
export const purchaseReturnLineIdSchema =
  uuidIdSchema<"PurchaseReturnLineId">();
export const pettyPurchaseIdSchema = uuidIdSchema<"PettyPurchaseId">();

export type SupplierId = z.infer<typeof supplierIdSchema>;
export type SupplierCatalogItemId = z.infer<typeof supplierCatalogItemIdSchema>;
export type PurchaseRequestId = z.infer<typeof purchaseRequestIdSchema>;
export type PurchaseOrderId = z.infer<typeof purchaseOrderIdSchema>;
export type PurchaseOrderLineId = z.infer<typeof purchaseOrderLineIdSchema>;
export type GoodsReceiptId = z.infer<typeof goodsReceiptIdSchema>;
export type SupplierInvoiceId = z.infer<typeof supplierInvoiceIdSchema>;
export type SupplierPaymentId = z.infer<typeof supplierPaymentIdSchema>;
export type PurchaseReturnId = z.infer<typeof purchaseReturnIdSchema>;
export type PettyPurchaseId = z.infer<typeof pettyPurchaseIdSchema>;

// ---- Shared fields --------------------------------------------------------

const supplierName = z.string().trim().min(1).max(150);
const personOrCompanyName = z.string().trim().min(1).max(150);
const note = z.string().trim().max(300).nullable();
const emailSchema = z.email().max(254);

/** PRD §6.E `number VARCHAR(40)`: PO, GR and return document numbers. */
export const purchaseDocumentNumberSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9/._-]*$/,
    "Document numbers use letters, digits and / . _ -",
  );
export type PurchaseDocumentNumber = z.infer<
  typeof purchaseDocumentNumberSchema
>;

/** WhatsApp-capable phone number, digits only with an optional leading +. */
export const supplierPhoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9]{7,15}$/, "Phone numbers are digits (7-15), optional +");
export type SupplierPhone = z.infer<typeof supplierPhoneSchema>;

/**
 * Supplier NPWP (legend-v4v7c): digits with optional dots and dashes, 15
 * digits (NPWP) or 16 (NIK-format NPWP), at most 20 characters.
 */
export const supplierNpwpSchema = z
  .string()
  .trim()
  .max(20)
  .regex(/^[0-9.-]+$/, "NPWP is digits with optional dots and dashes")
  .refine(
    (value) => [15, 16].includes(value.replace(/\D/g, "").length),
    "NPWP has 15 or 16 digits",
  );
export type SupplierNpwp = z.infer<typeof supplierNpwpSchema>;

// ---- Suppliers (PRD §3.18 Supplier, §6.E suppliers) ----------------------

/** Maintenance vendors share the supplier master with goods vendors. */
export const supplierKindSchema = z.enum(["goods", "maintenance"]);
export type SupplierKind = z.infer<typeof supplierKindSchema>;

/** Manual performance rating; computed metrics live in supplierPerformance. */
export const supplierRatingSchema = z.number().int().min(1).max(5);
export type SupplierRating = z.infer<typeof supplierRatingSchema>;

/**
 * Supplier master data. `payment_terms_days` is the term used to derive the
 * invoice due date; `rating` is the buyer's 1-5 assessment (PRD §3.18
 * "penilaian kinerja").
 */
export const supplierSchema = z.strictObject({
  id: supplierIdSchema,
  tenantId: tenantIdSchema,
  name: supplierName,
  kind: supplierKindSchema.default("goods"),
  legalName: z.string().trim().min(1).max(200).nullable(),
  npwp: supplierNpwpSchema.nullable().default(null),
  contactName: personOrCompanyName.nullable(),
  phone: supplierPhoneSchema.nullable(),
  email: emailSchema.nullable(),
  address: z.string().trim().min(1).max(300).nullable(),
  paymentTermsDays: z.number().int().min(0).max(365),
  rating: supplierRatingSchema.nullable(),
  isActive: z.boolean(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Supplier = z.infer<typeof supplierSchema>;

export const supplierContactSchema = z.strictObject({
  id: supplierContactIdSchema,
  tenantId: tenantIdSchema,
  supplierId: supplierIdSchema,
  name: personOrCompanyName,
  role: z.string().trim().min(1).max(60).nullable(),
  phone: supplierPhoneSchema,
  email: emailSchema.nullable(),
  isPrimary: z.boolean(),
});
export type SupplierContact = z.infer<typeof supplierContactSchema>;

export const supplierDetailSchema = z.strictObject({
  supplier: supplierSchema,
  contacts: z.array(supplierContactSchema),
});
export type SupplierDetail = z.infer<typeof supplierDetailSchema>;

/** The contact a PO is sent to: the flagged primary, else the first contact. */
export function primarySupplierContact(
  contacts: readonly SupplierContact[],
): SupplierContact | null {
  return contacts.find((contact) => contact.isPrimary) ?? contacts[0] ?? null;
}

// ---- Supplier catalog and price history (PRD §6.E supplier_prices) -------

/**
 * One catalog price row at a purchase unit. Price history is the list of rows
 * for one supplier/item ordered by `effectiveFrom`; a new row supersedes older
 * ones from its date (`supplierPriceOnDate`). `priceIdr` is per
 * `purchaseUomId` at NUMERIC(14,4) (D-CORE-2 per-unit cost), e.g. Rp 185.000
 * per kg of coffee.
 */
export const supplierCatalogItemSchema = z.strictObject({
  id: supplierCatalogItemIdSchema,
  tenantId: tenantIdSchema,
  supplierId: supplierIdSchema,
  inventoryItemId: inventoryItemIdSchema,
  purchaseUomId: uomIdSchema,
  priceIdr: nonnegativeDecimal4Schema,
  effectiveFrom: businessDateSchema,
  isActive: z.boolean(),
  createdAt: isoDateTimeSchema,
});
export type SupplierCatalogItem = z.infer<typeof supplierCatalogItemSchema>;

/** Active price in force on `onDate`; null when the supplier has no price yet. */
export function supplierPriceOnDate(
  catalog: readonly SupplierCatalogItem[],
  input: {
    supplierId: SupplierId | string;
    inventoryItemId: string;
    onDate: BusinessDate;
  },
): SupplierCatalogItem | null {
  const candidates = catalog.filter(
    (row) =>
      row.isActive &&
      row.supplierId === input.supplierId &&
      row.inventoryItemId === input.inventoryItemId &&
      row.effectiveFrom <= input.onDate,
  );
  candidates.sort((left, right) => {
    if (left.effectiveFrom !== right.effectiveFrom)
      return left.effectiveFrom < right.effectiveFrom ? 1 : -1;
    return left.createdAt < right.createdAt ? 1 : -1;
  });
  return candidates[0] ?? null;
}

/** Full price history for one item, newest first. */
export function supplierPriceHistory(
  catalog: readonly SupplierCatalogItem[],
  supplierId: SupplierId | string,
  inventoryItemId: string,
): SupplierCatalogItem[] {
  return catalog
    .filter(
      (row) =>
        row.supplierId === supplierId &&
        row.inventoryItemId === inventoryItemId,
    )
    .sort((left, right) => {
      if (left.effectiveFrom !== right.effectiveFrom)
        return left.effectiveFrom < right.effectiveFrom ? 1 : -1;
      return left.createdAt < right.createdAt ? 1 : -1;
    });
}

/**
 * Signed price change in basis points between two catalog rows
 * (1000 = +10%). Null when the previous price is zero.
 */
export function supplierPriceChangeBp(
  previousPriceIdr: Decimal4,
  nextPriceIdr: Decimal4,
  mode: RoundingMode,
): number | null {
  const previous = parseDecimal4(previousPriceIdr);
  if (previous === 0n) return null;
  return Number(
    divideRounded(
      (parseDecimal4(nextPriceIdr) - previous) * 10_000n,
      previous,
      mode,
    ),
  );
}

// ---- Supplier performance (PRD §3.18 ketepatan, kualitas, harga) ---------

/** One delivery observation for the performance report. */
export const supplierDeliverySchema = z
  .strictObject({
    purchaseOrderId: purchaseOrderIdSchema,
    expectedDate: businessDateSchema,
    receivedOn: businessDateSchema,
    quantityReceived: nonnegativeDecimal4Schema,
    quantityRejected: nonnegativeDecimal4Schema,
    /** Invoice price per purchase unit, when the invoice is recorded. */
    invoicedPriceIdr: nonnegativeDecimal4Schema.nullable(),
    /** Catalog price on the delivery date, when one exists. */
    catalogPriceIdr: nonnegativeDecimal4Schema.nullable(),
  })
  .refine(
    (delivery) =>
      parseDecimal4(delivery.quantityRejected) <=
      parseDecimal4(delivery.quantityReceived),
    { path: ["quantityRejected"], message: "Rejected exceeds received" },
  );
export type SupplierDelivery = z.infer<typeof supplierDeliverySchema>;

/**
 * Performance metrics over a period: on-time rate, QC rejection rate and the
 * quantity-weighted absolute price variance against the catalog. All are
 * derived, so the UI never shows a hand-entered score; `rating` stays manual.
 */
export const supplierPerformanceSchema = z
  .strictObject({
    tenantId: tenantIdSchema,
    supplierId: supplierIdSchema,
    fromDate: businessDateSchema,
    toDate: businessDateSchema,
    deliveriesTotal: z.number().int().nonnegative(),
    onTimeDeliveries: z.number().int().nonnegative(),
    /** Null when there are no deliveries in the period. */
    onTimeRateBp: z.number().int().min(0).max(10_000).nullable(),
    receivedQty: nonnegativeDecimal4Schema,
    rejectedQty: nonnegativeDecimal4Schema,
    /** Null when nothing was received in the period. */
    rejectionRateBp: z.number().int().min(0).max(10_000).nullable(),
    /** Quantity-weighted absolute variance; null with no comparable price. */
    priceVarianceBp: z.number().int().nonnegative().nullable(),
    computedAt: isoDateTimeSchema,
  })
  .refine((row) => row.fromDate <= row.toDate, {
    path: ["toDate"],
    message: "The period must not end before it starts",
  });
export type SupplierPerformance = z.infer<typeof supplierPerformanceSchema>;

/** Builds the report from receipt observations inside `[fromDate, toDate]`. */
export function supplierPerformance(
  input: {
    tenantId: Supplier["tenantId"];
    supplierId: SupplierId;
    fromDate: BusinessDate;
    toDate: BusinessDate;
    deliveries: readonly SupplierDelivery[];
    computedAt: IsoDateTime;
  },
  mode: RoundingMode,
): SupplierPerformance {
  const deliveries = input.deliveries.filter(
    (delivery) =>
      delivery.receivedOn >= input.fromDate &&
      delivery.receivedOn <= input.toDate,
  );
  let onTime = 0;
  let receivedScaled = 0n;
  let rejectedScaled = 0n;
  let priceWeight = 0n;
  let priceVariance = 0n;
  for (const delivery of deliveries) {
    if (delivery.receivedOn <= delivery.expectedDate) onTime += 1;
    receivedScaled += parseDecimal4(delivery.quantityReceived);
    rejectedScaled += parseDecimal4(delivery.quantityRejected);
    if (delivery.invoicedPriceIdr === null || delivery.catalogPriceIdr === null)
      continue;
    const accepted =
      parseDecimal4(delivery.quantityReceived) -
      parseDecimal4(delivery.quantityRejected);
    const catalog = parseDecimal4(delivery.catalogPriceIdr);
    if (accepted <= 0n || catalog === 0n) continue;
    const difference = parseDecimal4(delivery.invoicedPriceIdr) - catalog;
    priceVariance += (difference < 0n ? -difference : difference) * accepted;
    priceWeight += catalog * accepted;
  }
  const total = deliveries.length;
  return supplierPerformanceSchema.parse({
    tenantId: input.tenantId,
    supplierId: input.supplierId,
    fromDate: input.fromDate,
    toDate: input.toDate,
    deliveriesTotal: total,
    onTimeDeliveries: onTime,
    onTimeRateBp:
      total === 0
        ? null
        : Number(divideRounded(BigInt(onTime) * 10_000n, BigInt(total), mode)),
    receivedQty: formatDecimal4(receivedScaled),
    rejectedQty: formatDecimal4(rejectedScaled),
    rejectionRateBp:
      receivedScaled === 0n
        ? null
        : Number(divideRounded(rejectedScaled * 10_000n, receivedScaled, mode)),
    priceVarianceBp:
      priceWeight === 0n
        ? null
        : Number(divideRounded(priceVariance * 10_000n, priceWeight, mode)),
    computedAt: input.computedAt,
  });
}

// ---- Purchase requests (PRD §4 Alur I, §6.E purchase_requests) -----------

export const purchaseRequestStatusSchema = z.enum([
  "draft",
  "pending_approval",
  "approved",
  "rejected",
  "converted",
  "cancelled",
]);
export type PurchaseRequestStatus = z.infer<typeof purchaseRequestStatusSchema>;

export const purchaseRequestActionSchema = z.enum([
  "submit",
  "approve",
  "reject",
  "convert",
  "cancel",
]);
export type PurchaseRequestAction = z.infer<typeof purchaseRequestActionSchema>;

/** A requested quantity in the unit the kitchen or purchasing counted in. */
export const purchaseRequestLineSchema = z.strictObject({
  id: purchaseRequestLineIdSchema,
  tenantId: tenantIdSchema,
  purchaseRequestId: purchaseRequestIdSchema,
  inventoryItemId: inventoryItemIdSchema,
  quantity: positiveDecimal4Schema,
  uomId: uomIdSchema,
});
export type PurchaseRequestLine = z.infer<typeof purchaseRequestLineSchema>;

/**
 * Kitchen-lead request (PRD §4 I step 1). Approval is recorded with the
 * approver and time; a converted request has produced one or more POs.
 */
export const purchaseRequestSchema = z
  .strictObject({
    id: purchaseRequestIdSchema,
    tenantId: tenantIdSchema,
    outletId: outletIdSchema,
    requestedBy: userIdSchema,
    status: purchaseRequestStatusSchema,
    neededBy: businessDateSchema,
    note,
    decidedBy: userIdSchema.nullable(),
    decidedAt: isoDateTimeSchema.nullable(),
    decisionNote: z.string().trim().max(300).nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .superRefine((request, context) => {
    const decided = ["approved", "rejected", "converted"].includes(
      request.status,
    );
    if (decided && (request.decidedBy === null || request.decidedAt === null))
      context.addIssue({
        code: "custom",
        path: ["decidedBy"],
        message: "A decided request needs an approver and time",
      });
    if (
      !decided &&
      request.status !== "cancelled" &&
      request.decidedBy !== null
    )
      context.addIssue({
        code: "custom",
        path: ["decidedBy"],
        message: "Only a decided request has an approver",
      });
    if (
      request.decidedBy !== null &&
      request.decidedBy.toLowerCase() === request.requestedBy.toLowerCase()
    )
      context.addIssue({
        code: "custom",
        path: ["decidedBy"],
        message: "The requester cannot approve their own request",
      });
    if (
      request.status === "rejected" &&
      (request.decisionNote === null || request.decisionNote.length === 0)
    )
      context.addIssue({
        code: "custom",
        path: ["decisionNote"],
        message: "A rejected request needs a reason",
      });
  });
export type PurchaseRequest = z.infer<typeof purchaseRequestSchema>;

export const purchaseRequestDetailSchema = z.strictObject({
  request: purchaseRequestSchema,
  lines: z.array(purchaseRequestLineSchema),
});
export type PurchaseRequestDetail = z.infer<typeof purchaseRequestDetailSchema>;

const PURCHASE_REQUEST_TRANSITIONS: Record<
  PurchaseRequestStatus,
  Partial<Record<PurchaseRequestAction, PurchaseRequestStatus>>
> = {
  draft: { submit: "pending_approval", cancel: "cancelled" },
  pending_approval: {
    approve: "approved",
    reject: "rejected",
    cancel: "cancelled",
  },
  approved: { convert: "converted", cancel: "cancelled" },
  rejected: {},
  converted: {},
  cancelled: {},
};

/** Explicit PR state machine (PRD §4 Alur I step 1-2). */
export function transitionPurchaseRequest(
  from: PurchaseRequestStatus,
  action: PurchaseRequestAction,
): PurchaseRequestStatus {
  const next = PURCHASE_REQUEST_TRANSITIONS[from][action];
  if (!next)
    throw new PurchasingError(
      "PURCHASE_REQUEST_INVALID_TRANSITION",
      `Cannot ${action} a purchase request in ${from}`,
    );
  return next;
}

/** PRD §3.7: approval needs a submitted request and a different person. */
export function assertPurchaseRequestApproval(
  request: Pick<PurchaseRequest, "status" | "requestedBy">,
  approverId: string,
): void {
  if (request.status !== "pending_approval")
    throw new PurchasingError(
      "PURCHASE_REQUEST_NOT_PENDING_APPROVAL",
      `Purchase request is ${request.status}, not pending_approval`,
    );
  if (request.requestedBy.toLowerCase() === approverId.toLowerCase())
    throw new PurchasingError(
      "PURCHASE_REQUEST_SELF_APPROVAL",
      "The requester cannot approve their own purchase request",
    );
}

/** Estimated PR value from catalog prices at NUMERIC(14,4) line precision. */
export function purchaseRequestEstimateIdr(
  lines: readonly {
    quantity: Decimal4;
    unitPriceIdr: Decimal4;
  }[],
  mode: RoundingMode,
): Idr {
  return sumIdr(
    lines.map((line) => extendCostIdr(line.quantity, line.unitPriceIdr, mode)),
  );
}

// ---- Purchase orders (PRD §6.E purchase_orders, §4 Alur I step 2) --------

/** PRD §6.E: where the PO came from (AI-08 and TL-13 still need approval). */
export const purchaseOrderSourceSchema = z.enum(["user", "ai", "mcp"]);
export type PurchaseOrderSource = z.infer<typeof purchaseOrderSourceSchema>;

export const purchaseOrderStatusSchema = z.enum([
  "draft",
  "pending_approval",
  "approved",
  "sent",
  "partially_received",
  "received",
  "closed",
  "cancelled",
]);
export type PurchaseOrderStatus = z.infer<typeof purchaseOrderStatusSchema>;

export const purchaseOrderActionSchema = z.enum([
  "submit",
  "approve",
  "reject",
  "send",
  "receive_partial",
  "receive_full",
  "close",
  "cancel",
]);
export type PurchaseOrderAction = z.infer<typeof purchaseOrderActionSchema>;

/**
 * One ordered line. `unitPriceIdr` is per purchase unit (NUMERIC(14,4));
 * `lineTotalIdr` is the server-computed whole-rupiah line value.
 */
export const purchaseOrderLineSchema = z.strictObject({
  id: purchaseOrderLineIdSchema,
  tenantId: tenantIdSchema,
  purchaseOrderId: purchaseOrderIdSchema,
  inventoryItemId: inventoryItemIdSchema,
  quantity: positiveDecimal4Schema,
  /** Goods quantities reserved by invoices that have not been rejected. */
  quantityInvoiced: nonnegativeDecimal4Schema.default(formatDecimal4(0n)),
  uomId: uomIdSchema,
  unitPriceIdr: nonnegativeDecimal4Schema,
  lineTotalIdr: nonnegativeIdrSchema,
});
export type PurchaseOrderLine = z.infer<typeof purchaseOrderLineSchema>;

/** Delivery state of a PO email: queued for the job, sent, or failed for good. */
export const purchaseOrderEmailDeliveryStatusSchema = z.enum([
  "queued",
  "sent",
  "failed",
]);
export type PurchaseOrderEmailDeliveryStatus = z.infer<
  typeof purchaseOrderEmailDeliveryStatusSchema
>;

export const purchaseOrderSchema = z
  .strictObject({
    id: purchaseOrderIdSchema,
    tenantId: tenantIdSchema,
    outletId: outletIdSchema,
    supplierId: supplierIdSchema,
    number: purchaseDocumentNumberSchema,
    purchaseRequestId: purchaseRequestIdSchema.nullable(),
    status: purchaseOrderStatusSchema,
    expectedDate: businessDateSchema,
    subtotalIdr: nonnegativeIdrSchema,
    /** Tax amount from the tax contract; purchasing never computes rates. */
    taxIdr: nonnegativeIdrSchema,
    totalIdr: nonnegativeIdrSchema,
    source: purchaseOrderSourceSchema,
    createdBy: userIdSchema,
    createdAt: isoDateTimeSchema,
    /** Optimistic concurrency token; bumped by every write to the PO. */
    updatedAt: isoDateTimeSchema,
    approvedBy: userIdSchema.nullable(),
    approvedAt: isoDateTimeSchema.nullable(),
    sentAt: isoDateTimeSchema.nullable(),
    /** Email the PO was sent to; null for a share link only. */
    sentTo: emailSchema.nullable(),
    /** Latest email delivery of this PO by created time; null = never emailed. */
    emailDeliveryStatus: purchaseOrderEmailDeliveryStatusSchema.nullable(),
    closedAt: isoDateTimeSchema.nullable(),
    note,
  })
  .superRefine((order, context) => {
    if (addIdr(order.subtotalIdr, order.taxIdr) !== order.totalIdr)
      context.addIssue({
        code: "custom",
        path: ["totalIdr"],
        message: "total must equal subtotal + tax",
      });
    const approved = [
      "approved",
      "sent",
      "partially_received",
      "received",
      "closed",
    ].includes(order.status);
    if (approved && (order.approvedBy === null || order.approvedAt === null))
      context.addIssue({
        code: "custom",
        path: ["approvedBy"],
        message: "An approved PO needs an approver and time",
      });
    if (!approved && order.status !== "cancelled" && order.approvedBy !== null)
      context.addIssue({
        code: "custom",
        path: ["approvedBy"],
        message: "Only an approved PO has an approver",
      });
    if (
      order.approvedBy !== null &&
      order.approvedBy.toLowerCase() === order.createdBy.toLowerCase()
    )
      context.addIssue({
        code: "custom",
        path: ["approvedBy"],
        message: "The creator cannot approve their own purchase order",
      });
    const sent = ["sent", "partially_received", "received", "closed"].includes(
      order.status,
    );
    if (sent && order.sentAt === null)
      context.addIssue({
        code: "custom",
        path: ["sentAt"],
        message: "A sent PO needs a send time",
      });
    if (order.closedAt !== null && order.status !== "closed")
      context.addIssue({
        code: "custom",
        path: ["closedAt"],
        message: "Only a closed PO has a closing time",
      });
    if (order.status === "closed" && order.closedAt === null)
      context.addIssue({
        code: "custom",
        path: ["closedAt"],
        message: "A closed PO needs a closing time",
      });
  });
export type PurchaseOrder = z.infer<typeof purchaseOrderSchema>;

export const purchaseOrderDetailSchema = z.strictObject({
  purchaseOrder: purchaseOrderSchema,
  lines: z.array(purchaseOrderLineSchema),
});
export type PurchaseOrderDetail = z.infer<typeof purchaseOrderDetailSchema>;

/** Result of PRD §3.18 "Kirim PO" (email or a shareable PDF link). */
export const purchaseOrderSendResultSchema = z
  .strictObject({
    purchaseOrder: purchaseOrderSchema,
    channel: z.enum(["email", "share_link"]),
    sentTo: emailSchema.nullable(),
    shareUrl: z.url().max(2000).nullable(),
    expiresAt: isoDateTimeSchema.nullable(),
  })
  .superRefine((result, context) => {
    if (result.channel === "email" && result.sentTo === null)
      context.addIssue({
        code: "custom",
        path: ["sentTo"],
        message: "An email send needs a recipient",
      });
    if (
      result.channel === "share_link" &&
      (result.shareUrl === null || result.expiresAt === null)
    )
      context.addIssue({
        code: "custom",
        path: ["shareUrl"],
        message: "A share link needs a URL and an expiry",
      });
  });
export type PurchaseOrderSendResult = z.infer<
  typeof purchaseOrderSendResultSchema
>;

export const purchaseOrderShareLinksRevokedSchema = z.strictObject({
  revoked: z.number().int().nonnegative(),
});
export type PurchaseOrderShareLinksRevoked = z.infer<
  typeof purchaseOrderShareLinksRevokedSchema
>;

/** Whole-rupiah value of one line (quantity x unit price, one rounding). */
export function purchaseOrderLineTotalIdr(
  quantity: Decimal4,
  unitPriceIdr: Decimal4,
  mode: RoundingMode,
): Idr {
  return extendCostIdr(quantity, unitPriceIdr, mode);
}

/**
 * Header totals: subtotal from the lines, total = subtotal + the tax amount
 * the tax contract computed. The client submits neither subtotal nor total.
 */
export function purchaseOrderTotals(
  lines: readonly Pick<PurchaseOrderLine, "quantity" | "unitPriceIdr">[],
  taxIdr: Idr,
  mode: RoundingMode,
): { subtotalIdr: Idr; taxIdr: Idr; totalIdr: Idr } {
  const subtotalIdr = sumIdr(
    lines.map((line) =>
      purchaseOrderLineTotalIdr(line.quantity, line.unitPriceIdr, mode),
    ),
  );
  return { subtotalIdr, taxIdr, totalIdr: addIdr(subtotalIdr, taxIdr) };
}

const PURCHASE_ORDER_TRANSITIONS: Record<
  PurchaseOrderStatus,
  Partial<Record<PurchaseOrderAction, PurchaseOrderStatus>>
> = {
  draft: { submit: "pending_approval", cancel: "cancelled" },
  pending_approval: {
    approve: "approved",
    reject: "draft",
    cancel: "cancelled",
  },
  approved: { send: "sent", cancel: "cancelled" },
  sent: {
    receive_partial: "partially_received",
    receive_full: "received",
    close: "closed",
    cancel: "cancelled",
  },
  partially_received: {
    receive_partial: "partially_received",
    receive_full: "received",
    close: "closed",
  },
  received: { close: "closed" },
  closed: {},
  cancelled: {},
};

/**
 * Explicit PO state machine. `receive_partial` / `receive_full` are applied by
 * the goods-receipt service, never by a client action; `reject` returns the PO
 * to `draft` (PRD is silent, decision reported with the bead).
 */
export function transitionPurchaseOrder(
  from: PurchaseOrderStatus,
  action: PurchaseOrderAction,
): PurchaseOrderStatus {
  const next = PURCHASE_ORDER_TRANSITIONS[from][action];
  if (!next)
    throw new PurchasingError(
      "PURCHASE_ORDER_INVALID_TRANSITION",
      `Cannot ${action} a purchase order in ${from}`,
    );
  return next;
}

/** PRD §3.7: approval needs a submitted PO and a different person. */
export function assertPurchaseOrderApproval(
  order: Pick<PurchaseOrder, "status" | "createdBy">,
  approverId: string,
): void {
  if (order.status !== "pending_approval")
    throw new PurchasingError(
      "PURCHASE_ORDER_NOT_PENDING_APPROVAL",
      `Purchase order is ${order.status}, not pending_approval`,
    );
  if (order.createdBy.toLowerCase() === approverId.toLowerCase())
    throw new PurchasingError(
      "PURCHASE_ORDER_SELF_APPROVAL",
      "The creator cannot approve their own purchase order",
    );
}

// ---- Goods receipts (PRD §3.18 QC/partial, §6.E goods_receipts, INV-05) --

/**
 * A receipt line keeps QC in the same row (PRD §6.E qty_received /
 * qty_rejected). The accepted quantity is the difference and it is the only
 * quantity that enters stock (INV-05).
 */
export const goodsReceiptLineSchema = z
  .strictObject({
    id: goodsReceiptLineIdSchema,
    tenantId: tenantIdSchema,
    goodsReceiptId: goodsReceiptIdSchema,
    purchaseOrderLineId: purchaseOrderLineIdSchema,
    inventoryItemId: inventoryItemIdSchema,
    locationId: stockLocationIdSchema,
    quantityReceived: positiveDecimal4Schema,
    quantityRejected: nonnegativeDecimal4Schema,
    /** Receipt value per purchase unit: the PO unit price (standard cost). */
    unitCostIdr: nonnegativeDecimal4Schema,
    batchCode: z.string().trim().min(1).max(40).nullable(),
    expiresOn: businessDateSchema.nullable(),
  })
  .superRefine((line, context) => {
    if (
      parseDecimal4(line.quantityRejected) >
      parseDecimal4(line.quantityReceived)
    )
      context.addIssue({
        code: "custom",
        path: ["quantityRejected"],
        message: "Rejected quantity cannot exceed the received quantity",
      });
    if (line.expiresOn !== null && line.batchCode === null)
      context.addIssue({
        code: "custom",
        path: ["batchCode"],
        message: "An expiry date needs a batch code",
      });
  });
export type GoodsReceiptLine = z.infer<typeof goodsReceiptLineSchema>;

export const goodsReceiptSchema = z.strictObject({
  id: goodsReceiptIdSchema,
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
  purchaseOrderId: purchaseOrderIdSchema,
  supplierId: supplierIdSchema,
  number: purchaseDocumentNumberSchema,
  receivedBy: userIdSchema,
  receivedAt: isoDateTimeSchema,
  /** Business date in the outlet time zone (D-CORE-6). */
  receivedOn: businessDateSchema,
  qcNotes: z.string().trim().max(500).nullable(),
  /** Photo evidence of the delivery and QC (PRD §3.18). */
  mediaIds: z.array(uuidSchema).max(10),
  note,
  createdAt: isoDateTimeSchema,
});
export type GoodsReceipt = z.infer<typeof goodsReceiptSchema>;

export const goodsReceiptDetailSchema = z.strictObject({
  receipt: goodsReceiptSchema,
  lines: z.array(goodsReceiptLineSchema),
});
export type GoodsReceiptDetail = z.infer<typeof goodsReceiptDetailSchema>;

/** Quantity that enters stock: received minus QC-rejected (INV-05). */
export function acceptedQuantity(
  line: Pick<GoodsReceiptLine, "quantityReceived" | "quantityRejected">,
): Decimal4 {
  return formatDecimal4(
    parseDecimal4(line.quantityReceived) - parseDecimal4(line.quantityRejected),
  );
}

/** Stock value of a receipt in whole rupiah (accepted quantity x unit cost). */
export function goodsReceiptValueIdr(
  lines: readonly Pick<
    GoodsReceiptLine,
    "quantityReceived" | "quantityRejected" | "unitCostIdr"
  >[],
  mode: RoundingMode,
): Idr {
  return sumIdr(
    lines.map((line) =>
      extendCostIdr(acceptedQuantity(line), line.unitCostIdr, mode),
    ),
  );
}

/** Accepted quantity already received for one PO line, across receipts. */
export function acceptedReceivedQuantity(
  receiptLines: readonly Pick<
    GoodsReceiptLine,
    "purchaseOrderLineId" | "quantityReceived" | "quantityRejected"
  >[],
  purchaseOrderLineId: string,
): Decimal4 {
  let total = 0n;
  for (const line of receiptLines) {
    if (line.purchaseOrderLineId !== purchaseOrderLineId) continue;
    total +=
      parseDecimal4(line.quantityReceived) -
      parseDecimal4(line.quantityRejected);
  }
  return formatDecimal4(total);
}

/**
 * INV-05 guard: every new receipt line belongs to this PO and its item, and
 * cumulative accepted receipts never exceed the ordered quantity. `priorLines`
 * are already posted receipts, `newLines` the receipt being recorded.
 */
export function assertGoodsReceiptMatchesOrder(
  orderLines: readonly Pick<
    PurchaseOrderLine,
    "id" | "inventoryItemId" | "quantity"
  >[],
  priorLines: readonly Pick<
    GoodsReceiptLine,
    | "purchaseOrderLineId"
    | "inventoryItemId"
    | "quantityReceived"
    | "quantityRejected"
  >[],
  newLines: readonly Pick<
    GoodsReceiptLine,
    | "purchaseOrderLineId"
    | "inventoryItemId"
    | "quantityReceived"
    | "quantityRejected"
  >[],
): void {
  const orderLineById = new Map(orderLines.map((line) => [line.id, line]));
  const accepted = new Map<string, bigint>();
  for (const line of priorLines) {
    const current = accepted.get(line.purchaseOrderLineId) ?? 0n;
    accepted.set(
      line.purchaseOrderLineId,
      current +
        parseDecimal4(line.quantityReceived) -
        parseDecimal4(line.quantityRejected),
    );
  }
  for (const line of newLines) {
    const orderLine = orderLineById.get(line.purchaseOrderLineId);
    if (!orderLine)
      throw new PurchasingError(
        "PURCHASE_ORDER_LINE_MISMATCH",
        `Receipt line ${line.purchaseOrderLineId} is not on this purchase order`,
      );
    if (orderLine.inventoryItemId !== line.inventoryItemId)
      throw new PurchasingError(
        "PURCHASE_ORDER_LINE_MISMATCH",
        `Receipt line ${line.purchaseOrderLineId} is for another item`,
      );
    const next =
      (accepted.get(line.purchaseOrderLineId) ?? 0n) +
      parseDecimal4(line.quantityReceived) -
      parseDecimal4(line.quantityRejected);
    if (next > parseDecimal4(orderLine.quantity))
      throw new PurchasingError(
        "PURCHASE_ORDER_OVER_RECEIPT",
        `Line ${line.purchaseOrderLineId} would receive ${formatDecimal4(next)} of ${orderLine.quantity}`,
      );
    accepted.set(line.purchaseOrderLineId, next);
  }
}

/**
 * PO status after recording a receipt: `received` when every line's accepted
 * quantity reaches its order quantity, `partially_received` while some is
 * outstanding, null when the given receipt lines accepted nothing (all
 * QC-rejected).
 */
export function purchaseOrderStatusAfterReceipt(
  orderLines: readonly Pick<PurchaseOrderLine, "id" | "quantity">[],
  receiptLines: readonly Pick<
    GoodsReceiptLine,
    "purchaseOrderLineId" | "quantityReceived" | "quantityRejected"
  >[],
): "partially_received" | "received" | null {
  let acceptedAny = false;
  let complete = true;
  for (const orderLine of orderLines) {
    const accepted = parseDecimal4(
      acceptedReceivedQuantity(receiptLines, orderLine.id),
    );
    if (accepted > 0n) acceptedAny = true;
    if (accepted < parseDecimal4(orderLine.quantity)) complete = false;
  }
  if (!acceptedAny) return null;
  return complete ? "received" : "partially_received";
}

// ---- Supplier invoices and the three-way match (PRD §3.18, §6.E) ---------

export const supplierInvoiceMatchStatusSchema = z.enum([
  "pending",
  "matched",
  "discrepancy",
]);
export type SupplierInvoiceMatchStatus = z.infer<
  typeof supplierInvoiceMatchStatusSchema
>;

/**
 * Lifecycle of a recorded supplier invoice. `matched`: clean three-way match,
 * the payable is booked. `held`: the match found an issue, nothing is booked
 * and nothing can be paid. `released`: finance released a held invoice and the
 * payable is booked. `rejected`: a held invoice that will never be booked.
 * `matchStatus` stays the coarse view of the same fact.
 */
export const supplierInvoiceStatusSchema = z.enum([
  "matched",
  "held",
  "released",
  "rejected",
]);
export type SupplierInvoiceStatus = z.infer<typeof supplierInvoiceStatusSchema>;

export const supplierInvoiceLineKindSchema = z.enum(["goods", "service"]);
export type SupplierInvoiceLineKind = z.infer<
  typeof supplierInvoiceLineKindSchema
>;

/**
 * One invoiced line. Goods lines may reference a PO line; service lines
 * (PPh 23 jasa supplier, §3.19) have no stock receipt, so they take part in
 * the amount match only.
 */
export const supplierInvoiceLineSchema = z.strictObject({
  id: supplierInvoiceLineIdSchema,
  tenantId: tenantIdSchema,
  supplierInvoiceId: supplierInvoiceIdSchema,
  purchaseOrderLineId: purchaseOrderLineIdSchema.nullable(),
  kind: supplierInvoiceLineKindSchema,
  description: z.string().trim().min(1).max(200),
  quantity: positiveDecimal4Schema,
  unitPriceIdr: nonnegativeDecimal4Schema,
  lineTotalIdr: nonnegativeIdrSchema,
});
export type SupplierInvoiceLine = z.infer<typeof supplierInvoiceLineSchema>;

/**
 * Recorded supplier invoice. Header amounts are server-computed from the lines
 * and the match: `goodsIdr` is the invoiced goods valued at the PO price (the
 * amount that clears GRNI, which the receipt credited at PO cost),
 * `priceVarianceIdr` is the line-level price difference against the PO price
 * (invoiced goods at invoice price = goods + variance), `totalIdr = goods +
 * variance + services + ppn` is what the supplier billed, and
 * `payableIdr = total - pph23` (PPh 23 is withheld from the payment). A
 * quantity difference is a match issue, not a price variance.
 */
export const supplierInvoiceSchema = z
  .strictObject({
    id: supplierInvoiceIdSchema,
    tenantId: tenantIdSchema,
    outletId: outletIdSchema,
    supplierId: supplierIdSchema,
    purchaseOrderId: purchaseOrderIdSchema,
    number: z.string().trim().min(1).max(60),
    invoiceDate: businessDateSchema,
    dueDate: businessDateSchema,
    goodsIdr: nonnegativeIdrSchema,
    priceVarianceIdr: idrSchema,
    servicesIdr: nonnegativeIdrSchema,
    ppnIdr: nonnegativeIdrSchema,
    pph23Idr: nonnegativeIdrSchema,
    totalIdr: nonnegativeIdrSchema,
    payableIdr: nonnegativeIdrSchema,
    paidIdr: nonnegativeIdrSchema,
    outstandingIdr: nonnegativeIdrSchema,
    status: supplierInvoiceStatusSchema,
    matchStatus: supplierInvoiceMatchStatusSchema,
    matchedAt: isoDateTimeSchema.nullable(),
    matchNote: z.string().trim().max(500).nullable(),
    recordedBy: userIdSchema,
    recordedAt: isoDateTimeSchema,
  })
  .superRefine((invoice, context) => {
    const expectedTotal = [
      invoice.goodsIdr,
      invoice.priceVarianceIdr,
      invoice.servicesIdr,
      invoice.ppnIdr,
    ].reduce((total, amount) => total + amount, 0);
    if (expectedTotal !== invoice.totalIdr)
      context.addIssue({
        code: "custom",
        path: ["totalIdr"],
        message: "total = goods + price variance + services + ppn",
      });
    if (subtractIdr(invoice.totalIdr, invoice.pph23Idr) !== invoice.payableIdr)
      context.addIssue({
        code: "custom",
        path: ["payableIdr"],
        message: "payable = total - pph23",
      });
    // A held or rejected invoice is not a payable: nothing is outstanding.
    const expectedOutstanding =
      invoice.status === "held" || invoice.status === "rejected"
        ? 0
        : subtractIdr(invoice.payableIdr, invoice.paidIdr);
    if (expectedOutstanding !== invoice.outstandingIdr)
      context.addIssue({
        code: "custom",
        path: ["outstandingIdr"],
        message:
          "outstanding = 0 for held or rejected, otherwise payable - paid",
      });
    if (invoice.dueDate < invoice.invoiceDate)
      context.addIssue({
        code: "custom",
        path: ["dueDate"],
        message: "dueDate must not be before invoiceDate",
      });
    if (
      (invoice.status === "matched" || invoice.status === "released") !==
      (invoice.matchStatus === "matched")
    )
      context.addIssue({
        code: "custom",
        path: ["matchStatus"],
        message:
          "matchStatus is matched exactly when status is matched or released",
      });
    if (invoice.matchStatus === "pending" && invoice.matchedAt !== null)
      context.addIssue({
        code: "custom",
        path: ["matchedAt"],
        message: "A pending invoice has not been matched yet",
      });
    if (invoice.matchStatus !== "pending" && invoice.matchedAt === null)
      context.addIssue({
        code: "custom",
        path: ["matchedAt"],
        message: "A matched or discrepant invoice needs a match time",
      });
    if (
      invoice.matchStatus === "discrepancy" &&
      (invoice.matchNote === null || invoice.matchNote.length === 0)
    )
      context.addIssue({
        code: "custom",
        path: ["matchNote"],
        message: "A discrepancy needs an explanation",
      });
  });
export type SupplierInvoice = z.infer<typeof supplierInvoiceSchema>;

// ---- Three-way match (PRD §3.18, §4 Alur I step 4) -----------------------

export const threeWayMatchIssueSchema = z.enum([
  /** Invoiced quantity exceeds the accepted receipt for that line. */
  "quantity_exceeds_receipt",
  /** Invoice unit price deviates from the PO price beyond the tolerance. */
  "price_outside_tolerance",
  /** A goods line does not reference a line of this PO. */
  "no_purchase_order_line",
  /** quantity x unitPrice does not equal the stored line total. */
  "line_total_mismatch",
  /** Header goods/services amounts do not equal the sum of the lines. */
  "invoice_total_mismatch",
]);
export type ThreeWayMatchIssue = z.infer<typeof threeWayMatchIssueSchema>;

export const threeWayMatchRowSchema = z.strictObject({
  invoiceLineId: supplierInvoiceLineIdSchema,
  purchaseOrderLineId: purchaseOrderLineIdSchema.nullable(),
  kind: supplierInvoiceLineKindSchema,
  orderedQty: nonnegativeDecimal4Schema.nullable(),
  acceptedQty: nonnegativeDecimal4Schema.nullable(),
  /** Available before this line, excluding this invoice from prior invoices. */
  remainingInvoiceableQty: nonnegativeDecimal4Schema.nullable().default(null),
  invoicedQty: positiveDecimal4Schema,
  orderedUnitPriceIdr: nonnegativeDecimal4Schema.nullable(),
  invoicedUnitPriceIdr: nonnegativeDecimal4Schema,
  /** Signed deviation from the PO price; null when the PO price is zero. */
  priceVarianceBp: z.number().int().nullable(),
  priceVarianceIdr: idrSchema,
  issues: z.array(threeWayMatchIssueSchema),
});
export type ThreeWayMatchRow = z.infer<typeof threeWayMatchRowSchema>;

export const threeWayMatchSchema = z.strictObject({
  purchaseOrderId: purchaseOrderIdSchema,
  invoiceId: supplierInvoiceIdSchema,
  /** Tenant match tolerance in basis points; 0 is exact match. */
  toleranceBp: basisPointsSchema,
  status: z.enum(["matched", "discrepancy"]),
  orderedValueIdr: nonnegativeIdrSchema,
  receivedValueIdr: nonnegativeIdrSchema,
  invoicedGoodsIdr: nonnegativeIdrSchema,
  invoicedServicesIdr: nonnegativeIdrSchema,
  priceVarianceIdr: idrSchema,
  rows: z.array(threeWayMatchRowSchema),
  headerIssues: z.array(threeWayMatchIssueSchema),
  computedAt: isoDateTimeSchema,
});
export type ThreeWayMatch = z.infer<typeof threeWayMatchSchema>;

/**
 * PO x receipt x invoice comparison. A goods line is discrepant when it
 * invoices more than the accepted receipt or when its unit price deviates from
 * the PO price by more than `toleranceBp` (compared exactly, no rounding);
 * the cap is the accepted receipt minus returned quantity, with no quantity
 * tolerance; header amounts must equal the line sums. Service lines are matched on amount only. Throws
 * `THREE_WAY_MATCH_INVALID_INPUT` when an invoice line points at a PO line
 * that is not in `purchaseOrderLines`.
 */
export function threeWayMatch(
  input: {
    invoice: Pick<
      SupplierInvoice,
      "id" | "purchaseOrderId" | "goodsIdr" | "servicesIdr"
    >;
    invoiceLines: readonly SupplierInvoiceLine[];
    purchaseOrderLines: readonly PurchaseOrderLine[];
    goodsReceiptLines: readonly Pick<
      GoodsReceiptLine,
      "purchaseOrderLineId" | "quantityReceived" | "quantityRejected"
    >[];
    toleranceBp: number;
    computedAt: IsoDateTime;
    /**
     * Goods lines of earlier, non-void invoices on the same PO. The accepted
     * receipt is a cumulative cap: two invoices may not each bill it in full.
     */
    previouslyInvoicedLines?: readonly Pick<
      SupplierInvoiceLine,
      "purchaseOrderLineId" | "kind" | "quantity"
    >[];
    /**
     * Quantity already returned to the supplier per PO line, in the PO unit
     * (the service converts base quantity with the receipt line's ratio). It
     * is subtracted from the accepted receipt: a returned item is not billed.
     */
    returnedLines?: readonly {
      purchaseOrderLineId: string;
      quantity: Decimal4;
    }[];
  },
  mode: RoundingMode,
): ThreeWayMatch {
  if (
    !Number.isInteger(input.toleranceBp) ||
    input.toleranceBp < 0 ||
    input.toleranceBp > 10_000
  )
    throw new RangeError(`Invalid tolerance: ${input.toleranceBp}`);
  const orderLineById = new Map(
    input.purchaseOrderLines.map((line) => [line.id, line]),
  );
  const acceptedByLine = new Map<string, bigint>();
  for (const line of input.goodsReceiptLines) {
    if (!orderLineById.has(line.purchaseOrderLineId)) continue;
    const current = acceptedByLine.get(line.purchaseOrderLineId) ?? 0n;
    acceptedByLine.set(
      line.purchaseOrderLineId,
      current +
        parseDecimal4(line.quantityReceived) -
        parseDecimal4(line.quantityRejected),
    );
  }
  // Net received = accepted - returned (never below zero). This is the
  // cumulative cap on the billed quantity; the quantity tolerance is zero.
  for (const line of input.returnedLines ?? []) {
    const current = acceptedByLine.get(line.purchaseOrderLineId);
    if (current === undefined) continue;
    const net = current - parseDecimal4(line.quantity);
    acceptedByLine.set(line.purchaseOrderLineId, net > 0n ? net : 0n);
  }

  // Quantity already billed per PO line (earlier invoices, then this
  // invoice's earlier lines), so the receipt cap is cumulative.
  const invoicedByLine = new Map<string, bigint>();
  for (const line of input.previouslyInvoicedLines ?? []) {
    if (line.kind !== "goods" || line.purchaseOrderLineId === null) continue;
    invoicedByLine.set(
      line.purchaseOrderLineId,
      (invoicedByLine.get(line.purchaseOrderLineId) ?? 0n) +
        parseDecimal4(line.quantity),
    );
  }
  let invoicedGoodsIdr: Idr = idr(0);
  let invoicedServicesIdr: Idr = idr(0);
  const rows: ThreeWayMatchRow[] = input.invoiceLines.map((line) => {
    if (
      line.purchaseOrderLineId !== null &&
      !orderLineById.has(line.purchaseOrderLineId)
    )
      throw new PurchasingError(
        "THREE_WAY_MATCH_INVALID_INPUT",
        `Invoice line ${line.id} points at PO line ${line.purchaseOrderLineId} outside this order`,
      );
    const issues: ThreeWayMatchIssue[] = [];
    if (line.kind === "goods")
      invoicedGoodsIdr = addIdr(invoicedGoodsIdr, line.lineTotalIdr);
    else invoicedServicesIdr = addIdr(invoicedServicesIdr, line.lineTotalIdr);
    const expectedLineTotal = extendCostIdr(
      line.quantity,
      line.unitPriceIdr,
      mode,
    );
    if (expectedLineTotal !== line.lineTotalIdr)
      issues.push("line_total_mismatch");
    const orderLine =
      line.purchaseOrderLineId === null
        ? null
        : (orderLineById.get(line.purchaseOrderLineId) ?? null);
    if (line.kind === "goods" && orderLine === null)
      issues.push("no_purchase_order_line");
    if (orderLine === null)
      return {
        invoiceLineId: line.id,
        purchaseOrderLineId: line.purchaseOrderLineId,
        kind: line.kind,
        orderedQty: null,
        acceptedQty: null,
        remainingInvoiceableQty: null,
        invoicedQty: line.quantity,
        orderedUnitPriceIdr: null,
        invoicedUnitPriceIdr: line.unitPriceIdr,
        priceVarianceBp: null,
        priceVarianceIdr: idr(0),
        issues,
      };
    const accepted = acceptedByLine.get(orderLine.id) ?? 0n;
    const remaining = accepted - (invoicedByLine.get(orderLine.id) ?? 0n);
    if (line.kind === "goods") {
      const billed =
        (invoicedByLine.get(orderLine.id) ?? 0n) + parseDecimal4(line.quantity);
      invoicedByLine.set(orderLine.id, billed);
      if (billed > accepted) issues.push("quantity_exceeds_receipt");
    }
    const orderedPrice = parseDecimal4(orderLine.unitPriceIdr);
    const invoicedPrice = parseDecimal4(line.unitPriceIdr);
    const priceVarianceBp =
      orderedPrice === 0n
        ? null
        : Number(
            divideRounded(
              (invoicedPrice - orderedPrice) * 10_000n,
              orderedPrice,
              mode,
            ),
          );
    // Exact comparison: the rounded `priceVarianceBp` can pass 200.4 bp on a
    // 200 bp tolerance, so the check never uses it.
    const priceDifference =
      invoicedPrice > orderedPrice
        ? invoicedPrice - orderedPrice
        : orderedPrice - invoicedPrice;
    if (
      orderedPrice === 0n
        ? invoicedPrice !== 0n
        : priceDifference * 10_000n > BigInt(input.toleranceBp) * orderedPrice
    )
      issues.push("price_outside_tolerance");
    return {
      invoiceLineId: line.id,
      purchaseOrderLineId: line.purchaseOrderLineId,
      kind: line.kind,
      orderedQty: orderLine.quantity,
      acceptedQty: formatDecimal4(accepted),
      remainingInvoiceableQty: formatDecimal4(remaining > 0n ? remaining : 0n),
      invoicedQty: line.quantity,
      orderedUnitPriceIdr: orderLine.unitPriceIdr,
      invoicedUnitPriceIdr: line.unitPriceIdr,
      priceVarianceBp,
      priceVarianceIdr: subtractIdr(
        expectedLineTotal,
        extendCostIdr(line.quantity, orderLine.unitPriceIdr, mode),
      ),
      issues,
    };
  });

  const receivedValueIdr = input.purchaseOrderLines.reduce(
    (total, line) =>
      addIdr(
        total,
        extendCostIdr(
          formatDecimal4(acceptedByLine.get(line.id) ?? 0n),
          line.unitPriceIdr,
          mode,
        ),
      ),
    idr(0),
  );
  const orderedValueIdr = sumIdr(
    input.purchaseOrderLines.map((line) =>
      extendCostIdr(line.quantity, line.unitPriceIdr, mode),
    ),
  );
  const priceVarianceIdr = sumIdr(rows.map((row) => row.priceVarianceIdr));
  const headerIssues: ThreeWayMatchIssue[] = [];
  // Header goods are at PO price: invoice-price goods minus the price variance.
  if (
    invoicedGoodsIdr !== addIdr(input.invoice.goodsIdr, priceVarianceIdr) ||
    invoicedServicesIdr !== input.invoice.servicesIdr
  )
    headerIssues.push("invoice_total_mismatch");
  const discrepant =
    headerIssues.length > 0 || rows.some((row) => row.issues.length > 0);
  return threeWayMatchSchema.parse({
    purchaseOrderId: input.invoice.purchaseOrderId,
    invoiceId: input.invoice.id,
    toleranceBp: input.toleranceBp,
    status: discrepant ? "discrepancy" : "matched",
    orderedValueIdr,
    receivedValueIdr,
    invoicedGoodsIdr,
    invoicedServicesIdr,
    priceVarianceIdr,
    rows,
    headerIssues,
    computedAt: input.computedAt,
  });
}

/**
 * Tenant purchasing policy (one row per tenant). A tenant without a row uses
 * the default tolerance of 0 bp: the invoice must match the PO price exactly
 * until finance sets a looser one. Loosening the tolerance raises the risk of
 * overpaying a supplier, so the cap is 10%.
 */
export const PURCHASING_DEFAULT_TOLERANCE_BP = 0;
export const PURCHASING_MAX_TOLERANCE_BP = 1000;

export const purchasingPolicySchema = z.strictObject({
  tenantId: tenantIdSchema,
  threeWayMatchToleranceBp: z
    .number()
    .int()
    .min(0)
    .max(PURCHASING_MAX_TOLERANCE_BP),
  /** Null while the tenant still runs on the default (no row yet). */
  updatedAt: isoDateTimeSchema.nullable(),
  updatedBy: userIdSchema.nullable(),
});
export type PurchasingPolicy = z.infer<typeof purchasingPolicySchema>;

export const supplierInvoiceDetailSchema = z.strictObject({
  invoice: supplierInvoiceSchema,
  lines: z.array(supplierInvoiceLineSchema),
  match: threeWayMatchSchema.nullable(),
});
export type SupplierInvoiceDetail = z.infer<typeof supplierInvoiceDetailSchema>;

export const supplierInvoicePaymentStatusSchema = z.enum([
  "unpaid",
  "partially_paid",
  "paid",
  "overdue",
]);
export type SupplierInvoicePaymentStatus = z.infer<
  typeof supplierInvoicePaymentStatusSchema
>;

/** Payment state on `asOf` (outlet business date): overdue wins once due. */
export function supplierInvoicePaymentStatus(
  invoice: Pick<SupplierInvoice, "paidIdr" | "outstandingIdr" | "dueDate">,
  asOf: BusinessDate,
): SupplierInvoicePaymentStatus {
  if (invoice.outstandingIdr === 0) return "paid";
  if (invoice.dueDate < asOf) return "overdue";
  if (invoice.paidIdr > 0) return "partially_paid";
  return "unpaid";
}

// ---- Supplier payments (PRD §3.18 payment with approval, §6.E) -----------

export const supplierPaymentStatusSchema = z.enum([
  "pending_approval",
  "approved",
  "paid",
  "rejected",
  "cancelled",
]);
export type SupplierPaymentStatus = z.infer<typeof supplierPaymentStatusSchema>;

export const supplierPaymentActionSchema = z.enum([
  "approve",
  "reject",
  "pay",
  "cancel",
]);
export type SupplierPaymentAction = z.infer<typeof supplierPaymentActionSchema>;

/** PRD §6.E supplier_payments: invoice_id, amount_idr, paid_at, approved_by. */
export const supplierPaymentMethodSchema = z.enum([
  "bank_transfer",
  "cash",
  "qris",
  "virtual_account",
]);
export type SupplierPaymentMethod = z.infer<typeof supplierPaymentMethodSchema>;

export const supplierPaymentSchema = z
  .strictObject({
    id: supplierPaymentIdSchema,
    tenantId: tenantIdSchema,
    supplierId: supplierIdSchema,
    supplierInvoiceId: supplierInvoiceIdSchema,
    amountIdr: idrSchema.refine(
      (amount) => amount > 0,
      "Payment amount must be greater than zero",
    ),
    method: supplierPaymentMethodSchema,
    reference: z.string().trim().min(1).max(60).nullable(),
    status: supplierPaymentStatusSchema,
    requestedBy: userIdSchema,
    requestedAt: isoDateTimeSchema,
    approvedBy: userIdSchema.nullable(),
    approvedAt: isoDateTimeSchema.nullable(),
    paidAt: isoDateTimeSchema.nullable(),
    note,
    createdAt: isoDateTimeSchema,
  })
  .superRefine((payment, context) => {
    const approved = ["approved", "paid"].includes(payment.status);
    if (
      approved &&
      (payment.approvedBy === null || payment.approvedAt === null)
    )
      context.addIssue({
        code: "custom",
        path: ["approvedBy"],
        message: "An approved payment needs an approver and time",
      });
    if (payment.status === "pending_approval" && payment.approvedBy !== null)
      context.addIssue({
        code: "custom",
        path: ["approvedBy"],
        message: "A pending payment has no approver yet",
      });
    if (
      payment.approvedBy !== null &&
      payment.approvedBy.toLowerCase() === payment.requestedBy.toLowerCase()
    )
      context.addIssue({
        code: "custom",
        path: ["approvedBy"],
        message: "The requester cannot approve their own payment",
      });
    if (payment.status === "paid" && payment.paidAt === null)
      context.addIssue({
        code: "custom",
        path: ["paidAt"],
        message: "A paid payment needs a payment time",
      });
    if (payment.status !== "paid" && payment.paidAt !== null)
      context.addIssue({
        code: "custom",
        path: ["paidAt"],
        message: "Only a paid payment has a payment time",
      });
  });
export type SupplierPayment = z.infer<typeof supplierPaymentSchema>;

export const supplierPaymentDetailSchema = z.strictObject({
  payment: supplierPaymentSchema,
  invoice: supplierInvoiceSchema,
});
export type SupplierPaymentDetail = z.infer<typeof supplierPaymentDetailSchema>;

const SUPPLIER_PAYMENT_TRANSITIONS: Record<
  SupplierPaymentStatus,
  Partial<Record<SupplierPaymentAction, SupplierPaymentStatus>>
> = {
  pending_approval: {
    approve: "approved",
    reject: "rejected",
    cancel: "cancelled",
  },
  approved: { pay: "paid", cancel: "cancelled" },
  paid: {},
  rejected: {},
  cancelled: {},
};

/** Explicit payment state machine (`pay` records the bank transfer). */
export function transitionSupplierPayment(
  from: SupplierPaymentStatus,
  action: SupplierPaymentAction,
): SupplierPaymentStatus {
  const next = SUPPLIER_PAYMENT_TRANSITIONS[from][action];
  if (!next)
    throw new PurchasingError(
      "SUPPLIER_PAYMENT_INVALID_TRANSITION",
      `Cannot ${action} a supplier payment in ${from}`,
    );
  return next;
}

/** PRD §3.7: approval needs a pending request and a different person. */
export function assertSupplierPaymentApproval(
  payment: Pick<SupplierPayment, "status" | "requestedBy">,
  approverId: string,
): void {
  if (payment.status !== "pending_approval")
    throw new PurchasingError(
      "SUPPLIER_PAYMENT_NOT_PENDING_APPROVAL",
      `Supplier payment is ${payment.status}, not pending_approval`,
    );
  if (payment.requestedBy.toLowerCase() === approverId.toLowerCase())
    throw new PurchasingError(
      "SUPPLIER_PAYMENT_SELF_APPROVAL",
      "The requester cannot approve their own payment",
    );
}

/** A payment needs a matched invoice with something left to pay. */
export function assertSupplierInvoicePayable(
  invoice: Pick<SupplierInvoice, "matchStatus" | "outstandingIdr">,
): void {
  if (invoice.matchStatus !== "matched")
    throw new PurchasingError(
      "SUPPLIER_INVOICE_NOT_MATCHED",
      `Invoice is ${invoice.matchStatus}; three-way match must pass first`,
    );
  if (invoice.outstandingIdr <= 0)
    throw new PurchasingError(
      "SUPPLIER_INVOICE_NOT_PAYABLE",
      "The invoice has no outstanding amount",
    );
}

/**
 * Partial payments are allowed; the new payment plus every payment already
 * requested or approved but not yet paid (`openPayments`, status
 * `pending_approval` or `approved`) may not exceed `outstandingIdr`, so two
 * concurrent requests cannot overpay one invoice. Paid payments are already
 * inside `outstandingIdr`; rejected/cancelled ones are ignored.
 */
export function assertSupplierPaymentWithinInvoice(
  invoice: Pick<SupplierInvoice, "outstandingIdr">,
  amountIdr: Idr,
  openPayments: readonly Pick<SupplierPayment, "amountIdr" | "status">[],
): void {
  const committed = sumIdr(
    openPayments
      .filter(
        (payment) =>
          payment.status === "pending_approval" ||
          payment.status === "approved",
      )
      .map((payment) => payment.amountIdr),
  );
  if (addIdr(committed, amountIdr) > invoice.outstandingIdr)
    throw new PurchasingError(
      "SUPPLIER_INVOICE_OVERPAYMENT",
      `Payment ${amountIdr} plus open requests ${committed} exceeds outstanding ${invoice.outstandingIdr}`,
    );
}

// ---- Purchase returns (PRD §3.18 Retur Pembelian) ------------------------

/**
 * Standard return reasons proposed for the UI; the PRD names the nota retur
 * but not its reason list, so the owner can extend this enum before release.
 */
export const purchaseReturnReasonSchema = z.enum([
  "damaged",
  "wrong_item",
  "expired",
  "quality_reject",
  "over_delivery",
  "other",
]);
export type PurchaseReturnReason = z.infer<typeof purchaseReturnReasonSchema>;

export const purchaseReturnLineSchema = z.strictObject({
  id: purchaseReturnLineIdSchema,
  tenantId: tenantIdSchema,
  purchaseReturnId: purchaseReturnIdSchema,
  inventoryItemId: inventoryItemIdSchema,
  purchaseOrderLineId: purchaseOrderLineIdSchema.nullable(),
  quantity: positiveDecimal4Schema,
  unitCostIdr: nonnegativeDecimal4Schema,
  lineValueIdr: nonnegativeIdrSchema,
  batchCode: z.string().trim().min(1).max(40).nullable(),
});
export type PurchaseReturnLine = z.infer<typeof purchaseReturnLineSchema>;

/**
 * Immutable return note (PRD §3.18 "nota retur"). The service writes a
 * negative `return` stock-ledger row per line (inventory contract); the PRD
 * asks for no approval step on a return.
 */
export const purchaseReturnSchema = z.strictObject({
  id: purchaseReturnIdSchema,
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
  supplierId: supplierIdSchema,
  purchaseOrderId: purchaseOrderIdSchema.nullable(),
  goodsReceiptId: goodsReceiptIdSchema.nullable(),
  number: purchaseDocumentNumberSchema,
  returnedOn: businessDateSchema,
  returnedBy: userIdSchema,
  reason: purchaseReturnReasonSchema,
  valueIdr: nonnegativeIdrSchema,
  note,
  createdAt: isoDateTimeSchema,
});
export type PurchaseReturn = z.infer<typeof purchaseReturnSchema>;

export const purchaseReturnDetailSchema = z.strictObject({
  purchaseReturn: purchaseReturnSchema,
  lines: z.array(purchaseReturnLineSchema),
});
export type PurchaseReturnDetail = z.infer<typeof purchaseReturnDetailSchema>;

/** Sum of the returned line values in whole rupiah. */
export function purchaseReturnValueIdr(
  lines: readonly Pick<PurchaseReturnLine, "quantity" | "unitCostIdr">[],
  mode: RoundingMode,
): Idr {
  return sumIdr(
    lines.map((line) => extendCostIdr(line.quantity, line.unitCostIdr, mode)),
  );
}

/**
 * A return may not exceed what was accepted for that PO line, taking earlier
 * returns into account. Lines without a PO line are manual adjustments and are
 * left to the service. Map values are accepted/received and already returned
 * quantities per `purchaseOrderLineId`.
 */
export function assertPurchaseReturnWithinReceipt(
  acceptedByLine: ReadonlyMap<string, Decimal4>,
  returnedByLine: ReadonlyMap<string, Decimal4>,
  lines: readonly Pick<
    PurchaseReturnLine,
    "purchaseOrderLineId" | "quantity"
  >[],
): void {
  for (const line of lines) {
    if (line.purchaseOrderLineId === null) continue;
    const accepted = acceptedByLine.get(line.purchaseOrderLineId);
    if (accepted === undefined)
      throw new PurchasingError(
        "PURCHASE_RETURN_EXCEEDS_RECEIPT",
        `No accepted receipt for PO line ${line.purchaseOrderLineId}`,
      );
    const returned = parseDecimal4(
      returnedByLine.get(line.purchaseOrderLineId) ?? "0.0000",
    );
    if (returned + parseDecimal4(line.quantity) > parseDecimal4(accepted))
      throw new PurchasingError(
        "PURCHASE_RETURN_EXCEEDS_RECEIPT",
        `Returning ${line.quantity} exceeds the accepted quantity of line ${line.purchaseOrderLineId}`,
      );
  }
}

// ---- Simple/petty purchases (PRD §3.18 Pembelian Sederhana) --------------

/**
 * Spend limit for cash purchases at the market (PRD §3.18 "batas nominal").
 * An outlet row overrides the tenant default (`outletId: null`).
 */
export const pettyPurchasePolicySchema = z.strictObject({
  tenantId: tenantIdSchema,
  outletId: outletIdSchema.nullable(),
  limitIdr: idrSchema.refine(
    (limit) => limit > 0,
    "The limit must be greater than zero",
  ),
});
export type PettyPurchasePolicy = z.infer<typeof pettyPurchasePolicySchema>;

/** Effective limit for an outlet: an outlet row wins over the tenant default. */
export function pettyPurchaseLimitFor(
  policies: readonly PettyPurchasePolicy[],
  outletId: string,
): Idr | null {
  const outletPolicy = policies.find(
    (policy) => policy.outletId !== null && policy.outletId === outletId,
  );
  if (outletPolicy) return outletPolicy.limitIdr;
  const tenantPolicy = policies.find((policy) => policy.outletId === null);
  return tenantPolicy?.limitIdr ?? null;
}

/**
 * PRD §3.18: a cash purchase over the configured limit needs the normal PO.
 * A missing policy denies the purchase (deny by default); seed the tenant row.
 */
export function assertPettyPurchaseWithinLimit(
  amountIdr: Idr,
  limitIdr: Idr | null,
): void {
  if (limitIdr === null)
    throw new PurchasingError(
      "PETTY_PURCHASE_LIMIT_EXCEEDED",
      "No petty purchase limit is configured for this outlet",
    );
  if (amountIdr > limitIdr)
    throw new PurchasingError(
      "PETTY_PURCHASE_LIMIT_EXCEEDED",
      `Petty purchase ${amountIdr} exceeds the limit ${limitIdr}`,
    );
}

/**
 * Small cash purchase with mandatory photo evidence (PRD §3.18). It records
 * the spend only; the PRD does not make it a stock document, so stock entry
 * stays with a goods receipt or a manual adjustment.
 */
export const pettyPurchaseSchema = z.strictObject({
  id: pettyPurchaseIdSchema,
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
  vendorName: z.string().trim().min(1).max(150),
  description: z.string().trim().min(1).max(200),
  amountIdr: idrSchema.refine(
    (amount) => amount > 0,
    "The amount must be greater than zero",
  ),
  /** Photo of the receipt/goods (PRD §3.18 "bukti foto"). */
  photoMediaId: uuidSchema,
  paidBy: userIdSchema,
  paidAt: isoDateTimeSchema,
  businessDate: businessDateSchema,
  note,
  createdAt: isoDateTimeSchema,
});
export type PettyPurchase = z.infer<typeof pettyPurchaseSchema>;
