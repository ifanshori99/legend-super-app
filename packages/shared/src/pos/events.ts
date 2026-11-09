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
//
// `order.paid` and `order.refunded` carry exactly the amount keys the already
// merged WS-07 posting rules read (`paidCashIdr`, `paidGatewayIdr`,
// `paidEdcIdr`, `paidPointsIdr`, `discountIdr`, `grossSalesIdr`,
// `serviceChargeIdr`, `pbjtIdr`, `roundingIdr`; refunds: `refundCashIdr`,
// `refundGatewayIdr`, `refundEdcIdr`), so a sale posts once and balances.
// `cashier_shift.closed` carries the signed `differenceIdr` its rule needs.
//
// PRD v1.7: §3 F8 (Shift Kasir, Tutup Hari), §5 "Model event untuk
// operasional" (append-only, ULID), POS-02..POS-04, POS-06.

import {
  z,
  idrSchema,
  outletIdSchema,
  uuidIdSchema,
  userIdSchema,
  uuidSchema,
  businessDateSchema,
  isoDateTimeSchema,
} from "../core/index.ts";
import { posOverrideIdSchema } from "../access/override.ts";
import { orderIdSchema } from "../kitchen/schemas.ts";
import { defineDomainEvent, eventEnvelopeSchema } from "../events/index.ts";
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
    totalIdr: positiveIdr,
    /** Tender buckets: exactly the amount keys of the WS-07 posting rule. */
    paidCashIdr: nonnegativeIdr,
    paidGatewayIdr: nonnegativeIdr,
    paidEdcIdr: nonnegativeIdr,
    paidPointsIdr: nonnegativeIdr,
    tenders: z.array(tenderLineSchema).min(1),
    shiftId: posShiftIdSchema.nullable(),
    cashierId: userIdSchema.nullable(),
    deviceId: deviceIdSchema.nullable(),
    paidAt: isoDateTimeSchema,
  })
  .superRefine((payload, ctx) => {
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
    if (paid !== Number(payload.totalIdr))
      ctx.addIssue({
        code: "custom",
        path: ["tenders"],
        message: "Captured tenders must equal totalIdr",
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
    approvedBy: userIdSchema,
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
    lines: z.array(tenderLineSchema).min(1),
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
    const sum = payload.lines.reduce(
      (total, line) => total + Number(line.amountIdr),
      0,
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
      if (Number(payload[key]) !== bucketSum(payload.lines, bucket))
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
     * books, as if nothing were held (legend-utqr). Equals the stored shift
     * variance when nothing is held.
     */
    differenceIdr: idrSchema,
    /** Cash held for supervisor review, left out of expected (0 if absent). */
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
