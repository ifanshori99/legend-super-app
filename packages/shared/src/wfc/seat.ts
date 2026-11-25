// Paid WFC contract of brief 1270 card W1: seats, hourly quota, product split
// and the business settings (PRD v1.7 §3 F25/F39, FAC-14). Every request schema
// is built with `clientInputSchema`: the tenant comes from the domain or token
// (TEN-02) and an unknown field is rejected. A request never carries a total
// price: the server adds seat fee and credit. No sale is defined here (W2).

import {
  businessDateSchema,
  clientInputSchema,
  idrSchema,
  isoDateTimeSchema,
  uuidSchema,
  z,
} from "../core/index.ts";

const positiveIdr = idrSchema.refine((value) => value > 0, {
  message: "Jumlah harus lebih dari 0",
});
const nonnegativeIdr = idrSchema.refine((value) => value >= 0);

/** Longest seat reservation: one day. */
export const WFC_MAX_RESERVATION_MINUTES = 24 * 60;
/** Cells of one week: 7 days of 24 hours. */
export const WFC_QUOTA_CELLS = 7 * 24;
/** Most seats one quota cell may hold (the active WFC seats cap it further). */
export const WFC_MAX_QUOTA_SEATS = 1000;

/** The monthly pass joins with card W4. */
export const wfcProductKindSchema = z.enum(["day_pass", "seat_reservation"]);
export type WfcProductKind = z.infer<typeof wfcProductKindSchema>;

/** `off_peak` = outside the peak schedule only, `all_day` = any hour. */
export const wfcAccessSchema = z.enum(["off_peak", "all_day"]);
export type WfcAccess = z.infer<typeof wfcAccessSchema>;

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
export const WFC_ACTIVE_RESERVATION_STATUSES = [
  "pending_payment",
  "confirmed",
  "checked_in",
] as const satisfies readonly WfcReservationStatus[];

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

/** One cell of the weekly quota; a missing cell is 0 seats. */
export const wfcHourlyQuotaSchema = z.strictObject({
  /** Outlet-local weekday, 0 = Sunday (as in the facility hours). */
  dayOfWeek: z.number().int().min(0).max(6),
  hour: z.number().int().min(0).max(23),
  seats: z.number().int().min(0).max(WFC_MAX_QUOTA_SEATS),
});
export type WfcHourlyQuota = z.infer<typeof wfcHourlyQuotaSchema>;

/** The split of a WFC product; the price is always seat fee + credit. */
export const wfcProductSplitSchema = z
  .strictObject({
    kind: wfcProductKindSchema,
    access: wfcAccessSchema,
    /** Seat fee, recognised when the slot starts. */
    seatFeeIdr: positiveIdr,
    /** Food and drink credit; a pass without credit is not sold (release 1). */
    creditIdr: positiveIdr,
    /** Slot length in minutes: required for a seat reservation, else null. */
    durationMinutes: z
      .number()
      .int()
      .min(1)
      .max(WFC_MAX_RESERVATION_MINUTES)
      .nullable(),
  })
  .refine(
    (value) =>
      (value.kind === "seat_reservation") === (value.durationMinutes !== null),
    {
      message: "Durasi wajib diisi untuk reservasi kursi, dan hanya untuk itu.",
      path: ["durationMinutes"],
    },
  );
export type WfcProductSplit = z.infer<typeof wfcProductSplitSchema>;

export const wfcProductSchema = z.strictObject({
  productId: uuidSchema,
  outletId: uuidSchema,
  priceIdr: nonnegativeIdr,
  isActive: z.boolean(),
  wfc: wfcProductSplitSchema.nullable(),
  updatedAt: isoDateTimeSchema,
});
export type WfcProduct = z.infer<typeof wfcProductSchema>;

/**
 * One approved version of an outlet's WFC numbers. Every number is required:
 * an outlet without a complete version in force cannot sell.
 */
export const wfcBusinessSettingsSchema = z.strictObject({
  id: uuidSchema,
  outletId: uuidSchema,
  version: z.number().int().min(1),
  effectiveFrom: businessDateSchema,
  totalSeats: z.number().int().min(1),
  wfcSeats: z.number().int().min(1),
  openHoursPerMonth: z.number().int().min(1).max(744),
  fixedCostIdr: positiveIdr,
  targetRevenueIdr: positiveIdr,
  targetProfitIdr: nonnegativeIdr,
  targetOccupancyBp: z.number().int().min(1).max(10_000),
  spendPerPersonIdr: positiveIdr,
  /** Cost of goods, basis points of the food and drink sales. */
  cogsBp: z.number().int().min(1).max(9_999),
  avgStayMinutes: z.number().int().min(1).max(WFC_MAX_RESERVATION_MINUTES),
  /** Minutes after the slot start before a no-show releases the seat. */
  noShowMinutes: z.number().int().min(1).max(240),
});
export type WfcBusinessSettings = z.infer<typeof wfcBusinessSettingsSchema>;

// ---- Requests ---------------------------------------------------------------

/** The code is unique per zone, so a replay answers 409 instead of a second seat. */
export const createWfcSeatSchema = clientInputSchema({
  outletId: uuidSchema,
  zoneId: uuidSchema,
  code: z.string().trim().min(1).max(20),
});
export type CreateWfcSeatInput = z.input<typeof createWfcSeatSchema>;

export const setWfcSeatStatusSchema = clientInputSchema({
  seatId: uuidSchema,
  status: wfcSeatStatusSchema,
});
export type SetWfcSeatStatusInput = z.input<typeof setWfcSeatStatusSchema>;

/** Lists the seats of the outlets the caller may operate (RLS and permission). */
export const listWfcSeatsQuerySchema = clientInputSchema({
  zoneId: uuidSchema.optional(),
});
export type ListWfcSeatsInput = z.input<typeof listWfcSeatsQuerySchema>;

/** Sets the given cells; a cell left out keeps its value. */
export const putWfcHourlyQuotasSchema = clientInputSchema({
  outletId: uuidSchema,
  quotas: z
    .array(wfcHourlyQuotaSchema)
    .min(1)
    .max(WFC_QUOTA_CELLS)
    .refine(
      (cells) =>
        new Set(cells.map((cell) => cell.dayOfWeek * 24 + cell.hour)).size ===
        cells.length,
      { message: "Hari dan jam tidak boleh berulang." },
    ),
});
export type PutWfcHourlyQuotasInput = z.input<typeof putWfcHourlyQuotasSchema>;

export const listWfcHourlyQuotasQuerySchema = clientInputSchema({
  outletId: uuidSchema,
});
export type ListWfcHourlyQuotasInput = z.input<
  typeof listWfcHourlyQuotasQuerySchema
>;

/** Marks a till-unlinked single product of a coworking facility, or clears it. */
export const setWfcProductSchema = clientInputSchema({
  productId: uuidSchema,
  wfc: wfcProductSplitSchema.nullable(),
  expectedUpdatedAt: isoDateTimeSchema,
});
export type SetWfcProductInput = z.input<typeof setWfcProductSchema>;
