// O2 offline batch ingest (bead legend-wasr7.6; docs/design/cloud-only-release.md
// §2 and "Keputusan CTO O2"). Once back online, the tablet sends the sales it
// took offline (cash and manual EDC only) in batches. Each sale is one event,
// keyed by its ULID `eventId`, which is also the cloud order id: a replay of the
// same event never makes a second order.
//
// Rules the cloud applies per event, in `sequenceNumber` order per run:
// - The number must continue the run exactly (cloud high-water + 1). A gap is
//   refused (`sequence_gap`) and alerted, never written off silently; a number
//   the cloud already holds under another event is refused (`number_taken`).
// - Amounts come from the payload, never recomputed. A price that differs from
//   the kit snapshot is ingested with the `price_mismatch` flag ("perlu dicek"):
//   the money was already taken.
// - An event that is stored but cannot become an order (totals that do not add
//   up, ...) is `held` with its reason: the cloud keeps it for finance, so the
//   tablet may drop it from its queue like an `ingested` or `duplicate` one.
//   A `rejected` event is not stored: the tablet keeps it and resends.

import {
  z,
  clientInputSchema,
  dataResponseSchema,
  idrSchema,
  isoDateTimeSchema,
  outletIdSchema,
  uuidSchema,
} from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import { orderIdSchema } from "../kitchen/schemas.ts";
import { orderPaidTaxSchema } from "./events.ts";
import { OFFLINE_KIT_SERVICE_TYPES } from "./offline.ts";

const nonnegativeIdr = idrSchema.refine(
  (value) => value >= 0,
  "Amount must not be negative",
);
const positiveIdr = idrSchema.refine(
  (value) => value > 0,
  "Amount must be positive",
);
const text = z.string().trim().min(1).max(150);

/** Most events one batch may carry. */
export const OFFLINE_BATCH_MAX_EVENTS = 100;

export const offlineSaleModifierSchema = z.strictObject({
  modifierId: uuidSchema,
  groupId: uuidSchema,
  name: text,
  priceIdr: nonnegativeIdr,
});

export const offlineSaleLineSchema = z.strictObject({
  menuItemId: uuidSchema,
  variantId: uuidSchema.nullable(),
  name: text,
  quantity: z.number().int().min(1).max(99),
  unitPriceIdr: nonnegativeIdr,
  modifiers: z.array(offlineSaleModifierSchema).max(20),
  modifiersTotalIdr: nonnegativeIdr,
  lineTotalIdr: nonnegativeIdr,
});
export type OfflineSaleLine = z.infer<typeof offlineSaleLineSchema>;

/** Offline tenders: cash, and a standalone EDC card payment with its slip. */
export const offlineSaleTenderSchema = z.discriminatedUnion("method", [
  z.strictObject({
    method: z.literal("cash"),
    amountIdr: positiveIdr,
    receivedIdr: nonnegativeIdr,
  }),
  z.strictObject({
    method: z.literal("edc_card"),
    amountIdr: positiveIdr,
    /** Reference number printed on the EDC slip (required offline). */
    reference: z.string().trim().min(1).max(100),
  }),
]);
export type OfflineSaleTender = z.infer<typeof offlineSaleTenderSchema>;

export const offlineSaleEventSchema = z.strictObject({
  /** ULID of the sale; also the cloud order id. */
  eventId: orderIdSchema,
  /** The kit the tablet sold under (prices, shift, run). */
  kitId: uuidSchema,
  /** The offline run (`L<n>`) the sale is numbered on. */
  sequenceId: uuidSchema,
  sequenceNumber: z.number().int().min(1).max(999_999_999),
  serviceType: z.enum(OFFLINE_KIT_SERVICE_TYPES),
  paidAt: isoDateTimeSchema,
  lines: z.array(offlineSaleLineSchema).min(1).max(200),
  subtotalIdr: nonnegativeIdr,
  serviceChargeIdr: nonnegativeIdr,
  taxIdr: nonnegativeIdr,
  roundingIdr: idrSchema,
  totalIdr: nonnegativeIdr,
  pricesIncludeTax: z.boolean(),
  /** The tax rows behind `taxIdr`, as the tablet computed them. */
  taxes: z.array(orderPaidTaxSchema).max(50).optional(),
  tenders: z.array(offlineSaleTenderSchema).min(1).max(4),
});
export type OfflineSaleEvent = z.infer<typeof offlineSaleEventSchema>;

export const submitPosOfflineBatchInputSchema = clientInputSchema({
  events: z.array(offlineSaleEventSchema).min(1).max(OFFLINE_BATCH_MAX_EVENTS),
});
export type SubmitPosOfflineBatchInput = z.infer<
  typeof submitPosOfflineBatchInputSchema
>;

export const OFFLINE_EVENT_STATUSES = [
  "ingested",
  "held",
  "duplicate",
  "rejected",
] as const;
export const offlineEventStatusSchema = z.enum(OFFLINE_EVENT_STATUSES);
export type OfflineEventStatus = z.infer<typeof offlineEventStatusSchema>;

/** Statuses after which the tablet may drop the event from its queue. */
export const OFFLINE_EVENT_SETTLED: readonly OfflineEventStatus[] = [
  "ingested",
  "held",
  "duplicate",
];

/**
 * "Perlu dicek" flags of an ingested sale: the order exists, finance reviews.
 * - price_mismatch: a line price differs from the kit snapshot.
 * - kit_expired: paid after the kit's 24 hours (or before it was issued).
 * - shift_closed: the kit's shift was already closed; the cash is outside
 *   any drawer and the supervisors are alerted.
 * - late_day: the business day was closed; posted to the next open day.
 * - tax_missing / tax_mismatch: no usable tax rows; none were snapshotted.
 */
export const OFFLINE_SALE_FLAGS = [
  "price_mismatch",
  "kit_expired",
  "shift_closed",
  "late_day",
  "tax_missing",
  "tax_mismatch",
  /** Service charge, tax or rounding differ from the kit's tax snapshot (review O2 P1). */
  "amount_mismatch",
  /** paidAt after the cloud's clock; booked on today's business date (review O2 P3 2). */
  "paid_in_future",
  /**
   * Review O3 P1: the sale's eventId was stored under another kit; the tablet
   * reported it and the cloud booked it under its own order id, its cash in
   * the offline clearing account (like `shift_closed`).
   */
  "event_conflict",
] as const;
export const offlineSaleFlagSchema = z.enum(OFFLINE_SALE_FLAGS);
export type OfflineSaleFlag = z.infer<typeof offlineSaleFlagSchema>;

export const offlineEventResultSchema = z.strictObject({
  eventId: orderIdSchema,
  status: offlineEventStatusSchema,
  /** Why the event was held or rejected; null otherwise. */
  reason: z.string().max(100).nullable(),
  flags: z.array(offlineSaleFlagSchema),
  /** The `L<n>-000001` number the sale holds in the cloud, when stored. */
  receiptNumber: z.string().max(30).nullable(),
});
export type OfflineEventResult = z.infer<typeof offlineEventResultSchema>;

export const posOfflineBatchResultSchema = z.strictObject({
  results: z.array(offlineEventResultSchema),
  /** The cloud high-water of every run the batch named. */
  runs: z.array(
    z.strictObject({
      sequenceId: uuidSchema,
      lastNumber: z.number().int().nonnegative().max(999_999_999),
    }),
  ),
});
export type PosOfflineBatchResult = z.infer<typeof posOfflineBatchResultSchema>;

export const submitPosOfflineBatch = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/pos/offline-batch",
  params: z.strictObject({ outletId: outletIdSchema }),
  body: submitPosOfflineBatchInputSchema,
  response: dataResponseSchema(posOfflineBatchResultSchema),
});

/**
 * Review O3 P1 (CTO 27 Nov): the tablet's report of a sale the batch refused
 * with OFFLINE_EVENT_CONFLICT (its eventId is stored under another kit). The
 * cloud books it under an order id derived from (kit, eventId), flagged
 * `event_conflict`: its number fills the run's slot, its cash goes to the
 * offline clearing account, supervisors and owners are alerted. Idempotent per
 * (kit, eventId): a resend answers `duplicate`. A sale that turns out not to
 * conflict is ingested as a normal batch event.
 */
export const reportPosOfflineConflictInputSchema = clientInputSchema({
  event: offlineSaleEventSchema,
});
export type ReportPosOfflineConflictInput = z.infer<
  typeof reportPosOfflineConflictInputSchema
>;

export const reportPosOfflineConflict = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/pos/offline-conflicts",
  params: z.strictObject({ outletId: outletIdSchema }),
  body: reportPosOfflineConflictInputSchema,
  response: dataResponseSchema(offlineEventResultSchema),
});
