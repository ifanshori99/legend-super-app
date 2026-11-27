// POS contract (bead legend-4yp, WS-04) — PRD v1.7 §3 F8 "POS Kasir & Captain
// Order" and F43/F44, §4 E "Alur Kasir Membuka dan Menutup Shift", §5 "Model
// event untuk operasional" (orders, cash/EDC payments, shift cash are
// append-only events), §6.C (`orders`, `order_items`, `order_events`,
// `receipt_sequences`, `pos_shifts`, `cash_movements`). Acceptance criteria at
// contract level: POS-03, POS-04, POS-06 (and the POS-02/POS-07 vocabulary the
// screens need).
//
// What this contract is: the order, tender, discount, void/refund, cashier
// shift, end-of-day, receipt/document and customer-display vocabularies plus
// their explicit state machines, so the POS screens (WS-04 FE beads
// legend-59v/5w6/2fo/iqi/azt/76t), the API and the edge node cannot drift.
//
// What it is not: authorization, pricing, payment processing or stock
// deduction. Every amount here is server-computed (ORD-03, TEN-02): client
// request schemas carry menu ids, quantities, rates and codes — never prices,
// totals, expected cash or variance. Payment confirmation comes from WS-05
// (verified webhook / EDC), and the two accounting events (`order.paid`,
// `order.refunded`) carry exactly the amount keys the WS-07 posting rules
// already read (@starter/shared/accounting).
//
// Money is whole rupiah (`*Idr`, D-CORE-2); ids are UUID except orders, order
// items and order_events, which are ULIDs (§6, D-CORE-1).

import {
  z,
  uuidSchema,
  uuidIdSchema,
  ulidIdSchema,
  tenantIdSchema,
  outletIdSchema,
  userIdSchema,
  idr,
  idrSchema,
  basisPointsSchema,
  isoDateTimeSchema,
  businessDateSchema,
  clientInputSchema,
  idempotencyKeySchema,
} from "../core/index.ts";
import type { Idr } from "../core/index.ts";
import { posDiscountThresholdBpSchema } from "../core/money.ts";
import { posOverrideIdSchema } from "../access/override.ts";
import { printPayloadSchema } from "./print-payload.ts";
import {
  edcBankSchema,
  edcMethodSchema,
  edcTransactionStatusSchema,
} from "../edc/index.ts";
import { orderIdSchema } from "../kitchen/schemas.ts";
import { PICKUP_CODE_PATTERN } from "../kitchen/pickup-code.ts";
import {
  discountLineSchema,
  fireStatusSchema,
  orderItemIdSchema,
  orderItemStatusSchema,
  orderModifierSnapshotSchema,
  serviceChargeLineSchema,
  tableSessionIdSchema,
  taxLineSchema,
} from "../qr-order/schemas.ts";
import {
  ewalletPaymentInstructionsSchema,
  paymentChannelSchema,
  vaPaymentInstructionsSchema,
  type PaymentMethod,
} from "../payment/index.ts";
import { PosError } from "./errors.ts";
import { shiftExpectedCashIdr, shiftVarianceIdr } from "./calculations.ts";
import { receiptNumberSchema, receiptRunPrefixSchema } from "./receipts.ts";

const scope = { tenantId: tenantIdSchema, outletId: outletIdSchema };
const name = z.string().min(1).max(150);
const note = z.string().max(200);
const nonnegativeIdr = idrSchema.refine(
  (value) => value >= 0,
  "Amount must not be negative",
);
const positiveIdr = idrSchema.refine(
  (value) => value > 0,
  "Amount must be positive",
);
/** Approval records are WS-01 `approval_requests` rows (§3.7 Matriks Approval). */
const approvalRequestIdSchema = uuidSchema;
/**
 * The approval id a closed shift stores. A supervisor PIN decision has no WS-01
 * chain, so the shift keeps the `pos_overrides` ULID as a uuid (`ulidToUuid`);
 * that value has no RFC 4122 version/variant bits, so only its shape is
 * checked here. Client input keeps the strict `approvalRequestIdSchema`.
 */
export const storedApprovalIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  .toLowerCase();
/**
 * The approval a shift close names (legend-6c0): the WS-01 phone approval id
 * (uuid), or the supervisor PIN override id itself, the `pos_overrides` ULID as
 * the override service returns it. The `ulidToUuid` form a closed shift stores
 * parses too, so a client may send back the value it read. The server still
 * proves the approval from the override row, never from the id alone.
 */
export const closeApprovalIdSchema = z.union([
  posOverrideIdSchema,
  storedApprovalIdSchema,
]);
/**
 * legend-0gy1: the `pos_overrides` row (ULID) a void / discount / refund
 * consumed. It is the proof of approval; `approvalRequestId` is only the WS-01
 * chain id of a phone approval and is null for a supervisor PIN.
 */
const overrideIdSchema = posOverrideIdSchema;
// Rows written before legend-0gy1 carry only the client-sent approval id and
// no override id, so the stored shapes accept either one (new rows always set
// the override id).

// ---- Ids ------------------------------------------------------------------

export const posShiftIdSchema = uuidIdSchema<"CashierShiftId">();
export const posShiftCountIdSchema = uuidIdSchema<"CashierShiftCountId">();
export const cashMovementIdSchema = uuidIdSchema<"CashMovementId">();
export const posTenderIdSchema = uuidIdSchema<"PosTenderId">();
export const posDiscountIdSchema = uuidIdSchema<"PosDiscountId">();
export const posVoidIdSchema = uuidIdSchema<"PosVoidId">();
export const posRefundIdSchema = uuidIdSchema<"PosRefundId">();
export const posReceiptIdSchema = uuidIdSchema<"PosReceiptId">();
export const receiptSequenceIdSchema = uuidIdSchema<"ReceiptSequenceId">();
export const receiptDeliveryIdSchema = uuidIdSchema<"ReceiptDeliveryId">();
export const customerDisplayPairingIdSchema =
  uuidIdSchema<"CustomerDisplayPairingId">();
export const dailyCloseIdSchema = uuidIdSchema<"DailyCloseId">();
/** §6 `order_events` is an append-only operational log: ULID (§5). */
export const orderEventIdSchema = ulidIdSchema<"OrderEventId">();

// The order aggregate and its lines are owned by the kitchen/QR contracts;
// re-export them so POS callers use one id type everywhere (AGENT_PLAYBOOK §2).
export { orderIdSchema, orderItemIdSchema, receiptNumberSchema };

// ---- Orders (§6.C orders) -------------------------------------------------

/** §6 `orders.channel`. */
export const ORDER_CHANNELS = [
  "qr",
  "pos",
  "captain",
  "gofood",
  "grabfood",
  "shopeefood",
  "reservation",
  "kiosk",
  "facility",
] as const;
export const orderChannelSchema = z.enum(ORDER_CHANNELS);
export type OrderChannel = z.infer<typeof orderChannelSchema>;

/** §6 `orders.service_type`. */
export const SERVICE_TYPES = ["dine_in", "takeaway", "delivery"] as const;
export const serviceTypeSchema = z.enum(SERVICE_TYPES);
export type ServiceType = z.infer<typeof serviceTypeSchema>;

/** Advisory sequence preview; creating the order assigns its final number. */
export const posNextCallNumberSchema = z.strictObject({
  number: z.number().int().positive(),
  code: z.string().regex(PICKUP_CODE_PATTERN),
  businessDate: businessDateSchema,
});
export type PosNextCallNumber = z.infer<typeof posNextCallNumberSchema>;

/** Server-priced choices for the cashier/captain item picker. */
export const posCatalogSchema = z.strictObject({
  categories: z.array(
    z.strictObject({
      id: uuidSchema,
      name,
      sortOrder: z.number().int().nonnegative(),
    }),
  ),
  items: z.array(
    z.strictObject({
      id: uuidSchema,
      categoryId: uuidSchema,
      categoryName: name,
      name,
      /** Display price only: variant items still require a selected variant. */
      basePriceIdr: positiveIdr,
      plainPriceIdr: positiveIdr.nullable(),
      variants: z.array(
        z.strictObject({ id: uuidSchema, name, priceIdr: positiveIdr }),
      ),
      imageUrl: z.string().max(2048).nullable(),
      course: z.string().max(20).nullable(),
      code: z.string().max(100).nullable(),
      soldOut: z.boolean(),
      modifierGroups: z.array(
        z.strictObject({
          id: uuidSchema,
          name,
          required: z.boolean(),
          min: z.number().int().nonnegative(),
          max: z.number().int().nonnegative(),
          options: z.array(
            z.strictObject({
              id: uuidSchema,
              label: name,
              priceDeltaIdr: nonnegativeIdr,
            }),
          ),
        }),
      ),
    }),
  ),
  updatedAt: isoDateTimeSchema,
  source: z.literal("live"),
});
export type PosCatalog = z.infer<typeof posCatalogSchema>;

/** §6 `orders.status`, plus the POS actions that move between them. */
export const POS_ORDER_STATUSES = [
  "draft",
  "awaiting_payment",
  "sent",
  "completed",
  "voided",
] as const;
export const posOrderStatusSchema = z.enum(POS_ORDER_STATUSES);
export type PosOrderStatus = z.infer<typeof posOrderStatusSchema>;

export const POS_ORDER_ACTIONS = [
  "submit",
  "fire",
  "complete",
  "void",
] as const;
export const posOrderActionSchema = z.enum(POS_ORDER_ACTIONS);
export type PosOrderAction = z.infer<typeof posOrderActionSchema>;

/**
 * One explicit transition table for FE and BE. `completed` and `voided` are
 * terminal (POS-04: no delete, no edit); correcting a completed sale is a
 * linked void/refund record, never a status change.
 */
export const POS_ORDER_TRANSITIONS: Record<
  PosOrderStatus,
  Partial<Record<PosOrderAction, PosOrderStatus>>
> = {
  draft: { submit: "awaiting_payment", void: "voided" },
  awaiting_payment: { fire: "sent", void: "voided" },
  sent: { complete: "completed", void: "voided" },
  completed: {},
  voided: {},
};

export function canTransitionPosOrder(
  status: PosOrderStatus,
  action: PosOrderAction,
): boolean {
  return POS_ORDER_TRANSITIONS[status][action] !== undefined;
}

export function transitionPosOrder(
  status: PosOrderStatus,
  action: PosOrderAction,
): PosOrderStatus {
  const next = POS_ORDER_TRANSITIONS[status][action];
  if (next === undefined) throw new PosError("ORDER_TRANSITION_INVALID");
  return next;
}

/** POS-04: final orders are immutable history. */
export function isFinalPosOrder(status: PosOrderStatus): boolean {
  return status === "completed" || status === "voided";
}

/**
 * POS-04 "Transaksi final tidak dapat dihapus": every mutating service calls
 * this before touching an order. There is deliberately no delete operation in
 * this contract.
 */
export function assertPosOrderMutable(order: Pick<PosOrder, "status">): void {
  if (isFinalPosOrder(order.status))
    throw new PosError("ORDER_FINAL_IMMUTABLE");
}

/** A sale is settled only after it was submitted; drafts are not payable. */
export function canSettlePosOrder(status: PosOrderStatus): boolean {
  return status === "awaiting_payment" || status === "sent";
}

export function assertPosOrderSettleable(
  order: Pick<PosOrder, "status">,
): void {
  if (!canSettlePosOrder(order.status)) throw new PosError("ORDER_NOT_PAYABLE");
}

export const voidReasonSchema = z.enum([
  "customer_cancelled",
  "wrong_order",
  "sold_out",
  "duplicate_order",
  "price_error",
  "system_error",
  "other",
]);
export const refundReasonSchema = z.enum([
  "customer_cancelled",
  "quality_complaint",
  "wrong_order",
  "overpayment",
  "duplicate_payment",
  "event_cancelled",
  "manager_goodwill",
  "other",
]);
export type VoidReason = z.infer<typeof voidReasonSchema>;
export type RefundReason = z.infer<typeof refundReasonSchema>;

const orderNumber = z
  .string()
  .min(3)
  .max(30)
  .regex(
    /^[A-Z0-9-]+$/,
    "Order numbers use uppercase letters, digits and hyphens",
  );

export const posOrderShape = {
  id: orderIdSchema,
  ...scope,
  /** Nomor pesanan atau nomor panggilan (§6). */
  number: orderNumber,
  channel: orderChannelSchema,
  serviceType: serviceTypeSchema,
  tableSessionId: tableSessionIdSchema.nullable(),
  customerProfileId: uuidSchema.nullable(),
  /** Platform order number for the manual ojol channel (§6). */
  externalRef: z.string().min(1).max(100).nullable(),
  /** Shift attribution for POS-03 cash reconciliation. */
  shiftId: posShiftIdSchema.nullable(),
  deviceId: uuidSchema.nullable(),
  cashierId: userIdSchema.nullable(),
  subtotalIdr: nonnegativeIdr,
  discountIdr: nonnegativeIdr,
  serviceChargeIdr: nonnegativeIdr,
  taxIdr: nonnegativeIdr,
  /** §6 `orders.rounding_idr`: a signed cash-rounding adjustment. */
  roundingIdr: idrSchema,
  totalIdr: nonnegativeIdr,
  /**
   * legend-9pz9: the reservation DP applied to this order (the table
   * session's credit, `orders.deposit_applied_idr`). Tenders settle the rest.
   */
  depositAppliedIdr: nonnegativeIdr.default(idr(0)),
  /**
   * legend-npnh: inclusive prices (harga nett, `orders.prices_include_tax`).
   * `subtotalIdr` is then gross with service and tax inside it, and the total
   * is subtotal - discount + rounding. Absent (legacy) means exclusive.
   */
  pricesIncludeTax: z.boolean().default(false),
  status: posOrderStatusSchema,
  createdBy: userIdSchema.nullable(),
  createdAt: isoDateTimeSchema,
  submittedAt: isoDateTimeSchema.nullable(),
  /** Set when the order first reached a kitchen station (F8 hold & fire). */
  firedAt: isoDateTimeSchema.nullable(),
  completedAt: isoDateTimeSchema.nullable(),
  voidedAt: isoDateTimeSchema.nullable(),
  voidReason: voidReasonSchema.nullable(),
  voidReasonNote: z.string().min(4).max(500).nullable(),
  voidApprovedBy: userIdSchema.nullable(),
  voidApprovalRequestId: approvalRequestIdSchema.nullable(),
  voidOverrideId: overrideIdSchema.nullable(),
  /**
   * legend-63l6: the optimistic-concurrency version (`pos_orders.version`),
   * bumped by every write. Echo it back as `expectedVersion` (or `If-Match`)
   * to refuse a stale write.
   */
  version: z.number().int().nonnegative(),
};

export const posOrderBaseSchema = z.strictObject(posOrderShape);

function checkOrderMoney(
  order: {
    subtotalIdr: Idr;
    discountIdr: Idr;
    serviceChargeIdr: Idr;
    taxIdr: Idr;
    roundingIdr: Idr;
    totalIdr: Idr;
    depositAppliedIdr: Idr;
    pricesIncludeTax: boolean;
  },
  ctx: z.RefinementCtx,
): void {
  if (Number(order.depositAppliedIdr) > Number(order.totalIdr))
    ctx.addIssue({
      code: "custom",
      path: ["depositAppliedIdr"],
      message: "depositAppliedIdr must not exceed totalIdr",
    });
  const netSubtotal = Number(order.subtotalIdr) - Number(order.discountIdr);
  if (order.pricesIncludeTax) {
    // Inclusive (as the QR order): service and tax sit inside the subtotal.
    if (Number(order.totalIdr) !== netSubtotal + Number(order.roundingIdr))
      ctx.addIssue({
        code: "custom",
        path: ["totalIdr"],
        message: "inclusive totalIdr must equal subtotal - discount + rounding",
      });
    if (Number(order.serviceChargeIdr) + Number(order.taxIdr) > netSubtotal)
      ctx.addIssue({
        code: "custom",
        path: ["serviceChargeIdr"],
        message:
          "included service charge and tax cannot exceed the net subtotal",
      });
    return;
  }
  const expected =
    netSubtotal +
    Number(order.serviceChargeIdr) +
    Number(order.taxIdr) +
    Number(order.roundingIdr);
  if (Number(order.totalIdr) !== expected)
    ctx.addIssue({
      code: "custom",
      path: ["totalIdr"],
      message:
        "totalIdr must equal subtotal - discount + service + tax + rounding",
    });
}

export const posOrderSchema = posOrderBaseSchema.superRefine((order, ctx) => {
  checkOrderMoney(order, ctx);
  if (order.status === "draft" && order.submittedAt !== null)
    ctx.addIssue({
      code: "custom",
      path: ["submittedAt"],
      message: "A draft order has not been submitted",
    });
  // An order voided straight from the draft never reached the kitchen or a
  // payment, so it has no submittedAt.
  if (
    order.status !== "draft" &&
    order.status !== "voided" &&
    order.submittedAt === null
  )
    ctx.addIssue({
      code: "custom",
      path: ["submittedAt"],
      message: "A submitted order records submittedAt",
    });
  if (
    (order.status === "sent" || order.status === "completed") &&
    order.firedAt === null
  )
    ctx.addIssue({
      code: "custom",
      path: ["firedAt"],
      message: "A fired order records firedAt (hold & fire)",
    });
  if ((order.status === "completed") !== (order.completedAt !== null))
    ctx.addIssue({
      code: "custom",
      path: ["completedAt"],
      message: "completedAt is set exactly when the order is completed",
    });
  if (order.status === "voided") {
    if (
      order.voidedAt === null ||
      order.voidReason === null ||
      order.voidApprovedBy === null ||
      (order.voidOverrideId === null && order.voidApprovalRequestId === null)
    )
      ctx.addIssue({
        code: "custom",
        path: ["voidedAt"],
        message:
          "A voided order records time, standard reason and approval (POS-02)",
      });
    if (order.voidReason === "other" && order.voidReasonNote === null)
      ctx.addIssue({
        code: "custom",
        path: ["voidReasonNote"],
        message: "An 'other' void reason needs a written note",
      });
  } else if (
    order.voidedAt !== null ||
    order.voidReason !== null ||
    order.voidApprovedBy !== null ||
    order.voidApprovalRequestId !== null ||
    order.voidOverrideId !== null
  )
    ctx.addIssue({
      code: "custom",
      path: ["voidedAt"],
      message: "Only a voided order carries void metadata",
    });
});

export type PosOrder = z.infer<typeof posOrderSchema>;

/** Cashier list row: enough for the order rail, without the lines. */
export const posOrderSummarySchema = z.strictObject({
  id: orderIdSchema,
  ...scope,
  number: orderNumber,
  channel: orderChannelSchema,
  serviceType: serviceTypeSchema,
  tableSessionId: tableSessionIdSchema.nullable(),
  status: posOrderStatusSchema,
  shiftId: posShiftIdSchema.nullable(),
  totalIdr: nonnegativeIdr,
  /** Total less deposit, captured tenders and paid link; 0 once final. */
  remainingIdr: nonnegativeIdr,
  /** Table the order's session sits at now; null without a session. */
  tableLabel: z.string().min(1).nullable(),
  itemCount: z.number().int().nonnegative(),
  heldItemCount: z.number().int().nonnegative(),
  createdAt: isoDateTimeSchema,
});
export type PosOrderSummary = z.infer<typeof posOrderSummarySchema>;

// ---- Order items (§6.C order_items) ---------------------------------------

export const posOrderItemShape = {
  id: orderItemIdSchema,
  tenantId: tenantIdSchema,
  orderId: orderIdSchema,
  menuItemId: uuidSchema,
  variantId: uuidSchema.nullable(),
  name,
  quantity: z.number().int().min(1).max(99),
  /** Positive, except a swap replacement on a completed order (see swapRole). */
  unitPriceIdr: nonnegativeIdr,
  modifiersTotalIdr: nonnegativeIdr,
  lineTotalIdr: nonnegativeIdr,
  modifiers: z.array(orderModifierSnapshotSchema),
  note: note.nullable(),
  course: z.string().min(1).max(20).nullable(),
  /**
   * legend-kxoyf: the part this line plays in a kitchen swap (order_issues).
   * `replaced` = the failed line the swap voided (no POS-02 approval chain:
   * the recovery flow approved it); `replacement` = the line added by the swap
   * (recorded at zero on a completed order). Every other line is `none`.
   */
  swapRole: z.enum(["none", "replaced", "replacement"]).default("none"),
  /** F8 hold & fire, per item and per course. */
  fireStatus: fireStatusSchema,
  firedAt: isoDateTimeSchema.nullable(),
  status: orderItemStatusSchema,
  voidReason: voidReasonSchema.nullable(),
  voidReasonNote: z.string().min(4).max(500).nullable(),
  voidedBy: userIdSchema.nullable(),
  voidApprovedBy: userIdSchema.nullable(),
  voidApprovalRequestId: approvalRequestIdSchema.nullable(),
  voidOverrideId: overrideIdSchema.nullable(),
  /**
   * §6 `order_items.cost_snapshot_idr`: line HPP at sale time, server-computed.
   * Finance data (`inventory.cost.view`): the POS order DTO always sends
   * `null` (unknown / not exposed); never read it as 0. Cost readers use SQL.
   */
  costSnapshotIdr: nonnegativeIdr.nullable(),
  createdAt: isoDateTimeSchema,
};

export const posOrderItemSchema = z
  .strictObject(posOrderItemShape)
  .superRefine((item, ctx) => {
    if (Number(item.unitPriceIdr) <= 0 && item.swapRole !== "replacement")
      ctx.addIssue({
        code: "custom",
        path: ["unitPriceIdr"],
        message: "Amount must be positive",
      });
    if (
      Number(item.lineTotalIdr) !==
      (Number(item.unitPriceIdr) + Number(item.modifiersTotalIdr)) *
        item.quantity
    )
      ctx.addIssue({
        code: "custom",
        path: ["lineTotalIdr"],
        message: "lineTotalIdr must equal (unit price + modifiers) x quantity",
      });
    if (
      Number(item.modifiersTotalIdr) !==
      item.modifiers.reduce(
        (sum, modifier) => sum + Number(modifier.priceIdr),
        0,
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["modifiersTotalIdr"],
        message: "modifiersTotalIdr must equal the sum of modifier prices",
      });
    if ((item.fireStatus === "fired") !== (item.firedAt !== null))
      ctx.addIssue({
        code: "custom",
        path: ["firedAt"],
        message: "A fired item records firedAt; a held item does not",
      });
    if (item.swapRole === "replaced" && item.status !== "voided") {
      // A completed order keeps the swapped-out line live: no void metadata.
    } else if (item.status === "voided") {
      if (
        item.voidReason === null ||
        (item.swapRole !== "replaced" &&
          (item.voidedBy === null ||
            item.voidApprovedBy === null ||
            (item.voidOverrideId === null &&
              item.voidApprovalRequestId === null)))
      )
        ctx.addIssue({
          code: "custom",
          path: ["voidReason"],
          message:
            "A voided item records standard reason, who voided it and the approval (POS-02)",
        });
    } else if (
      item.voidReason !== null ||
      item.voidedBy !== null ||
      item.voidApprovedBy !== null ||
      item.voidApprovalRequestId !== null ||
      item.voidOverrideId !== null
    )
      ctx.addIssue({
        code: "custom",
        path: ["voidReason"],
        message: "Only a voided item carries void metadata",
      });
  });
export type PosOrderItem = z.infer<typeof posOrderItemSchema>;

// ---- Tenders (§3 F8 Pembayaran, F10/F10a) ---------------------------------

/**
 * POS tender methods. `voucher` is not here: a voucher is a discount line
 * applied before the total (like the QR quote), so every captured tender lands
 * in an accounting bucket. E-wallet is paid through QRIS in Legend (PRD §7).
 */
export const POS_TENDER_METHODS = [
  "cash",
  "qris",
  "va",
  "ewallet",
  "card",
  "edc_card",
  "edc_qris",
  "points",
] as const;
export const posTenderMethodSchema = z.enum(POS_TENDER_METHODS);
export type PosTenderMethod = z.infer<typeof posTenderMethodSchema>;

export const TENDER_BUCKETS = ["cash", "gateway", "edc", "points"] as const;
export const tenderBucketSchema = z.enum(TENDER_BUCKETS);
export type TenderBucket = z.infer<typeof tenderBucketSchema>;

export const POS_TENDER_PROVIDERS = [
  "doit",
  "duitku",
  "edc",
  "manual",
] as const;
export const posTenderProviderSchema = z.enum(POS_TENDER_PROVIDERS);
export type PosTenderProvider = z.infer<typeof posTenderProviderSchema>;

export const posTenderStatusSchema = z.enum([
  "authorized",
  "captured",
  "failed",
  "voided",
]);
export type PosTenderStatus = z.infer<typeof posTenderStatusSchema>;

/**
 * Why the server voided a QRIS tender and refunded the money (event
 * `order.tender_voided`, payload `reason`). Only the reasons the cashier text
 * names; any other void reason is reported as null (generic text).
 */
export const POS_TENDER_VOID_REASONS = [
  "bill_below_tender",
  "business_day_closed",
  "refund_reserved",
  "edc_request_open",
] as const;
export const posTenderVoidReasonSchema = z.enum(POS_TENDER_VOID_REASONS);
export type PosTenderVoidReason = z.infer<typeof posTenderVoidReasonSchema>;

export const posTenderSchema = z
  .strictObject({
    id: posTenderIdSchema,
    ...scope,
    orderId: orderIdSchema,
    method: posTenderMethodSchema,
    provider: posTenderProviderSchema,
    /** WS-05 `payment_intents` row that holds the money for this tender. */
    paymentIntentId: uuidSchema.nullable(),
    /** Amount applied to the bill; never the amount handed over. */
    amountIdr: positiveIdr,
    /** Cash only: banknotes handed over and the change returned. */
    receivedIdr: nonnegativeIdr.nullable(),
    changeIdr: nonnegativeIdr.nullable(),
    /** EDC approval code / bank reference, or the gateway reference. */
    reference: z.string().min(1).max(100).nullable(),
    edcTransactionId: uuidSchema.nullable(),
    pointsUsed: z.number().int().positive().max(1_000_000).nullable(),
    status: posTenderStatusSchema,
    requestedAt: isoDateTimeSchema,
    resolvedAt: isoDateTimeSchema.nullable(),
    capturedBy: userIdSchema.nullable(),
    /** Supervisor PIN for the standalone EDC mode (§3.13 EDC). */
    approvedBy: userIdSchema.nullable(),
    /**
     * Order detail only: why a voided QRIS tender was voided (from its
     * `order.tender_voided` event). Null/absent when not voided, or when the
     * void reason has no dedicated cashier text.
     */
    voidReason: posTenderVoidReasonSchema.nullable().optional(),
  })
  .superRefine((tender, ctx) => {
    if (tender.method === "cash") {
      if (tender.receivedIdr === null || tender.changeIdr === null)
        ctx.addIssue({
          code: "custom",
          path: ["receivedIdr"],
          message: "A cash tender records received cash and change",
        });
      else {
        if (Number(tender.receivedIdr) < Number(tender.amountIdr))
          ctx.addIssue({
            code: "custom",
            path: ["receivedIdr"],
            message: "Received cash must cover the applied amount",
          });
        if (
          Number(tender.changeIdr) !==
          Number(tender.receivedIdr) - Number(tender.amountIdr)
        )
          ctx.addIssue({
            code: "custom",
            path: ["changeIdr"],
            message: "changeIdr must equal received - applied",
          });
      }
    } else if (tender.receivedIdr !== null || tender.changeIdr !== null)
      ctx.addIssue({
        code: "custom",
        path: ["receivedIdr"],
        message: "Only a cash tender records received cash and change",
      });
    if ((tender.method === "points") !== (tender.pointsUsed !== null))
      ctx.addIssue({
        code: "custom",
        path: ["pointsUsed"],
        message: "Only a points tender records the points spent",
      });
    if (tender.status !== "authorized" && tender.resolvedAt === null)
      ctx.addIssue({
        code: "custom",
        path: ["resolvedAt"],
        message: "A resolved tender records resolvedAt",
      });
    if (tender.status === "authorized" && tender.resolvedAt !== null)
      ctx.addIssue({
        code: "custom",
        path: ["resolvedAt"],
        message: "An authorized tender is not resolved yet",
      });
    if (
      tender.status === "captured" &&
      (tender.method === "edc_card" || tender.method === "edc_qris") &&
      tender.reference === null
    )
      ctx.addIssue({
        code: "custom",
        path: ["reference"],
        message: "A captured EDC tender records the bank reference",
      });
    // Online gateway methods are settled through a WS-05 payment intent, so a
    // captured one is never an unexplained rupiah.
    if (
      tender.status === "captured" &&
      (tender.method === "qris" ||
        tender.method === "va" ||
        tender.method === "ewallet" ||
        tender.method === "card") &&
      tender.paymentIntentId === null
    )
      ctx.addIssue({
        code: "custom",
        path: ["paymentIntentId"],
        message: "A captured gateway tender links its payment intent (WS-05)",
      });
  });
export type PosTender = z.infer<typeof posTenderSchema>;

// ---- Discounts (POS-02, F8) -----------------------------------------------

export const posDiscountSourceSchema = discountLineSchema.shape.source;
export const posDiscountKindSchema = z.enum(["percent", "amount"]);
export const discountReasonSchema = z.enum([
  "promo_engine",
  "member_benefit",
  "manager_goodwill",
  "staff_meal",
  "event",
  "complaint_recovery",
  "price_correction",
  "other",
]);
export type PosDiscountSource = z.infer<typeof posDiscountSourceSchema>;
export type PosDiscountKind = z.infer<typeof posDiscountKindSchema>;
export type DiscountReason = z.infer<typeof discountReasonSchema>;

export const posDiscountSchema = z
  .strictObject({
    id: posDiscountIdSchema,
    tenantId: tenantIdSchema,
    orderId: orderIdSchema,
    source: posDiscountSourceSchema,
    kind: posDiscountKindSchema,
    /** For `kind: "percent"`: the rate the cashier chose, e.g. 1000 = 10%. */
    percentBp: basisPointsSchema.nullable(),
    /** The amount the server applied; the receipt and `order.paid` read this. */
    amountIdr: positiveIdr,
    reason: discountReasonSchema,
    reasonNote: z.string().min(4).max(500).nullable(),
    appliedBy: userIdSchema,
    approvedBy: userIdSchema.nullable(),
    approvalRequestId: approvalRequestIdSchema.nullable(),
    overrideId: overrideIdSchema.nullable(),
    /** 936: the voucher or promo code entered; null for any other source. */
    voucherCode: z.string().min(1).max(40).nullable(),
    createdAt: isoDateTimeSchema,
  })
  .superRefine((discount, ctx) => {
    if ((discount.kind === "percent") !== (discount.percentBp !== null))
      ctx.addIssue({
        code: "custom",
        path: ["percentBp"],
        message: "Only a percent discount carries a rate",
      });
    if (discount.source === "manual" && discount.reasonNote === null)
      ctx.addIssue({
        code: "custom",
        path: ["reasonNote"],
        message: "A manual discount records its written reason (POS-02)",
      });
    if (discount.percentBp !== null && Number(discount.percentBp) === 0)
      ctx.addIssue({
        code: "custom",
        path: ["percentBp"],
        message: "A percent discount is above zero",
      });
  });
export type PosDiscount = z.infer<typeof posDiscountSchema>;

// Founder cap for the cashier discount approval threshold (W9). Defined in
// core/money.ts (a leaf module) so access/ and platform/ can share it without
// importing pos/ (circular import).
export {
  POS_DISCOUNT_APPROVAL_MAX_BP,
  capDiscountThresholdBp,
  posDiscountThresholdBpSchema,
} from "../core/money.ts";

/** Tenant setting behind POS-02 "diskon di atas ambang". */
export const posApprovalPolicySchema = z.strictObject({
  ...scope,
  /** Manual discounts above this share of the subtotal need approval. */
  discountThresholdBp: posDiscountThresholdBpSchema,
  /** Cash rounding increment (PRD F11 "aturan pembulatan"). */
  cashRoundingIncrementIdr: z.number().int().positive().max(1_000),
});
export type PosApprovalPolicy = z.infer<typeof posApprovalPolicySchema>;

// ---- Order corrections: void & refund (POS-02, POS-04) --------------------

/**
 * POS-04: a completed sale is corrected by a *linked* record, never by editing
 * or deleting the order. A void of an order that has not completed is the
 * `void` status transition above; this record applies to a final sale and
 * keeps the receipt number it was sold under (POS-06: "struk yang di-void tetap
 * tercatat dengan nomornya").
 */
export const posVoidSchema = z
  .strictObject({
    id: posVoidIdSchema,
    ...scope,
    /** The completed order being voided (stays `completed` with its lines). */
    orderId: orderIdSchema,
    receiptNumber: receiptNumberSchema,
    amountIdr: positiveIdr,
    reason: voidReasonSchema,
    reasonNote: z.string().min(4).max(500),
    requestedBy: userIdSchema,
    approvedBy: userIdSchema,
    approvalRequestId: approvalRequestIdSchema.nullable(),
    overrideId: overrideIdSchema.nullable(),
    voidedAt: isoDateTimeSchema,
  })
  .refine((row) => row.requestedBy !== row.approvedBy, {
    path: ["approvedBy"],
    message: "The approver is a different actor from the requester (§3.7)",
  })
  .refine((row) => row.overrideId !== null || row.approvalRequestId !== null, {
    path: ["overrideId"],
    message: "A void records the approval it consumed (POS-02)",
  });
export type PosVoid = z.infer<typeof posVoidSchema>;

/** POS-04: only a final sale can be voided or refunded by correction. */
export function assertCorrectionTargetsFinalOrder(
  order: Pick<PosOrder, "status">,
): void {
  if (order.status !== "completed")
    throw new PosError("CORRECTION_TARGET_NOT_FINAL");
}

export const posRefundLineSchema = z.strictObject({
  method: posTenderMethodSchema,
  amountIdr: positiveIdr,
  /** Gateway/EDC refund reference once the provider answered. */
  reference: z.string().min(1).max(100).nullable(),
  /**
   * legend-186 (8v2yl): the captured tender this line was returned through and
   * its WS-05 payment intent (null for cash/EDC), so a refund can be attributed
   * to one intent. Absent on rows written before per-tender allocation.
   */
  tenderId: posTenderIdSchema.optional(),
  paymentIntentId: uuidSchema.nullable().optional(),
});
export type PosRefundLine = z.infer<typeof posRefundLineSchema>;

/** One order item (and how many of it) a refund covers. */
export const posRefundItemSchema = z.strictObject({
  itemId: orderItemIdSchema,
  quantity: z.number().int().positive().max(999),
});
export type PosRefundItem = z.infer<typeof posRefundItemSchema>;

export const posRefundSchema = z
  .strictObject({
    id: posRefundIdSchema,
    ...scope,
    orderId: orderIdSchema,
    /** Rp0 only for a goods return with nothing to pay back (legend-wkl3). */
    amountIdr: nonnegativeIdr,
    reason: refundReasonSchema,
    reasonNote: z.string().min(4).max(500),
    /** Empty exactly when the refund pays Rp0. */
    lines: z.array(posRefundLineSchema),
    items: z.array(posRefundItemSchema),
    requestedBy: userIdSchema,
    approvedBy: userIdSchema,
    approvalRequestId: approvalRequestIdSchema.nullable(),
    overrideId: overrideIdSchema.nullable(),
    refundedAt: isoDateTimeSchema,
  })
  .superRefine((refund, ctx) => {
    const sum = refund.lines.reduce(
      (total, line) => total + Number(line.amountIdr),
      0,
    );
    if (sum !== Number(refund.amountIdr))
      ctx.addIssue({
        code: "custom",
        path: ["lines"],
        message: "Refund lines must sum to the refund amount",
      });
    if (refund.lines.length > 0 !== Number(refund.amountIdr) > 0)
      ctx.addIssue({
        code: "custom",
        path: ["lines"],
        message: "A paid refund has payment lines; a Rp0 return has none",
      });
    if (Number(refund.amountIdr) === 0 && refund.items.length === 0)
      ctx.addIssue({
        code: "custom",
        path: ["items"],
        message: "A Rp0 refund records the items returned (legend-wkl3)",
      });
    if (refund.requestedBy === refund.approvedBy)
      ctx.addIssue({
        code: "custom",
        path: ["approvedBy"],
        message: "The approver is a different actor from the requester (§3.7)",
      });
    if (refund.overrideId === null && refund.approvalRequestId === null)
      ctx.addIssue({
        code: "custom",
        path: ["overrideId"],
        message: "A refund records the approval it consumed (POS-02)",
      });
  });
export type PosRefund = z.infer<typeof posRefundSchema>;

// ---- Order events (§6.C order_events) -------------------------------------

/** Event names this contract appends to `order_events` (see events.ts). */
export const posOrderEventTypeSchema = z.enum([
  "order.submitted",
  "order.paid",
  "order.voided",
  "order.refunded",
  /**
   * A ticket or line was voided on the KDS (kitchen-only; the bill is
   * unchanged until a POS void). Payload: { ticketId, stationId,
   * orderItemIds, ticketCancelled, reason } (bead legend-4d5).
   */
  "order.kitchen_voided",
]);
export type PosOrderEventType = z.infer<typeof posOrderEventTypeSchema>;

export const posOrderEventSchema = z.strictObject({
  id: orderEventIdSchema,
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
  orderId: orderIdSchema,
  type: posOrderEventTypeSchema,
  /** JSON only, exactly as stored in `order_events.payload` (JSONB). */
  payload: z.json(),
  actorId: userIdSchema.nullable(),
  deviceId: uuidSchema.nullable(),
  /** Per-order sequence, so the edge can detect a gap (§5). */
  sequence: z.number().int().positive(),
  occurredAt: isoDateTimeSchema,
});
export type PosOrderEvent = z.infer<typeof posOrderEventSchema>;

// ---- Cashier shift (§6.C pos_shifts, POS-03) ------------------------------

export const POS_SHIFT_STATUSES = ["open", "closed"] as const;
export const posShiftStatusSchema = z.enum(POS_SHIFT_STATUSES);
export type PosShiftStatus = z.infer<typeof posShiftStatusSchema>;

export const posShiftShape = {
  id: posShiftIdSchema,
  ...scope,
  deviceId: uuidSchema,
  cashierId: userIdSchema,
  businessDate: businessDateSchema,
  status: posShiftStatusSchema,
  openedAt: isoDateTimeSchema,
  openingFloatIdr: nonnegativeIdr,
  /**
   * Server aggregates over the shift's captured/refunded cash tenders. Null
   * together with expectedIdr and varianceIdr in the blind view a caller
   * without the variance permission gets, open or closed (legend-4wrfd).
   */
  cashSalesIdr: nonnegativeIdr.nullable(),
  cashRefundsIdr: nonnegativeIdr.nullable(),
  cashInIdr: nonnegativeIdr.nullable(),
  cashOutIdr: nonnegativeIdr.nullable(),
  cashDropIdr: nonnegativeIdr.nullable(),
  /** Signed (legend-4wu4): cash out may exceed the drawer; the gap is a variance. */
  expectedIdr: idrSchema.nullable(),
  countedIdr: nonnegativeIdr.nullable(),
  /** counted − expected: negative is short, positive is over. */
  varianceIdr: idrSchema.nullable(),
  varianceNote: z.string().min(4).max(500).nullable(),
  approvedBy: userIdSchema.nullable(),
  approvalRequestId: storedApprovalIdSchema.nullable(),
  approvedAt: isoDateTimeSchema.nullable(),
  closedAt: isoDateTimeSchema.nullable(),
  /** The count submission the close used (`pos_shift_counts`). */
  countId: posShiftCountIdSchema.nullable(),
};

/** The drawer figures the blind view hides (legend-4wrfd). */
export const POS_SHIFT_BLIND_FIELDS = [
  "cashSalesIdr",
  "cashRefundsIdr",
  "cashInIdr",
  "cashOutIdr",
  "cashDropIdr",
  "expectedIdr",
  "varianceIdr",
] as const;

export const posShiftSchema = z
  .strictObject(posShiftShape)
  .superRefine((shift, ctx) => {
    // Blind view: the drawer breakdown, expected and variance are null
    // together; a partly hidden shift would leak the rest by subtraction.
    const blind = shift.cashSalesIdr === null;
    for (const key of POS_SHIFT_BLIND_FIELDS)
      if (
        (blind && shift[key] !== null) ||
        (!blind &&
          key !== "expectedIdr" &&
          key !== "varianceIdr" &&
          shift[key] === null)
      ) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "The blind view hides all drawer figures together",
        });
        return;
      }
    if (shift.status === "open") {
      for (const key of [
        "countedIdr",
        "expectedIdr",
        "varianceIdr",
        "approvedBy",
        "approvalRequestId",
        "approvedAt",
        "closedAt",
        "countId",
      ] as const)
        if (shift[key] !== null)
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: "An open shift has no close figures",
          });
      return;
    }
    if (
      shift.closedAt === null ||
      shift.countedIdr === null ||
      (!blind && (shift.expectedIdr === null || shift.varianceIdr === null)) ||
      shift.approvedBy === null ||
      shift.approvalRequestId === null ||
      shift.approvedAt === null ||
      shift.countId === null
    )
      ctx.addIssue({
        code: "custom",
        path: ["closedAt"],
        message:
          "A closed shift records count, expectation, variance and supervisor approval (POS-03)",
      });
    else if (
      shift.cashSalesIdr !== null &&
      shift.cashRefundsIdr !== null &&
      shift.cashInIdr !== null &&
      shift.cashOutIdr !== null &&
      shift.cashDropIdr !== null &&
      shift.expectedIdr !== null &&
      shift.varianceIdr !== null
    ) {
      const expected = shiftExpectedCashIdr({
        ...shift,
        cashSalesIdr: shift.cashSalesIdr,
        cashRefundsIdr: shift.cashRefundsIdr,
        cashInIdr: shift.cashInIdr,
        cashOutIdr: shift.cashOutIdr,
        cashDropIdr: shift.cashDropIdr,
      });
      if (Number(shift.expectedIdr) !== Number(expected))
        ctx.addIssue({
          code: "custom",
          path: ["expectedIdr"],
          message:
            "expectedIdr must equal float + cash sales − cash refunds + in − out − drops",
        });
      if (
        Number(shift.varianceIdr) !==
        Number(shiftVarianceIdr(shift.countedIdr, shift.expectedIdr))
      )
        ctx.addIssue({
          code: "custom",
          path: ["varianceIdr"],
          message: "varianceIdr must equal counted − expected",
        });
      // The U9 note rule is not checked here (legend-utqr): it applies to
      // counted − expected + held cash, and held cash is supervisor-only, so
      // this cashier-readable DTO cannot carry it. closeShift (calculations),
      // the pos_shifts_closed_check constraint and the cashier_shift.closed
      // payload refine enforce it.
    }
  });
export type PosShift = z.infer<typeof posShiftSchema>;
/** Full (supervisor and internal) shift: the drawer breakdown is present. */
export type PosShiftWithFigures = PosShift & {
  [
    K in Exclude<
      (typeof POS_SHIFT_BLIND_FIELDS)[number],
      "expectedIdr" | "varianceIdr"
    >
  ]: NonNullable<PosShift[K]>;
};

/**
 * Rupiah notes and coins in circulation (Bank Indonesia); the blind count is
 * entered per denomination from this list (founder Q8, 2026-11-08).
 */
export const IDR_CASH_DENOMINATIONS = [
  100_000, 50_000, 20_000, 10_000, 5_000, 2_000, 1_000, 500, 200, 100,
] as const;

/** One denomination line of the blind count sheet. */
export const blindCashCountSchema = z.strictObject({
  denominationIdr: z
    .number()
    .refine(
      (value) => (IDR_CASH_DENOMINATIONS as readonly number[]).includes(value),
      {
        message: `denominationIdr must be one of ${IDR_CASH_DENOMINATIONS.join(", ")}`,
      },
    ),
  quantity: z.number().int().min(0).max(10_000),
});
export type BlindCashCount = z.infer<typeof blindCashCountSchema>;

/** The blind count sheet: listed denominations, each at most once, 1..10 rows. */
export const blindCountsSchema = z
  .array(blindCashCountSchema)
  .min(1)
  .max(IDR_CASH_DENOMINATIONS.length)
  .refine(
    (counts) =>
      new Set(counts.map((row) => row.denominationIdr)).size === counts.length,
    { message: "Each denomination can be counted only once" },
  );

/**
 * POS-03 blind count submission. It deliberately has **no** expected, counted
 * or variance field: the cashier counts notes and coins, and the server derives
 * the total (strict parsing rejects a submitted system number). Every
 * submission is stored append-only (`pos_shift_counts`); the close later
 * names the submission it uses.
 */
export const submitPosShiftCountInputSchema = clientInputSchema({
  counts: blindCountsSchema,
  idempotencyKey: idempotencyKeySchema,
});

/** Supervisor view of one stored count submission (full figures). */
export const posShiftCountSchema = z.strictObject({
  id: posShiftCountIdSchema,
  ...scope,
  shiftId: posShiftIdSchema,
  /** 1, 2, 3 … per shift; a recount is a new row, never an edit. */
  sequence: z.number().int().positive(),
  counts: blindCountsSchema,
  countedIdr: nonnegativeIdr,
  /** Signed (legend-4wu4): cash out may exceed the drawer; the gap is a variance. */
  expectedIdr: idrSchema,
  /** counted − expected: negative is short, positive is over. */
  varianceIdr: idrSchema,
  /**
   * Cash outs / drops held for review at count time (left out of expectedIdr).
   * Supervisor trail only; the cashier receipt never carries it.
   */
  heldCashOutIdr: nonnegativeIdr,
  submittedBy: userIdSchema,
  submittedAt: isoDateTimeSchema,
});
export type PosShiftCount = z.infer<typeof posShiftCountSchema>;

/**
 * Cashier view of the same submission: blind. It carries the counted total the
 * cashier typed but never the expected figure or the variance, only whether a
 * written note is required before the close.
 */
export const posShiftCountReceiptSchema = z.strictObject({
  id: posShiftCountIdSchema,
  shiftId: posShiftIdSchema,
  sequence: z.number().int().positive(),
  countedIdr: nonnegativeIdr,
  noteRequired: z.boolean(),
  submittedAt: isoDateTimeSchema,
});
export type PosShiftCountReceipt = z.infer<typeof posShiftCountReceiptSchema>;

/**
 * POS-03 close: names the stored count submission it closes with. The server
 * derives expected and variance, and re-checks the supervisor approval
 * (§3.7, action type `cash_shift_close`) against that variance; the id alone is
 * not proof.
 */
export const closePosShiftInputSchema = clientInputSchema({
  countId: posShiftCountIdSchema,
  varianceNote: z.string().min(4).max(500).nullable().optional(),
  approvedBy: userIdSchema,
  approvalRequestId: closeApprovalIdSchema,
  idempotencyKey: idempotencyKeySchema,
  /**
   * O3 (legend-wasr7.7, CTO O2 (a)): how many offline sales the tablet still
   * queues. Above zero the close is refused (OFFLINE_QUEUE_PENDING): their
   * cash is in the drawer but not yet in the shift's figures. Absent from an
   * older client; the tablet's own guard refuses first.
   */
  offlineQueuePending: z.number().int().nonnegative().max(1_000_000).optional(),
});

/**
 * U9 force close (legend-6c0 review K), step two. Step one is a normal
 * `POST .../counts` by a supervisor who is not the shift's cashier: it stores a
 * forced count (the server derives the figures). The witness (`approvedBy`:
 * neither the caller nor the cashier, holding `shift.cash.approve_close`)
 * approves that count through the usual `cash_shift_close` override, then this
 * closes the shift with it. `note` is the supervisor's written reason.
 */
export const forceClosePosShiftInputSchema = clientInputSchema({
  countId: posShiftCountIdSchema,
  note: z.string().trim().min(10).max(500),
  approvedBy: userIdSchema,
  approvalRequestId: closeApprovalIdSchema,
  idempotencyKey: idempotencyKeySchema,
});

export const openPosShiftInputSchema = clientInputSchema({
  openingFloatIdr: nonnegativeIdr,
  /**
   * 1271 F3: required for (and only for) a failover shift in the cloud: the
   * blind drawer count at switchover (C1). Its total is the opening float and
   * the forced count of the interrupted edge shift.
   */
  openingCounts: blindCountsSchema.optional(),
  idempotencyKey: idempotencyKeySchema,
});

// ---- Cash movements (§6.C cash_movements) ---------------------------------

export const CASH_MOVEMENT_TYPES = ["cash_in", "cash_out", "drop"] as const;
export const cashMovementTypeSchema = z.enum(CASH_MOVEMENT_TYPES);
export type CashMovementType = z.infer<typeof cashMovementTypeSchema>;

export const posCashMovementSchema = z.strictObject({
  id: cashMovementIdSchema,
  ...scope,
  shiftId: posShiftIdSchema,
  type: cashMovementTypeSchema,
  amountIdr: positiveIdr,
  /** "kas masuk dan keluar dengan alasan" (§3 F8 Shift Kasir). */
  reasonNote: z.string().min(4).max(500),
  recordedBy: userIdSchema,
  recordedAt: isoDateTimeSchema,
  approvedBy: userIdSchema.nullable(),
  /**
   * Held for supervisor review: larger than the expected drawer cash when
   * recorded. Set only for callers that see live figures (supervisor reads);
   * never in the record response or for the shift's own cashier.
   */
  needsApproval: z.boolean().optional(),
  /**
   * How a held movement was decided (approved, rejected or expired at close);
   * null while still pending. Sent together with `needsApproval`, so a held
   * list shows only `needsApproval && outcome === null`.
   */
  outcome: z.enum(["approved", "rejected", "expired"]).nullable().optional(),
});
export type PosCashMovement = z.infer<typeof posCashMovementSchema>;

/**
 * Receipt gaps of one run (prefix) of the device. `missing` are receipt
 * numbers (`P2-000003`) the device never delivered; `lostRange` (legend-yd0h8)
 * is the span of a run retired after the edge regressed that the edge reported
 * issuing but the cloud never received, null otherwise.
 */
export const posReceiptGapRunSchema = z.strictObject({
  prefix: receiptRunPrefixSchema,
  missing: z.array(receiptNumberSchema),
  /** legend-0hzqw: numbers the owner wrote off as lost; not in `missing`. */
  writtenOff: z.array(receiptNumberSchema),
  lostRange: z
    .strictObject({ from: receiptNumberSchema, to: receiptNumberSchema })
    .nullable(),
});
export type PosShiftReceiptGapRun = z.infer<typeof posReceiptGapRunSchema>;

/** Shift screen: the shift, its cash movements and the device's receipt gaps. */
export const posShiftReportSchema = z.strictObject({
  shift: posShiftSchema,
  movements: z.array(posCashMovementSchema),
  /**
   * POS-06: receipt numbers the device has not delivered, per run (prefix).
   * No run with `missing` means the day may be closed (a lost range does not
   * block); the API recomputes this at close, the screen only explains it.
   */
  receiptGaps: z.array(posReceiptGapRunSchema),
});
export type PosShiftReport = z.infer<typeof posShiftReportSchema>;

export const recordCashMovementInputSchema = clientInputSchema({
  type: cashMovementTypeSchema,
  amountIdr: positiveIdr,
  // Code points, as the database check counts them ("😀😀" is 2, not 4).
  reasonNote: z
    .string()
    .trim()
    .min(4)
    .max(500)
    .refine((value) => Array.from(value).length >= 4, {
      message: "Reason needs at least 4 characters",
    }),
  idempotencyKey: idempotencyKeySchema,
});

/** A supervisor approves or rejects a held cash out or drop (legend-3l4q). */
export const decidePosCashMovementInputSchema = z.strictObject({
  decision: z.enum(["approved", "rejected"]),
});

export const posCashMovementDecisionSchema = z.strictObject({
  movementId: cashMovementIdSchema,
  outcome: z.enum(["approved", "rejected"]),
  decidedBy: userIdSchema,
  decidedAt: isoDateTimeSchema,
});
export type PosCashMovementDecision = z.infer<
  typeof posCashMovementDecisionSchema
>;

// ---- End of day (F8 "Tutup Hari") -----------------------------------------

const endOfDayDeviceRecapShape = z.strictObject({
  deviceId: uuidSchema,
  orderCount: z.number().int().nonnegative(),
  grossSalesIdr: nonnegativeIdr,
  discountIdr: nonnegativeIdr,
  serviceChargeIdr: nonnegativeIdr,
  taxIdr: nonnegativeIdr,
  roundingIdr: idrSchema,
  /** Sum of the orders that stand: gross − discount + service + tax + rounding. */
  totalIdr: nonnegativeIdr,
  voidedOrderCount: z.number().int().nonnegative(),
  voidedAmountIdr: nonnegativeIdr,
  refundCount: z.number().int().nonnegative(),
  refundAmountIdr: nonnegativeIdr,
  shiftCount: z.number().int().nonnegative(),
  cashVarianceIdr: idrSchema,
  /**
   * Held cash outs / drops of the day's shifts that expired at their shift
   * close (legend-y9bf): never disbursed, never booked. 0 on recaps frozen
   * before it.
   */
  expiredCashOutIdr: nonnegativeIdr.default(idr(0)),
  /**
   * legend-vet9d: deposit (DP) that funded the day's sales. DP is a liability,
   * never a tender: it sits beside the tender rows, so the drawer's expected
   * cash is unchanged. 0 on recaps frozen before this field existed.
   */
  depositAppliedIdr: nonnegativeIdr.default(idr(0)),
  /**
   * legend-vet9d: deposit paid back by refunds made on the business day (the
   * refund's own date), on top of the tender part in refundAmountIdr.
   */
  depositRefundedIdr: nonnegativeIdr.default(idr(0)),
  closed: z.boolean(),
});

const depositWithinTotal = (device: {
  depositAppliedIdr: unknown;
  totalIdr: unknown;
}) => Number(device.depositAppliedIdr) <= Number(device.totalIdr);
const depositWithinTotalIssue = {
  path: ["depositAppliedIdr"],
  message: "depositAppliedIdr cannot exceed the device total",
};

export const endOfDayDeviceRecapSchema = endOfDayDeviceRecapShape.refine(
  depositWithinTotal,
  depositWithinTotalIssue,
);
export type EndOfDayDeviceRecap = z.infer<typeof endOfDayDeviceRecapSchema>;

export const endOfDayTenderRowSchema = z
  .strictObject({
    method: posTenderMethodSchema,
    capturedIdr: nonnegativeIdr,
    /** Refunds and voided paid sales paid back through this method. */
    refundedIdr: nonnegativeIdr,
    netIdr: idrSchema,
  })
  .refine(
    (row) =>
      Number(row.netIdr) === Number(row.capturedIdr) - Number(row.refundedIdr),
    { path: ["netIdr"], message: "netIdr must equal captured − refunded" },
  );
export type EndOfDayTenderRow = z.infer<typeof endOfDayTenderRowSchema>;

export const endOfDayChannelRowSchema = z.strictObject({
  channel: orderChannelSchema,
  orderCount: z.number().int().nonnegative(),
  totalIdr: nonnegativeIdr,
});
export type EndOfDayChannelRow = z.infer<typeof endOfDayChannelRowSchema>;

/**
 * X2 (legend-wasr7.11): EDC per terminal on the Tutup Hari recap. The day's
 * captured EDC tenders against the bank settlement CSV lines matched to them.
 * Computed on every read (the bank file comes H+1, after the day closed), so
 * it is never part of the frozen recap; the blind view never carries it.
 */
export const endOfDayEdcBankStatusSchema = z.enum([
  "awaiting",
  "matched",
  "mismatch",
  "no_match",
]);
export type EndOfDayEdcBankStatus = z.infer<typeof endOfDayEdcBankStatusSchema>;

export const endOfDayEdcTerminalRowSchema = z
  .strictObject({
    terminalId: uuidSchema,
    terminalCode: z.string().min(1).max(64),
    bank: edcBankSchema,
    /** Captured EDC tenders of the day's completed sales on this terminal. */
    receiptIdr: nonnegativeIdr,
    receiptCount: z.number().int().nonnegative(),
    /** Of those: confirmed by a matched bank settlement line. */
    settledIdr: nonnegativeIdr,
    settledCount: z.number().int().nonnegative(),
    /** Of those: still "perlu dicek" (e.g. a manual slip not yet matched). */
    flaggedCount: z.number().int().nonnegative(),
    /** Bank lines naming one of these sales with another amount or terminal. */
    mismatchCount: z.number().int().nonnegative(),
    /**
     * Receipts minus the bank-confirmed part, computed by the service: the
     * screens show it and never subtract money themselves.
     */
    differenceIdr: nonnegativeIdr,
    /**
     * Where the bank file stands for this terminal. `awaiting`: no file that
     * names the terminal was uploaded after its sales. `matched`: the bank
     * confirmed at least one sale (the difference is the rest). `mismatch`:
     * a bank line names a sale with another amount or terminal. `no_match`:
     * a file naming the terminal was uploaded but confirmed none of its sales.
     */
    bankStatus: endOfDayEdcBankStatusSchema,
  })
  .refine(
    (row) =>
      Number(row.settledIdr) <= Number(row.receiptIdr) &&
      row.settledCount <= row.receiptCount &&
      row.flaggedCount <= row.receiptCount,
    { message: "settled and flagged are part of the receipts" },
  )
  .refine(
    (row) =>
      Number(row.differenceIdr) ===
      Number(row.receiptIdr) - Number(row.settledIdr),
    { message: "the difference is the receipts minus the settled part" },
  )
  .refine(
    (row) =>
      row.bankStatus === "mismatch"
        ? row.mismatchCount > 0
        : row.bankStatus === "matched"
          ? row.mismatchCount === 0 && row.settledCount > 0
          : row.mismatchCount === 0 && row.settledCount === 0,
    { message: "the bank status follows the settled and mismatch counts" },
  );
export type EndOfDayEdcTerminalRow = z.infer<
  typeof endOfDayEdcTerminalRowSchema
>;

export const endOfDayRecapSchema = z
  .strictObject({
    id: dailyCloseIdSchema,
    ...scope,
    businessDate: businessDateSchema,
    status: z.enum(["open", "closed"]),
    generatedAt: isoDateTimeSchema,
    closedAt: isoDateTimeSchema.nullable(),
    closedBy: userIdSchema.nullable(),
    devices: z.array(endOfDayDeviceRecapSchema).min(1),
    tenders: z.array(endOfDayTenderRowSchema).min(1),
    channels: z.array(endOfDayChannelRowSchema).min(1),
    totalSalesIdr: nonnegativeIdr,
    totalRefundsIdr: nonnegativeIdr,
    totalVoidsIdr: nonnegativeIdr,
    totalVarianceIdr: idrSchema,
    /** Sum of the device expiredCashOutIdr (legend-y9bf). */
    totalExpiredCashOutIdr: nonnegativeIdr.default(idr(0)),
    /** Sum of the device depositAppliedIdr (legend-vet9d). */
    totalDepositAppliedIdr: nonnegativeIdr.default(idr(0)),
    /** Sum of the device depositRefundedIdr (legend-vet9d). */
    totalDepositRefundedIdr: nonnegativeIdr.default(idr(0)),
    /** F8: "pemotongan stok akhir hari bila dipilih". */
    inventoryDeductionApplied: z.boolean(),
    /**
     * legend-21c8n: receipt numbers the cloud sequence head says were issued
     * but pos_receipts lacks (the RECEIPT_SEQUENCE_GAP numbers, outlet-wide).
     * 0 on a gap-free day and on recaps frozen before this field existed.
     */
    unsyncedReceiptCount: z.number().int().nonnegative().default(0),
    accountingSync: z.strictObject({
      status: z.enum(["pending", "posted"]),
      journalCount: z.number().int().nonnegative(),
      postedAt: isoDateTimeSchema.nullable(),
    }),
    /** X2: EDC per terminal, live on read only (see the row schema). */
    edcSettlement: z.array(endOfDayEdcTerminalRowSchema).optional(),
  })
  .superRefine((recap, ctx) => {
    for (const device of recap.devices) {
      const expected =
        Number(device.grossSalesIdr) -
        Number(device.discountIdr) +
        Number(device.serviceChargeIdr) +
        Number(device.taxIdr) +
        Number(device.roundingIdr);
      if (Number(device.totalIdr) !== expected)
        ctx.addIssue({
          code: "custom",
          path: ["devices"],
          message:
            "A device total must equal gross − discount + service + tax + rounding",
        });
    }
    const sales = recap.devices.reduce(
      (sum, device) => sum + Number(device.totalIdr),
      0,
    );
    if (Number(recap.totalSalesIdr) !== sales)
      ctx.addIssue({
        code: "custom",
        path: ["totalSalesIdr"],
        message: "totalSalesIdr must equal the device totals",
      });
    const refunds = recap.devices.reduce(
      (sum, device) => sum + Number(device.refundAmountIdr),
      0,
    );
    if (Number(recap.totalRefundsIdr) !== refunds)
      ctx.addIssue({
        code: "custom",
        path: ["totalRefundsIdr"],
        message: "totalRefundsIdr must equal the device refunds",
      });
    const voids = recap.devices.reduce(
      (sum, device) => sum + Number(device.voidedAmountIdr),
      0,
    );
    if (Number(recap.totalVoidsIdr) !== voids)
      ctx.addIssue({
        code: "custom",
        path: ["totalVoidsIdr"],
        message: "totalVoidsIdr must equal the device voided sales",
      });
    const variances = recap.devices.reduce(
      (sum, device) => sum + Number(device.cashVarianceIdr),
      0,
    );
    if (Number(recap.totalVarianceIdr) !== variances)
      ctx.addIssue({
        code: "custom",
        path: ["totalVarianceIdr"],
        message: "totalVarianceIdr must equal the device variances",
      });
    const expired = recap.devices.reduce(
      (sum, device) => sum + Number(device.expiredCashOutIdr),
      0,
    );
    if (Number(recap.totalExpiredCashOutIdr) !== expired)
      ctx.addIssue({
        code: "custom",
        path: ["totalExpiredCashOutIdr"],
        message:
          "totalExpiredCashOutIdr must equal the device expired cash outs",
      });
    const depositApplied = recap.devices.reduce(
      (sum, device) => sum + Number(device.depositAppliedIdr),
      0,
    );
    if (Number(recap.totalDepositAppliedIdr) !== depositApplied)
      ctx.addIssue({
        code: "custom",
        path: ["totalDepositAppliedIdr"],
        message:
          "totalDepositAppliedIdr must equal the device deposits applied",
      });
    const depositRefunded = recap.devices.reduce(
      (sum, device) => sum + Number(device.depositRefundedIdr),
      0,
    );
    if (Number(recap.totalDepositRefundedIdr) !== depositRefunded)
      ctx.addIssue({
        code: "custom",
        path: ["totalDepositRefundedIdr"],
        message:
          "totalDepositRefundedIdr must equal the device deposits refunded",
      });
    const net = recap.tenders.reduce((sum, row) => sum + Number(row.netIdr), 0);
    const expectedNet =
      Number(recap.totalSalesIdr) -
      Number(recap.totalDepositAppliedIdr) -
      Number(recap.totalRefundsIdr) -
      Number(recap.totalVoidsIdr);
    if (net !== expectedNet)
      ctx.addIssue({
        code: "custom",
        path: ["tenders"],
        message:
          "Tender net must equal sales − deposit applied − refunds − voided paid sales (POS-05 identity at contract level)",
      });
    if (
      recap.status === "closed" &&
      (recap.closedAt === null || recap.closedBy === null)
    )
      ctx.addIssue({
        code: "custom",
        path: ["closedAt"],
        message: "A closed business day records who closed it and when",
      });
    if (
      recap.status === "open" &&
      (recap.closedAt !== null || recap.closedBy !== null)
    )
      ctx.addIssue({
        code: "custom",
        path: ["closedAt"],
        message: "An open business day is not closed yet",
      });
    if (
      (recap.accountingSync.status === "posted") !==
      (recap.accountingSync.postedAt !== null)
    )
      ctx.addIssue({
        code: "custom",
        path: ["accountingSync", "postedAt"],
        message: "A posted recap records postedAt",
      });
  });
export type EndOfDayRecap = z.infer<typeof endOfDayRecapSchema>;

/**
 * GET recap read by a caller below the outlet manager (no `pos.day.close`)
 * who holds a shift on that business day (legend-awg5p, POS-03 blind rule).
 * The drawer figures of their own shift are blank, before and after the
 * close: the cash variance and expired cash outs of every device they ran a
 * shift on, the outlet totals that sum them, and the captured / refunded / net
 * per method (on a one-device outlet those are their own cash sales and cash
 * paid back). A device row is blank whole: both fields null together.
 */
export const endOfDayBlindDeviceRecapSchema = endOfDayDeviceRecapShape
  .extend({
    cashVarianceIdr: idrSchema.nullable(),
    expiredCashOutIdr: nonnegativeIdr.nullable(),
  })
  .refine(depositWithinTotal, depositWithinTotalIssue);
export type EndOfDayBlindDeviceRecap = z.infer<
  typeof endOfDayBlindDeviceRecapSchema
>;

export const endOfDayBlindTenderRowSchema = z.strictObject({
  method: posTenderMethodSchema,
  capturedIdr: z.null(),
  refundedIdr: z.null(),
  netIdr: z.null(),
});
export type EndOfDayBlindTenderRow = z.infer<
  typeof endOfDayBlindTenderRowSchema
>;

export const endOfDayBlindRecapSchema = z
  .strictObject({
    id: dailyCloseIdSchema,
    ...scope,
    businessDate: businessDateSchema,
    status: z.enum(["open", "closed"]),
    generatedAt: isoDateTimeSchema,
    closedAt: isoDateTimeSchema.nullable(),
    closedBy: userIdSchema.nullable(),
    devices: z.array(endOfDayBlindDeviceRecapSchema).min(1),
    tenders: z.array(endOfDayBlindTenderRowSchema).min(1),
    channels: z.array(endOfDayChannelRowSchema).min(1),
    totalSalesIdr: nonnegativeIdr,
    totalRefundsIdr: nonnegativeIdr,
    totalVoidsIdr: nonnegativeIdr,
    totalVarianceIdr: z.null(),
    totalExpiredCashOutIdr: z.null(),
    /** Deposit figures are not drawer figures: they stay visible (legend-vet9d). */
    totalDepositAppliedIdr: nonnegativeIdr.default(idr(0)),
    totalDepositRefundedIdr: nonnegativeIdr.default(idr(0)),
    inventoryDeductionApplied: z.boolean(),
    /** Same count as the full recap (legend-21c8n); not a drawer figure. */
    unsyncedReceiptCount: z.number().int().nonnegative().default(0),
    accountingSync: z.strictObject({
      status: z.enum(["pending", "posted"]),
      journalCount: z.number().int().nonnegative(),
      postedAt: isoDateTimeSchema.nullable(),
    }),
    /** Marks the blind view; a full recap has no such field. */
    drawerFiguresHidden: z.literal(true),
  })
  .superRefine((recap, ctx) => {
    // Every method exactly once: the set of methods used would leak the
    // cash net on a one-device, cash-only day.
    const methods = recap.tenders.map((row) => row.method);
    if (
      methods.length !== POS_TENDER_METHODS.length ||
      POS_TENDER_METHODS.some((method) => !methods.includes(method))
    )
      ctx.addIssue({
        code: "custom",
        path: ["tenders"],
        message: "A blind recap lists every tender method once",
      });
    let blankDevices = 0;
    for (const device of recap.devices) {
      if (
        (device.cashVarianceIdr === null) !==
        (device.expiredCashOutIdr === null)
      )
        ctx.addIssue({
          code: "custom",
          path: ["devices"],
          message: "A blind device row hides its drawer figures together",
        });
      if (device.cashVarianceIdr === null) blankDevices += 1;
    }
    if (blankDevices === 0)
      ctx.addIssue({
        code: "custom",
        path: ["devices"],
        message: "A blind recap blanks the caller's own device",
      });
    const total = (pick: (d: EndOfDayBlindDeviceRecap) => unknown) =>
      recap.devices.reduce((sum, device) => sum + Number(pick(device)), 0);
    if (Number(recap.totalSalesIdr) !== total((d) => d.totalIdr))
      ctx.addIssue({
        code: "custom",
        path: ["totalSalesIdr"],
        message: "totalSalesIdr must equal the device totals",
      });
    if (Number(recap.totalRefundsIdr) !== total((d) => d.refundAmountIdr))
      ctx.addIssue({
        code: "custom",
        path: ["totalRefundsIdr"],
        message: "totalRefundsIdr must equal the device refunds",
      });
    if (Number(recap.totalVoidsIdr) !== total((d) => d.voidedAmountIdr))
      ctx.addIssue({
        code: "custom",
        path: ["totalVoidsIdr"],
        message: "totalVoidsIdr must equal the device voided sales",
      });
    if (
      Number(recap.totalDepositAppliedIdr) !== total((d) => d.depositAppliedIdr)
    )
      ctx.addIssue({
        code: "custom",
        path: ["totalDepositAppliedIdr"],
        message:
          "totalDepositAppliedIdr must equal the device deposits applied",
      });
    if (
      Number(recap.totalDepositRefundedIdr) !==
      total((d) => d.depositRefundedIdr)
    )
      ctx.addIssue({
        code: "custom",
        path: ["totalDepositRefundedIdr"],
        message:
          "totalDepositRefundedIdr must equal the device deposits refunded",
      });
    if ((recap.status === "closed") !== (recap.closedAt !== null))
      ctx.addIssue({
        code: "custom",
        path: ["closedAt"],
        message: "closedAt is set exactly when the business day is closed",
      });
    if ((recap.closedAt === null) !== (recap.closedBy === null))
      ctx.addIssue({
        code: "custom",
        path: ["closedBy"],
        message: "closedAt and closedBy are set together",
      });
  });
export type EndOfDayBlindRecap = z.infer<typeof endOfDayBlindRecapSchema>;

/** GET /pos/day response: the full recap, or the blind one (legend-awg5p). */
export const endOfDayRecapViewSchema = z.union([
  endOfDayRecapSchema,
  endOfDayBlindRecapSchema,
]);
export type EndOfDayRecapView = z.infer<typeof endOfDayRecapViewSchema>;

export const closeBusinessDayInputSchema = clientInputSchema({
  businessDate: businessDateSchema,
  inventoryDeduction: z.boolean(),
  idempotencyKey: idempotencyKeySchema,
});

// ---- Receipt sequences and receipts (POS-06) ------------------------------

/** §6 `receipt_sequences`: one gapless run per outlet and device. */
export const receiptSequenceSchema = z.strictObject({
  id: receiptSequenceIdSchema,
  ...scope,
  deviceId: uuidSchema,
  /** Printed before the ordinal: "prefiks perangkat diikuti nomor urut". */
  prefix: receiptRunPrefixSchema,
  lastNumber: z.number().int().min(0).max(999_999_999),
  updatedAt: isoDateTimeSchema,
});
export type ReceiptSequence = z.infer<typeof receiptSequenceSchema>;

export const posReceiptSchema = z
  .strictObject({
    id: posReceiptIdSchema,
    ...scope,
    orderId: orderIdSchema,
    deviceId: uuidSchema,
    /** The printed number; it stays on a voided receipt (POS-06). */
    number: receiptNumberSchema,
    sequenceNumber: z.number().int().positive().max(999_999_999),
    status: z.enum(["issued", "voided"]),
    issuedAt: isoDateTimeSchema,
    voidedAt: isoDateTimeSchema.nullable(),
    voidReason: voidReasonSchema.nullable(),
    voidedBy: userIdSchema.nullable(),
    reprintCount: z.number().int().nonnegative().max(99),
  })
  .superRefine((receipt, ctx) => {
    if (receipt.status === "voided") {
      if (
        receipt.voidedAt === null ||
        receipt.voidReason === null ||
        receipt.voidedBy === null
      )
        ctx.addIssue({
          code: "custom",
          path: ["voidedAt"],
          message: "A voided receipt records when, why and by whom (POS-06)",
        });
    } else if (
      receipt.voidedAt !== null ||
      receipt.voidReason !== null ||
      receipt.voidedBy !== null
    )
      ctx.addIssue({
        code: "custom",
        path: ["voidedAt"],
        message: "Only a voided receipt carries void metadata",
      });
  });
export type PosReceipt = z.infer<typeof posReceiptSchema>;

// ---- Cashier order detail ------------------------------------------------

/**
 * 936 (legend-hpgyw): one EDC request sent for this bill, newest first. A
 * declined or failed request is not a tender: the bill is unchanged and can
 * be paid again. `declineReason` is the terminal message, only when declined.
 */
export const posEdcAttemptSchema = z.strictObject({
  id: uuidSchema,
  status: edcTransactionStatusSchema,
  amountIdr: nonnegativeIdr,
  terminalId: uuidSchema,
  terminalLabel: z.string().nullable(),
  declineReason: z.string().nullable(),
  responseCode: z.string().nullable(),
  /** 936: the terminal's bank, so a refused request names it. */
  bank: edcBankSchema.nullable(),
  /** 936: how the customer paid on the terminal (card or QRIS). */
  method: edcMethodSchema.nullable(),
  /** 936: ECR (cashier app drives the terminal) or standalone. */
  mode: z.enum(["ecr", "standalone"]).nullable(),
  createdAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.nullable(),
});
export type PosEdcAttempt = z.infer<typeof posEdcAttemptSchema>;

/**
 * The order with its lines, tenders, discounts and receipt — what the cashier
 * screen and the payment panel render. It lives after the tender, discount and
 * receipt schemas because it embeds all three.
 */
export const posOrderDetailSchema = posOrderBaseSchema
  .extend({
    /** The immutable code already assigned to this order, or no pickup call. */
    callNumber: z.string().regex(PICKUP_CODE_PATTERN).nullable().default(null),
    items: z.array(posOrderItemSchema),
    tenders: z.array(posTenderSchema),
    discounts: z.array(posDiscountSchema),
    receipt: posReceiptSchema.nullable(),
    /** The latest 5 EDC requests of this bill, newest first (936). */
    edcAttempts: z.array(posEdcAttemptSchema).max(5).default([]),
    /**
     * legend-kxoyf: sale value of the counted (not voided) kitchen-swap
     * replacement lines. The swap leaves the order money frozen (the price
     * difference is settled outside the order), so these lines are taken back
     * out of the subtotal check. 0 for an order without a swap.
     */
    swapReplacementIdr: nonnegativeIdr.default(0 as Idr),
    /**
     * legend-kxoyf: sale value of the voided swapped-out lines. The frozen
     * subtotal still includes them, so they are added back into the subtotal
     * check. 0 for an order without a swap (and for a completed order, whose
     * old line stays live).
     */
    swapReplacedIdr: nonnegativeIdr.default(0 as Idr),
  })
  .superRefine((order, ctx) => {
    checkOrderMoney(order, ctx);
    for (const item of order.items)
      if (item.orderId !== order.id)
        ctx.addIssue({
          code: "custom",
          path: ["items"],
          message: "Every order item belongs to the order",
        });
    // A live order's subtotal follows its non-voided lines; a voided order's
    // totals are frozen history, so its own voided lines stay in the sum.
    const countedItems =
      order.status === "voided"
        ? order.items
        : order.items.filter((item) => item.status !== "voided");
    const counted = countedItems.reduce(
      (sum, item) => sum + Number(item.lineTotalIdr),
      0,
    );
    // The adjustments are not free numbers: they must equal what the lines
    // themselves say (swapRole), so they cannot hide a wrong subtotal. A voided
    // order counts every line and carries no adjustment.
    const roleSum = (role: "replacement" | "replaced", voided: boolean) =>
      order.items
        .filter(
          (item) =>
            item.swapRole === role && (item.status === "voided") === voided,
        )
        .reduce((sum, item) => sum + Number(item.lineTotalIdr), 0);
    const swapReplacement = Number(order.swapReplacementIdr);
    const swapReplaced = Number(order.swapReplacedIdr);
    const expectedReplacement =
      order.status === "voided" ? 0 : roleSum("replacement", false);
    const expectedReplaced =
      order.status === "voided" ? 0 : roleSum("replaced", true);
    if (swapReplacement !== expectedReplacement)
      ctx.addIssue({
        code: "custom",
        path: ["swapReplacementIdr"],
        message:
          "swapReplacementIdr must equal the sum of the live swap replacement lines",
      });
    if (swapReplaced !== expectedReplaced)
      ctx.addIssue({
        code: "custom",
        path: ["swapReplacedIdr"],
        message:
          "swapReplacedIdr must equal the sum of the voided swapped-out lines",
      });
    // A kitchen swap keeps the order money frozen: the replacement line is
    // taken back out and the voided swapped-out line is added back.
    const subtotal = counted - swapReplacement + swapReplaced;
    if (Number(order.subtotalIdr) !== subtotal)
      ctx.addIssue({
        code: "custom",
        path: ["subtotalIdr"],
        message:
          "subtotalIdr must equal the sum of the non-voided lines (all lines once the order is voided), less swap replacement lines plus swapped-out voided lines",
      });
    for (const tender of order.tenders)
      if (tender.orderId !== order.id)
        ctx.addIssue({
          code: "custom",
          path: ["tenders"],
          message: "Every tender belongs to the order",
        });
    for (const row of order.discounts)
      if (row.orderId !== order.id)
        ctx.addIssue({
          code: "custom",
          path: ["discounts"],
          message: "Every discount belongs to the order",
        });
    const discount = order.discounts.reduce(
      (sum, row) => sum + Number(row.amountIdr),
      0,
    );
    if (Number(order.discountIdr) !== discount)
      ctx.addIssue({
        code: "custom",
        path: ["discountIdr"],
        message: "discountIdr must equal the sum of the discount rows",
      });
    const captured = order.tenders.filter(
      (tender) => tender.status === "captured",
    );
    const paid = captured.reduce(
      (sum, tender) => sum + Number(tender.amountIdr),
      0,
    );
    // A split payment is still in progress until the last tender lands, so the
    // tenders must merely never exceed the bill; a completed sale is exact.
    // The bill the tenders settle is the total less the applied DP.
    const due = Number(order.totalIdr) - Number(order.depositAppliedIdr);
    if (captured.length > 0 && paid > due)
      ctx.addIssue({
        code: "custom",
        path: ["tenders"],
        message:
          "Captured tenders must not exceed the order total less the deposit",
      });
    if (order.status === "completed" && paid !== due)
      ctx.addIssue({
        code: "custom",
        path: ["tenders"],
        message: "A completed sale is paid in full",
      });
    if (order.status === "completed" && order.receipt === null)
      ctx.addIssue({
        code: "custom",
        path: ["receipt"],
        message: "A completed sale has a receipt number (POS-06)",
      });
    if (order.receipt !== null && order.receipt.orderId !== order.id)
      ctx.addIssue({
        code: "custom",
        path: ["receipt"],
        message: "The receipt belongs to the order",
      });
  });
export type PosOrderDetail = z.infer<typeof posOrderDetailSchema>;

/** What the payment panel receives back after adding one tender. */
export const posTenderResultSchema = z.strictObject({
  order: posOrderDetailSchema,
  tender: posTenderSchema,
  remainingIdr: nonnegativeIdr,
});
export type PosTenderResult = z.infer<typeof posTenderResultSchema>;

// ---- QRIS hold (legend-yhia9 D-01..D-04) -----------------------------------

export const posQrisHoldStateSchema = z.enum([
  "open",
  "cancelling",
  "paid",
  "closed",
]);
export type PosQrisHoldStateDto = z.infer<typeof posQrisHoldStateSchema>;

/**
 * The newest QRIS hold of a bill, as the cashier sees it. While `open` or
 * `cancelling` the bill's money is frozen; `cancelling` means the cashier hid
 * the QR and the provider has not yet proven it can no longer be paid.
 */
export const posQrisHoldSchema = z.strictObject({
  id: z.string().min(1),
  orderId: orderIdSchema,
  /** null for a guest split-bill QR (no POS tender). */
  tenderId: uuidSchema.nullable(),
  state: posQrisHoldStateSchema,
  amountIdr: positiveIdr,
  /** When the QR stops being payable at the provider. */
  expiresAt: isoDateTimeSchema.nullable(),
  cancelRequestedAt: isoDateTimeSchema.nullable(),
  lastCheckedAt: isoDateTimeSchema.nullable(),
  closeReason: z
    .enum([
      "provider_paid",
      "provider_expired",
      "provider_failed",
      "provider_cancelled",
      "force_released",
    ])
    .nullable(),
});
export type PosQrisHold = z.infer<typeof posQrisHoldSchema>;

/** 1269 C3a: what the cashier shows for a VA or e-wallet code. */
export const posOnlineCodeInstructionsSchema = z.discriminatedUnion("method", [
  vaPaymentInstructionsSchema,
  ewalletPaymentInstructionsSchema,
]);
export type PosOnlineCodeInstructions = z.infer<
  typeof posOnlineCodeInstructionsSchema
>;

/**
 * GET .../qris only (cancel and release never carry a payload). `qrPayload` is
 * set only while this QR may be shown for exactly this bill: hold `open` and
 * unexpired, the bill unchanged since issue, amount = remaining, and the
 * caller holds `pos.payment.accept`. Null means: show no QR.
 */
export const posQrisStatusSchema = posQrisHoldSchema.extend({
  qrPayload: z.string().min(16).nullable(),
  /**
   * 1269 C3a: a VA or e-wallet code of the hold (the VA number or the Duitku
   * payment page), under the same rules as `qrPayload`; null = show nothing.
   * Absent for a QRIS hold.
   */
  instructions: posOnlineCodeInstructionsSchema.nullable().optional(),
});
export type PosQrisStatus = z.infer<typeof posQrisStatusSchema>;

// ---- Payment options (1268 B2) ----------------------------------------------

/** The methods the payment panel lists; points has its own endpoint. */
export const POS_PAYMENT_OPTION_METHODS = [
  "cash",
  "qris",
  "va",
  "ewallet",
  "card",
  "edc_card",
  "edc_qris",
] as const satisfies readonly PosTenderMethod[];

export const posPaymentUnavailableReasonSchema = z.enum([
  "not_supported",
  "device_required",
  "routing_disabled",
  "gateway_down",
  "needs_cloud",
  "no_terminal",
]);
export type PosPaymentUnavailableReason = z.infer<
  typeof posPaymentUnavailableReasonSchema
>;

export const posPaymentOptionSchema = z
  .strictObject({
    method: z.enum(POS_PAYMENT_OPTION_METHODS),
    enabled: z.boolean(),
    unavailableReason: posPaymentUnavailableReasonSchema.nullable(),
    /** 1269 C3a: VA and e-wallet only, the channels the cashier may pick. */
    channels: z.array(paymentChannelSchema).optional(),
  })
  .refine((row) => row.enabled === (row.unavailableReason === null), {
    path: ["unavailableReason"],
    message: "A disabled method says why, an enabled one does not",
  })
  .refine(
    (row) =>
      row.channels === undefined ||
      ((row.method === "va" || row.method === "ewallet") &&
        (row.enabled ? row.channels.length > 0 : row.channels.length === 0)),
    {
      path: ["channels"],
      message:
        "Only VA and e-wallet list channels; an enabled one lists at least one",
    },
  );

/** What a cashier needs to pick a terminal: no merchant id, address or full id. */
export const posPaymentTerminalSchema = z.strictObject({
  id: uuidSchema,
  bankCode: edcBankSchema,
  model: z.string().min(1),
  terminalIdLast4: z.string().min(1).max(4),
  supportedMethods: z.array(z.enum(["card", "qris"])).min(1),
});

export const posPaymentOptionsSchema = z.strictObject({
  outletId: outletIdSchema,
  methods: z.array(posPaymentOptionSchema),
  edc: z.strictObject({
    /** False: EDC is keyed by hand (`standalone`) with a supervisor approval. */
    ecrEnabled: z.boolean(),
    /** Active terminals of this outlet only. */
    terminals: z.array(posPaymentTerminalSchema),
  }),
});
export type PosPaymentOptions = z.infer<typeof posPaymentOptionsSchema>;

/**
 * legend-adiov: a force released QRIS the system keeps asking the provider
 * about until it answers for good. Staff read the queue; there is no UI yet.
 */
export const posQrisReconciliationStatusSchema = z.enum(["open", "resolved"]);
export const posQrisReconciliationSchema = z.strictObject({
  id: z.string().min(1),
  outletId: z.string().min(1),
  holdId: z.string().min(1),
  paymentIntentId: uuidSchema,
  status: posQrisReconciliationStatusSchema,
  reason: z.string().min(1),
  attempts: z.number().int().min(0),
  nextCheckAt: isoDateTimeSchema,
  lastCheckedAt: isoDateTimeSchema.nullable(),
  lastProviderStatus: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  resolvedAt: isoDateTimeSchema.nullable(),
  resolution: z
    .enum(["paid_recorded", "provider_expired", "provider_failed"])
    .nullable(),
});
export type PosQrisReconciliation = z.infer<typeof posQrisReconciliationSchema>;

/**
 * legend-5wn1e: the written reason of a VA release, 3..300 characters counted
 * in code points (the database check uses char_length, not UTF-16 units).
 */
export const posVaReleaseReasonSchema = z
  .string()
  .trim()
  .refine((value) => {
    const length = [...value].length;
    return length >= 3 && length <= 300;
  }, "Alasan pelepasan wajib diisi (3 sampai 300 karakter).");

/** legend-5wn1e: a supervisor released a VA code without provider proof. */
export const posVaReleaseSchema = z.strictObject({
  id: z.string().min(1),
  outletId: z.string().min(1),
  orderId: z.string().min(1),
  paymentIntentId: uuidSchema,
  status: posQrisReconciliationStatusSchema,
  reason: posVaReleaseReasonSchema,
  releasedBy: z.string().min(1),
  approvedBy: z.string().min(1),
  attempts: z.number().int().min(0),
  nextCheckAt: isoDateTimeSchema,
  createdAt: isoDateTimeSchema,
  resolvedAt: isoDateTimeSchema.nullable(),
  resolution: z
    .enum(["paid_recorded", "provider_expired", "provider_failed"])
    .nullable(),
});
export type PosVaRelease = z.infer<typeof posVaReleaseSchema>;

// ---- Documents: receipt, kuitansi, invoice (POS-07, F43/F44) --------------

export const posDocumentLineSchema = z
  .strictObject({
    name,
    quantity: z.number().int().min(1).max(99),
    /** Positive, except a swap replacement on a completed order (swapRole). */
    unitPriceIdr: nonnegativeIdr,
    modifiersTotalIdr: nonnegativeIdr,
    lineTotalIdr: nonnegativeIdr,
    note: note.nullable(),
    /** legend-135b4: a kitchen-swap replacement line is recorded at zero. */
    swapRole: z.enum(["none", "replacement"]).default("none"),
  })
  .superRefine((line, ctx) => {
    if (Number(line.unitPriceIdr) <= 0 && line.swapRole !== "replacement")
      ctx.addIssue({
        code: "custom",
        path: ["unitPriceIdr"],
        message: "Amount must be positive",
      });
  });
export type PosDocumentLine = z.infer<typeof posDocumentLineSchema>;

export const posDocumentTenderSchema = z.strictObject({
  method: posTenderMethodSchema,
  amountIdr: positiveIdr,
  reference: z.string().min(1).max(100).nullable(),
});

/**
 * POS-07: "E-receipt dan kuitansi selalu memuat nama dan alamat outlet, rincian
 * item, pajak, dan metode pembayaran." D40 adds the outlet name/address. The
 * document is a printed/electronic snapshot: it carries the amounts of the
 * order at issue time and never recomputes them.
 */
const documentTotalsShape = {
  subtotalIdr: nonnegativeIdr,
  discountIdr: nonnegativeIdr,
  serviceChargeIdr: nonnegativeIdr,
  taxIdr: nonnegativeIdr,
  roundingIdr: idrSchema,
  totalIdr: nonnegativeIdr,
  /** legend-j772n: DP applied to the order; printed as DP, never as a tender. */
  depositAppliedIdr: nonnegativeIdr.default(idr(0)),
  /**
   * legend-npnh: inclusive prices. `subtotalIdr` then holds service and tax,
   * which the document shows as included. Absent (legacy) means exclusive.
   */
  pricesIncludeTax: z.boolean().default(false),
};

function checkDocumentTotals(
  document: {
    items: readonly { lineTotalIdr: Idr }[];
    discounts: readonly { amountIdr: Idr }[];
    serviceCharge: { amountIdr: Idr } | null;
    taxLines: readonly { amountIdr: Idr }[];
    tenders: readonly { amountIdr: Idr }[];
    depositAppliedIdr: Idr;
    subtotalIdr: Idr;
    discountIdr: Idr;
    serviceChargeIdr: Idr;
    taxIdr: Idr;
    roundingIdr: Idr;
    totalIdr: Idr;
    pricesIncludeTax: boolean;
  },
  ctx: z.RefinementCtx,
): void {
  const sum = (values: readonly Idr[]) =>
    values.reduce((total, value) => total + Number(value), 0);
  if (
    sum(document.items.map((line) => line.lineTotalIdr)) !==
    Number(document.subtotalIdr)
  )
    ctx.addIssue({
      code: "custom",
      path: ["subtotalIdr"],
      message: "subtotalIdr must equal the document lines",
    });
  if (
    sum(document.discounts.map((row) => row.amountIdr)) !==
    Number(document.discountIdr)
  )
    ctx.addIssue({
      code: "custom",
      path: ["discountIdr"],
      message: "discountIdr must equal the discount lines",
    });
  if (
    (document.serviceCharge === null
      ? 0
      : Number(document.serviceCharge.amountIdr)) !==
    Number(document.serviceChargeIdr)
  )
    ctx.addIssue({
      code: "custom",
      path: ["serviceChargeIdr"],
      message: "serviceChargeIdr must match the service charge line",
    });
  if (
    sum(document.taxLines.map((line) => line.amountIdr)) !==
    Number(document.taxIdr)
  )
    ctx.addIssue({
      code: "custom",
      path: ["taxIdr"],
      message: "taxIdr must equal the tax lines",
    });
  const netSubtotal =
    Number(document.subtotalIdr) - Number(document.discountIdr);
  if (document.pricesIncludeTax) {
    // Inclusive (as checkOrderMoney): service and tax sit inside the subtotal.
    if (
      Number(document.totalIdr) !==
      netSubtotal + Number(document.roundingIdr)
    )
      ctx.addIssue({
        code: "custom",
        path: ["totalIdr"],
        message: "inclusive totalIdr must equal subtotal - discount + rounding",
      });
    if (
      Number(document.serviceChargeIdr) + Number(document.taxIdr) >
      netSubtotal
    )
      ctx.addIssue({
        code: "custom",
        path: ["serviceChargeIdr"],
        message:
          "included service charge and tax cannot exceed the net subtotal",
      });
  } else {
    const total =
      netSubtotal +
      Number(document.serviceChargeIdr) +
      Number(document.taxIdr) +
      Number(document.roundingIdr);
    if (Number(document.totalIdr) !== total)
      ctx.addIssue({
        code: "custom",
        path: ["totalIdr"],
        message:
          "totalIdr must equal subtotal - discount + service + tax + rounding",
      });
  }
  // A document without any tender must be settled by DP (fail closed).
  if (document.tenders.length === 0 && Number(document.depositAppliedIdr) <= 0)
    ctx.addIssue({
      code: "custom",
      path: ["tenders"],
      message: "A document needs at least one tender or a DP bucket",
    });
  // DP is a prepaid bucket, not a tender: tenders plus DP must cover the total.
  if (Number(document.depositAppliedIdr) > Number(document.totalIdr))
    ctx.addIssue({
      code: "custom",
      path: ["depositAppliedIdr"],
      message: "depositAppliedIdr cannot exceed the total",
    });
  if (
    sum(document.tenders.map((row) => row.amountIdr)) +
      Number(document.depositAppliedIdr) !==
    Number(document.totalIdr)
  )
    ctx.addIssue({
      code: "custom",
      path: ["tenders"],
      message: "Tender methods plus DP must sum to the total (POS-07)",
    });
}

export const receiptDocumentBaseShape = {
  id: z.string().min(1).max(100),
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
  receiptNumber: receiptNumberSchema,
  orderNumber: orderNumber,
  documentKind: z.enum(["receipt", "kuitansi"]),
  status: z.enum(["issued", "voided"]),
  /** POS-06: true once the receipt has been printed again ("CETAK ULANG"). */
  reprint: z.boolean(),
  outletName: z.string().min(1).max(150),
  /** D40/POS-07: the address is printed on every receipt and kuitansi. */
  outletAddress: z.string().min(10).max(300),
  issuedAt: isoDateTimeSchema,
  items: z.array(posDocumentLineSchema).min(1),
  discounts: z.array(discountLineSchema),
  serviceCharge: serviceChargeLineSchema.nullable(),
  // Empty for a tax-free order: the receipt prints no tax rows.
  taxLines: z.array(taxLineSchema),
  ...documentTotalsShape,
  // legend-j772n: empty only for a DP-only sale (checkDocumentTotals enforces
  // that DP then covers the total); every other document keeps a tender.
  tenders: z.array(posDocumentTenderSchema),
  cashierName: z.string().min(1).max(150).nullable(),
  customerName: z.string().min(1).max(150).nullable(),
};

export const receiptDocumentSchema = z
  .strictObject(receiptDocumentBaseShape)
  .superRefine(checkDocumentTotals);
export type ReceiptDocument = z.infer<typeof receiptDocumentSchema>;

/**
 * F8 "Invoice dapat dibuat untuk event dan pemesanan korporat": the same
 * amounts as the receipt plus who is billed. The corporate tax number (NPWP)
 * is optional data, never required.
 */
export const invoiceDocumentSchema = z
  .strictObject({
    ...receiptDocumentBaseShape,
    receiptNumber: receiptNumberSchema,
    documentKind: z.literal("invoice"),
    billedTo: z.strictObject({
      name: z.string().min(1).max(150),
      address: z.string().min(10).max(300),
      npwp: z
        .string()
        .regex(/^\d{2}\.\d{3}\.\d{3}\.\d-\d{3}\.\d{3}$/)
        .nullable(),
    }),
    dueDate: businessDateSchema,
    paymentStatus: z.enum(["unpaid", "paid", "refunded"]),
    notes: z.string().min(4).max(500).nullable(),
  })
  .superRefine(checkDocumentTotals);
export type InvoiceDocument = z.infer<typeof invoiceDocumentSchema>;

/** Delivery of a document. WhatsApp is excluded on purpose: it costs money. */
export const RECEIPT_DELIVERY_CHANNELS = ["print", "link", "email"] as const;
export const receiptDeliveryChannelSchema = z.enum(RECEIPT_DELIVERY_CHANNELS);
export const receiptDeliveryStatusSchema = z.enum(["queued", "sent", "failed"]);

export const receiptDeliverySchema = z
  .strictObject({
    id: receiptDeliveryIdSchema,
    ...scope,
    receiptId: posReceiptIdSchema,
    channel: receiptDeliveryChannelSchema,
    status: receiptDeliveryStatusSchema,
    /** Masked destination only (`o***@example.com`); never the raw address. */
    destinationMasked: z.string().min(1).max(120).nullable(),
    sentAt: isoDateTimeSchema.nullable(),
    failureReason: z.string().min(1).max(200).nullable(),
  })
  .refine((row) => (row.status === "sent") === (row.sentAt !== null), {
    path: ["sentAt"],
    message: "sentAt is set exactly when the document was sent",
  })
  .refine((row) => row.status !== "failed" || row.failureReason !== null, {
    path: ["failureReason"],
    message: "A failed delivery records why",
  });
export type ReceiptDelivery = z.infer<typeof receiptDeliverySchema>;

/** E-receipt link, returned once: the token is not stored, only its hash. */
export const receiptLinkSchema = z.strictObject({
  receiptId: posReceiptIdSchema,
  url: z.string().min(1).max(500),
  expiresAt: isoDateTimeSchema,
});
export type ReceiptLink = z.infer<typeof receiptLinkSchema>;

/**
 * What happened to a requested print: the outlet's edge queued it on a printer,
 * or nothing was printed (cloud: offer the PDF). Never "printed": no printer
 * confirms it here.
 */
export const receiptPrintResultSchema = z.enum([
  "queued_to_printer",
  "not_printed",
]);
export type ReceiptPrintResult = z.infer<typeof receiptPrintResultSchema>;

/** What the print/e-receipt action returns: number, document and deliveries. */
export const posReceiptIssueResultSchema = z.strictObject({
  receipt: posReceiptSchema,
  document: receiptDocumentSchema,
  deliveries: z.array(receiptDeliverySchema),
  /** E-receipt link, returned once; the raw token is never stored. */
  link: receiptLinkSchema.nullable(),
  /** Null when this request asked for no print (also on a lookup). */
  printResult: receiptPrintResultSchema.nullable(),
  /**
   * Cloud only, when the request named a `paperWidth`: the ESC/POS bytes the
   * tablet sends to its own printer (P1). Absent otherwise.
   */
  print: printPayloadSchema.nullable().optional(),
});
export type PosReceiptIssueResult = z.infer<typeof posReceiptIssueResultSchema>;

// ---- Customer display (F8 "Customer Display") -----------------------------

export const customerDisplayPairingSchema = z
  .strictObject({
    id: customerDisplayPairingIdSchema,
    ...scope,
    terminalDeviceId: uuidSchema,
    displayDeviceId: uuidSchema,
    status: z.enum(["active", "revoked"]),
    pairedAt: isoDateTimeSchema,
    pairedBy: userIdSchema,
    revokedAt: isoDateTimeSchema.nullable(),
  })
  .refine((row) => (row.status === "revoked") === (row.revokedAt !== null), {
    path: ["revokedAt"],
    message: "Revocation status and timestamp must agree",
  });
export type CustomerDisplayPairing = z.infer<
  typeof customerDisplayPairingSchema
>;

export const pairCustomerDisplayInputSchema = clientInputSchema({
  /** Six-digit code shown on the display while pairing. */
  code: z.string().regex(/^\d{6}$/, "The pairing code is six digits"),
  idempotencyKey: idempotencyKeySchema,
});

/** legend-yhia9 D-08: the code a display shows while it waits to be paired. */
export const customerDisplayPairingCodeSchema = z.strictObject({
  code: z.string().regex(/^\d{6}$/),
  expiresAt: isoDateTimeSchema,
});
export type CustomerDisplayPairingCode = z.infer<
  typeof customerDisplayPairingCodeSchema
>;

/** The cashier chooses the bill the paired display shows; never an amount. */
export const selectCustomerDisplayBillInputSchema = clientInputSchema({
  orderId: orderIdSchema.nullable(),
  idempotencyKey: idempotencyKeySchema,
});

export const customerDisplaySelectionSchema = z.strictObject({
  ...scope,
  terminalDeviceId: uuidSchema,
  orderId: orderIdSchema.nullable(),
  version: z.number().int().nonnegative(),
  updatedAt: isoDateTimeSchema,
});
export type CustomerDisplaySelection = z.infer<
  typeof customerDisplaySelectionSchema
>;

export const customerDisplayLineSchema = z.strictObject({
  name,
  quantity: z.number().int().min(1).max(99),
  unitPriceIdr: positiveIdr,
  lineTotalIdr: nonnegativeIdr,
  note: note.nullable(),
});
export type CustomerDisplayLine = z.infer<typeof customerDisplayLineSchema>;

/** Dynamic QRIS (DOIT) shown on the second screen; it expires (~10 minutes). */
export const customerDisplayQrisSchema = z.strictObject({
  provider: z.enum(["doit", "duitku"]),
  amountIdr: positiveIdr,
  payload: z.string().min(16).max(2048),
  expiresAt: isoDateTimeSchema,
});
export type CustomerDisplayQris = z.infer<typeof customerDisplayQrisSchema>;

/**
 * 1269 C3a: a cashier VA or e-wallet code on the second screen (VA number or
 * Duitku payment page). Same rules as `qris`: open hold, exactly the remaining
 * balance, unexpired.
 */
export const customerDisplayOnlineCodeSchema = z.strictObject({
  amountIdr: positiveIdr,
  instructions: posOnlineCodeInstructionsSchema,
  expiresAt: isoDateTimeSchema,
});
export type CustomerDisplayOnlineCode = z.infer<
  typeof customerDisplayOnlineCodeSchema
>;

export const customerDisplayPromotionSchema = z.strictObject({
  title: z.string().min(1),
  body: z.string().min(1),
  validUntil: isoDateTimeSchema,
});
export type CustomerDisplayPromotion = z.infer<
  typeof customerDisplayPromotionSchema
>;

export const customerDisplayStateSchema = z
  .strictObject({
    ...scope,
    terminalDeviceId: uuidSchema.nullable(),
    displayDeviceId: uuidSchema,
    state: z.enum(["idle", "ordering", "awaiting_payment", "paid"]),
    promotions: z.array(customerDisplayPromotionSchema),
    pairingCode: z
      .string()
      .regex(/^\d{6}$/)
      .nullable(),
    orderId: orderIdSchema.nullable(),
    orderNumber: orderNumber.nullable(),
    lines: z.array(customerDisplayLineSchema),
    subtotalIdr: nonnegativeIdr,
    discountIdr: nonnegativeIdr,
    serviceChargeIdr: nonnegativeIdr,
    taxIdr: nonnegativeIdr,
    /** Cash rounding carried from the order, so the screen shows the final total. */
    roundingIdr: idrSchema,
    totalIdr: nonnegativeIdr,
    /**
     * legend-npnh: inclusive prices. The subtotal then holds service and tax,
     * so the total is subtotal - discount + rounding. Absent (legacy) means
     * exclusive.
     */
    pricesIncludeTax: z.boolean().default(false),
    /** Reservation credit already applied; absent in legacy display pushes. */
    depositAppliedIdr: nonnegativeIdr.default(idr(0)),
    /** Derived from the gross total less the deposit and captured tenders. */
    remainingIdr: nonnegativeIdr.optional(),
    qris: customerDisplayQrisSchema.nullable(),
    /** 1269 C3a: absent when no VA / e-wallet code is shown. */
    onlineCode: customerDisplayOnlineCodeSchema.nullable().optional(),
    /** Captured amounts applied to the bill, excluding cash handed over. */
    tenders: z.array(posDocumentTenderSchema),
    changeIdr: nonnegativeIdr.nullable(),
    /** Monotonic per terminal so the display drops stale pushes. */
    version: z.number().int().nonnegative(),
    updatedAt: isoDateTimeSchema,
  })
  .superRefine((state, ctx) => {
    if (
      state.terminalDeviceId === null &&
      (state.state !== "idle" || state.pairingCode === null)
    )
      ctx.addIssue({
        code: "custom",
        path: ["pairingCode"],
        message: "An unpaired display needs a pairing code and an idle state",
      });
    if (state.terminalDeviceId !== null && state.pairingCode !== null)
      ctx.addIssue({
        code: "custom",
        path: ["pairingCode"],
        message: "A paired display has no pairing code",
      });
    if (
      state.terminalDeviceId === null &&
      (state.orderId !== null ||
        state.orderNumber !== null ||
        state.lines.length > 0 ||
        Number(state.subtotalIdr) !== 0 ||
        Number(state.discountIdr) !== 0 ||
        Number(state.serviceChargeIdr) !== 0 ||
        Number(state.taxIdr) !== 0 ||
        Number(state.roundingIdr) !== 0 ||
        Number(state.totalIdr) !== 0 ||
        Number(state.depositAppliedIdr) !== 0 ||
        (state.remainingIdr !== undefined &&
          Number(state.remainingIdr) !== 0) ||
        state.qris !== null ||
        (state.onlineCode ?? null) !== null ||
        state.tenders.length > 0 ||
        state.changeIdr !== null)
    )
      ctx.addIssue({
        code: "custom",
        message: "An unpaired display has no bill data",
      });
    if (state.state === "idle" && state.orderId !== null)
      ctx.addIssue({
        code: "custom",
        path: ["orderId"],
        message: "The idle screen has no order",
      });
    if (state.state !== "idle" && state.orderId === null)
      ctx.addIssue({
        code: "custom",
        path: ["orderId"],
        message: "A live display state shows an order",
      });
    const netSubtotal = Number(state.subtotalIdr) - Number(state.discountIdr);
    const total = state.pricesIncludeTax
      ? netSubtotal + Number(state.roundingIdr)
      : netSubtotal +
        Number(state.serviceChargeIdr) +
        Number(state.taxIdr) +
        Number(state.roundingIdr);
    if (Number(state.totalIdr) !== total)
      ctx.addIssue({
        code: "custom",
        path: ["totalIdr"],
        message:
          "totalIdr must equal subtotal - discount + service + tax + rounding",
      });
    const deposit = Number(state.depositAppliedIdr);
    const captured = state.tenders.reduce(
      (sum, tender) => sum + Number(tender.amountIdr),
      0,
    );
    const remaining = Number(state.totalIdr) - deposit - captured;
    if (deposit > Number(state.totalIdr))
      ctx.addIssue({
        code: "custom",
        path: ["depositAppliedIdr"],
        message: "depositAppliedIdr must not exceed totalIdr",
      });
    if (remaining < 0)
      ctx.addIssue({
        code: "custom",
        path: ["tenders"],
        message: "Captured tenders and deposit must not exceed the bill total",
      });
    if (
      state.remainingIdr !== undefined &&
      Number(state.remainingIdr) !== remaining
    )
      ctx.addIssue({
        code: "custom",
        path: ["remainingIdr"],
        message:
          "remainingIdr must equal total less deposit and captured tenders",
      });
    if (state.qris !== null) {
      if (state.state !== "awaiting_payment")
        ctx.addIssue({
          code: "custom",
          path: ["qris"],
          message: "QRIS is shown while the bill is awaiting payment",
        });
      if (remaining <= 0 || Number(state.qris.amountIdr) !== remaining)
        ctx.addIssue({
          code: "custom",
          path: ["qris", "amountIdr"],
          message: "The QRIS amount is the positive remaining bill balance",
        });
    }
    if (state.onlineCode) {
      if (state.state !== "awaiting_payment" || state.qris !== null)
        ctx.addIssue({
          code: "custom",
          path: ["onlineCode"],
          message:
            "A VA or e-wallet code is shown alone while the bill awaits payment",
        });
      if (remaining <= 0 || Number(state.onlineCode.amountIdr) !== remaining)
        ctx.addIssue({
          code: "custom",
          path: ["onlineCode", "amountIdr"],
          message: "The code amount is the positive remaining bill balance",
        });
    }
    if (state.state === "paid" && remaining !== 0)
      ctx.addIssue({
        code: "custom",
        path: ["tenders"],
        message:
          "A paid screen is fully covered by the deposit and captured tenders",
      });
  })
  .transform((state) => ({
    ...state,
    remainingIdr: idr(
      Number(state.totalIdr) -
        Number(state.depositAppliedIdr) -
        state.tenders.reduce(
          (sum, tender) => sum + Number(tender.amountIdr),
          0,
        ),
    ),
  }));
export type CustomerDisplayState = z.infer<typeof customerDisplayStateSchema>;

// ---- Fixture set ----------------------------------------------------------

/** Whole Cafe Legend POS fixture; must parse as one object (test). */
export const posFixtureSchema = z.strictObject({
  approvalPolicy: posApprovalPolicySchema,
  shifts: z.array(posShiftSchema),
  shiftCounts: z.array(posShiftCountSchema),
  cashMovements: z.array(posCashMovementSchema),
  orders: z.array(posOrderSchema),
  orderDetails: z.array(posOrderDetailSchema),
  orderItems: z.array(posOrderItemSchema),
  orderEvents: z.array(posOrderEventSchema),
  tenders: z.array(posTenderSchema),
  discounts: z.array(posDiscountSchema),
  voids: z.array(posVoidSchema),
  refunds: z.array(posRefundSchema),
  receiptSequences: z.array(receiptSequenceSchema),
  receipts: z.array(posReceiptSchema),
  receiptDocuments: z.array(receiptDocumentSchema),
  invoices: z.array(invoiceDocumentSchema),
  deliveries: z.array(receiptDeliverySchema),
  customerDisplayPairings: z.array(customerDisplayPairingSchema),
  customerDisplayState: customerDisplayStateSchema,
  endOfDay: endOfDayRecapSchema,
});
export type PosFixture = z.infer<typeof posFixtureSchema>;

// Re-exported for callers that group POS tender methods with payment methods.
export type { PaymentMethod };
