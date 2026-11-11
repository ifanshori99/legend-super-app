// WFC min-spend monitor and RevPASH (PRD v1.7 §3 F25/F39, FAC-14; bead
// legend-bz9h). The monitor only nudges: it never charges, blocks or ends a
// session (rule M6). Spend is paid money only (M7). No schema here carries a
// price; every amount is read from the ledger on the server.

import {
  z,
  clientInputSchema,
  idrSchema,
  isoDateTimeSchema,
  uuidSchema,
} from "../core/index.ts";
import { defineDomainEvent } from "../events/index.ts";

/** Rule M6: at most this many nudges per spend window. */
export const maxNudgesPerWindow = 2;
/** A nudge waits until this many minutes of the window have passed. */
export const MIN_SPEND_FIRST_NUDGE_MINUTES = 30;
/** Two nudges of one window are at least this many minutes apart. */
export const MIN_SPEND_NUDGE_GAP_MINUTES = 15;
/** The rolling spend window is one hour (`min_spend_per_hour_idr`). */
export const MIN_SPEND_WINDOW_MINUTES = 60;
/** Longest RevPASH range one call reads (31 days of hour buckets). */
export const REVPASH_MAX_RANGE_DAYS = 31;

export const wfcSpendWindowStatusSchema = z.enum(["ok", "below", "nudged"]);
export type WfcSpendWindowStatus = z.infer<typeof wfcSpendWindowStatusSchema>;

/**
 * One nudge sent to a table (rule M6). Ids and amounts only: no names, no
 * contact data. The notification text lives in the notification rows.
 */
export const wfcMinSpendNudgedEvent = defineDomainEvent({
  name: "facility_session.min_spend_nudged",
  payload: z.strictObject({
    windowId: uuidSchema,
    tableSessionId: uuidSchema,
    zoneId: uuidSchema,
    nudgeCount: z.number().int().min(1).max(maxNudgesPerWindow),
    minSpendIdr: idrSchema,
    spentIdr: idrSchema,
  }),
});

export const minSpendSessionResultSchema = z.strictObject({
  tableSessionId: uuidSchema,
  windowStart: isoDateTimeSchema,
  windowEnd: isoDateTimeSchema,
  minSpendIdr: idrSchema,
  spentIdr: idrSchema,
  status: wfcSpendWindowStatusSchema,
  nudged: z.boolean(),
});
export type MinSpendSessionResult = z.infer<typeof minSpendSessionResultSchema>;

export const minSpendSummarySchema = z.strictObject({
  zoneId: uuidSchema,
  /** False when the zone is off-peak, has no policy or no minimum spend. */
  evaluated: z.boolean(),
  sessions: z.array(minSpendSessionResultSchema),
  nudgesSent: z.number().int().min(0),
});
export type MinSpendSummary = z.infer<typeof minSpendSummarySchema>;

const rangeCheck = (value: { from: string; to: string }) => {
  const from = Date.parse(value.from);
  const to = Date.parse(value.to);
  return to > from && to - from <= REVPASH_MAX_RANGE_DAYS * 24 * 60 * 60 * 1000;
};

export const getRevpashInputSchema = clientInputSchema({
  outletId: uuidSchema,
  zoneId: uuidSchema.optional(),
  from: isoDateTimeSchema,
  to: isoDateTimeSchema,
}).refine(rangeCheck, {
  path: ["to"],
  message: `to must be after from, at most ${REVPASH_MAX_RANGE_DAYS} days`,
});
export type GetRevpashInput = z.input<typeof getRevpashInputSchema>;

/**
 * One zone-hour. `revpashIdr` is null (never 0, never a division by zero)
 * when the zone has no active seat in that hour.
 */
export const revpashRowSchema = z.strictObject({
  zoneId: uuidSchema,
  hourStart: isoDateTimeSchema,
  revenueIdr: idrSchema,
  seatHours: z.number().int().min(0),
  revpashIdr: idrSchema.nullable(),
});
export type RevpashRow = z.infer<typeof revpashRowSchema>;
