// Typed endpoint contracts for QR order, used by the web app's API client and
// mock mode (docs/frontend.md "Typed endpoints and mock mode") and later by the
// API's route validation. Paths are absolute; every `:param` has a schema.
//
// Authorization is not part of the endpoint object:
// - Guest endpoints (`/api/qr/…`, and the guest side of
//   `/api/table-sessions/…`) require the session credential returned by
//   `openOrJoinTableSession` (`Authorization: Bearer <sessionToken>`), which is
//   rotated when the session closes (PRD "Keamanan Sesi", ORD-04).
// - Staff endpoints (`/api/outlets/…`, `/api/tables/…`, service-request inbox,
//   order-issue staff actions, apology vouchers) require a staff session with
//   outlet scope and the RBAC permission of the action.

import {
  cursorPageQuerySchema,
  cursorPageSchema,
  dataResponseSchema,
  outletIdSchema,
  z,
} from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import {
  addCartLineInputSchema,
  apologyVoucherSchema,
  cartLineIdSchema,
  cartMutationResultSchema,
  closeTableSessionInputSchema,
  createApologyVoucherInputSchema,
  createOrderIssueInputSchema,
  createServiceRequestInputSchema,
  createSplitsInputSchema,
  customerOrderIssueChoiceInputSchema,
  floorBoardSchema,
  floorZoneIdSchema,
  orderIssueIdSchema,
  orderIssueOptionsSchema,
  orderIssueSchema,
  orderItemIdSchema,
  orderQuoteSchema,
  placeOrderInputSchema,
  placeOrderResultSchema,
  qrScanInputSchema,
  qrScanResultSchema,
  quoteInputSchema,
  resolveServiceRequestInputSchema,
  reviewEligibilitySchema,
  serviceRequestIdSchema,
  serviceRequestSchema,
  serviceRequestStatusSchema,
  sessionBillSchema,
  sessionSplitsResultSchema,
  staffOrderIssueResolutionInputSchema,
  submitReviewInputSchema,
  tableIdSchema,
  tableQrSchema,
  tableReviewSchema,
  tableSessionIdSchema,
  tableSessionSchema,
  tableSessionViewSchema,
  updateCartLineInputSchema,
  voucherCodeSchema,
} from "./schemas.ts";

const sessionParams = z.strictObject({ sessionId: tableSessionIdSchema });

/** Scan the permanent table QR: opens a session or joins the active one. */
export const openOrJoinTableSession = defineEndpoint({
  method: "POST",
  path: "/api/qr/sessions",
  body: qrScanInputSchema,
  response: dataResponseSchema(qrScanResultSchema),
});

/** Session, shared cart, current quote, orders and open waiter calls. */
export const getTableSession = defineEndpoint({
  method: "GET",
  path: "/api/table-sessions/:sessionId",
  params: sessionParams,
  response: dataResponseSchema(tableSessionViewSchema),
});

export const addCartLine = defineEndpoint({
  method: "POST",
  path: "/api/table-sessions/:sessionId/cart/lines",
  params: sessionParams,
  body: addCartLineInputSchema,
  response: dataResponseSchema(cartMutationResultSchema),
});

export const updateCartLine = defineEndpoint({
  method: "PATCH",
  path: "/api/table-sessions/:sessionId/cart/lines/:lineId",
  params: z.strictObject({
    sessionId: tableSessionIdSchema,
    lineId: cartLineIdSchema,
  }),
  body: updateCartLineInputSchema,
  response: dataResponseSchema(cartMutationResultSchema),
});

export const removeCartLine = defineEndpoint({
  method: "DELETE",
  path: "/api/table-sessions/:sessionId/cart/lines/:lineId",
  params: z.strictObject({
    sessionId: tableSessionIdSchema,
    lineId: cartLineIdSchema,
  }),
  query: z.strictObject({
    expectedCartVersion: z.coerce.number().int().nonnegative(),
  }),
  response: dataResponseSchema(cartMutationResultSchema),
});

/** Server pricing quote (ORD-03). The body carries codes, never prices. */
export const quoteTableSession = defineEndpoint({
  method: "POST",
  path: "/api/table-sessions/:sessionId/quote",
  params: sessionParams,
  body: quoteInputSchema,
  response: dataResponseSchema(orderQuoteSchema),
});

/** Place the cart as an order; pay-first holds the kitchen until payment. */
export const placeQrOrder = defineEndpoint({
  method: "POST",
  path: "/api/table-sessions/:sessionId/orders",
  params: sessionParams,
  body: placeOrderInputSchema,
  response: dataResponseSchema(placeOrderResultSchema),
});

export const getSessionBill = defineEndpoint({
  method: "GET",
  path: "/api/table-sessions/:sessionId/bill",
  params: sessionParams,
  response: dataResponseSchema(sessionBillSchema),
});

/** Split the bill: equal, per person or per item; parts sum exactly (ORD-06). */
export const createSessionSplits = defineEndpoint({
  method: "POST",
  path: "/api/table-sessions/:sessionId/splits",
  params: sessionParams,
  body: createSplitsInputSchema,
  response: dataResponseSchema(sessionSplitsResultSchema),
});

/** Call waiter, request the bill or file a complaint (ORD-07). */
export const createServiceRequest = defineEndpoint({
  method: "POST",
  path: "/api/table-sessions/:sessionId/service-requests",
  params: sessionParams,
  body: createServiceRequestInputSchema,
  response: dataResponseSchema(serviceRequestSchema),
});

export const getReviewEligibility = defineEndpoint({
  method: "GET",
  path: "/api/table-sessions/:sessionId/review",
  params: sessionParams,
  response: dataResponseSchema(reviewEligibilitySchema),
});

export const submitTableReview = defineEndpoint({
  method: "POST",
  path: "/api/table-sessions/:sessionId/review",
  params: sessionParams,
  body: submitReviewInputSchema,
  response: dataResponseSchema(tableReviewSchema),
});

/** Open-bill zones: a waiter or cashier confirms before the first order fires. */
export const confirmOpenBillSession = defineEndpoint({
  method: "POST",
  path: "/api/table-sessions/:sessionId/confirm",
  params: sessionParams,
  response: dataResponseSchema(tableSessionSchema),
});

/** ORD-10: close only when the bill is settled and the table is clean. */
export const closeTableSession = defineEndpoint({
  method: "POST",
  path: "/api/table-sessions/:sessionId/close",
  params: sessionParams,
  body: closeTableSessionInputSchema,
  response: dataResponseSchema(tableSessionSchema),
});

/** Live floor board: zones, tables, sessions and waiter-call counts. */
export const getFloorBoard = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/floor",
  params: z.strictObject({ outletId: outletIdSchema }),
  response: dataResponseSchema(floorBoardSchema),
});

/** Generate (or reprint) the signed permanent QR of a table. */
export const issueTableQr = defineEndpoint({
  method: "POST",
  path: "/api/tables/:tableId/qr",
  params: z.strictObject({ tableId: tableIdSchema }),
  response: dataResponseSchema(tableQrSchema),
});

export const serviceRequestListQuerySchema = cursorPageQuerySchema.extend({
  status: serviceRequestStatusSchema.optional(),
  zoneId: floorZoneIdSchema.optional(),
});

/** Waiter inbox for one outlet, newest first (cursor pagination). */
export const listServiceRequests = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/service-requests",
  params: z.strictObject({ outletId: outletIdSchema }),
  query: serviceRequestListQuerySchema,
  response: cursorPageSchema(serviceRequestSchema),
});

const serviceRequestParams = z.strictObject({
  serviceRequestId: serviceRequestIdSchema,
});

export const acknowledgeServiceRequest = defineEndpoint({
  method: "POST",
  path: "/api/service-requests/:serviceRequestId/acknowledge",
  params: serviceRequestParams,
  response: dataResponseSchema(serviceRequestSchema),
});

export const resolveServiceRequest = defineEndpoint({
  method: "POST",
  path: "/api/service-requests/:serviceRequestId/resolve",
  params: serviceRequestParams,
  body: resolveServiceRequestInputSchema,
  response: dataResponseSchema(serviceRequestSchema),
});

const orderIssueParams = z.strictObject({ orderIssueId: orderIssueIdSchema });

/** Staff records a failed paid item; the guest is notified within a minute. */
export const reportOrderIssue = defineEndpoint({
  method: "POST",
  path: "/api/order-items/:orderItemId/issues",
  params: z.strictObject({ orderItemId: orderItemIdSchema }),
  body: createOrderIssueInputSchema,
  response: dataResponseSchema(orderIssueSchema),
});

/** The two choices the guest may see: swap or voucher credit (ORD-08). */
export const getOrderIssueOptions = defineEndpoint({
  method: "GET",
  path: "/api/order-issues/:orderIssueId/options",
  params: orderIssueParams,
  response: dataResponseSchema(orderIssueOptionsSchema),
});

export const chooseOrderIssueResolution = defineEndpoint({
  method: "POST",
  path: "/api/order-issues/:orderIssueId/customer-choice",
  params: orderIssueParams,
  body: customerOrderIssueChoiceInputSchema,
  response: dataResponseSchema(orderIssueSchema),
});

/** Supervisor action; a manual refund needs approval and a written reason. */
export const resolveOrderIssue = defineEndpoint({
  method: "POST",
  path: "/api/order-issues/:orderIssueId/resolve",
  params: orderIssueParams,
  body: staffOrderIssueResolutionInputSchema,
  response: dataResponseSchema(orderIssueSchema),
});

/** Supervisor issues a recovery voucher, above the cap only with approval. */
export const issueApologyVoucher = defineEndpoint({
  method: "POST",
  path: "/api/apology-vouchers",
  body: createApologyVoucherInputSchema,
  response: dataResponseSchema(apologyVoucherSchema),
});

export const getApologyVoucher = defineEndpoint({
  method: "GET",
  path: "/api/apology-vouchers/:code",
  params: z.strictObject({ code: voucherCodeSchema }),
  response: dataResponseSchema(apologyVoucherSchema),
});
