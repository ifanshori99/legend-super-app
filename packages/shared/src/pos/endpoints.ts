// POS endpoint contracts (bead legend-4yp). The web app's typed client and mock
// mode read these objects, and the API validates with the same ones
// (docs/frontend.md "Typed endpoints and mock mode"; PRD v1.7 §3 "Kontrak
// Bersama"). Outlet scoping comes from the verified session/device, never from
// the body (TEN-02): outletId appears only in the path, every request schema is
// built with clientInputSchema, and no request carries a price, a total, an
// expected cash figure or a variance — the server computes those (ORD-03).
//
// Screens these endpoints serve: cashier main screen (legend-59v), payment
// panel (legend-5w6), discount/void/refund + receipts (legend-2fo), cashier
// shift + end-of-day (legend-iqi), customer display (legend-azt), captain order
// (legend-76t).

import {
  z,
  clientInputSchema,
  cursorPageMetaSchema,
  cursorPageQuerySchema,
  cursorPageSchema,
  dataResponseSchema,
  businessDateSchema,
  outletIdSchema,
  userIdSchema,
  uuidSchema,
  idempotencyKeySchema,
} from "../core/index.ts";
import { posOverrideIdSchema } from "../access/override.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import { edcMethodSchema, edcTransactionSchema } from "../edc/index.ts";
import { tableSessionIdSchema } from "../qr-order/schemas.ts";
import {
  cashMovementIdSchema,
  cashMovementTypeSchema,
  closeBusinessDayInputSchema,
  closePosShiftInputSchema,
  forceClosePosShiftInputSchema,
  customerDisplayPairingCodeSchema,
  customerDisplayPairingIdSchema,
  customerDisplayPairingSchema,
  customerDisplaySelectionSchema,
  customerDisplayStateSchema,
  decidePosCashMovementInputSchema,
  discountReasonSchema,
  endOfDayRecapSchema,
  endOfDayRecapViewSchema,
  invoiceDocumentSchema,
  openPosShiftInputSchema,
  orderChannelSchema,
  orderItemIdSchema,
  orderIdSchema,
  pairCustomerDisplayInputSchema,
  selectCustomerDisplayBillInputSchema,
  posApprovalPolicySchema,
  posCashMovementDecisionSchema,
  posCashMovementSchema,
  posCatalogSchema,
  posDiscountIdSchema,
  posDiscountKindSchema,
  posDiscountSourceSchema,
  posNextCallNumberSchema,
  posOrderActionSchema,
  posOrderDetailSchema,
  posOrderEventSchema,
  posOrderStatusSchema,
  posOrderSummarySchema,
  posPaymentOptionsSchema,
  posQrisHoldSchema,
  posQrisStatusSchema,
  posQrisReconciliationSchema,
  posVaReleaseReasonSchema,
  posVaReleaseSchema,
  posQrisReconciliationStatusSchema,
  posReceiptIdSchema,
  posReceiptIssueResultSchema,
  posRefundItemSchema,
  posRefundSchema,
  posShiftCountReceiptSchema,
  posShiftCountSchema,
  posShiftIdSchema,
  posShiftReportSchema,
  posShiftSchema,
  posTenderMethodSchema,
  posTenderResultSchema,
  posVoidSchema,
  receiptDeliveryChannelSchema,
  receiptDocumentSchema,
  receiptLinkSchema,
  receiptNumberSchema,
  recordCashMovementInputSchema,
  refundReasonSchema,
  serviceTypeSchema,
  submitPosShiftCountInputSchema,
  voidReasonSchema,
} from "./schemas.ts";

const outletParams = z.strictObject({ outletId: outletIdSchema });
const orderParams = z.strictObject({
  outletId: outletIdSchema,
  orderId: orderIdSchema,
});
const orderItemParams = z.strictObject({
  outletId: outletIdSchema,
  orderId: orderIdSchema,
  itemId: orderItemIdSchema,
});
const shiftParams = z.strictObject({
  outletId: outletIdSchema,
  shiftId: posShiftIdSchema,
});
const cashMovementParams = z.strictObject({
  outletId: outletIdSchema,
  shiftId: posShiftIdSchema,
  movementId: cashMovementIdSchema,
});
const receiptParams = z.strictObject({
  outletId: outletIdSchema,
  receiptId: posReceiptIdSchema,
});

/**
 * legend-63l6: optimistic-concurrency guard. `expectedVersion` is the `version`
 * of the order response, equivalent to `If-Match: "v"`. The route uses
 * `expectedVersion ?? If-Match`; both given and different is 412
 * PRECONDITION_FAILED. Both absent means no version check, so legacy clients
 * keep working and `expectedStatus` still guards the transition.
 */
const expectedVersion = {
  expectedVersion: z.number().int().nonnegative().safe().optional(),
};

/** Stale-screen guard: the caller states the status it believes the order has. */
const expectedStatus = {
  expectedStatus: posOrderStatusSchema,
  ...expectedVersion,
  idempotencyKey: idempotencyKeySchema,
};

const orderLineInputSchema = z.strictObject({
  menuItemId: uuidSchema,
  variantId: uuidSchema.nullable().optional(),
  modifierIds: z.array(uuidSchema).max(20),
  quantity: z.number().int().min(1).max(99),
  note: z.string().max(200).nullable().optional(),
  /** F8 hold & fire: the course this line belongs to. */
  course: z.string().min(1).max(20).nullable().optional(),
  /** Per-line hold overrides the order-wide holdItems fallback. */
  hold: z.boolean().optional(),
});

// ---- Orders ---------------------------------------------------------------

/** The effective outlet/channel catalog, including visible unavailable items. */
export const getPosCatalog = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/pos/catalog",
  params: outletParams,
  query: z.strictObject({
    channel: orderChannelSchema.default("pos"),
    serviceType: serviceTypeSchema.default("dine_in"),
  }),
  response: dataResponseSchema(posCatalogSchema),
});

/** Read-only hint: concurrent creates can assign a different final number. */
export const getNextPosCallNumber = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/pos/next-call-number",
  params: outletParams,
  response: dataResponseSchema(posNextCallNumberSchema),
});

/**
 * `status` takes one status or several, comma separated. `withCount=true` adds
 * `meta.totalCount`: every match of the filters, not only this page.
 */
export const listPosOrders = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/pos/orders",
  params: outletParams,
  query: cursorPageQuerySchema.extend({
    status: z
      .string()
      .transform((value) => value.split(","))
      .pipe(z.array(posOrderStatusSchema).min(1).max(5))
      .optional(),
    tableSessionId: tableSessionIdSchema.optional(),
    withCount: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
    channel: orderChannelSchema.optional(),
    serviceType: serviceTypeSchema.optional(),
    shiftId: posShiftIdSchema.optional(),
    deviceId: uuidSchema.optional(),
  }),
  response: cursorPageSchema(posOrderSummarySchema).extend({
    meta: cursorPageMetaSchema.extend({
      /** Null unless the query asks `withCount=true`. */
      totalCount: z.number().int().nonnegative().nullable(),
    }),
  }),
});

/** The cashier screen: lines, tenders, discounts and the receipt. */
export const getPosOrder = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/pos/orders/:orderId",
  params: orderParams,
  response: dataResponseSchema(posOrderDetailSchema),
});

/**
 * Create a POS/captain order. The client sends menu ids, quantities,
 * modifiers and notes only: prices, totals, tax and service charge are computed
 * by the API from the channel price list and the tenant's tax configuration
 * (ORD-03). `holdItems` supplies the fallback when a line omits `hold`.
 */
export const createPosOrder = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/pos/orders",
  params: outletParams,
  body: clientInputSchema({
    channel: orderChannelSchema,
    serviceType: serviceTypeSchema,
    tableSessionId: tableSessionIdSchema.nullable().optional(),
    customerProfileId: uuidSchema.nullable().optional(),
    externalRef: z.string().min(1).max(100).nullable().optional(),
    items: z.array(orderLineInputSchema).min(1).max(99),
    holdItems: z.boolean().optional(),
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(posOrderDetailSchema),
});

/** draft → awaiting_payment; the order is now on the shift and payable. */
export const submitPosOrder = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/pos/orders/:orderId/submit",
  params: orderParams,
  body: clientInputSchema(expectedStatus),
  response: dataResponseSchema(posOrderDetailSchema),
});

/**
 * F8 hold & fire: release held items to the kitchen, by item or by course
 * ("Item dapat ditahan dan dikirim per course sesuai ritme makan").
 */
export const firePosOrderItems = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/pos/orders/:orderId/fire",
  params: orderParams,
  body: clientInputSchema({
    itemIds: z.array(orderItemIdSchema).min(1).max(99).optional(),
    course: z.string().min(1).max(20).optional(),
    ...expectedStatus,
  }).refine(
    (value) => (value.itemIds === undefined) !== (value.course === undefined),
    { message: "Fire either explicit items or one course", path: ["itemIds"] },
  ),
  response: dataResponseSchema(posOrderDetailSchema),
});

/** awaiting_payment/sent → completed, once served and settled. */
export const completePosOrder = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/pos/orders/:orderId/complete",
  params: orderParams,
  body: clientInputSchema(expectedStatus),
  response: dataResponseSchema(posOrderDetailSchema),
});

/**
 * POS-02: void an order that is not final (draft, awaiting payment or sent).
 * A completed sale is corrected through `voidPosOrderCorrection` instead.
 */
export const voidPosOrder = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/pos/orders/:orderId/void",
  params: orderParams,
  body: clientInputSchema({
    reason: voidReasonSchema,
    reasonNote: z.string().min(4).max(500),
    approvedBy: userIdSchema,
    overrideId: posOverrideIdSchema,
    ...expectedStatus,
  }),
  response: dataResponseSchema(posOrderDetailSchema),
});

/** POS-02: void one line; the approval is verified server-side. */
export const voidPosOrderItem = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/pos/orders/:orderId/items/:itemId/void",
  params: orderItemParams,
  body: clientInputSchema({
    reason: voidReasonSchema,
    reasonNote: z.string().min(4).max(500),
    approvedBy: userIdSchema,
    overrideId: posOverrideIdSchema,
    ...expectedVersion,
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(posOrderDetailSchema),
});

/** The append-only order log for one order (§6 order_events). */
export const listPosOrderEvents = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/pos/orders/:orderId/events",
  params: orderParams,
  query: cursorPageQuerySchema,
  response: cursorPageSchema(posOrderEventSchema),
});

// ---- Payment panel --------------------------------------------------------

/**
 * EDC-04 (legend-m4fv): a payment keyed on the terminal by hand while the EDC
 * agent is down. The bank reference is what the terminal slip prints (an RRN,
 * 6-24 letters/digits). Any value holding a 13-19 digit run looks like a card number (PAN) and
 * is refused, so a cashier cannot park a card number in the ledger.
 */
export const posStandaloneEdcSchema = z
  .object({
    terminalId: uuidSchema,
    bankRef: z
      .string()
      .regex(/^[A-Za-z0-9-]{6,24}$/, "Nomor referensi bank tidak valid.")
      .refine((value) => !/\d{13,19}/.test(value.replaceAll("-", "")), {
        message: "Nomor referensi bank tidak boleh menyerupai nomor kartu.",
      }),
    approvalCode: z
      .string()
      .regex(/^[A-Za-z0-9]{1,12}$/, "Kode persetujuan tidak valid.")
      .optional(),
    overrideId: posOverrideIdSchema,
  })
  .strict();

/**
 * legend-yhia9 D-04: the cashier hides the QR (`open` -> `cancelling`). The
 * tender stays authorized until the provider proves the QR is dead; a repeat
 * returns the current state, a `paid` / `closed` hold is returned as is.
 */
export const cancelPosQris = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/pos/orders/:orderId/qris/cancel",
  params: orderParams,
  body: clientInputSchema({
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(posQrisHoldSchema),
});

/** The newest QRIS hold of the bill (404 when the bill never had one). */
export const getPosQris = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/pos/orders/:orderId/qris",
  params: orderParams,
  response: dataResponseSchema(posQrisStatusSchema),
});

/** The methods the cashier may use now and the outlet's active EDC terminals. */
export const getPosPaymentOptions = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/pos/payment-options",
  params: outletParams,
  response: dataResponseSchema(posPaymentOptionsSchema),
});

/**
 * 1269 E7: an ECR card or QR sale on the outlet's own terminal, run by the EDC
 * agent of the edge node that serves the outlet. No amount in the body: the
 * terminal is asked for what the bill still owes (ORD-03), re-checked under the
 * bill lock before the terminal sees it. Repeating `idempotencyKey` returns the
 * same transaction (and asks the terminal when unresolved), never a second
 * sale. 503 EDC_AGENT_NOT_READY off the edge or while the agent is down; 503
 * EDC_PROVIDER_UNKNOWN when the terminal's bank has no adapter. An approved
 * sale is booked with `addPosTender` (`edcTransactionId`).
 */
export const startPosEdcSale = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/pos/orders/:orderId/edc",
  params: orderParams,
  body: clientInputSchema({
    terminalId: uuidSchema,
    method: edcMethodSchema,
    idempotencyKey: idempotencyKeySchema,
    ...expectedVersion,
  }),
  response: dataResponseSchema(edcTransactionSchema),
});

const edcTransactionParams = z.strictObject({
  outletId: outletIdSchema,
  transactionId: uuidSchema,
});

/** 1269 E7: one EDC transaction of this outlet, as the ledger holds it. */
export const getPosEdcTransaction = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/pos/edc/:transactionId",
  params: edcTransactionParams,
  response: dataResponseSchema(edcTransactionSchema),
});

/** 1269 E7: asks the terminal for the result of an unresolved sale (EDC-03). */
export const inquirePosEdcTransaction = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/pos/edc/:transactionId/inquire",
  params: edcTransactionParams,
  body: clientInputSchema({}),
  response: dataResponseSchema(edcTransactionSchema),
});

/** 1269 E7: cancels a sale the terminal has not finished. */
export const cancelPosEdcTransaction = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/pos/edc/:transactionId/cancel",
  params: edcTransactionParams,
  body: clientInputSchema({}),
  response: dataResponseSchema(edcTransactionSchema),
});

/**
 * legend-adiov: force released QRIS codes still being reconciled with the
 * provider (default `open`; at most 200, newest first).
 */
export const listPosQrisReconciliations = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/pos/qris/reconciliations",
  params: outletParams,
  query: z.strictObject({
    status: posQrisReconciliationStatusSchema.optional(),
  }),
  response: dataResponseSchema(z.array(posQrisReconciliationSchema)),
});

/**
 * Q93: a manager releases a stuck hold with a pos-overrides approval, only from
 * 30 minutes after the QR expired. Money paid on that QR afterwards is parked
 * as unallocated funds.
 */
export const releasePosQris = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/pos/orders/:orderId/qris/release",
  params: orderParams,
  body: clientInputSchema({
    approvedBy: userIdSchema,
    overrideId: posOverrideIdSchema,
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(posQrisHoldSchema),
});

/**
 * legend-5wn1e: a supervisor releases a virtual account code the provider has
 * not answered final for, with a pos-overrides approval and a reason, only from
 * 30 minutes after the code lapsed. Money paid on that code afterwards is
 * parked as unallocated funds, never applied to the bill.
 */
export const releasePosVa = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/pos/orders/:orderId/va/release",
  params: orderParams,
  body: clientInputSchema({
    paymentIntentId: uuidSchema,
    approvedBy: userIdSchema,
    overrideId: posOverrideIdSchema,
    idempotencyKey: idempotencyKeySchema,
    reason: posVaReleaseReasonSchema,
  }),
  response: dataResponseSchema(posVaReleaseSchema),
});

/**
 * Add one tender. The body has no amount: cash sends what the customer handed
 * over (`receivedIdr`) and the API applies `min(received, remaining)` and
 * computes change; every other method settles the remaining balance. Payment
 * confirmation itself comes from WS-05 (verified webhook / EDC adapter).
 */
export const addPosTender = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/pos/orders/:orderId/tenders",
  params: orderParams,
  body: clientInputSchema({
    method: posTenderMethodSchema,
    receivedIdr: z.number().int().positive().optional(),
    reference: z.string().min(1).max(100).nullable().optional(),
    edcTransactionId: uuidSchema.nullable().optional(),
    /** EDC-04: standalone terminal payment; exclusive with edcTransactionId. */
    standalone: posStandaloneEdcSchema.optional(),
    pointsUsed: z
      .number()
      .int()
      .positive()
      .max(1_000_000)
      .nullable()
      .optional(),
    /** A points tender: the member's QR token for this order and amount. */
    memberToken: z.string().min(1).max(512).optional(),
    /** 1269 C3a: the bank / e-wallet code of a VA or e-wallet tender. */
    channelCode: z.string().min(1).max(40).optional(),
    ...expectedStatus,
  })
    .refine(
      (value) =>
        (value.method === "va" || value.method === "ewallet") ===
        (value.channelCode !== undefined),
      {
        message: "VA and e-wallet name a channel; no other method sends one",
        path: ["channelCode"],
      },
    )
    .refine(
      (value) =>
        value.method === "cash"
          ? value.receivedIdr !== undefined
          : value.receivedIdr === undefined,
      {
        message: "Only a cash tender sends receivedIdr",
        path: ["receivedIdr"],
      },
    )
    .refine((value) => !(value.standalone && value.edcTransactionId), {
      message: "A standalone EDC payment has no edcTransactionId",
      path: ["standalone"],
    })
    .refine(
      (value) =>
        !value.standalone ||
        value.method === "edc_card" ||
        value.method === "edc_qris",
      {
        message: "Only an EDC tender can be standalone",
        path: ["standalone"],
      },
    ),
  response: dataResponseSchema(posTenderResultSchema),
});

/** POS-02: a manual discount above the tenant threshold needs approval. */
export const applyPosDiscount = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/pos/orders/:orderId/discounts",
  params: orderParams,
  body: clientInputSchema({
    source: posDiscountSourceSchema,
    kind: posDiscountKindSchema,
    percentBp: z.number().int().min(1).max(10_000).optional(),
    promoCode: z
      .string()
      .min(3)
      .max(40)
      .regex(/^[A-Z0-9-]+$/)
      .optional(),
    voucherCode: z.string().min(6).max(40).optional(),
    reason: discountReasonSchema,
    reasonNote: z.string().min(4).max(500).nullable().optional(),
    approvedBy: userIdSchema.optional(),
    overrideId: posOverrideIdSchema.optional(),
    ...expectedVersion,
    idempotencyKey: idempotencyKeySchema,
  })
    .refine(
      (value) => value.kind === "amount" || value.percentBp !== undefined,
      { message: "A percent discount sends percentBp", path: ["percentBp"] },
    )
    .refine(
      (value) =>
        value.source !== "manual" || (value.reasonNote ?? "").length >= 4,
      {
        message: "A manual discount records its written reason (POS-02)",
        path: ["reasonNote"],
      },
    )
    .refine(
      (value) =>
        (value.approvedBy === undefined) === (value.overrideId === undefined),
      {
        message: "Approval carries both the approver and the override id",
        path: ["overrideId"],
      },
    )
    .refine(
      (value) => value.source !== "promo" || value.promoCode !== undefined,
      { message: "A promo discount sends its promo code", path: ["promoCode"] },
    )
    .refine(
      (value) => value.source !== "voucher" || value.voucherCode !== undefined,
      {
        message: "A voucher discount sends its voucher code",
        path: ["voucherCode"],
      },
    ),
  response: dataResponseSchema(posOrderDetailSchema),
});

/** POS-04: linked void of a completed sale; the receipt number is kept. */
export const voidPosOrderCorrection = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/pos/orders/:orderId/corrections/void",
  params: orderParams,
  body: clientInputSchema({
    reason: voidReasonSchema,
    reasonNote: z.string().min(4).max(500),
    approvedBy: userIdSchema,
    overrideId: posOverrideIdSchema,
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(posVoidSchema),
});

/**
 * POS-02/POS-04: refund against a paid sale. The cashier states how much to
 * refund; the API validates it against what is still refundable and splits it
 * back over the original tender methods (`refundAllocation`).
 * A promo order must say which `items` come back: the API then works out what
 * is really due (the promo may be kept pro rata or withdrawn) and may pay less
 * than `amountIdr`. Refund never restores stock (only a void does).
 */
export const refundPosOrder = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/pos/orders/:orderId/corrections/refund",
  params: orderParams,
  body: clientInputSchema({
    amountIdr: z.number().int().positive(),
    items: z.array(posRefundItemSchema).min(1).max(100).optional(),
    reason: refundReasonSchema,
    reasonNote: z.string().min(4).max(500),
    approvedBy: userIdSchema,
    overrideId: posOverrideIdSchema,
    idempotencyKey: idempotencyKeySchema,
  }).refine(
    (value) =>
      value.items === undefined ||
      new Set(value.items.map((item) => item.itemId)).size ===
        value.items.length,
    { message: "Each refunded item may appear once", path: ["items"] },
  ),
  response: dataResponseSchema(posRefundSchema),
});

/** Remove a discount line (before settlement only). */
export const removePosDiscount = defineEndpoint({
  method: "DELETE",
  path: "/api/outlets/:outletId/pos/orders/:orderId/discounts/:discountId",
  params: z.strictObject({
    outletId: outletIdSchema,
    orderId: orderIdSchema,
    discountId: posDiscountIdSchema,
  }),
  body: clientInputSchema({
    ...expectedVersion,
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(posOrderDetailSchema),
});

/** The approval threshold the cashier screen shows before asking a supervisor. */
export const getPosApprovalPolicy = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/pos/policy",
  params: outletParams,
  response: dataResponseSchema(posApprovalPolicySchema),
});

// ---- Cashier shift (POS-03) ----------------------------------------------

/** §4 E: the cashier opens the shift with the drawer's opening float. */
export const openPosShift = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/pos/shifts",
  params: outletParams,
  body: openPosShiftInputSchema,
  response: dataResponseSchema(posShiftSchema),
});

export const listPosShifts = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/pos/shifts",
  params: outletParams,
  query: cursorPageQuerySchema.extend({
    businessDate: businessDateSchema.optional(),
    deviceId: uuidSchema.optional(),
  }),
  response: cursorPageSchema(posShiftSchema),
});

/** Shift report: the shift, its cash movements and any receipt gaps (POS-06). */
export const getPosShift = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/pos/shifts/:shiftId",
  params: shiftParams,
  response: dataResponseSchema(posShiftReportSchema),
});

/** POS-03: a blind count submission (cashier); the answer is blind too. */
export const submitPosShiftCount = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/pos/shifts/:shiftId/counts",
  params: shiftParams,
  body: submitPosShiftCountInputSchema,
  response: dataResponseSchema(posShiftCountReceiptSchema),
});

/** Supervisor view of every count submission of the shift. */
export const listPosShiftCounts = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/pos/shifts/:shiftId/counts",
  params: shiftParams,
  response: dataResponseSchema(z.array(posShiftCountSchema)),
});

/** POS-03: close with a stored count + supervisor approval; variance locked. */
export const closePosShift = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/pos/shifts/:shiftId/close",
  params: shiftParams,
  body: closePosShiftInputSchema,
  response: dataResponseSchema(posShiftSchema),
});

/** U9: a supervisor force closes a shift after the cashier's recount limit. */
export const forceClosePosShift = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/pos/shifts/:shiftId/force-close",
  params: shiftParams,
  body: forceClosePosShiftInputSchema,
  response: dataResponseSchema(posShiftSchema),
});

/** "kas masuk dan keluar dengan alasan" (F8 Shift Kasir). */
export const recordPosCashMovement = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/pos/shifts/:shiftId/cash-movements",
  params: shiftParams,
  body: recordCashMovementInputSchema,
  response: dataResponseSchema(posCashMovementSchema),
});

/**
 * legend-3l4q: a supervisor (`shift.cash.approve_close`, never the recorder)
 * approves or rejects a held cash out or drop while the shift is open.
 */
export const decidePosCashMovement = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/pos/shifts/:shiftId/cash-movements/:movementId/decision",
  params: cashMovementParams,
  body: decidePosCashMovementInputSchema,
  response: dataResponseSchema(posCashMovementDecisionSchema),
});

/** Read side of the same sheet, for the printed shift report. */
export const listPosCashMovements = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/pos/shifts/:shiftId/cash-movements",
  params: shiftParams,
  query: cursorPageQuerySchema.extend({
    type: cashMovementTypeSchema.optional(),
  }),
  response: cursorPageSchema(posCashMovementSchema),
});

// ---- End of day (F8 "Tutup Hari") ----------------------------------------

export const getEndOfDayRecap = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/pos/day",
  params: outletParams,
  query: z.strictObject({ businessDate: businessDateSchema }),
  response: dataResponseSchema(endOfDayRecapViewSchema),
});

/** Close the day: recap, optional stock deduction, sync to accounting. */
export const closePosDay = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/pos/day/close",
  params: outletParams,
  body: closeBusinessDayInputSchema,
  response: dataResponseSchema(endOfDayRecapSchema),
});

// ---- Receipts and documents (POS-06, POS-07) -----------------------------

/**
 * Issue (or reprint) the receipt for an order: the API allocates the next
 * device number from `receipt_sequences` inside the same transaction as the
 * order, then renders/queues the requested deliveries. A void keeps the number.
 */
export const issuePosReceipt = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/pos/orders/:orderId/receipts",
  params: orderParams,
  body: clientInputSchema({
    /** Defaults to printing once; `link` adds the e-receipt URL. */
    deliveries: z.array(receiptDeliveryChannelSchema).min(1).max(3).optional(),
    email: z.string().email().max(200).optional(),
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(posReceiptIssueResultSchema),
});

/** POS-07: the rendered receipt/kuitansi (print template and e-receipt page). */
export const getPosReceiptDocument = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/pos/receipts/:receiptId",
  params: receiptParams,
  response: dataResponseSchema(receiptDocumentSchema),
});

export const getPosReceiptByNumber = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/pos/receipts/by-number/:number",
  params: z.strictObject({
    outletId: outletIdSchema,
    number: receiptNumberSchema,
  }),
  response: dataResponseSchema(posReceiptIssueResultSchema),
});

/** E-receipt link/QR; the raw token is returned once and never stored. */
export const createPosReceiptLink = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/pos/receipts/:receiptId/link",
  params: receiptParams,
  body: clientInputSchema({ idempotencyKey: idempotencyKeySchema }),
  response: dataResponseSchema(receiptLinkSchema),
});

/** F8 "Invoice dapat dibuat untuk event dan pemesanan korporat". */
export const createPosInvoice = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/pos/orders/:orderId/invoices",
  params: orderParams,
  body: clientInputSchema({
    billedTo: z.strictObject({
      name: z.string().min(1).max(150),
      address: z.string().min(10).max(300),
      npwp: z.string().min(15).max(25).nullable().optional(),
    }),
    dueDate: businessDateSchema,
    notes: z.string().min(4).max(500).nullable().optional(),
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(invoiceDocumentSchema),
});

/** Convenience for the payment panel's method picker state. */
export const getPosOrderActionAvailability = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/pos/orders/:orderId/actions",
  params: orderParams,
  response: dataResponseSchema(
    z.strictObject({
      allowed: z.array(posOrderActionSchema),
      canSettle: z.boolean(),
      canCorrect: z.boolean(),
    }),
  ),
});

// ---- Customer display (F8 "Customer Display") ---------------------------

/** What the paired second screen shows (items, total, dynamic QRIS). */
export const getCustomerDisplayState = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/pos/customer-display",
  params: outletParams,
  query: z.strictObject({ terminalDeviceId: uuidSchema.optional() }),
  response: dataResponseSchema(customerDisplayStateSchema),
});

/** Pair a display to a terminal with the six-digit code on the screen. */
export const pairCustomerDisplay = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/pos/customer-display/pair",
  params: outletParams,
  body: pairCustomerDisplayInputSchema,
  response: dataResponseSchema(customerDisplayPairingSchema),
});

/** legend-yhia9 D-08: a display device asks for its pairing code. */
export const createCustomerDisplayPairingCode = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/pos/customer-display/pairing-codes",
  params: outletParams,
  response: dataResponseSchema(customerDisplayPairingCodeSchema),
});

/** The cashier picks the bill the paired display shows (null: idle). */
export const selectCustomerDisplayBill = defineEndpoint({
  method: "PUT",
  path: "/api/outlets/:outletId/pos/customer-display/selection",
  params: outletParams,
  body: selectCustomerDisplayBillInputSchema,
  response: dataResponseSchema(customerDisplaySelectionSchema),
});

export const revokeCustomerDisplayPairing = defineEndpoint({
  method: "DELETE",
  path: "/api/outlets/:outletId/pos/customer-display/pairings/:pairingId",
  params: z.strictObject({
    outletId: outletIdSchema,
    pairingId: customerDisplayPairingIdSchema,
  }),
  response: dataResponseSchema(customerDisplayPairingSchema),
});
