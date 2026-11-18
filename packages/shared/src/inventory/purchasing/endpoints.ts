// Purchasing endpoint contracts (bead legend-ejk). The web app's typed client
// and mock mode, and later the API route validation, read these objects (see
// docs/frontend.md, "Typed endpoints and mock mode"). Paths live under
// /api/inventory so they cannot collide with another domain.
//
// Tenant comes from the domain or token, never the body (TEN-02). Outlet ids
// in a query or write ARE client input: the server checks them against the
// caller's outlet scope (TEN-03). Lists use cursor pagination (D-CORE-5);
// writes that create documents carry an idempotency key.
//
// Money the server computes is never accepted from the client: PO subtotal,
// tax and total, receipt unit cost and value, invoice totals and match status
// and payment status are all server-derived.

import {
  businessDateSchema,
  clientInputSchema,
  cursorPageQuerySchema,
  cursorPageSchema,
  dataResponseSchema,
  idempotencyKeySchema,
  isoDateTimeSchema,
  outletIdSchema,
  uuidSchema,
  z,
} from "../../core/index.ts";
import { defineEndpoint } from "../../api/index.ts";
import { getPurchaseOrderPdfPreview } from "./preview.ts";
import {
  retrySupplierPaymentSettlementInputSchema,
  supplierInvoicePaymentSchema,
} from "./supplier-payment-request.ts";
import {
  inventoryItemIdSchema,
  nonnegativeDecimal4Schema,
  nonnegativeIdrSchema,
  positiveDecimal4Schema,
  stockLocationIdSchema,
  uomIdSchema,
} from "../schemas.ts";
import {
  goodsReceiptDetailSchema,
  goodsReceiptIdSchema,
  goodsReceiptSchema,
  pettyPurchaseIdSchema,
  pettyPurchasePolicySchema,
  pettyPurchaseSchema,
  PURCHASING_MAX_TOLERANCE_BP,
  purchaseOrderDetailSchema,
  purchaseOrderIdSchema,
  purchaseOrderLineIdSchema,
  purchaseOrderSendResultSchema,
  purchaseOrderShareLinksRevokedSchema,
  purchaseOrderSourceSchema,
  purchaseOrderSchema,
  purchaseOrderStatusSchema,
  purchaseRequestDetailSchema,
  purchaseRequestIdSchema,
  purchaseRequestSchema,
  purchaseRequestStatusSchema,
  purchaseReturnDetailSchema,
  purchaseReturnIdSchema,
  purchaseReturnReasonSchema,
  purchaseReturnSchema,
  purchasingPolicySchema,
  supplierCatalogItemSchema,
  supplierContactSchema,
  supplierDetailSchema,
  supplierIdSchema,
  supplierInvoiceDetailSchema,
  supplierInvoiceIdSchema,
  supplierInvoiceLineKindSchema,
  supplierInvoiceMatchStatusSchema,
  supplierInvoiceSchema,
  supplierInvoiceStatusSchema,
  supplierKindSchema,
  supplierPaymentActionSchema,
  supplierPaymentIdSchema,
  supplierPaymentMethodSchema,
  supplierPaymentSchema,
  supplierPerformanceSchema,
  supplierRatingSchema,
  supplierSchema,
  supplierNpwpSchema,
  supplierPhoneSchema,
} from "./schemas.ts";

// ---- List queries ---------------------------------------------------------

export const supplierQuerySchema = cursorPageQuerySchema.extend({
  isActive: z.enum(["true", "false"]).optional(),
  kind: supplierKindSchema.optional(),
});

export const supplierPriceHistoryQuerySchema = z.strictObject({
  inventoryItemId: inventoryItemIdSchema,
});

export const supplierPerformanceQuerySchema = z.strictObject({
  fromDate: businessDateSchema,
  toDate: businessDateSchema,
});

export const purchaseRequestQuerySchema = cursorPageQuerySchema.extend({
  outletId: outletIdSchema,
  status: purchaseRequestStatusSchema.optional(),
});

export const purchaseOrderQuerySchema = cursorPageQuerySchema.extend({
  outletId: outletIdSchema,
  supplierId: supplierIdSchema.optional(),
  status: purchaseOrderStatusSchema.optional(),
  source: purchaseOrderSourceSchema.optional(),
  fromDate: businessDateSchema.optional(),
  toDate: businessDateSchema.optional(),
});

export const goodsReceiptQuerySchema = cursorPageQuerySchema.extend({
  outletId: outletIdSchema,
  purchaseOrderId: purchaseOrderIdSchema.optional(),
  supplierId: supplierIdSchema.optional(),
  fromDate: businessDateSchema.optional(),
  toDate: businessDateSchema.optional(),
});

export const supplierInvoiceQuerySchema = cursorPageQuerySchema.extend({
  outletId: outletIdSchema,
  supplierId: supplierIdSchema.optional(),
  purchaseOrderId: purchaseOrderIdSchema.optional(),
  matchStatus: supplierInvoiceMatchStatusSchema.optional(),
  status: supplierInvoiceStatusSchema.optional(),
  fromDate: businessDateSchema.optional(),
  toDate: businessDateSchema.optional(),
});

export const supplierPaymentQuerySchema = cursorPageQuerySchema.extend({
  supplierId: supplierIdSchema.optional(),
  supplierInvoiceId: supplierInvoiceIdSchema.optional(),
  status: z
    .enum(["pending_approval", "approved", "paid", "rejected", "cancelled"])
    .optional(),
});

export const purchaseReturnQuerySchema = cursorPageQuerySchema.extend({
  outletId: outletIdSchema,
  supplierId: supplierIdSchema.optional(),
  purchaseOrderId: purchaseOrderIdSchema.optional(),
});

export const pettyPurchaseQuerySchema = cursorPageQuerySchema.extend({
  outletId: outletIdSchema,
  fromDate: businessDateSchema.optional(),
  toDate: businessDateSchema.optional(),
});

export const pettyPurchasePolicyQuerySchema = z.strictObject({
  outletId: outletIdSchema,
});

// ---- Write inputs ---------------------------------------------------------

export const createSupplierInputSchema = clientInputSchema({
  name: z.string().trim().min(1).max(150),
  kind: supplierKindSchema.optional(),
  legalName: z.string().trim().min(1).max(200).nullable().optional(),
  npwp: supplierNpwpSchema.nullable().optional(),
  contactName: z.string().trim().min(1).max(150).nullable().optional(),
  phone: supplierPhoneSchema.nullable().optional(),
  email: z.email().max(254).nullable().optional(),
  address: z.string().trim().min(1).max(300).nullable().optional(),
  /** PRD §6.E suppliers.payment_terms (days). */
  paymentTermsDays: z.number().int().min(0).max(365),
  rating: supplierRatingSchema.nullable().optional(),
  idempotencyKey: idempotencyKeySchema,
});

export const updateSupplierInputSchema = clientInputSchema({
  name: z.string().trim().min(1).max(150).optional(),
  kind: supplierKindSchema.optional(),
  legalName: z.string().trim().min(1).max(200).nullable().optional(),
  npwp: supplierNpwpSchema.nullable().optional(),
  contactName: z.string().trim().min(1).max(150).nullable().optional(),
  phone: supplierPhoneSchema.nullable().optional(),
  email: z.email().max(254).nullable().optional(),
  address: z.string().trim().min(1).max(300).nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  rating: supplierRatingSchema.nullable().optional(),
  isActive: z.boolean().optional(),
  /** Optimistic concurrency (CORE PRECONDITION_FAILED on a stale value). */
  expectedUpdatedAt: isoDateTimeSchema,
});

export const createSupplierContactInputSchema = clientInputSchema({
  name: z.string().trim().min(1).max(150),
  role: z.string().trim().min(1).max(60).nullable().optional(),
  phone: supplierPhoneSchema,
  email: z.email().max(254).nullable().optional(),
  isPrimary: z.boolean(),
  idempotencyKey: idempotencyKeySchema,
});

export const createSupplierCatalogItemInputSchema = clientInputSchema({
  inventoryItemId: inventoryItemIdSchema,
  purchaseUomId: uomIdSchema,
  /** Per purchase unit, NUMERIC(14,4); the client enters a quoted price. */
  priceIdr: nonnegativeDecimal4Schema,
  effectiveFrom: businessDateSchema,
  idempotencyKey: idempotencyKeySchema,
});

export const purchaseRequestLineInputSchema = z.strictObject({
  inventoryItemId: inventoryItemIdSchema,
  quantity: positiveDecimal4Schema,
  uomId: uomIdSchema,
});

export const createPurchaseRequestInputSchema = clientInputSchema({
  outletId: outletIdSchema,
  neededBy: businessDateSchema,
  lines: z.array(purchaseRequestLineInputSchema).min(1).max(200),
  note: z.string().trim().max(300).nullable().optional(),
  idempotencyKey: idempotencyKeySchema,
});

export const transitionPurchaseRequestInputSchema = clientInputSchema({
  action: z.enum(["submit", "approve", "reject", "convert", "cancel"]),
  note: z.string().trim().max(300).nullable().optional(),
  idempotencyKey: idempotencyKeySchema,
});

export const purchaseOrderLineInputSchema = z.strictObject({
  inventoryItemId: inventoryItemIdSchema,
  quantity: positiveDecimal4Schema,
  uomId: uomIdSchema,
  /** Quoted price per purchase unit; subtotal and total are server-computed. */
  unitPriceIdr: nonnegativeDecimal4Schema,
});

/**
 * PRD §6.E purchase_orders.source: `user | ai | mcp`. An AI/MCP caller still
 * goes through the approval matrix; the server overwrites `source` from the
 * authenticated actor (an AI tool call declares `ai`, never `user`).
 */
export const createPurchaseOrderInputSchema = clientInputSchema({
  outletId: outletIdSchema,
  supplierId: supplierIdSchema,
  purchaseRequestId: purchaseRequestIdSchema.nullable().optional(),
  expectedDate: businessDateSchema,
  source: purchaseOrderSourceSchema,
  lines: z.array(purchaseOrderLineInputSchema).min(1).max(200),
  note: z.string().trim().max(300).nullable().optional(),
  idempotencyKey: idempotencyKeySchema,
});

/** A draft PO may still change supplier, date, lines and note. */
export const updatePurchaseOrderInputSchema = clientInputSchema({
  supplierId: supplierIdSchema.optional(),
  expectedDate: businessDateSchema.optional(),
  lines: z.array(purchaseOrderLineInputSchema).min(1).max(200).optional(),
  note: z.string().trim().max(300).nullable().optional(),
  expectedUpdatedAt: isoDateTimeSchema,
});

/** Client-controlled PO actions; receiving is driven by goods receipts. */
export const purchaseOrderClientActionSchema = z.enum([
  "submit",
  "approve",
  "reject",
  "close",
  "cancel",
]);

export const transitionPurchaseOrderInputSchema = clientInputSchema({
  action: purchaseOrderClientActionSchema,
  note: z.string().trim().max(300).nullable().optional(),
  idempotencyKey: idempotencyKeySchema,
});

/**
 * PRD §3.18 "Kirim PO": email the PO or return a shareable PDF link. An email
 * send without `email` goes to the supplier (its email, else the primary
 * contact's); another address needs `purchasing.supplier.manage`.
 */
export const sendPurchaseOrderInputSchema = clientInputSchema({
  channel: z.enum(["email", "share_link"]),
  email: z.email().max(254).optional(),
  note: z.string().trim().max(300).nullable().optional(),
  idempotencyKey: idempotencyKeySchema,
});

/** Revoke every live share link of a PO (the PDF link stops working). */
export const revokePurchaseOrderShareLinksInputSchema = clientInputSchema({
  note: z.string().trim().max(300).nullable().optional(),
  idempotencyKey: idempotencyKeySchema,
});

export const goodsReceiptLineInputSchema = z
  .strictObject({
    purchaseOrderLineId: purchaseOrderLineIdSchema,
    locationId: stockLocationIdSchema,
    quantityReceived: positiveDecimal4Schema,
    quantityRejected: nonnegativeDecimal4Schema,
    batchCode: z.string().trim().min(1).max(40).nullable().optional(),
    expiresOn: businessDateSchema.nullable().optional(),
  })
  .refine(
    (line) =>
      line.expiresOn === undefined ||
      line.expiresOn === null ||
      (line.batchCode !== undefined && line.batchCode !== null),
    { path: ["batchCode"], message: "An expiry date needs a batch code" },
  );

export const createGoodsReceiptInputSchema = clientInputSchema({
  outletId: outletIdSchema,
  purchaseOrderId: purchaseOrderIdSchema,
  receivedOn: businessDateSchema.optional(),
  qcNotes: z.string().trim().max(500).nullable().optional(),
  mediaIds: z.array(uuidSchema).max(10).optional(),
  lines: z.array(goodsReceiptLineInputSchema).min(1),
  note: z.string().trim().max(300).nullable().optional(),
  idempotencyKey: idempotencyKeySchema,
});

export const supplierInvoiceLineInputSchema = z.strictObject({
  /** Null for a service line (no stock receipt, amount match only). */
  purchaseOrderLineId: purchaseOrderLineIdSchema.nullable().optional(),
  kind: supplierInvoiceLineKindSchema,
  description: z.string().trim().min(1).max(200),
  quantity: positiveDecimal4Schema,
  unitPriceIdr: nonnegativeDecimal4Schema,
});

export const createSupplierInvoiceInputSchema = clientInputSchema({
  outletId: outletIdSchema,
  supplierId: supplierIdSchema,
  purchaseOrderId: purchaseOrderIdSchema,
  number: z.string().trim().min(1).max(60),
  invoiceDate: businessDateSchema,
  dueDate: businessDateSchema,
  lines: z.array(supplierInvoiceLineInputSchema).min(1),
  /** PPN masukan and PPh 23 jasa supplier (§3.19), from the tax contract. */
  ppnIdr: nonnegativeIdrSchema,
  pph23Idr: nonnegativeIdrSchema,
  idempotencyKey: idempotencyKeySchema,
}).refine((input) => input.dueDate >= input.invoiceDate, {
  path: ["dueDate"],
  message: "dueDate must not be before invoiceDate",
});

export const recordSupplierInvoiceMatchInputSchema = clientInputSchema({
  note: z.string().trim().max(500).nullable().optional(),
  idempotencyKey: idempotencyKeySchema,
});

/** Release or reject of a held invoice: the reason is mandatory and audited. */
export const decideSupplierInvoiceInputSchema = clientInputSchema({
  note: z.string().trim().min(10).max(500),
  idempotencyKey: idempotencyKeySchema,
});

/**
 * Finance command "jurnalkan penerimaan" (legend-7e0q4): no input, the server
 * rebuilds the receipt fact from the stored receipt. The journal key is the
 * receipt, so a repeat never books twice.
 */
export const journalizeGoodsReceiptInputSchema = clientInputSchema({});

export const goodsReceiptJournalizedSchema = z.strictObject({
  goodsReceiptId: goodsReceiptIdSchema,
  /** `posted`: journal booked now; `already_posted`: it existed, nothing booked. */
  status: z.enum(["posted", "already_posted"]),
  journalEntryId: uuidSchema,
});
export type GoodsReceiptJournalized = z.infer<
  typeof goodsReceiptJournalizedSchema
>;

/**
 * Tenant tolerance update. `expectedUpdatedAt` is the `updatedAt` the caller
 * last read (null while the tenant still runs on the default); a stale value
 * is a 412.
 */
export const putPurchasingPolicyInputSchema = clientInputSchema({
  threeWayMatchToleranceBp: z
    .number()
    .int()
    .min(0)
    .max(PURCHASING_MAX_TOLERANCE_BP),
  expectedUpdatedAt: isoDateTimeSchema.nullable(),
  idempotencyKey: idempotencyKeySchema,
});

export const createSupplierPaymentInputSchema = clientInputSchema({
  supplierInvoiceId: supplierInvoiceIdSchema,
  amountIdr: z.number().int().positive(),
  method: supplierPaymentMethodSchema,
  reference: z.string().trim().min(1).max(60).nullable().optional(),
  note: z.string().trim().max(300).nullable().optional(),
  idempotencyKey: idempotencyKeySchema,
});

export const transitionSupplierPaymentInputSchema = clientInputSchema({
  action: supplierPaymentActionSchema,
  reference: z.string().trim().min(1).max(60).nullable().optional(),
  note: z.string().trim().max(300).nullable().optional(),
  idempotencyKey: idempotencyKeySchema,
});

export const purchaseReturnLineInputSchema = z.strictObject({
  purchaseOrderLineId: purchaseOrderLineIdSchema.nullable().optional(),
  inventoryItemId: inventoryItemIdSchema,
  quantity: positiveDecimal4Schema,
  locationId: stockLocationIdSchema,
  batchCode: z.string().trim().min(1).max(40).nullable().optional(),
});

export const createPurchaseReturnInputSchema = clientInputSchema({
  outletId: outletIdSchema,
  supplierId: supplierIdSchema,
  purchaseOrderId: purchaseOrderIdSchema.nullable().optional(),
  goodsReceiptId: goodsReceiptIdSchema.nullable().optional(),
  returnedOn: businessDateSchema,
  reason: purchaseReturnReasonSchema,
  lines: z.array(purchaseReturnLineInputSchema).min(1),
  note: z.string().trim().max(300).nullable().optional(),
  idempotencyKey: idempotencyKeySchema,
});

/** Upsert of the petty purchase limit; `outletId: null` is the tenant default. */
export const upsertPettyPurchasePolicyInputSchema = clientInputSchema({
  outletId: outletIdSchema.nullable(),
  limitIdr: pettyPurchasePolicySchema.shape.limitIdr,
  idempotencyKey: idempotencyKeySchema,
});

export const createPettyPurchaseInputSchema = clientInputSchema({
  outletId: outletIdSchema,
  vendorName: z.string().trim().min(1).max(150),
  description: z.string().trim().min(1).max(200),
  amountIdr: z.number().int().positive(),
  /** PRD §3.18 "bukti foto": the photo is mandatory, not an attachment. */
  photoMediaId: uuidSchema,
  paidAt: isoDateTimeSchema.optional(),
  businessDate: businessDateSchema.optional(),
  note: z.string().trim().max(300).nullable().optional(),
  idempotencyKey: idempotencyKeySchema,
});

// ---- Read endpoints -------------------------------------------------------

export const listSuppliers = defineEndpoint({
  method: "GET",
  path: "/api/inventory/suppliers",
  query: supplierQuerySchema,
  response: cursorPageSchema(supplierSchema),
});

export const getSupplier = defineEndpoint({
  method: "GET",
  path: "/api/inventory/suppliers/:supplierId",
  params: z.strictObject({ supplierId: supplierIdSchema }),
  response: dataResponseSchema(supplierDetailSchema),
});

export const listSupplierCatalog = defineEndpoint({
  method: "GET",
  path: "/api/inventory/suppliers/:supplierId/catalog",
  params: z.strictObject({ supplierId: supplierIdSchema }),
  query: cursorPageQuerySchema,
  response: cursorPageSchema(supplierCatalogItemSchema),
});

export const getSupplierPriceHistory = defineEndpoint({
  method: "GET",
  path: "/api/inventory/suppliers/:supplierId/prices",
  params: z.strictObject({ supplierId: supplierIdSchema }),
  query: supplierPriceHistoryQuerySchema,
  response: dataResponseSchema(z.array(supplierCatalogItemSchema)),
});

export const getSupplierPerformance = defineEndpoint({
  method: "GET",
  path: "/api/inventory/suppliers/:supplierId/performance",
  params: z.strictObject({ supplierId: supplierIdSchema }),
  query: supplierPerformanceQuerySchema,
  response: dataResponseSchema(supplierPerformanceSchema),
});

export const listPurchaseRequests = defineEndpoint({
  method: "GET",
  path: "/api/inventory/purchase-requests",
  query: purchaseRequestQuerySchema,
  response: cursorPageSchema(purchaseRequestSchema),
});

export const getPurchaseRequest = defineEndpoint({
  method: "GET",
  path: "/api/inventory/purchase-requests/:purchaseRequestId",
  params: z.strictObject({ purchaseRequestId: purchaseRequestIdSchema }),
  response: dataResponseSchema(purchaseRequestDetailSchema),
});

export const listPurchaseOrders = defineEndpoint({
  method: "GET",
  path: "/api/inventory/purchase-orders",
  query: purchaseOrderQuerySchema,
  response: cursorPageSchema(purchaseOrderSchema),
});

export const getPurchaseOrder = defineEndpoint({
  method: "GET",
  path: "/api/inventory/purchase-orders/:purchaseOrderId",
  params: z.strictObject({ purchaseOrderId: purchaseOrderIdSchema }),
  response: dataResponseSchema(purchaseOrderDetailSchema),
});

export const listGoodsReceipts = defineEndpoint({
  method: "GET",
  path: "/api/inventory/goods-receipts",
  query: goodsReceiptQuerySchema,
  response: cursorPageSchema(goodsReceiptSchema),
});

export const getGoodsReceipt = defineEndpoint({
  method: "GET",
  path: "/api/inventory/goods-receipts/:goodsReceiptId",
  params: z.strictObject({ goodsReceiptId: goodsReceiptIdSchema }),
  response: dataResponseSchema(goodsReceiptDetailSchema),
});

export const listSupplierInvoices = defineEndpoint({
  method: "GET",
  path: "/api/inventory/supplier-invoices",
  query: supplierInvoiceQuerySchema,
  response: cursorPageSchema(supplierInvoiceSchema),
});

export const getSupplierInvoice = defineEndpoint({
  method: "GET",
  path: "/api/inventory/supplier-invoices/:supplierInvoiceId",
  params: z.strictObject({ supplierInvoiceId: supplierInvoiceIdSchema }),
  response: dataResponseSchema(supplierInvoiceDetailSchema),
});

export const listSupplierPayments = defineEndpoint({
  method: "GET",
  path: "/api/inventory/supplier-payments",
  query: supplierPaymentQuerySchema,
  response: cursorPageSchema(supplierPaymentSchema),
});

export const getSupplierPayment = defineEndpoint({
  method: "GET",
  path: "/api/inventory/supplier-payments/:supplierPaymentId",
  params: z.strictObject({ supplierPaymentId: supplierPaymentIdSchema }),
  response: dataResponseSchema(supplierPaymentSchema),
});

export const listPurchaseReturns = defineEndpoint({
  method: "GET",
  path: "/api/inventory/purchase-returns",
  query: purchaseReturnQuerySchema,
  response: cursorPageSchema(purchaseReturnSchema),
});

export const getPurchaseReturn = defineEndpoint({
  method: "GET",
  path: "/api/inventory/purchase-returns/:purchaseReturnId",
  params: z.strictObject({ purchaseReturnId: purchaseReturnIdSchema }),
  response: dataResponseSchema(purchaseReturnDetailSchema),
});

export const listPettyPurchases = defineEndpoint({
  method: "GET",
  path: "/api/inventory/petty-purchases",
  query: pettyPurchaseQuerySchema,
  response: cursorPageSchema(pettyPurchaseSchema),
});

export const getPettyPurchase = defineEndpoint({
  method: "GET",
  path: "/api/inventory/petty-purchases/:pettyPurchaseId",
  params: z.strictObject({ pettyPurchaseId: pettyPurchaseIdSchema }),
  response: dataResponseSchema(pettyPurchaseSchema),
});

export const getPettyPurchasePolicy = defineEndpoint({
  method: "GET",
  path: "/api/inventory/petty-purchase-policy",
  query: pettyPurchasePolicyQuerySchema,
  response: dataResponseSchema(pettyPurchasePolicySchema),
});

export const getPurchasingPolicy = defineEndpoint({
  method: "GET",
  path: "/api/inventory/purchasing-policy",
  response: dataResponseSchema(purchasingPolicySchema),
});

// ---- Write endpoints ------------------------------------------------------

export const createSupplier = defineEndpoint({
  method: "POST",
  path: "/api/inventory/suppliers",
  body: createSupplierInputSchema,
  response: dataResponseSchema(supplierSchema),
});

export const updateSupplier = defineEndpoint({
  method: "PATCH",
  path: "/api/inventory/suppliers/:supplierId",
  params: z.strictObject({ supplierId: supplierIdSchema }),
  body: updateSupplierInputSchema,
  response: dataResponseSchema(supplierSchema),
});

export const createSupplierContact = defineEndpoint({
  method: "POST",
  path: "/api/inventory/suppliers/:supplierId/contacts",
  params: z.strictObject({ supplierId: supplierIdSchema }),
  body: createSupplierContactInputSchema,
  response: dataResponseSchema(supplierContactSchema),
});

export const createSupplierCatalogItem = defineEndpoint({
  method: "POST",
  path: "/api/inventory/suppliers/:supplierId/catalog",
  params: z.strictObject({ supplierId: supplierIdSchema }),
  body: createSupplierCatalogItemInputSchema,
  response: dataResponseSchema(supplierCatalogItemSchema),
});

export const createPurchaseRequest = defineEndpoint({
  method: "POST",
  path: "/api/inventory/purchase-requests",
  body: createPurchaseRequestInputSchema,
  response: dataResponseSchema(purchaseRequestDetailSchema),
});

export const postPurchaseRequestTransition = defineEndpoint({
  method: "POST",
  path: "/api/inventory/purchase-requests/:purchaseRequestId/transitions",
  params: z.strictObject({ purchaseRequestId: purchaseRequestIdSchema }),
  body: transitionPurchaseRequestInputSchema,
  response: dataResponseSchema(purchaseRequestSchema),
});

export const createPurchaseOrder = defineEndpoint({
  method: "POST",
  path: "/api/inventory/purchase-orders",
  body: createPurchaseOrderInputSchema,
  response: dataResponseSchema(purchaseOrderDetailSchema),
});

export const updatePurchaseOrder = defineEndpoint({
  method: "PATCH",
  path: "/api/inventory/purchase-orders/:purchaseOrderId",
  params: z.strictObject({ purchaseOrderId: purchaseOrderIdSchema }),
  body: updatePurchaseOrderInputSchema,
  response: dataResponseSchema(purchaseOrderDetailSchema),
});

export const postPurchaseOrderTransition = defineEndpoint({
  method: "POST",
  path: "/api/inventory/purchase-orders/:purchaseOrderId/transitions",
  params: z.strictObject({ purchaseOrderId: purchaseOrderIdSchema }),
  body: transitionPurchaseOrderInputSchema,
  response: dataResponseSchema(purchaseOrderSchema),
});

export const sendPurchaseOrder = defineEndpoint({
  method: "POST",
  path: "/api/inventory/purchase-orders/:purchaseOrderId/send",
  params: z.strictObject({ purchaseOrderId: purchaseOrderIdSchema }),
  body: sendPurchaseOrderInputSchema,
  response: dataResponseSchema(purchaseOrderSendResultSchema),
});

export const revokePurchaseOrderShareLinks = defineEndpoint({
  method: "POST",
  path: "/api/inventory/purchase-orders/:purchaseOrderId/share-links/revoke",
  params: z.strictObject({ purchaseOrderId: purchaseOrderIdSchema }),
  body: revokePurchaseOrderShareLinksInputSchema,
  response: dataResponseSchema(purchaseOrderShareLinksRevokedSchema),
});

export const createGoodsReceipt = defineEndpoint({
  method: "POST",
  path: "/api/inventory/goods-receipts",
  body: createGoodsReceiptInputSchema,
  response: dataResponseSchema(goodsReceiptDetailSchema),
});

export const journalizeGoodsReceipt = defineEndpoint({
  method: "POST",
  path: "/api/inventory/goods-receipts/:goodsReceiptId/journalize",
  params: z.strictObject({ goodsReceiptId: goodsReceiptIdSchema }),
  body: journalizeGoodsReceiptInputSchema,
  response: dataResponseSchema(goodsReceiptJournalizedSchema),
});

export const createSupplierInvoice = defineEndpoint({
  method: "POST",
  path: "/api/inventory/supplier-invoices",
  body: createSupplierInvoiceInputSchema,
  response: dataResponseSchema(supplierInvoiceDetailSchema),
});

export const postSupplierInvoiceMatch = defineEndpoint({
  method: "POST",
  path: "/api/inventory/supplier-invoices/:supplierInvoiceId/match",
  params: z.strictObject({ supplierInvoiceId: supplierInvoiceIdSchema }),
  body: recordSupplierInvoiceMatchInputSchema,
  response: dataResponseSchema(supplierInvoiceDetailSchema),
});

export const releaseSupplierInvoice = defineEndpoint({
  method: "POST",
  path: "/api/inventory/supplier-invoices/:supplierInvoiceId/release",
  params: z.strictObject({ supplierInvoiceId: supplierInvoiceIdSchema }),
  body: decideSupplierInvoiceInputSchema,
  response: dataResponseSchema(supplierInvoiceDetailSchema),
});

export const rejectSupplierInvoice = defineEndpoint({
  method: "POST",
  path: "/api/inventory/supplier-invoices/:supplierInvoiceId/reject",
  params: z.strictObject({ supplierInvoiceId: supplierInvoiceIdSchema }),
  body: decideSupplierInvoiceInputSchema,
  response: dataResponseSchema(supplierInvoiceDetailSchema),
});

export const putPurchasingPolicy = defineEndpoint({
  method: "PUT",
  path: "/api/inventory/purchasing-policy",
  body: putPurchasingPolicyInputSchema,
  response: dataResponseSchema(purchasingPolicySchema),
});

export const createSupplierPayment = defineEndpoint({
  method: "POST",
  path: "/api/inventory/supplier-payments",
  body: createSupplierPaymentInputSchema,
  response: dataResponseSchema(supplierPaymentSchema),
});

export const postSupplierPaymentTransition = defineEndpoint({
  method: "POST",
  path: "/api/inventory/supplier-payments/:supplierPaymentId/transitions",
  params: z.strictObject({ supplierPaymentId: supplierPaymentIdSchema }),
  body: transitionSupplierPaymentInputSchema,
  response: dataResponseSchema(supplierPaymentSchema),
});

export const retrySupplierPaymentSettlement = defineEndpoint({
  method: "POST",
  path: "/api/inventory/supplier-payments/:supplierPaymentId/retry-settlement",
  params: z.strictObject({ supplierPaymentId: supplierPaymentIdSchema }),
  body: retrySupplierPaymentSettlementInputSchema,
  response: dataResponseSchema(supplierInvoicePaymentSchema),
});

export const createPurchaseReturn = defineEndpoint({
  method: "POST",
  path: "/api/inventory/purchase-returns",
  body: createPurchaseReturnInputSchema,
  response: dataResponseSchema(purchaseReturnDetailSchema),
});

export const createPettyPurchase = defineEndpoint({
  method: "POST",
  path: "/api/inventory/petty-purchases",
  body: createPettyPurchaseInputSchema,
  response: dataResponseSchema(pettyPurchaseSchema),
});

export const upsertPettyPurchasePolicy = defineEndpoint({
  method: "PUT",
  path: "/api/inventory/petty-purchase-policy",
  body: upsertPettyPurchasePolicyInputSchema,
  response: dataResponseSchema(pettyPurchasePolicySchema),
});

/**
 * Every purchasing endpoint in one list, for API route registration, FE mock
 * discovery and contract tests: ids are unique and paths live under
 * /api/inventory.
 */
export const purchasingEndpoints = [
  listSuppliers,
  getSupplier,
  listSupplierCatalog,
  getSupplierPriceHistory,
  getSupplierPerformance,
  listPurchaseRequests,
  getPurchaseRequest,
  listPurchaseOrders,
  getPurchaseOrder,
  getPurchaseOrderPdfPreview,
  listGoodsReceipts,
  getGoodsReceipt,
  listSupplierInvoices,
  getSupplierInvoice,
  listSupplierPayments,
  getSupplierPayment,
  listPurchaseReturns,
  getPurchaseReturn,
  listPettyPurchases,
  getPettyPurchase,
  getPettyPurchasePolicy,
  getPurchasingPolicy,
  createSupplier,
  updateSupplier,
  createSupplierContact,
  createSupplierCatalogItem,
  createPurchaseRequest,
  postPurchaseRequestTransition,
  createPurchaseOrder,
  updatePurchaseOrder,
  postPurchaseOrderTransition,
  sendPurchaseOrder,
  revokePurchaseOrderShareLinks,
  createGoodsReceipt,
  journalizeGoodsReceipt,
  createSupplierInvoice,
  postSupplierInvoiceMatch,
  releaseSupplierInvoice,
  rejectSupplierInvoice,
  putPurchasingPolicy,
  createSupplierPayment,
  postSupplierPaymentTransition,
  retrySupplierPaymentSettlement,
  createPurchaseReturn,
  createPettyPurchase,
  upsertPettyPurchasePolicy,
] as const;
