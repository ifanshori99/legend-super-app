// WFC seats, seat reservations and day passes (PRD v1.7 §3 F25/F39, FAC-14;
// bead legend-bz9h). Every request schema is built with `clientInputSchema`:
// the tenant comes from the domain or token (TEN-02), an unknown field is
// rejected, and NO schema carries a price: the price is always read from the
// product on the server. A sale carries a `paymentRef` that must match a real
// captured payment (services/wfc-payment.ts); no client sends an amount.

import {
  z,
  clientInputSchema,
  idempotencyKeySchema,
  idrSchema,
  isoDateTimeSchema,
  uuidSchema,
} from "../core/index.ts";

/** Longest seat reservation: one day (equals the product duration cap). */
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
  /** Longest reservation in minutes; required for `seat_reservation`. */
  durationMinutes: z.number().int().min(1).max(1440).nullable().optional(),
});
export type SetWfcProductKindInput = z.input<typeof setWfcProductKindSchema>;

/**
 * No `endsAt`: the server sets it to `startsAt` plus the product's duration, so
 * a client cannot book a slot longer or shorter than the product it pays for
 * (a strict schema rejects the field). The read model still returns `endsAt`.
 */
export const reserveWfcSeatSchema = clientInputSchema({
  seatId: uuidSchema,
  productId: uuidSchema,
  customerProfileId: uuidSchema,
  startsAt: isoDateTimeSchema,
  idempotencyKey: idempotencyKeySchema,
});
export type ReserveWfcSeatInput = z.input<typeof reserveWfcSeatSchema>;

/**
 * `paymentRef` names the captured POS tender (its id or reference; letter
 * case does not matter, the service stores it lowercase); the service checks it
 * is a real, unused capture of at least the price for the product's menu item.
 */
export const confirmWfcReservationPaidSchema = clientInputSchema({
  reservationId: uuidSchema,
  paymentRef: z.string().trim().min(1).max(100),
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
  paymentRef: z.string().trim().min(1).max(40),
});
export type PurchaseDayPassInput = z.input<typeof purchaseDayPassSchema>;

export const refundDayPassSchema = clientInputSchema({
  paymentRef: z.string().trim().min(1).max(40),
  refundIdr: positiveIdr,
});
export type RefundDayPassInput = z.input<typeof refundDayPassSchema>;
