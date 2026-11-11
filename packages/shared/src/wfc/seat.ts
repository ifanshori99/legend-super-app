// WFC seats, seat reservations and day passes (PRD v1.7 §3 F25/F39, FAC-14;
// bead legend-bz9h). Every request schema is built with `clientInputSchema`:
// the tenant comes from the domain or token (TEN-02), an unknown field is
// rejected, and NO schema carries a price: the price is always read from the
// product on the server. The only amount a client sends is the amount a payment
// provider reports (`paidIdr`), and the service refuses anything that is not
// exactly the stored price.

import {
  z,
  clientInputSchema,
  idempotencyKeySchema,
  idrSchema,
  isoDateTimeSchema,
  uuidSchema,
} from "../core/index.ts";

/** Longest seat reservation: one day (a day pass covers the rest). */
export const WFC_MAX_RESERVATION_MINUTES = 24 * 60;

const positiveIdr = idrSchema.refine((value) => value > 0, {
  message: "Jumlah harus lebih dari 0",
});
const nonnegativeIdr = idrSchema.refine((value) => value >= 0);

export const wfcProductKindSchema = z.enum(["day_pass", "seat_reservation"]);
export type WfcProductKind = z.infer<typeof wfcProductKindSchema>;

export const wfcSeatStatusSchema = z.enum(["active", "inactive"]);
export type WfcSeatStatus = z.infer<typeof wfcSeatStatusSchema>;

export const wfcReservationStatusSchema = z.enum([
  "pending_payment",
  "confirmed",
  "checked_in",
  "completed",
  "no_show",
  "cancelled",
  "refunded",
]);
export type WfcReservationStatus = z.infer<typeof wfcReservationStatusSchema>;

/** Statuses that hold the seat (the exclusion constraint of the table). */
export const WFC_ACTIVE_RESERVATION_STATUSES: readonly WfcReservationStatus[] =
  ["pending_payment", "confirmed", "checked_in"];

export const wfcDayPassStatusSchema = z.enum(["paid", "refunded"]);
export type WfcDayPassStatus = z.infer<typeof wfcDayPassStatusSchema>;

// ---- Read models ------------------------------------------------------------

export const wfcSeatSchema = z.strictObject({
  id: uuidSchema,
  outletId: uuidSchema,
  zoneId: uuidSchema,
  code: z.string().min(1).max(20),
  status: wfcSeatStatusSchema,
  createdAt: isoDateTimeSchema,
});
export type WfcSeat = z.infer<typeof wfcSeatSchema>;

export const wfcSeatReservationSchema = z.strictObject({
  id: uuidSchema,
  outletId: uuidSchema,
  seatId: uuidSchema,
  productId: uuidSchema,
  customerProfileId: uuidSchema,
  startsAt: isoDateTimeSchema,
  endsAt: isoDateTimeSchema,
  status: wfcReservationStatusSchema,
  priceIdr: nonnegativeIdr,
  paidIdr: nonnegativeIdr,
  refundedIdr: nonnegativeIdr,
  createdAt: isoDateTimeSchema,
});
export type WfcSeatReservation = z.infer<typeof wfcSeatReservationSchema>;

export const wfcDayPassPurchaseSchema = z.strictObject({
  id: uuidSchema,
  outletId: uuidSchema,
  productId: uuidSchema,
  customerProfileId: uuidSchema,
  paymentRef: z.string().min(1).max(40),
  status: wfcDayPassStatusSchema,
  priceIdr: nonnegativeIdr,
  paidIdr: nonnegativeIdr,
  refundedIdr: nonnegativeIdr,
  /** When the day pass entitlement lapses (end of the outlet business day). */
  expiresAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type WfcDayPassPurchase = z.infer<typeof wfcDayPassPurchaseSchema>;

// ---- Requests ---------------------------------------------------------------

/** The code is unique per zone, so a replay answers 409 instead of a second seat. */
export const createWfcSeatSchema = clientInputSchema({
  outletId: uuidSchema,
  zoneId: uuidSchema,
  code: z.string().trim().min(1).max(20),
  status: wfcSeatStatusSchema.optional(),
});
export type CreateWfcSeatInput = z.input<typeof createWfcSeatSchema>;

/** Lists the seats of the outlets the caller may operate (RLS and permission). */
export const listWfcSeatsQuerySchema = clientInputSchema({
  zoneId: uuidSchema.optional(),
});
export type ListWfcSeatsInput = z.input<typeof listWfcSeatsQuerySchema>;

/** Marks a single-type product of a coworking facility as a WFC product. */
export const setWfcProductKindSchema = clientInputSchema({
  productId: uuidSchema,
  wfcKind: wfcProductKindSchema.nullable(),
});
export type SetWfcProductKindInput = z.input<typeof setWfcProductKindSchema>;

export const reserveWfcSeatSchema = clientInputSchema({
  seatId: uuidSchema,
  productId: uuidSchema,
  customerProfileId: uuidSchema,
  startsAt: isoDateTimeSchema,
  endsAt: isoDateTimeSchema,
  idempotencyKey: idempotencyKeySchema,
});
export type ReserveWfcSeatInput = z.input<typeof reserveWfcSeatSchema>;

/**
 * `paidIdr` is what the provider captured; it must equal the stored price. A
 * zero or short amount parses and is refused by the service with 409.
 */
export const confirmWfcReservationPaidSchema = clientInputSchema({
  reservationId: uuidSchema,
  paidIdr: nonnegativeIdr,
});
export type ConfirmWfcReservationPaidInput = z.input<
  typeof confirmWfcReservationPaidSchema
>;

export const cancelWfcReservationSchema = clientInputSchema({
  reservationId: uuidSchema,
});
export type CancelWfcReservationInput = z.input<
  typeof cancelWfcReservationSchema
>;

export const refundWfcReservationSchema = clientInputSchema({
  reservationId: uuidSchema,
  refundIdr: positiveIdr,
});
export type RefundWfcReservationInput = z.input<
  typeof refundWfcReservationSchema
>;

export const purchaseDayPassSchema = clientInputSchema({
  productId: uuidSchema,
  customerProfileId: uuidSchema,
  paidIdr: nonnegativeIdr,
  paymentRef: z.string().trim().min(1).max(40),
});
export type PurchaseDayPassInput = z.input<typeof purchaseDayPassSchema>;

export const refundDayPassSchema = clientInputSchema({
  paymentRef: z.string().trim().min(1).max(40),
  refundIdr: positiveIdr,
});
export type RefundDayPassInput = z.input<typeof refundDayPassSchema>;
