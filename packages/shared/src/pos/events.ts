// POS domain events (bead legend-4yp, WS-04). Names registered on the WS-04
// line of the WS-00 event catalog (`events/catalog.ts`) and bound with
// defineDomainEvent, so every payload is validated against its catalogued
// `<name>.v1` schema (docs/plan/contracts.md "One catalog, typed payloads").
//
//   order.submitted           cashier/captain submitted a POS order
//   order.paid                a sale was settled (per tender method) — the
//                             event WS-07 posts sales journals from
//   order.voided              an order was voided, or a final sale corrected
//   order.refunded            money was refunded against a paid sale
//   cashier_shift.opened      cashier opened a shift with its opening float
//   cashier_shift.closed      blind-count close, variance and approval
//   day.closed                end-of-day recap for one outlet business date
//   cash_movement.recorded    kas masuk/keluar/setoran during a shift
//   cash_movement.approved    a held kas keluar/setoran approved by a supervisor
//
// `order.paid` and `order.refunded` carry exactly the amount keys the already
// merged WS-07 posting rules read (`paidCashIdr`, `paidGatewayIdr`,
// `paidEdcIdr`, `paidPointsIdr`, `discountIdr`, `grossSalesIdr`,
// `serviceChargeIdr`, `pbjtIdr`, `roundingIdr`, `paidDepositIdr`; refunds:
// `refundCashIdr`, `refundGatewayIdr`, `refundEdcIdr`), so a sale posts once
// and balances.
// `cashier_shift.closed` carries the signed `differenceIdr` its rule needs.
//
// PRD v1.7: §3 F8 (Shift Kasir, Tutup Hari), §5 "Model event untuk
// operasional" (append-only, ULID), POS-02..POS-04, POS-06.

import {
  z,
  idr,
  idrSchema,
  basisPointsSchema,
  outletIdSchema,
  uuidIdSchema,
  userIdSchema,
  uuidSchema,
  businessDateSchema,
  isoDateTimeSchema,
} from "../core/index.ts";
import { posOverrideIdSchema } from "../access/override.ts";
import { orderIdSchema } from "../kitchen/schemas.ts";
import {
  fireStatusSchema,
  orderItemStatusSchema,
  paymentModeSchema,
} from "../qr-order/schemas.ts";
import { defineDomainEvent, eventEnvelopeSchema } from "../events/index.ts";
import {
  ruleCodeSchema,
  taxRuleIdSchema,
  taxTypeSchema,
} from "../tax/schemas.ts";
import type { EventCatalogEntry, EventEnvelope } from "../events/index.ts";
import { tenderBucket } from "./calculations.ts";
import {
  cashMovementTypeSchema,
  orderChannelSchema,
  posRefundIdSchema,
  posShiftIdSchema,
  posTenderMethodSchema,
  posVoidIdSchema,
  refundReasonSchema,
  serviceTypeSchema,
  voidReasonSchema,
  storedApprovalIdSchema,
} from "./schemas.ts";

const deviceIdSchema = uuidSchema;
const nonnegativeIdr = idrSchema.refine(
  (value) => value >= 0,
  "Amount must not be negative",
);
const positiveIdr = idrSchema.refine(
  (value) => value > 0,
  "Amount must be positive",
);

const tenderLineSchema = z.strictObject({
  method: posTenderMethodSchema,
  amountIdr: positiveIdr,
  /**
   * Edge order ingest (docs/design/edge-order-ingest.md): the cash handed
   * over, and the points redeemed. Optional: events written before the edge
   * contract change do not carry them.
   */
  receivedIdr: nonnegativeIdr.optional(),
  pointsUsed: z.number().int().positive().max(1_000_000).optional(),
  /**
   * legend-yu8z0: the `pos_order_tenders.provider` of the tender. Optional and
   * deliberately a plain string: a value the cloud does not know is refused at
   * ingest (recorded, parked), not by this schema. A gateway method (card, va,
   * ewallet, qris) is ingested only with a gateway provider.
   */
  provider: z.string().max(20).optional(),
});
type TenderLine = z.infer<typeof tenderLineSchema>;

function bucketSum(lines: readonly TenderLine[], bucket: string): number {
  return lines
    .filter((line) => tenderBucket(line.method) === bucket)
    .reduce((sum, line) => sum + Number(line.amountIdr), 0);
}

const orderScope = {
  orderId: orderIdSchema,
  outletId: outletIdSchema,
  businessDate: businessDateSchema,
};

// ---- order.submitted ------------------------------------------------------

/** A cashier or captain submitted the order; items may still be held. */
export const orderSubmittedPayloadSchema = z.strictObject({
  ...orderScope,
  channel: orderChannelSchema,
  serviceType: serviceTypeSchema,
  status: z.literal("awaiting_payment"),
  itemCount: z.number().int().positive().max(999),
  totalIdr: nonnegativeIdr,
  shiftId: posShiftIdSchema.nullable(),
  deviceId: deviceIdSchema.nullable(),
  submittedBy: userIdSchema.nullable(),
  submittedAt: isoDateTimeSchema,
});
export type OrderSubmittedPayload = z.infer<typeof orderSubmittedPayloadSchema>;

// ---- order.paid -----------------------------------------------------------

/**
 * Edge order ingest: one `order_items` row as it stood when the sale was
 * settled (voided lines included, `status` says which). Optional on the
 * payload; see `lines` below.
 */
const orderPaidLineSchema = z.strictObject({
  menuItemId: uuidSchema,
  name: z.string().min(1).max(150),
  quantity: z.number().int().min(1).max(99),
  unitPriceIdr: nonnegativeIdr,
  modifiersTotalIdr: nonnegativeIdr,
  lineTotalIdr: nonnegativeIdr,
  fireStatus: fireStatusSchema,
  reservedBusinessDate: businessDateSchema,
  status: orderItemStatusSchema,
});

/**
 * Edge sales GL (legend-uctlr): one `tax_snapshots` row of the sale, copied
 * from the edge's `order.taxResult` as it stood (never recomputed). The cloud
 * writes the same rows a cloud-paid order gets, so the sale journal splits
 * PBJT from the revenue the same way.
 */
const orderPaidTaxSchema = z.strictObject({
  taxRuleId: taxRuleIdSchema,
  code: ruleCodeSchema,
  version: z.number().int().positive(),
  taxType: taxTypeSchema,
  rateBp: basisPointsSchema,
  priceIncludesTax: z.boolean(),
  grossIdr: nonnegativeIdr,
  taxBaseIdr: nonnegativeIdr,
  serviceChargeIdr: nonnegativeIdr,
  taxIdr: nonnegativeIdr,
});

export const orderPaidPayloadSchema = z
  .strictObject({
    ...orderScope,
    channel: orderChannelSchema,
    serviceType: serviceTypeSchema,
    /** Sum of the non-voided lines before discount. */
    grossSalesIdr: nonnegativeIdr,
    discountIdr: nonnegativeIdr,
    serviceChargeIdr: nonnegativeIdr,
    /** PBJT (or the configured tax) for this sale. */
    pbjtIdr: nonnegativeIdr,
    roundingIdr: idrSchema,
    /**
     * legend-fbms: zero for a fully discounted sale (staff meal, comp). The
     * event still fires so recipe deduction runs; WS-07 ignores an all-zero
     * payload and still posts a discount/sales pair.
     */
    totalIdr: nonnegativeIdr,
    /** Tender buckets: exactly the amount keys of the WS-07 posting rule. */
    paidCashIdr: nonnegativeIdr,
    paidGatewayIdr: nonnegativeIdr,
    paidEdcIdr: nonnegativeIdr,
    paidPointsIdr: nonnegativeIdr,
    /**
     * legend-9pz9: the reservation DP applied to this sale (the order's
     * `depositAppliedIdr`). Not a tender: the tenders settle the rest.
     */
    paidDepositIdr: nonnegativeIdr.default(idr(0)),
    /**
     * Empty only when nothing is left to settle: the DP covers the whole
     * total, or the total is 0 (legend-fbms). The sum check below
     * (tenders = totalIdr - paidDepositIdr) refuses any other empty list.
     */
    tenders: z.array(tenderLineSchema),
    shiftId: posShiftIdSchema.nullable(),
    cashierId: userIdSchema.nullable(),
    deviceId: deviceIdSchema.nullable(),
    paidAt: isoDateTimeSchema,
    // Edge order ingest (docs/design/edge-order-ingest.md "Contract change").
    // All optional and additive: an event without them is a legacy payload
    // the cloud cannot rebuild the order from.
    orderNumber: z.string().min(1).max(30).optional(),
    /**
     * The order's `subtotal_idr`. NOT `grossSalesIdr`: with tax-inclusive
     * prices gross = subtotal - service - tax.
     */
    subtotalIdr: nonnegativeIdr.optional(),
    pricesIncludeTax: z.boolean().optional(),
    paymentMode: paymentModeSchema.optional(),
    isTraining: z.boolean().optional(),
    lines: z.array(orderPaidLineSchema).max(999).optional(),
    // Edge sales GL (legend-uctlr), additive. The order's customer (points
    // earn at ingest) and the tax rows behind `pbjtIdr` (tax_snapshots).
    customerProfileId: uuidSchema.nullable().optional(),
    /**
     * legend-cqehx: the staff user who attached the customer
     * (`orders.customer_attached_by`); null when the customer attached
     * themselves. The LOY-02 guard needs it: staff earn no points on their own
     * sale, whoever the cashier is.
     */
    customerAttachedBy: userIdSchema.nullable().optional(),
    taxes: z.array(orderPaidTaxSchema).max(50).optional(),
  })
  .superRefine((payload, ctx) => {
    // Σ taxes == pbjtIdr is NOT a schema rule either (same reason as the
    // lines below): the cloud checks it at ingest (`tax_mismatch`) so the
    // event is still parked and recorded when it fails.
    // Σ non-void lines == subtotalIdr is NOT a schema rule: the cloud checks it
    // at ingest (`lines_mismatch`) so the event is still parked when it fails.
    if (payload.lines !== undefined && payload.subtotalIdr === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["subtotalIdr"],
        message: "subtotalIdr is required when lines are present",
      });
    const total =
      Number(payload.grossSalesIdr) -
      Number(payload.discountIdr) +
      Number(payload.serviceChargeIdr) +
      Number(payload.pbjtIdr) +
      Number(payload.roundingIdr);
    if (Number(payload.totalIdr) !== total)
      ctx.addIssue({
        code: "custom",
        path: ["totalIdr"],
        message:
          "totalIdr must equal gross - discount + service + tax + rounding",
      });
    const paid = payload.tenders.reduce(
      (sum, line) => sum + Number(line.amountIdr),
      0,
    );
    if (Number(payload.paidDepositIdr) > Number(payload.totalIdr))
      ctx.addIssue({
        code: "custom",
        path: ["paidDepositIdr"],
        message: "paidDepositIdr must not exceed totalIdr",
      });
    else if (paid !== Number(payload.totalIdr) - Number(payload.paidDepositIdr))
      ctx.addIssue({
        code: "custom",
        path: ["tenders"],
        message: "Captured tenders must equal totalIdr - paidDepositIdr",
      });
    for (const [key, bucket] of [
      ["paidCashIdr", "cash"],
      ["paidGatewayIdr", "gateway"],
      ["paidEdcIdr", "edc"],
      ["paidPointsIdr", "points"],
    ] as const)
      if (Number(payload[key]) !== bucketSum(payload.tenders, bucket))
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `${key} must equal the ${bucket} tenders`,
        });
  });
export type OrderPaidPayload = z.infer<typeof orderPaidPayloadSchema>;

// ---- order.voided ---------------------------------------------------------

/**
 * POS-02/POS-04: either the order's own `void` transition (not yet a final
 * sale) or a linked void of a completed sale. A final sale keeps its receipt
 * number (POS-06), so the linked correction always carries `receiptNumber`.
 */
export const orderVoidedPayloadSchema = z
  .strictObject({
    ...orderScope,
    amountIdr: nonnegativeIdr,
    reason: voidReasonSchema,
    reasonNote: z.string().min(4).max(500),
    /**
     * The supervisor who approved the void. Null only for a system void with
     * no human approver: a delivery platform cancel (legend-5bn3), where
     * `overrideId` and `approvalRequestId` are null too.
     */
    approvedBy: userIdSchema.nullable(),
    /**
     * legend-0gy1: the consumed `pos_overrides` row; the proof of approval.
     * Null only on events written before the override id was recorded.
     */
    overrideId: posOverrideIdSchema.nullable(),
    /** WS-01 chain id of a phone approval; null for a supervisor PIN. */
    approvalRequestId: uuidSchema.nullable(),
    /** True when a completed sale is being corrected by a linked void. */
    voidedFinalOrder: z.boolean(),
    voidId: posVoidIdSchema.nullable(),
    receiptNumber: z.string().min(1).max(20).nullable(),
    voidedAt: isoDateTimeSchema,
    /**
     * Edge order ingest: the user who requested the void (the approver is
     * `approvedBy`). Optional: absent on a system void and on events written
     * before the edge contract change.
     */
    requestedBy: userIdSchema.optional(),
  })
  .superRefine((payload, ctx) => {
    if (payload.voidedFinalOrder) {
      if (payload.voidId === null || payload.receiptNumber === null)
        ctx.addIssue({
          code: "custom",
          path: ["voidId"],
          message:
            "A corrected final sale records the void and its receipt number (POS-04, POS-06)",
        });
    } else if (payload.voidId !== null)
      ctx.addIssue({
        code: "custom",
        path: ["voidId"],
        message: "Only a final-sale correction has a void record",
      });
  });
export type OrderVoidedPayload = z.infer<typeof orderVoidedPayloadSchema>;

// ---- order.refunded -------------------------------------------------------

export const orderRefundedPayloadSchema = z
  .strictObject({
    ...orderScope,
    refundId: posRefundIdSchema,
    amountIdr: positiveIdr,
    reason: refundReasonSchema,
    reasonNote: z.string().min(4).max(500),
    approvedBy: userIdSchema,
    overrideId: posOverrideIdSchema.nullable(),
    approvalRequestId: uuidSchema.nullable(),
    /** Refund buckets: the amount keys of the refund posting rule. */
    grossSalesIdr: nonnegativeIdr,
    discountIdr: nonnegativeIdr,
    serviceChargeIdr: nonnegativeIdr,
    pbjtIdr: nonnegativeIdr,
    refundCashIdr: nonnegativeIdr,
    refundGatewayIdr: nonnegativeIdr,
    refundEdcIdr: nonnegativeIdr,
    refundPointsIdr: nonnegativeIdr,
    lines: z.array(tenderLineSchema),
    /** Original gateway DP methods, separate from POS tenders. */
    depositLines: z
      .array(
        z.strictObject({
          method: z.enum([
            "qris",
            "card",
            "ewallet",
            "va",
            "bank_transfer",
            "paylater",
          ]),
          amountIdr: positiveIdr,
        }),
      )
      .optional(),
    refundedAt: isoDateTimeSchema,
  })
  .superRefine((payload, ctx) => {
    // The refund journal debits revenue, service charge and tax and credits
    // the discount plus each refund bucket (WS-07 order.refunded rule), so the
    // revenue split must add up to the money returned or it cannot balance.
    const split =
      Number(payload.grossSalesIdr) -
      Number(payload.discountIdr) +
      Number(payload.serviceChargeIdr) +
      Number(payload.pbjtIdr);
    if (split !== Number(payload.amountIdr))
      ctx.addIssue({
        code: "custom",
        path: ["amountIdr"],
        message:
          "amountIdr must equal gross - discount + service + tax for the refunded lines",
      });
    const depositSum = (payload.depositLines ?? []).reduce(
      (total, line) => total + Number(line.amountIdr),
      0,
    );
    const sum = payload.lines.reduce(
      (total, line) => total + Number(line.amountIdr),
      depositSum,
    );
    if (sum !== Number(payload.amountIdr))
      ctx.addIssue({
        code: "custom",
        path: ["lines"],
        message: "Refund lines must sum to the refund amount",
      });
    for (const [key, bucket] of [
      ["refundCashIdr", "cash"],
      ["refundGatewayIdr", "gateway"],
      ["refundEdcIdr", "edc"],
      ["refundPointsIdr", "points"],
    ] as const)
      if (
        Number(payload[key]) !==
        bucketSum(payload.lines, bucket) +
          (bucket === "gateway" ? depositSum : 0)
      )
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `${key} must equal the ${bucket} refund lines`,
        });
  });
export type OrderRefundedPayload = z.infer<typeof orderRefundedPayloadSchema>;

// ---- cashier_shift.opened / cashier_shift.closed --------------------------

export const cashierShiftOpenedPayloadSchema = z.strictObject({
  shiftId: posShiftIdSchema,
  outletId: outletIdSchema,
  deviceId: deviceIdSchema,
  cashierId: userIdSchema,
  businessDate: businessDateSchema,
  openingFloatIdr: nonnegativeIdr,
  openedAt: isoDateTimeSchema,
});
export type CashierShiftOpenedPayload = z.infer<
  typeof cashierShiftOpenedPayloadSchema
>;

export const cashierShiftClosedPayloadSchema = z
  .strictObject({
    shiftId: posShiftIdSchema,
    outletId: outletIdSchema,
    deviceId: deviceIdSchema,
    cashierId: userIdSchema,
    businessDate: businessDateSchema,
    openingFloatIdr: nonnegativeIdr,
    cashSalesIdr: nonnegativeIdr,
    cashRefundsIdr: nonnegativeIdr,
    cashInIdr: nonnegativeIdr,
    cashOutIdr: nonnegativeIdr,
    cashDropIdr: nonnegativeIdr,
    expectedIdr: nonnegativeIdr,
    /** The blind count the cashier submitted. */
    countedIdr: nonnegativeIdr,
    /**
     * counted − expected + heldCashOutIdr: the signed amount the WS-07 rule
     * books (stored as pos_shifts.difference_idr). Held cash outs and drops
     * expire at the close with their cash still in the drawer and are not in
     * it (legend-y9bf); held refund and void cash is (legend-utqr). Equals
     * the stored shift variance when no refund or void is held.
     */
    differenceIdr: idrSchema,
    /**
     * Cash of the held refunds and voids, left out of expected and booked by
     * their own events (0 if absent). Since legend-y9bf it excludes held cash
     * outs and drops; events stored before it carried the whole held sum.
     */
    heldCashOutIdr: nonnegativeIdr.optional(),
    varianceNote: z.string().min(4).max(500).nullable(),
    approvedBy: userIdSchema,
    approvalRequestId: storedApprovalIdSchema,
    closedAt: isoDateTimeSchema,
  })
  .superRefine((payload, ctx) => {
    if (
      Number(payload.differenceIdr) !==
      Number(payload.countedIdr) -
        Number(payload.expectedIdr) +
        Number(payload.heldCashOutIdr ?? 0)
    )
      ctx.addIssue({
        code: "custom",
        path: ["differenceIdr"],
        message: "differenceIdr must equal counted − expected + held",
      });
    if (Number(payload.differenceIdr) !== 0 && payload.varianceNote === null)
      ctx.addIssue({
        code: "custom",
        path: ["varianceNote"],
        message: "A cash difference carries a written explanation (U9)",
      });
  });
export type CashierShiftClosedPayload = z.infer<
  typeof cashierShiftClosedPayloadSchema
>;

// ---- day.closed -----------------------------------------------------------

/** F8 "Tutup Hari": the day's POS totals for one outlet, synced to WS-07. */
export const dayClosedPayloadSchema = z.strictObject({
  outletId: outletIdSchema,
  businessDate: businessDateSchema,
  orderCount: z.number().int().nonnegative(),
  totalSalesIdr: nonnegativeIdr,
  totalRefundsIdr: nonnegativeIdr,
  totalVoidsIdr: nonnegativeIdr,
  totalVarianceIdr: idrSchema,
  inventoryDeductionApplied: z.boolean(),
  accountingSyncStatus: z.enum(["pending", "posted"]),
  closedBy: userIdSchema,
  closedAt: isoDateTimeSchema,
});
export type DayClosedPayload = z.infer<typeof dayClosedPayloadSchema>;

// ---- cash_movement.recorded ----------------------------------------------

export const cashMovementRecordedPayloadSchema = z.strictObject({
  movementId: uuidIdSchema<"CashMovementId">(),
  shiftId: posShiftIdSchema,
  outletId: outletIdSchema,
  deviceId: deviceIdSchema,
  type: cashMovementTypeSchema,
  amountIdr: positiveIdr,
  reasonNote: z.string().min(4).max(500),
  recordedBy: userIdSchema,
  recordedAt: isoDateTimeSchema,
});
export type CashMovementRecordedPayload = z.infer<
  typeof cashMovementRecordedPayloadSchema
>;

// ---- cash_movement.approved ----------------------------------------------
// A held cash out / drop (needs_approval, legend-67dt) approved by a
// supervisor while the shift is open. Carries every cash_movement.recorded
// field plus the approval, so the journal consumer reads one shape.

export const cashMovementApprovedPayloadSchema =
  cashMovementRecordedPayloadSchema.extend({
    approvedBy: userIdSchema,
    approvedAt: isoDateTimeSchema,
  });
export type CashMovementApprovedPayload = z.infer<
  typeof cashMovementApprovedPayloadSchema
>;

// ---- definitions ----------------------------------------------------------

export const posEventNames = [
  "order.submitted",
  "order.paid",
  "order.voided",
  "order.refunded",
  "cashier_shift.opened",
  "cashier_shift.closed",
  "day.closed",
  "cash_movement.recorded",
  "cash_movement.approved",
] as const;
export type PosEventName = (typeof posEventNames)[number];

export const posEventPayloads: Record<
  PosEventName,
  z.ZodType<Record<string, unknown>>
> = {
  "order.submitted": orderSubmittedPayloadSchema,
  "order.paid": orderPaidPayloadSchema,
  "order.voided": orderVoidedPayloadSchema,
  "order.refunded": orderRefundedPayloadSchema,
  "cashier_shift.opened": cashierShiftOpenedPayloadSchema,
  "cashier_shift.closed": cashierShiftClosedPayloadSchema,
  "day.closed": dayClosedPayloadSchema,
  "cash_movement.recorded": cashMovementRecordedPayloadSchema,
  "cash_movement.approved": cashMovementApprovedPayloadSchema,
};

/**
 * Catalog-bound definitions: defineDomainEvent throws at module load if a name
 * is not catalogued, and each `envelopeSchema` validates name, version, schema
 * ref and payload together.
 */
export const posEvents = Object.fromEntries(
  posEventNames.map((name) => [
    name,
    defineDomainEvent({ name, payload: posEventPayloads[name] }),
  ]),
) as Record<PosEventName, ReturnType<typeof defineDomainEvent>>;

export const posEventCatalog: readonly EventCatalogEntry[] = posEventNames.map(
  (name) => posEvents[name].entry,
);

/** Envelope whose name and payload belong to this domain. */
export const posEventSchema = eventEnvelopeSchema
  .refine(
    (event) => (posEventNames as readonly string[]).includes(event.name),
    { path: ["name"], message: "Not a POS event" },
  )
  .refine(
    (event) =>
      posEvents[event.name as PosEventName]?.envelopeSchema.safeParse(event)
        .success === true,
    {
      path: ["payload"],
      message: "Event does not match its catalogued schema",
    },
  );

export type PosEvent = EventEnvelope;
