// Paid WFC sale contract of brief 1270 card W2: a member holds a seat, pays the
// pass online (QRIS only in release 1) and gets the seat once the payment is
// confirmed. Every request is built with `clientInputSchema`: the tenant comes
// from the domain (TEN-02), the member from the session, the price from the
// product. A request never carries an amount, a member or a payment method.

import {
  businessDateSchema,
  clientInputSchema,
  idrSchema,
  isoDateTimeSchema,
  uuidSchema,
  z,
} from "../core/index.ts";
import {
  wfcAccessSchema,
  wfcProductKindSchema,
  wfcReservationStatusSchema,
} from "./seat.ts";

/** A payment link of a pass stays open this long (brief 1270 §3). */
export const WFC_LINK_MINUTES = 30;
/** A seat is held this long for its payment (brief 1270 §3). */
export const WFC_HOLD_MINUTES = 45;
/** The one online method of a pass in release 1 (CTO 26 Nov, W1b no. 2). */
export const WFC_PAYMENT_METHOD = "qris" as const;

const nonnegativeIdr = idrSchema.refine((value) => value >= 0);

// ---- Read models ------------------------------------------------------------

/** A pass on sale at an outlet; the price is always seat fee + credit. */
export const wfcSaleProductSchema = z.strictObject({
  productId: uuidSchema,
  outletId: uuidSchema,
  name: z.string(),
  kind: wfcProductKindSchema,
  access: wfcAccessSchema,
  priceIdr: nonnegativeIdr,
  seatFeeIdr: nonnegativeIdr,
  creditIdr: nonnegativeIdr,
  durationMinutes: z.number().int().min(1).nullable(),
});
export type WfcSaleProduct = z.infer<typeof wfcSaleProductSchema>;

/** The QRIS code of a held seat; null once the claim left `pending_payment`. */
export const wfcPaymentCodeSchema = z.strictObject({
  intentId: uuidSchema,
  qrisPayload: z.string().nullable(),
  amountIdr: nonnegativeIdr,
  status: z.string(),
  expiresAt: isoDateTimeSchema,
});
export type WfcPaymentCode = z.infer<typeof wfcPaymentCodeSchema>;

/** One seat claim of the signed-in member. */
export const wfcClaimSchema = z.strictObject({
  id: uuidSchema,
  outletId: uuidSchema,
  productId: uuidSchema,
  seatId: uuidSchema,
  seatCode: z.string(),
  kind: wfcProductKindSchema,
  access: wfcAccessSchema,
  businessDate: businessDateSchema,
  startsAt: isoDateTimeSchema,
  endsAt: isoDateTimeSchema,
  status: wfcReservationStatusSchema,
  priceIdr: nonnegativeIdr,
  seatFeeIdr: nonnegativeIdr,
  creditIdr: nonnegativeIdr,
  paidIdr: nonnegativeIdr,
  refundedIdr: nonnegativeIdr,
  holdExpiresAt: isoDateTimeSchema.nullable(),
  payment: wfcPaymentCodeSchema.nullable(),
});
export type WfcClaim = z.infer<typeof wfcClaimSchema>;

// ---- Requests ---------------------------------------------------------------

export const listWfcSaleProductsQuerySchema = clientInputSchema({
  outletId: uuidSchema,
});
export type ListWfcSaleProductsInput = z.input<
  typeof listWfcSaleProductsQuerySchema
>;

/**
 * Holds a seat for one pass. A seat reservation names its start (`startsAt`),
 * a day pass its local date (`date`); exactly one of the two, checked against
 * the product's kind on the server. `seatId` picks a seat, else the first
 * free one is taken.
 */
export const holdWfcSeatSchema = clientInputSchema({
  productId: uuidSchema,
  seatId: uuidSchema.optional(),
  startsAt: isoDateTimeSchema.optional(),
  date: businessDateSchema.optional(),
}).refine((value) => (value.startsAt === undefined) !== (value.date === undefined), {
  message: "Isi jam mulai untuk reservasi atau tanggal untuk day pass.",
  path: ["startsAt"],
});
export type HoldWfcSeatInput = z.input<typeof holdWfcSeatSchema>;

export const wfcClaimParamsSchema = clientInputSchema({ claimId: uuidSchema });
