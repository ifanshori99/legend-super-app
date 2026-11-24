// Fiscal periods: close with balance snapshot, reopen only with reason and
// approval (PRD v1.7 §3.19 "Tutup Periode [P0] — Tutup bulan dengan snapshot
// saldo; pembukaan ulang memerlukan alasan dan approval"; §6 F
// `fiscal_periods`: legal_entity_id, period, status open/closed, closed_by,
// reopened_reason; ACC-02 "Transaksi di periode yang sudah ditutup ditolak
// kecuali periode dibuka ulang dengan approval").
//
// Fixes the two gaps of the 119connect source (docs/plan/119connect-inventory.md):
//
// 1. Approved reopen. A reopen is a request with a reason, decided by someone
//    other than the requester (AUTH-06). Only the latest closed period of a
//    legal entity can be reopened (a later closed period would keep a stale
//    snapshot); close goes in order too (earlier periods first).
//
// 2. Close-vs-post race. `version` increases on every close and reopen. The
//    BE (bead legend-xm30) serialises on the period row inside the tenant
//    transaction:
//      post:   SELECT … FROM fiscal_periods WHERE id = $1 FOR SHARE
//              → assertPostingAllowed(period, entryDate) → INSERT entry/lines
//      close/reopen: first lock the legal entity row FOR UPDATE, then lock the
//              period row FOR UPDATE, check all entity periods and update.
//              Close takes its snapshot before setting status and version.
//    The shared entity lock serializes ordering checks across different periods;
//    a period-row lock alone cannot prevent close vs reopen write skew.
//    FOR SHARE blocks FOR UPDATE and vice versa, so a close waits for in-flight
//    posts and a post that starts after the close commits reads `closed` and
//    fails PERIOD_CLOSED. A client that read the period earlier (e.g. the
//    manual-journal form) sends `expectedVersion`; assertPeriodVersion turns a
//    stale read into PERIOD_CHANGED instead of a silent post.

import { z } from "zod";
import {
  idempotencyKeySchema,
  idrSchema,
  isoDateTimeSchema,
  tenantIdSchema,
  userIdSchema,
} from "../core/index.ts";
import type { IsoDateTime, UserId } from "../core/index.ts";
import { AccessError } from "../access/errors.ts";
import { AccountingError } from "./errors.ts";
import {
  accountIdSchema,
  fiscalPeriodIdSchema,
  legalEntityIdSchema,
  periodReopenRequestIdSchema,
} from "./ids.ts";
import { periodBounds, periodKeySchema, periodOf } from "./period-key.ts";

export const fiscalPeriodStatusSchema = z.enum(["open", "closed"]);
export type FiscalPeriodStatus = z.infer<typeof fiscalPeriodStatusSchema>;

export const fiscalPeriodSchema = z
  .strictObject({
    id: fiscalPeriodIdSchema,
    tenantId: tenantIdSchema,
    legalEntityId: legalEntityIdSchema,
    period: periodKeySchema,
    status: fiscalPeriodStatusSchema,
    /** Starts at 1; +1 on every close and reopen (optimistic concurrency token). */
    version: z.number().int().min(1).safe(),
    closedBy: userIdSchema.nullable(),
    closedAt: isoDateTimeSchema.nullable(),
    /** Reason of the latest approved reopen (null until reopened once). */
    reopenedReason: z.string().trim().min(1).max(500).nullable(),
    reopenedBy: userIdSchema.nullable(),
    reopenedAt: isoDateTimeSchema.nullable(),
  })
  .superRefine((row, ctx) => {
    const closed = row.status === "closed";
    if (closed !== (row.closedBy !== null && row.closedAt !== null))
      ctx.addIssue({
        code: "custom",
        path: ["closedBy"],
        message: "closedBy/closedAt are set exactly when closed",
      });
    const reopened = [row.reopenedReason, row.reopenedBy, row.reopenedAt];
    if (reopened.some((value) => value === null) && reopened.some((v) => v))
      ctx.addIssue({
        code: "custom",
        path: ["reopenedReason"],
        message: "reopenedReason/By/At are set together",
      });
  });
export type FiscalPeriod = z.infer<typeof fiscalPeriodSchema>;

type PeriodRow = Pick<
  FiscalPeriod,
  "id" | "legalEntityId" | "period" | "status" | "version"
>;

/** A period row that also says who closed it (separation of duties). */
type ClosedByRow = PeriodRow & Pick<FiscalPeriod, "closedBy">;

/** ACC-02: the one check before inserting any journal entry. */
export function assertPostingAllowed(
  period: Pick<FiscalPeriod, "period" | "status">,
  entryDate: string,
): void {
  if (periodOf(entryDate) !== period.period)
    throw new AccountingError("PERIOD_MISMATCH");
  if (period.status !== "open") throw new AccountingError("PERIOD_CLOSED");
}

/** Stale read guard for clients that send `expectedVersion`. */
export function assertPeriodVersion(
  period: Pick<FiscalPeriod, "version">,
  expectedVersion: number,
): void {
  if (period.version !== expectedVersion)
    throw new AccountingError("PERIOD_CHANGED");
}

/**
 * Close decision (§3.19 Tutup Periode). `today` is the entity's business date
 * (Asia/Jakarta by default): only a month that has ended can close, and every
 * earlier period of the same entity must be closed first.
 */
export function decidePeriodClose<Row extends PeriodRow>(input: {
  period: Row;
  entityPeriods: readonly PeriodRow[];
  today: string;
  actorId: UserId;
  now: IsoDateTime;
}): Row & {
  status: "closed";
  closedBy: UserId;
  closedAt: IsoDateTime;
} {
  const { period } = input;
  if (period.status === "closed")
    throw new AccountingError("PERIOD_ALREADY_CLOSED");
  if (input.today <= periodBounds(period.period).end)
    throw new AccountingError("PERIOD_NOT_ENDED");
  const earlierOpen = input.entityPeriods.some(
    (row) =>
      row.legalEntityId === period.legalEntityId &&
      row.period < period.period &&
      row.status === "open",
  );
  if (earlierOpen) throw new AccountingError("PERIOD_CLOSE_OUT_OF_ORDER");
  return {
    ...period,
    status: "closed",
    version: period.version + 1,
    closedBy: input.actorId,
    closedAt: input.now,
  };
}

// ---- Reopen requests -------------------------------------------------------

export const periodReopenRequestStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "cancelled",
]);
export type PeriodReopenRequestStatus = z.infer<
  typeof periodReopenRequestStatusSchema
>;

export const periodReopenRequestSchema = z
  .strictObject({
    id: periodReopenRequestIdSchema,
    tenantId: tenantIdSchema,
    legalEntityId: legalEntityIdSchema,
    fiscalPeriodId: fiscalPeriodIdSchema,
    period: periodKeySchema,
    reason: z.string().trim().min(1).max(500),
    status: periodReopenRequestStatusSchema,
    requestedBy: userIdSchema,
    requestedAt: isoDateTimeSchema,
    decidedBy: userIdSchema.nullable(),
    decidedAt: isoDateTimeSchema.nullable(),
    decisionNote: z.string().trim().min(1).max(500).nullable(),
  })
  .superRefine((row, ctx) => {
    const decided = row.status === "approved" || row.status === "rejected";
    if (decided !== (row.decidedBy !== null && row.decidedAt !== null))
      ctx.addIssue({
        code: "custom",
        path: ["decidedBy"],
        message: "decidedBy/decidedAt are set exactly when decided",
      });
    if (row.decidedBy !== null && row.decidedBy === row.requestedBy)
      ctx.addIssue({
        code: "custom",
        path: ["decidedBy"],
        message: "Approver must differ from requester (AUTH-06)",
      });
  });
export type PeriodReopenRequest = z.infer<typeof periodReopenRequestSchema>;

export const requestPeriodReopenInputSchema = z.strictObject({
  reason: z.string().trim().min(1).max(500),
});

/**
 * Opening a reopen request: the period must be closed and a reason given.
 * With `entityPeriods`, it must also be the latest closed period of its
 * entity: an earlier one could never be approved (PERIOD_REOPEN_OUT_OF_ORDER
 * in decidePeriodReopen), so the request is refused up front.
 */
export function assertReopenRequestable(
  period: Pick<FiscalPeriod, "status"> &
    Partial<Pick<FiscalPeriod, "legalEntityId" | "period">>,
  reason: string,
  entityPeriods?: readonly Pick<
    FiscalPeriod,
    "legalEntityId" | "period" | "status"
  >[],
): void {
  if (reason.trim() === "") throw new AccountingError("REOPEN_REASON_REQUIRED");
  if (period.status !== "closed")
    throw new AccountingError("PERIOD_ALREADY_OPEN");
  const laterClosed = entityPeriods?.some(
    (row) =>
      row.legalEntityId === period.legalEntityId &&
      period.period !== undefined &&
      row.period > period.period &&
      row.status === "closed",
  );
  if (laterClosed) throw new AccountingError("PERIOD_REOPEN_OUT_OF_ORDER");
}

/**
 * Approve or reject a reopen request (ACC-02). Approval needs a person other
 * than the requester (AUTH-06) and other than whoever closed the period
 * (separation of duties), and reopens only the latest closed period of the
 * entity. Returns the request status and, on approval, the reopened period.
 */
export function decidePeriodReopen<Row extends ClosedByRow>(input: {
  request: Pick<
    PeriodReopenRequest,
    "status" | "requestedBy" | "reason" | "fiscalPeriodId"
  >;
  period: Row;
  entityPeriods: readonly PeriodRow[];
  decision: "approve" | "reject";
  actorId: UserId;
  now: IsoDateTime;
}):
  | { requestStatus: "rejected"; period: null }
  | {
      requestStatus: "approved";
      period: Row & {
        status: "open";
        reopenedReason: string;
        reopenedBy: UserId;
        reopenedAt: IsoDateTime;
        closedBy: null;
        closedAt: null;
      };
    } {
  const { request, period } = input;
  if (request.status !== "pending")
    throw new AccountingError("INVALID_TRANSITION");
  if (request.fiscalPeriodId !== period.id)
    throw new AccountingError("PERIOD_MISMATCH");
  if (input.actorId === request.requestedBy)
    throw new AccessError("APPROVER_IS_REQUESTER");
  if (input.decision === "reject")
    return { requestStatus: "rejected", period: null };
  if (request.reason.trim() === "")
    throw new AccountingError("REOPEN_REASON_REQUIRED");
  if (period.status !== "closed")
    throw new AccountingError("PERIOD_ALREADY_OPEN");
  if (period.closedBy !== null && input.actorId === period.closedBy)
    throw new AccountingError("APPROVER_IS_CLOSER");
  const laterClosed = input.entityPeriods.some(
    (row) =>
      row.legalEntityId === period.legalEntityId &&
      row.period > period.period &&
      row.status === "closed",
  );
  if (laterClosed) throw new AccountingError("PERIOD_REOPEN_OUT_OF_ORDER");
  return {
    requestStatus: "approved",
    period: {
      ...period,
      status: "open",
      version: period.version + 1,
      closedBy: null,
      closedAt: null,
      reopenedReason: request.reason.trim(),
      reopenedBy: input.actorId,
      reopenedAt: input.now,
    },
  };
}

// ---- Close snapshot ------------------------------------------------------

/** Cumulative balance per account at period end, taken at close (§3.19). */
export const periodCloseSnapshotSchema = z
  .strictObject({
    fiscalPeriodId: fiscalPeriodIdSchema,
    legalEntityId: legalEntityIdSchema,
    period: periodKeySchema,
    /** The period version this close produced; reopen + re-close adds a new snapshot. */
    version: z.number().int().min(2).safe(),
    takenAt: isoDateTimeSchema,
    takenBy: userIdSchema,
    /**
     * Current status/version of the period, filled by the API on read. The
     * snapshot is history once periodStatus is "open" or periodVersion differs
     * from `version` (reopened, maybe closed again). Optional for older mocks.
     */
    periodStatus: fiscalPeriodStatusSchema.optional(),
    periodVersion: z.number().int().min(1).safe().optional(),
    balances: z.array(
      z.strictObject({
        accountId: accountIdSchema,
        debitIdr: idrSchema,
        creditIdr: idrSchema,
      }),
    ),
  })
  .superRefine((snapshot, ctx) => {
    const sum = (key: "debitIdr" | "creditIdr") =>
      snapshot.balances.reduce((total, row) => total + BigInt(row[key]), 0n);
    if (sum("debitIdr") !== sum("creditIdr"))
      ctx.addIssue({
        code: "custom",
        path: ["balances"],
        message: "Snapshot debit and credit totals must be equal",
      });
  });
export type PeriodCloseSnapshot = z.infer<typeof periodCloseSnapshotSchema>;

// ---- Close override (card 1263, founder no. 19) ----------------------------

/** Only a batch whose stock rows are incomplete may be closed over. */
export const PERIOD_CLOSE_OVERRIDABLE_CODE = "PRODUCTION_INCOMPLETE";
/** Above this many parked sources no override is offered: fix the cause first. */
export const PERIOD_CLOSE_OVERRIDE_MAX_SOURCES = 200;

const closeBlockerSourceIdSchema = z.string().trim().min(1).max(64);

/** One parked stock source that stops a close, as shown to the closer. */
export const periodCloseBlockerSchema = z.strictObject({
  sourceType: z.string().min(1).max(64),
  sourceId: closeBlockerSourceIdSchema,
  errorCode: z.string().min(1).max(64),
  outletName: z.string(),
  /** Outlet business day of the first stock row (null: none found). */
  businessDate: z.iso.date().nullable(),
  /** Output item of a production batch; null for other sources. */
  itemName: z.string().nullable(),
});
export type PeriodCloseBlocker = z.infer<typeof periodCloseBlockerSchema>;

export const periodCloseBlockersSchema = z.strictObject({
  count: z.number().int().min(0),
  /** Every blocker is PRODUCTION_INCOMPLETE and all of them are listed. */
  overridable: z.boolean(),
  sources: z
    .array(periodCloseBlockerSchema)
    .max(PERIOD_CLOSE_OVERRIDE_MAX_SOURCES),
});
export type PeriodCloseBlockers = z.infer<typeof periodCloseBlockersSchema>;

/**
 * Body of a close override. `sourceIds` must be exactly the sources blocked at
 * that moment (PERIOD_OVERRIDE_SOURCES_CHANGED otherwise).
 */
export const closeFiscalPeriodOverrideInputSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  idempotencyKey: idempotencyKeySchema,
  reason: z.string().trim().min(20).max(1000),
  sourceIds: z
    .array(closeBlockerSourceIdSchema)
    .min(1)
    .max(PERIOD_CLOSE_OVERRIDE_MAX_SOURCES)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "sourceIds must be unique",
    }),
});
export type CloseFiscalPeriodOverrideInput = z.infer<
  typeof closeFiscalPeriodOverrideInputSchema
>;
