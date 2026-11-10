// Journals (PRD v1.7 §3.19 Jurnal Otomatis / Jurnal Manual & Berulang; §6 F
// `journal_entries` + `journal_lines`; ACC-01 "Setiap jurnal selalu
// seimbang; jurnal final tidak dapat dihapus dan koreksi dilakukan melalui
// jurnal pembalik").
//
// - `journal_entries` is append-only and holds only posted (final) entries.
//   A correction is a reversal entry (`reversalOf`) plus a new entry.
// - Invariants ported from 119connect `cekJurnal` / `balikAnyJurnal`: at least
//   two lines, each line debit XOR credit in whole rupiah, totals equal, zero
//   lines dropped before posting; a reversal mirrors every line; a journal is
//   reversed at most once and a reversal is never reversed again.
// - One entry belongs to one legal entity, so it balances per legal entity;
//   lines may carry different outlets (outlet P&L, ACC-03).
// - Manual and recurring journals are requests that become entries only after
//   approval by someone other than the requester (AUTH-06, §3.7 Matriks
//   Approval action `manual_journal`). The multi-level matrix itself runs in
//   the access contract; `approve` here is the final decision.

import { z } from "zod";
import {
  businessDateSchema,
  idempotencyKeySchema,
  idrSchema,
  isoDateTimeSchema,
  outletIdSchema,
  tenantIdSchema,
  ulidSchema,
  userIdSchema,
  uuidSchema,
} from "../core/index.ts";
import type { BusinessDate, Idr, UserId } from "../core/index.ts";
import { AccessError } from "../access/errors.ts";
import { AccountingError } from "./errors.ts";
import {
  accountIdSchema,
  fiscalPeriodIdSchema,
  journalEntryIdSchema,
  journalLineIdSchema,
  legalEntityIdSchema,
  manualJournalIdSchema,
  recurringJournalIdSchema,
} from "./ids.ts";
import { nextPeriod, periodKeySchema } from "./period-key.ts";

/** journal_entries.source_type (VARCHAR(30)): the document that produced the entry. */
export const JOURNAL_SOURCE_TYPES = [
  "sale",
  "refund",
  "customer_deposit",
  "gateway_settlement",
  "edc_settlement",
  "cogs",
  "stock_adjustment",
  "purchase",
  "supplier_invoice",
  "supplier_payment",
  "purchase_return",
  "petty_purchase",
  "production",
  "payroll",
  "loyalty",
  "depreciation",
  "asset_acquisition",
  "asset_disposal",
  "asset_revaluation",
  "dividend",
  "cash_deposit",
  "cashier_shift",
  "opening_balance",
  "manual",
  "recurring",
  "reversal",
] as const;
export const journalSourceTypeSchema = z.enum(JOURNAL_SOURCE_TYPES);
export type JournalSourceType = z.infer<typeof journalSourceTypeSchema>;

/** Source document id: UUID aggregates, or ULID aggregates (orders) as ULID text (D-CORE-1). */
export const journalSourceIdSchema = z.union([ulidSchema, uuidSchema]);

const nonNegativeIdr = idrSchema.refine(
  (value) => value >= 0,
  "Amount must be >= 0",
);

const lineShape = {
  accountId: accountIdSchema,
  debitIdr: nonNegativeIdr,
  creditIdr: nonNegativeIdr,
  outletId: outletIdSchema.nullable(),
  costCenter: z.string().trim().min(1).max(30).nullable(),
};

function lineSideIssue(line: { debitIdr: number; creditIdr: number }) {
  return line.debitIdr > 0 === line.creditIdr > 0;
}

/** A line as entered or built by a posting rule (no ids yet). */
export const journalLineInputSchema = z
  .strictObject(lineShape)
  .refine((line) => !lineSideIssue(line), {
    message: "Fill debit or credit, exactly one",
  });
export type JournalLineInput = z.infer<typeof journalLineInputSchema>;

export const journalLineSchema = z
  .strictObject({ id: journalLineIdSchema, ...lineShape })
  .refine((line) => !lineSideIssue(line), {
    message: "Fill debit or credit, exactly one",
  });
export type JournalLine = z.infer<typeof journalLineSchema>;

type Sided = { debitIdr: number; creditIdr: number };

export type JournalBalance = {
  balanced: boolean;
  totalDebitIdr: Idr;
  totalCreditIdr: Idr;
  issues: string[];
};

/** ACC-01 check, never throws (UI shows `issues`). */
export function checkJournalBalance(lines: readonly Sided[]): JournalBalance {
  const issues: string[] = [];
  if (lines.length < 2) issues.push("A journal needs at least two lines");
  let debit = 0n;
  let credit = 0n;
  lines.forEach((line, index) => {
    const valid = (value: number) => Number.isSafeInteger(value) && value >= 0;
    if (!valid(line.debitIdr) || !valid(line.creditIdr))
      issues.push(`Line ${index + 1}: amounts are whole rupiah >= 0`);
    else if (lineSideIssue(line))
      issues.push(`Line ${index + 1}: fill debit or credit, exactly one`);
    if (valid(line.debitIdr)) debit += BigInt(line.debitIdr);
    if (valid(line.creditIdr)) credit += BigInt(line.creditIdr);
  });
  if (debit !== credit) issues.push("Total debit must equal total credit");
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (debit > max || credit > max)
    issues.push("Journal totals exceed safe rupiah range");
  return {
    balanced: issues.length === 0,
    totalDebitIdr: Number(debit > max ? 0n : debit) as Idr,
    totalCreditIdr: Number(credit > max ? 0n : credit) as Idr,
    issues,
  };
}

/** Throws JOURNAL_LINE_INVALID / JOURNAL_UNBALANCED; returns the total. */
export function assertJournalBalanced(lines: readonly Sided[]): Idr {
  const result = checkJournalBalance(lines);
  if (result.balanced) return result.totalDebitIdr;
  const lineProblem = result.issues.some((issue) => issue.startsWith("Line"));
  throw new AccountingError(
    lineProblem ? "JOURNAL_LINE_INVALID" : "JOURNAL_UNBALANCED",
    result.issues.join("; "),
  );
}

/** Drops all-zero lines (posting rules emit them for unused amounts). */
export function dropZeroLines<Line extends Sided>(
  lines: readonly Line[],
): Line[] {
  return lines.filter((line) => line.debitIdr !== 0 || line.creditIdr !== 0);
}

/** Mirror image: every debit becomes a credit and vice versa. */
export function reverseLines<Line extends Sided>(
  lines: readonly Line[],
): Line[] {
  return lines.map((line) => ({
    ...line,
    debitIdr: line.creditIdr,
    creditIdr: line.debitIdr,
  }));
}

const entryShape = {
  id: journalEntryIdSchema,
  tenantId: tenantIdSchema,
  legalEntityId: legalEntityIdSchema,
  /** Main outlet of the entry; null for entity-level entries (payroll, depreciation). */
  outletId: outletIdSchema.nullable(),
  entryDate: businessDateSchema,
  fiscalPeriodId: fiscalPeriodIdSchema,
  sourceType: journalSourceTypeSchema,
  sourceId: journalSourceIdSchema.nullable(),
  description: z.string().trim().min(1).max(255),
  reversalOf: journalEntryIdSchema.nullable(),
  /** null = posted automatically by the system (event or scheduled job). */
  postedBy: userIdSchema.nullable(),
  postedAt: isoDateTimeSchema,
};

/** A posted (final) journal entry with its lines. */
export const journalEntrySchema = z
  .strictObject({ ...entryShape, lines: z.array(journalLineSchema).min(2) })
  .superRefine((entry, ctx) => {
    for (const issue of checkJournalBalance(entry.lines).issues)
      ctx.addIssue({ code: "custom", path: ["lines"], message: issue });
    if ((entry.sourceType === "reversal") !== (entry.reversalOf !== null))
      ctx.addIssue({
        code: "custom",
        path: ["reversalOf"],
        message: "reversalOf is set exactly when sourceType is reversal",
      });
    if (entry.reversalOf === entry.id)
      ctx.addIssue({
        code: "custom",
        path: ["reversalOf"],
        message: "An entry cannot reverse itself",
      });
  });
export type JournalEntry = z.infer<typeof journalEntrySchema>;

/** List row: header + total, no lines. */
export const journalEntrySummarySchema = z.strictObject({
  ...entryShape,
  totalIdr: idrSchema,
  lineCount: z.number().int().min(2),
  /** Id of the entry that reversed this one, if any (derived). */
  reversedBy: journalEntryIdSchema.nullable(),
});
export type JournalEntrySummary = z.infer<typeof journalEntrySummarySchema>;

/**
 * Reversal guard (ACC-01). `reversedBy` is the id of an existing reversal of
 * `entry`, looked up under the same row lock as the insert.
 */
export function assertReversible(
  entry: { reversalOf: string | null },
  reversedBy: string | null,
): void {
  if (entry.reversalOf !== null)
    throw new AccountingError("JOURNAL_NOT_REVERSIBLE");
  if (reversedBy !== null)
    throw new AccountingError("JOURNAL_ALREADY_REVERSED");
}

/**
 * Lines of the reversal entry. Description and date come from the request;
 * the reversal date must fall in an open period (assertPostingAllowed), which
 * is how a closed-period entry is corrected without reopening it.
 */
export function buildReversalLines(
  entry: Pick<JournalEntry, "lines" | "reversalOf">,
  reversedBy: string | null,
): JournalLineInput[] {
  assertReversible(entry, reversedBy);
  return reverseLines(
    entry.lines.map((line) => ({
      accountId: line.accountId,
      debitIdr: line.debitIdr,
      creditIdr: line.creditIdr,
      outletId: line.outletId,
      costCenter: line.costCenter,
    })),
  );
}

/** Posted entries are final: every edit/delete path calls this (ACC-01). */
export function rejectPostedJournalMutation(): never {
  throw new AccountingError("JOURNAL_IMMUTABLE");
}

export const reverseJournalInputSchema = z.strictObject({
  entryDate: businessDateSchema,
  reason: z.string().trim().min(1).max(200),
  idempotencyKey: idempotencyKeySchema,
});

// ---- Manual journals (request → approval → posted entry) -----------------

export const MANUAL_JOURNAL_STATUSES = [
  "draft",
  "pending_approval",
  "rejected",
  "cancelled",
  "posted",
] as const;
export const manualJournalStatusSchema = z.enum(MANUAL_JOURNAL_STATUSES);
export type ManualJournalStatus = z.infer<typeof manualJournalStatusSchema>;

const balancedLines = z
  .array(journalLineInputSchema)
  .min(2)
  .max(200)
  .superRefine((lines, ctx) => {
    for (const issue of checkJournalBalance(lines).issues)
      ctx.addIssue({ code: "custom", message: issue });
  });

export const manualJournalSchema = z
  .strictObject({
    id: manualJournalIdSchema,
    tenantId: tenantIdSchema,
    legalEntityId: legalEntityIdSchema,
    outletId: outletIdSchema.nullable(),
    entryDate: businessDateSchema,
    /** "general" = jurnal umum, "adjustment" = jurnal penyesuaian (§3.19). */
    kind: z.enum(["general", "adjustment"]),
    description: z.string().trim().min(1).max(255),
    lines: balancedLines,
    status: manualJournalStatusSchema,
    requestedBy: userIdSchema,
    createdAt: isoDateTimeSchema,
    submittedAt: isoDateTimeSchema.nullable(),
    decidedBy: userIdSchema.nullable(),
    decidedAt: isoDateTimeSchema.nullable(),
    rejectionReason: z.string().trim().min(1).max(500).nullable(),
    postedEntryId: journalEntryIdSchema.nullable(),
    recurringJournalId: recurringJournalIdSchema.nullable(),
  })
  .superRefine((row, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if ((row.status === "posted") !== (row.postedEntryId !== null))
      issue("postedEntryId", "postedEntryId is set exactly when posted");
    if ((row.status === "rejected") !== (row.rejectionReason !== null))
      issue("rejectionReason", "rejectionReason is set exactly when rejected");
    const decided = row.status === "posted" || row.status === "rejected";
    if (decided !== (row.decidedAt !== null))
      issue("decidedAt", "decidedAt is set exactly when decided");
    // A rejection may come from the system (approval chain expired or
    // cancelled, §3 F7 "batas waktu"): decidedBy stays null then. A posted
    // journal always records its human approver.
    if (row.status === "posted" && row.decidedBy === null)
      issue("decidedBy", "A posted journal records its approver");
    if (!decided && row.decidedBy !== null)
      issue("decidedBy", "decidedBy is set only when decided");
    if (row.decidedBy !== null && row.decidedBy === row.requestedBy)
      issue("decidedBy", "Approver must differ from requester (AUTH-06)");
  });
export type ManualJournal = z.infer<typeof manualJournalSchema>;

export type ManualJournalAction =
  | { type: "edit"; actorId: UserId }
  | { type: "submit"; actorId: UserId }
  | { type: "withdraw"; actorId: UserId }
  | { type: "approve"; actorId: UserId }
  | { type: "reject"; actorId: UserId; reason: string }
  | { type: "cancel"; actorId: UserId };

/**
 * Manual journal state machine. Only the requester edits, submits, withdraws
 * or cancels; approve/reject need a different person. Approval posts the
 * entry in the same transaction, so `posted` is final (ACC-01).
 *
 *   draft ─submit→ pending_approval ─approve→ posted
 *     ↑ edit/withdraw          └─reject→ rejected ─edit→ draft
 *   draft|rejected ─cancel→ cancelled
 */
export function transitionManualJournal(
  current: Pick<ManualJournal, "status" | "requestedBy">,
  action: ManualJournalAction,
): ManualJournalStatus {
  const { status } = current;
  if (status === "posted") rejectPostedJournalMutation();
  const isRequester = action.actorId === current.requestedBy;
  const invalid = () => new AccountingError("INVALID_TRANSITION");
  switch (action.type) {
    case "edit":
      if (!isRequester) throw invalid();
      if (status === "draft" || status === "rejected") return "draft";
      throw invalid();
    case "submit":
      if (!isRequester || status !== "draft") throw invalid();
      return "pending_approval";
    case "withdraw":
      if (!isRequester || status !== "pending_approval") throw invalid();
      return "draft";
    case "approve":
    case "reject":
      if (status !== "pending_approval") throw invalid();
      if (isRequester) throw new AccessError("APPROVER_IS_REQUESTER");
      if (action.type === "reject" && action.reason.trim() === "")
        throw invalid();
      return action.type === "approve" ? "posted" : "rejected";
    case "cancel":
      if (!isRequester) throw invalid();
      if (status === "draft" || status === "rejected") return "cancelled";
      throw invalid();
  }
}

export const createManualJournalInputSchema = z.strictObject({
  legalEntityId: legalEntityIdSchema,
  outletId: outletIdSchema.nullable(),
  entryDate: businessDateSchema,
  kind: z.enum(["general", "adjustment"]),
  description: z.string().trim().min(1).max(255),
  lines: balancedLines,
  idempotencyKey: idempotencyKeySchema,
});
export const updateManualJournalInputSchema = createManualJournalInputSchema
  .omit({ idempotencyKey: true, legalEntityId: true })
  .partial();
export const rejectInputSchema = z.strictObject({
  reason: z.string().trim().min(1).max(500),
});

// ---- Recurring journals ---------------------------------------------------

export const RECURRING_JOURNAL_STATUSES = [
  "draft",
  "pending_approval",
  "rejected",
  "active",
  "paused",
  "ended",
] as const;
export const recurringJournalStatusSchema = z.enum(RECURRING_JOURNAL_STATUSES);
export type RecurringJournalStatus = z.infer<
  typeof recurringJournalStatusSchema
>;

/**
 * A monthly template (e.g. rent accrual). The template is approved once by
 * someone other than the requester; each month's entry is then generated with
 * sourceType "recurring" and sourceId = template id. Changing an active
 * template's lines is not allowed: end it and create a new one, so every
 * posted entry traces back to an approved version.
 */
export const recurringJournalSchema = z
  .strictObject({
    id: recurringJournalIdSchema,
    tenantId: tenantIdSchema,
    legalEntityId: legalEntityIdSchema,
    outletId: outletIdSchema.nullable(),
    description: z.string().trim().min(1).max(255),
    lines: balancedLines,
    frequency: z.literal("monthly"),
    /** 1–31; months shorter than this use their last day. */
    dayOfMonth: z.number().int().min(1).max(31),
    startPeriod: periodKeySchema,
    endPeriod: periodKeySchema.nullable(),
    status: recurringJournalStatusSchema,
    requestedBy: userIdSchema,
    approvedBy: userIdSchema.nullable(),
    approvedAt: isoDateTimeSchema.nullable(),
    lastGeneratedPeriod: periodKeySchema.nullable(),
  })
  .superRefine((row, ctx) => {
    if (row.endPeriod !== null && row.endPeriod < row.startPeriod)
      ctx.addIssue({
        code: "custom",
        path: ["endPeriod"],
        message: "endPeriod must not be before startPeriod",
      });
    const approved = ["active", "paused", "ended"].includes(row.status);
    if (approved && (row.approvedBy === null || row.approvedAt === null))
      ctx.addIssue({
        code: "custom",
        path: ["approvedBy"],
        message: "An approved template records its approver",
      });
    if (row.approvedBy !== null && row.approvedBy === row.requestedBy)
      ctx.addIssue({
        code: "custom",
        path: ["approvedBy"],
        message: "Approver must differ from requester (AUTH-06)",
      });
  });
export type RecurringJournal = z.infer<typeof recurringJournalSchema>;

export type RecurringJournalAction =
  | { type: "submit" | "edit" | "pause" | "resume" | "end"; actorId: UserId }
  | { type: "approve"; actorId: UserId }
  | { type: "reject"; actorId: UserId; reason: string };

/**
 *   draft ─submit→ pending_approval ─approve→ active ⇄ paused
 *   pending_approval ─reject→ rejected ─edit→ draft
 *   active|paused ─end→ ended
 */
export function transitionRecurringJournal(
  current: Pick<RecurringJournal, "status" | "requestedBy">,
  action: RecurringJournalAction,
): RecurringJournalStatus {
  const { status } = current;
  const invalid = () => new AccountingError("INVALID_TRANSITION");
  switch (action.type) {
    case "edit":
      if (status === "draft" || status === "rejected") return "draft";
      throw invalid();
    case "submit":
      if (status === "draft") return "pending_approval";
      throw invalid();
    case "approve":
    case "reject":
      if (status !== "pending_approval") throw invalid();
      if (action.actorId === current.requestedBy)
        throw new AccessError("APPROVER_IS_REQUESTER");
      return action.type === "approve" ? "active" : "rejected";
    case "pause":
      if (status === "active") return "paused";
      throw invalid();
    case "resume":
      if (status === "paused") return "active";
      throw invalid();
    case "end":
      if (status === "active" || status === "paused") return "ended";
      throw invalid();
  }
}

/** Entry date of a recurring template in `period`, clamped to the month's last day. */
export function recurringOccurrenceDate(
  period: string,
  dayOfMonth: number,
): BusinessDate {
  periodKeySchema.parse(period);
  const [year, month] = period.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(Math.max(1, Math.trunc(dayOfMonth)), lastDay);
  return `${period}-${String(day).padStart(2, "0")}` as BusinessDate;
}

/** Periods still to generate up to and including `throughPeriod`. */
export function recurringPeriodsDue(
  template: Pick<
    RecurringJournal,
    "status" | "startPeriod" | "endPeriod" | "lastGeneratedPeriod"
  >,
  throughPeriod: string,
): string[] {
  if (template.status !== "active") return [];
  const due: string[] = [];
  let period = template.lastGeneratedPeriod
    ? nextPeriod(template.lastGeneratedPeriod)
    : template.startPeriod;
  const last =
    template.endPeriod !== null && template.endPeriod < throughPeriod
      ? template.endPeriod
      : throughPeriod;
  while (period <= last) {
    due.push(period);
    period = nextPeriod(period);
  }
  return due;
}
