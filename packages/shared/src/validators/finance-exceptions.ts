// Finance exceptions list (bead legend-4oclu): one read-only view over the
// rows finance must look at because an edge sync or a payout step did not
// finish cleanly. Dates are business dates (YYYY-MM-DD), both required.
import { z } from "zod";

export const FINANCE_EXCEPTION_KINDS = [
  "edge_tax_unsnapshotted",
  "edge_void_unsupported",
  "edge_receipt_skipped",
  "edge_link_dead_letter",
  "payout_fee_not_posted",
  "receipt_pending_stale",
  "release_recon_unproven",
] as const;
export type FinanceExceptionKind = (typeof FINANCE_EXCEPTION_KINDS)[number];

/**
 * `receipt_pending_stale` (legend-z13t) ignores the date window: a parked
 * auto-journal waiting for its receipt for more than this long is listed
 * whatever day it first failed.
 */
export const RECEIPT_PENDING_STALE_AFTER_HOURS = 24;

/**
 * `release_recon_unproven` (legend-912 P1-2) ignores the date window too: a
 * released QRIS hold or VA code whose reconciliation row is still open after
 * this long has no provider proof that the code is dead. The queue never
 * closes such a row on a timer; finance reads it here. Mirrors the QRIS
 * recon's `PAID_WATCH_MS` (72 hours).
 */
export const RELEASE_RECON_UNPROVEN_AFTER_HOURS = 72;

/** The widest window one request may cover. */
export const FINANCE_EXCEPTIONS_MAX_DAYS = 92;
/** Items returned per request; the summary always counts every row. */
export const FINANCE_EXCEPTIONS_MAX_ITEMS = 500;

const businessDate = z.iso.date();
const DAY_MS = 86_400_000;

export const financeExceptionsQuerySchema = z
  .strictObject({
    kind: z.enum(FINANCE_EXCEPTION_KINDS).optional(),
    outletId: z.uuid().optional(),
    from: businessDate,
    to: businessDate,
  })
  .superRefine((value, ctx) => {
    const span = (Date.parse(value.to) - Date.parse(value.from)) / DAY_MS;
    if (span < 0)
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: "to must not be before from",
      });
    else if (span + 1 > FINANCE_EXCEPTIONS_MAX_DAYS)
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: `The window is at most ${FINANCE_EXCEPTIONS_MAX_DAYS} days`,
      });
  });
export type FinanceExceptionsQuery = z.infer<
  typeof financeExceptionsQuerySchema
>;
