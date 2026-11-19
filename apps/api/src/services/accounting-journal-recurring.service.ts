// Recurring journal templates (PRD v1.7 §3.19 "Jurnal Manual & Berulang";
// ACC-01/ACC-02; AUTH-06; bead legend-vmyg).
//
// A template is a REQUEST: it never touches the ledger. It is approved once
// by someone other than the requester (directly, or through the approval
// matrix chain, action `manual_journal`); only an `active` template is turned
// into one `journal_entries` row per month by `runDueRecurringJournals`.
//
// - every write runs in `withTenant`; mutated rows are locked FOR UPDATE and
//   every query filters `tenant_id`; an outlet-scoped caller only sees rows
//   whose outlet is in its scope (a null outlet is tenant-level data);
// - create is idempotent per (tenant, idempotencyKey) bound to a request
//   fingerprint, like the accounting journal service;
// - `lastGeneratedPeriod` means "last month handled (posted or skipped)": a
//   month is skipped on resume (it fell due after `paused_at`) or by an
//   operator (`skipRecurringJournalPeriod`, a month the ledger refuses); both
//   move the cursor and leave a `recurring_journal_runs` row without an entry
//   (arrears from before the pause are never skipped silently);
// - the job posts each month in its OWN transaction under the key
//   `recurring-journal:<templateId>:<YYYY-MM>`; `recurring_journal_runs` is
//   UNIQUE per template + period, so a re-run or a second worker never posts
//   the same month twice, and an error stops only the failing template (its
//   later months wait, other templates continue);
// - settlement from the approval chain is idempotent and shared by the approve
//   endpoint and the `approval.resolved` consumer.

import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { AccessError } from "@starter/shared/access";
import {
  AccountingError,
  assertJournalBalanced,
  checkJournalBalance,
  createRecurringJournal as createRecurringJournalEndpoint,
  nextPeriod,
  periodOf,
  recurringJournalSchema,
  recurringOccurrenceDate,
  recurringPeriodsDue,
  transitionRecurringJournal as transitionRecurringJournalState,
  skipRecurringJournalPeriodEndpoint,
  transitionRecurringJournalEndpoint,
  type JournalLineInput,
  type RecurringJournal,
} from "@starter/shared/accounting";
import {
  assertTrustedScopedContext,
  CoreError,
  type ScopedTenantContext,
  type UserId,
  type z,
} from "@starter/shared/core";
import { db } from "../db";
import {
  recurringJournalRuns,
  recurringJournals,
} from "../db/schema/accounting-journal-requests";
import { approvalRequests } from "../db/schema/platform-approval";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { entityToday } from "./accounting-ap-fa-shared";
import {
  assertJournalPeriodPostable,
  JOURNAL_APPROVAL_SOURCE_MODULE,
  RECURRING_JOURNAL_OBJECT_TYPE,
} from "./accounting-journal-period-gate";
import { approverMayPostJournal } from "./accounting-journal-approver";
import { wouldPostingBeBlockedByClosedPeriod } from "./accounting-period.service";
import { assertJournalCredit1102Covered } from "./accounting-petty-cash.service";
import {
  assertJournalLinesPostable,
  postJournalInTransaction,
} from "./accounting-journal.service";
import {
  auditAccountingChange,
  requireLegalEntity,
  requireOutlet,
  uniqueViolation,
  type TenantTransaction,
} from "./accounting-shared";
import {
  cancelApprovalRequest,
  openApprovalRequest,
  resolveApprovalChainOutcome,
} from "./platform-approval.service";

type Row = typeof recurringJournals.$inferSelect;

export type CreateRecurringJournalInput = z.infer<
  typeof createRecurringJournalEndpoint.body
>;
export type RecurringJournalTransitionBody = z.infer<
  typeof transitionRecurringJournalEndpoint.body
>;

export type SkipRecurringJournalPeriodInput = z.infer<
  typeof skipRecurringJournalPeriodEndpoint.body
>;

/** What one run of the job did, summed over every active template. */
export type RecurringJournalJobResult = {
  readonly posted: number;
  readonly skipped: number;
  readonly failed: number;
};

/** The deterministic posting key of one template + month (exported for tests). */
export const recurringJournalPostingKey = (
  templateId: string,
  period: string,
) => `recurring-journal:${templateId}:${period}`;

// ----------------------------------------------------------------- helpers

function toRecurring(row: Row): RecurringJournal {
  return recurringJournalSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    legalEntityId: row.legalEntityId,
    outletId: row.outletId,
    description: row.description,
    lines: row.lines,
    frequency: row.frequency,
    dayOfMonth: row.dayOfMonth,
    startPeriod: row.startPeriod,
    endPeriod: row.endPeriod,
    status: row.status,
    requestedBy: row.requestedBy,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    lastGeneratedPeriod: row.lastGeneratedPeriod,
  });
}

/** The two fields the shared state machine reads. */
const stateOf = (row: Row) => ({
  status: row.status,
  requestedBy: row.requestedBy as UserId,
});

const notFound = () =>
  new HttpError(404, "NOT_FOUND", "Recurring journal not found.");

const sameUser = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Outlet-scoped callers reach only rows of their outlets; null = tenant-level. */
function covers(context: ScopedTenantContext, outletId: string | null) {
  if (context.outletScope.kind === "tenant") return true;
  if (outletId === null) return false;
  return context.outletScope.outletIds.some((id) => sameUser(id, outletId));
}

/** A create may only name outlets the caller covers (header and every line). */
function assertCreateScope(
  context: ScopedTenantContext,
  outletId: string | null,
  lines: readonly Pick<JournalLineInput, "outletId">[],
): void {
  if (context.outletScope.kind === "tenant") return;
  const denied = () =>
    new CoreError("OUTLET_OUT_OF_SCOPE", "Outlet di luar cakupan Anda.");
  if (!covers(context, outletId)) throw denied();
  for (const line of lines) if (!covers(context, line.outletId)) throw denied();
}

function createFingerprint(
  actorId: string,
  input: CreateRecurringJournalInput,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        actorId.toLowerCase(),
        input.legalEntityId.toLowerCase(),
        input.outletId?.toLowerCase() ?? null,
        input.description.trim(),
        input.lines.map((line) => [
          line.accountId.toLowerCase(),
          line.debitIdr,
          line.creditIdr,
          line.outletId?.toLowerCase() ?? null,
          line.costCenter,
        ]),
        input.dayOfMonth,
        input.startPeriod,
        input.endPeriod,
      ]),
    )
    .digest("hex");
}

async function lockTemplate(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  id: string,
): Promise<Row> {
  const [row] = await tx
    .select()
    .from(recurringJournals)
    .where(
      and(
        eq(recurringJournals.tenantId, context.tenant.tenantId),
        eq(recurringJournals.id, id),
      ),
    )
    .for("update")
    .limit(1);
  if (!row || !covers(context, row.outletId)) throw notFound();
  return row;
}

async function updateTemplate(
  tx: TenantTransaction,
  row: Row,
  patch: Partial<typeof recurringJournals.$inferInsert>,
  now: Date,
): Promise<Row> {
  const [updated] = await tx
    .update(recurringJournals)
    .set({ ...patch, updatedAt: now })
    .where(
      and(
        eq(recurringJournals.tenantId, row.tenantId),
        eq(recurringJournals.id, row.id),
      ),
    )
    .returning();
  if (!updated) throw new Error("recurring journal update returned no row");
  return updated;
}

async function auditTemplate(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  actorId: UserId | null,
  action: string,
  before: Row | null,
  after: Row,
  reason?: string,
): Promise<void> {
  await auditAccountingChange(tx, context, {
    actorId,
    action: `recurring_journal.${action}`,
    objectType: RECURRING_JOURNAL_OBJECT_TYPE,
    objectId: after.id,
    outletId: after.outletId,
    reason: reason ?? null,
    before: before ? { status: before.status } : null,
    after: { status: after.status },
  });
}

// ------------------------------------------------------------------ create

/** Creates a draft template. Replaying the same key + body returns the same row. */
export async function createRecurringJournal(
  context: ScopedTenantContext,
  actorId: UserId,
  input: CreateRecurringJournalInput,
  now = new Date(),
): Promise<RecurringJournal> {
  assertTrustedScopedContext(context);
  const description = input.description.trim();
  if (description.length === 0 || description.length > 255)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Description must be 1-255 characters.",
    );
  if (input.endPeriod !== null && input.endPeriod < input.startPeriod)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "endPeriod must not be before startPeriod.",
    );
  assertJournalBalanced(input.lines);
  assertCreateScope(context, input.outletId, input.lines);
  const fingerprint = createFingerprint(actorId, input);
  const tenantId = context.tenant.tenantId;

  const findByKey = async (tx: TenantTransaction) => {
    const [existing] = await tx
      .select()
      .from(recurringJournals)
      .where(
        and(
          eq(recurringJournals.tenantId, tenantId),
          eq(recurringJournals.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    return existing ?? null;
  };
  const replay = (existing: Row) => {
    if (existing.requestFingerprint !== fingerprint)
      throw new CoreError(
        "IDEMPOTENCY_KEY_REUSED",
        "That idempotency key was used for a different recurring journal.",
      );
    return toRecurring(existing);
  };

  return withTenant(db, context, async (tx) => {
    const existing = await findByKey(tx);
    if (existing) return replay(existing);
    await requireLegalEntity(tx, tenantId, input.legalEntityId);
    if (input.outletId !== null)
      await requireOutlet(tx, tenantId, input.outletId);
    let row: Row | undefined;
    try {
      [row] = await tx
        .insert(recurringJournals)
        .values({
          tenantId,
          legalEntityId: input.legalEntityId,
          outletId: input.outletId,
          description,
          lines: [...input.lines],
          frequency: "monthly",
          dayOfMonth: input.dayOfMonth,
          startPeriod: input.startPeriod,
          endPeriod: input.endPeriod,
          status: "draft",
          requestedBy: actorId,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: fingerprint,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: [
            recurringJournals.tenantId,
            recurringJournals.idempotencyKey,
          ],
        })
        .returning();
    } catch (error) {
      if (!uniqueViolation(error)) throw error;
    }
    if (!row) {
      const concurrent = await findByKey(tx);
      if (!concurrent) throw new Error("recurring journal insert lost its row");
      return replay(concurrent);
    }
    await auditTemplate(tx, context, actorId, "create", null, row);
    return toRecurring(row);
  });
}

// -------------------------------------------------------------------- list

export async function listRecurringJournals(
  context: ScopedTenantContext,
  legalEntityId: string,
): Promise<{ data: RecurringJournal[] }> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    await requireLegalEntity(tx, tenantId, legalEntityId);
    const filters = [
      eq(recurringJournals.tenantId, tenantId),
      eq(recurringJournals.legalEntityId, legalEntityId),
    ];
    // Outlet-scoped readers never see tenant-level (null outlet) templates.
    if (context.outletScope.kind !== "tenant")
      filters.push(
        inArray(recurringJournals.outletId, [...context.outletScope.outletIds]),
      );
    const rows = await tx
      .select()
      .from(recurringJournals)
      .where(and(...filters))
      .orderBy(desc(recurringJournals.createdAt), desc(recurringJournals.id));
    return { data: rows.map(toRecurring) };
  });
}

// ------------------------------------------------------------- settlement

/**
 * Settles a pending template from its approval chain on the caller's
 * transaction (row locked FOR UPDATE, so the approve endpoint, the consumer
 * and a poll produce one outcome). Idempotent: a row that is no longer
 * pending, or has no chain, or whose chain is still open, is returned
 * unchanged. Approved → active with the last level's decider (re-checked
 * against the requester); rejected/expired/cancelled → rejected.
 */
export async function settleRecurringJournalForApproval(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  id: string,
  now: Date = new Date(),
): Promise<RecurringJournal> {
  assertTrustedScopedContext(context);
  const row = await lockTemplate(tx, context, id);
  return toRecurring(await settleLocked(tx, context, row, now));
}

async function settleLocked(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  row: Row,
  now: Date,
): Promise<Row> {
  if (row.status !== "pending_approval" || row.approvalChainId === null)
    return row;
  const chainId = row.approvalChainId;
  // Locks the chain head and applies the deadline atomically, so an inbox
  // decision in flight commits first; read the last level only afterwards.
  const outcome = await resolveApprovalChainOutcome(tx, context, {
    chainId,
    sourceModule: JOURNAL_APPROVAL_SOURCE_MODULE,
    now,
  });
  const [last] = await tx
    .select({
      decidedBy: approvalRequests.decidedBy,
    })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, context.tenant.tenantId),
        eq(approvalRequests.chainId, chainId),
      ),
    )
    .orderBy(desc(approvalRequests.level))
    .limit(1);
  if (!last) throw notFound();
  if (outcome === "pending") return row;

  // `actorId` null = a system decision (expired chain, invalid or unauthorised
  // approver); a human inbox rejection is audited under that person.
  const reject = async (reason: string, actorId: UserId | null) => {
    const updated = await updateTemplate(
      tx,
      row,
      { status: "rejected", rejectionReason: reason },
      now,
    );
    await auditTemplate(tx, context, actorId, "reject", row, updated, reason);
    return updated;
  };
  if (outcome !== "approved")
    return reject(
      `approval ${outcome}`,
      outcome === "expired" || last.decidedBy === null
        ? null
        : (last.decidedBy as UserId),
    );
  const decider = last.decidedBy;
  if (decider === null || sameUser(decider, row.requestedBy))
    return reject("approval approver_invalid", null);
  // The inbox role can decide; the ledger still needs the post permission.
  if (
    !(await approverMayPostJournal(
      tx,
      context,
      decider as UserId,
      { outletId: row.outletId, lines: row.lines as JournalLineInput[] },
      now,
    ))
  )
    return reject("approval approver lacks permission", null);
  const status = transitionRecurringJournalState(stateOf(row), {
    type: "approve",
    actorId: decider as UserId,
  });
  const updated = await updateTemplate(
    tx,
    row,
    { status, approvedBy: decider, approvedAt: now },
    now,
  );
  await auditTemplate(tx, context, decider as UserId, "approve", row, updated);
  return updated;
}

// -------------------------------------------------------------- transition

/**
 * submit / approve / reject / pause / resume / end. The route enforces
 * `accounting.journal.post`; pause/resume/end accept any actor with it.
 */
export async function transitionRecurringJournal(
  context: ScopedTenantContext,
  actorId: UserId,
  id: string,
  body: RecurringJournalTransitionBody,
  now = new Date(),
): Promise<RecurringJournal> {
  assertTrustedScopedContext(context);
  return withTenant(db, context, async (tx) => {
    const row = await lockTemplate(tx, context, id);
    switch (body.type) {
      case "submit":
        return toRecurring(await submit(tx, context, actorId, row, now));
      case "approve":
        return toRecurring(await approve(tx, context, actorId, row, now));
      case "reject":
        return toRecurring(
          await reject(tx, context, actorId, row, body.reason.trim(), now),
        );
      case "pause":
      case "resume":
      case "end": {
        const status = transitionRecurringJournalState(stateOf(row), {
          type: body.type,
          actorId,
        });
        const resumeCursor =
          body.type === "resume"
            ? await skipPausedMonths(tx, context, actorId, row, now)
            : null;
        const updated = await updateTemplate(
          tx,
          row,
          {
            status,
            ...(body.type === "pause" ? { pausedAt: now } : {}),
            ...(body.type === "resume"
              ? { pausedAt: null, ...resumeCursor }
              : {}),
          },
          now,
        );
        await auditTemplate(tx, context, actorId, body.type, row, updated);
        return toRecurring(updated);
      }
    }
  });
}

/** Reason stored on a run row skipped by a resume (system text, not the actor's). */
const PAUSE_SKIP_REASON = "Dilewati otomatis: jatuh tempo saat templat dijeda";

/**
 * Months that fell due while paused are skipped on resume: generation restarts
 * from the current month (it still posts when its day arrives). Only a month
 * whose occurrence date is after the pause counts; arrears that were already
 * due before the pause stay owed (the job posts them, or an operator uses
 * skip-period). Arrears always precede the paused months, so they are passed
 * over without a row, and the cursor only advances when there were none: the
 * job then posts the arrears and moves past the paused months through their
 * run rows. Each skipped month is a `recurring_journal_runs` row (skipped_by =
 * the resuming actor) plus an audit row, in the resume transaction. Returns
 * the cursor patch.
 */
async function skipPausedMonths(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  actorId: UserId,
  row: Row,
  now: Date,
): Promise<Partial<typeof recurringJournals.$inferInsert>> {
  const currentPeriod = periodOf(entityToday(now));
  // Rows paused before the column existed fall back to their last update.
  const pausedOn = entityToday(row.pausedAt ?? row.updatedAt);
  let period = row.lastGeneratedPeriod
    ? nextPeriod(row.lastGeneratedPeriod)
    : row.startPeriod;
  let handledThrough: string | null = null;
  let arrears = false;
  while (
    period < currentPeriod &&
    (row.endPeriod === null || period <= row.endPeriod)
  ) {
    if (recurringOccurrenceDate(period, row.dayOfMonth) <= pausedOn) {
      // Owed from before the pause: left for the job or skip-period.
      arrears = true;
      period = nextPeriod(period);
      continue;
    }
    const [inserted] = await tx
      .insert(recurringJournalRuns)
      .values({
        tenantId: row.tenantId,
        recurringJournalId: row.id,
        period,
        journalEntryId: null,
        skippedBy: actorId,
        skipReason: PAUSE_SKIP_REASON,
      })
      .onConflictDoNothing({
        target: [
          recurringJournalRuns.tenantId,
          recurringJournalRuns.recurringJournalId,
          recurringJournalRuns.period,
        ],
      })
      .returning({ id: recurringJournalRuns.id });
    if (inserted)
      await auditAccountingChange(tx, context, {
        actorId,
        action: "accounting.recurring_journal.period_skipped",
        objectType: RECURRING_JOURNAL_OBJECT_TYPE,
        objectId: row.id,
        outletId: row.outletId,
        reason: PAUSE_SKIP_REASON,
        before: { status: row.status },
        after: { status: "active" },
      });
    if (!arrears) handledThrough = period;
    period = nextPeriod(period);
  }
  return handledThrough === null ? {} : { lastGeneratedPeriod: handledThrough };
}

/**
 * Operator skip of the next due month of an `active` or `paused` template
 * the ledger refuses (its fiscal period, or a later one, is closed: the job
 * cannot post into it and would wait forever). Records a run row without a journal entry, moves the cursor, and
 * audits in the same transaction. Replaying a skip changes nothing.
 */
export async function skipRecurringJournalPeriod(
  context: ScopedTenantContext,
  actorId: UserId,
  id: string,
  input: SkipRecurringJournalPeriodInput,
  now = new Date(),
): Promise<RecurringJournal> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const period = input.period;
  const reason = input.reason.trim();
  return withTenant(db, context, async (tx) => {
    const row = await lockTemplate(tx, context, id);
    const [run] = await tx
      .select({
        journalEntryId: recurringJournalRuns.journalEntryId,
        skippedBy: recurringJournalRuns.skippedBy,
      })
      .from(recurringJournalRuns)
      .where(
        and(
          eq(recurringJournalRuns.tenantId, tenantId),
          eq(recurringJournalRuns.recurringJournalId, row.id),
          eq(recurringJournalRuns.period, period),
        ),
      )
      .limit(1);
    if (run) {
      // Already skipped: idempotent. A posted month cannot be skipped.
      if (run.skippedBy === null)
        throw new AccountingError("INVALID_TRANSITION");
      return toRecurring(row);
    }
    if (row.status !== "active" && row.status !== "paused")
      throw new AccountingError("INVALID_TRANSITION");
    const nextDue = row.lastGeneratedPeriod
      ? nextPeriod(row.lastGeneratedPeriod)
      : row.startPeriod;
    if (
      period !== nextDue ||
      (row.endPeriod !== null && period > row.endPeriod)
    )
      throw new AccountingError("INVALID_TRANSITION");
    // Skippable exactly when posting into the month would fail PERIOD_CLOSED:
    // the month is closed, or a later month is (the posting guard refuses an
    // open or never-created month behind a closed one too).
    if (
      !(await wouldPostingBeBlockedByClosedPeriod(
        tx,
        tenantId,
        row.legalEntityId,
        period,
      ))
    )
      throw new AccountingError("PERIOD_NOT_CLOSED");
    await tx.insert(recurringJournalRuns).values({
      tenantId,
      recurringJournalId: row.id,
      period,
      journalEntryId: null,
      skippedBy: actorId,
      skipReason: reason,
    });
    const updated = await updateTemplate(
      tx,
      row,
      // The skipped month is handled: clear the failure shown to finance (a
      // template whose last month is skipped never runs again to clear it).
      { lastGeneratedPeriod: period, lastError: null, failedAt: null },
      now,
    );
    await auditAccountingChange(tx, context, {
      actorId,
      action: "accounting.recurring_journal.period_skipped",
      objectType: RECURRING_JOURNAL_OBJECT_TYPE,
      objectId: updated.id,
      outletId: updated.outletId,
      reason,
      before: { status: row.status },
      after: { status: updated.status },
    });
    return toRecurring(updated);
  });
}

async function submit(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  actorId: UserId,
  row: Row,
  now: Date,
): Promise<Row> {
  // Only the requester submits; the shared state machine owns the status rule.
  if (!sameUser(actorId, row.requestedBy))
    throw new AccountingError("INVALID_TRANSITION");
  const status = transitionRecurringJournalState(stateOf(row), {
    type: "submit",
    actorId,
  });
  const lines = row.lines as JournalLineInput[];
  await assertJournalLinesPostable(tx, context, row.legalEntityId, lines);
  const request = await openApprovalRequest(tx, context, {
    sourceModule: JOURNAL_APPROVAL_SOURCE_MODULE,
    actionType: "manual_journal",
    objectType: RECURRING_JOURNAL_OBJECT_TYPE,
    objectId: row.id,
    amountIdr: checkJournalBalance(lines).totalDebitIdr,
    outletId: row.outletId,
    requestedBy: actorId,
    source: "user",
    requestReason:
      row.description.length >= 3
        ? row.description
        : `Jurnal berulang ${row.description}`,
    now,
  });
  const updated = await updateTemplate(
    tx,
    row,
    { status, approvalChainId: request.required ? request.chainId : null },
    now,
  );
  await auditTemplate(tx, context, actorId, "submit", row, updated);
  return updated;
}

async function approve(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  actorId: UserId,
  row: Row,
  now: Date,
): Promise<Row> {
  if (sameUser(actorId, row.requestedBy))
    throw new AccessError("APPROVER_IS_REQUESTER");
  // Already settled from the chain (e.g. by the consumer): idempotent.
  if (row.status !== "pending_approval" && row.approvalChainId !== null)
    return row;
  if (row.approvalChainId === null) {
    // No matrix step applies: the actor's approval is the decision.
    const status = transitionRecurringJournalState(stateOf(row), {
      type: "approve",
      actorId,
    });
    const updated = await updateTemplate(
      tx,
      row,
      { status, approvedBy: actorId, approvedAt: now },
      now,
    );
    await auditTemplate(tx, context, actorId, "approve", row, updated);
    return updated;
  }
  const settled = await settleLocked(tx, context, row, now);
  if (settled.status === "pending_approval")
    throw new HttpError(
      409,
      "APPROVAL_PENDING",
      "The approval chain has not finished yet.",
    );
  return settled;
}

async function reject(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  actorId: UserId,
  row: Row,
  reason: string,
  now: Date,
): Promise<Row> {
  const status = transitionRecurringJournalState(stateOf(row), {
    type: "reject",
    actorId,
    reason,
  });
  if (row.approvalChainId !== null) {
    const outcome = await cancelApprovalRequest(tx, context, {
      chainId: row.approvalChainId,
      sourceModule: JOURNAL_APPROVAL_SOURCE_MODULE,
      actorUserId: actorId,
      now,
    });
    // The chain approved first (a race with the inbox): do not turn that into
    // a rejection; the caller retries and sees the settled template.
    if (outcome === "approved") throw new AccountingError("INVALID_TRANSITION");
  }
  const updated = await updateTemplate(
    tx,
    row,
    { status, rejectionReason: reason },
    now,
  );
  await auditTemplate(tx, context, actorId, "reject", row, updated, reason);
  return updated;
}

// --------------------------------------------------------------------- job

/**
 * Generates every due month of every active template (scheduled by the
 * worker). Tenant-wide trusted context only. Each month runs in its own
 * transaction; an error stops THIS template (later months wait) and the
 * others continue. Resumable and safe to run twice or concurrently.
 */
export async function runDueRecurringJournals(
  context: ScopedTenantContext,
  now: Date = new Date(),
): Promise<RecurringJournalJobResult> {
  assertTrustedScopedContext(context);
  if (context.outletScope.kind !== "tenant")
    throw new Error("Recurring journal job requires tenant-wide scope");
  const tenantId = context.tenant.tenantId;
  const today = entityToday(now);
  const currentPeriod = periodOf(today);
  const templates = await withTenant(db, context, (tx) =>
    tx
      .select()
      .from(recurringJournals)
      .where(
        and(
          eq(recurringJournals.tenantId, tenantId),
          eq(recurringJournals.status, "active"),
        ),
      )
      .orderBy(asc(recurringJournals.createdAt), asc(recurringJournals.id)),
  );
  let posted = 0;
  let skipped = 0;
  let failed = 0;
  for (const template of templates) {
    const periods = recurringPeriodsDue(template, currentPeriod).filter(
      (period) => recurringOccurrenceDate(period, template.dayOfMonth) <= today,
    );
    for (const period of periods) {
      try {
        const outcome = await withTenant(db, context, (tx) =>
          generatePeriod(tx, context, template.id, period, now),
        );
        if (outcome === "posted") posted += 1;
        else if (outcome === "skipped") skipped += 1;
        else break; // paused, ended or changed meanwhile: nothing more now
      } catch (error) {
        failed += 1;
        console.error("Recurring journal generation failed for a template");
        await recordGenerationFailure(context, template.id, error, now);
        break; // later months wait for this one
      }
    }
  }
  return { posted, skipped, failed };
}

/** Short, secret-free description of a failure (domain code + message only). */
function describeFailure(error: unknown): string {
  const text =
    error instanceof AccountingError || error instanceof CoreError
      ? `${error.code}: ${error.message}`
      : `Unexpected ${error instanceof Error ? error.name : "error"}`;
  return text.slice(0, 500);
}

/**
 * Stores the last failure on the template (own transaction, so the rolled
 * back month cannot erase it). Best effort: a failure to record it must not
 * stop the job.
 */
async function recordGenerationFailure(
  context: ScopedTenantContext,
  templateId: string,
  error: unknown,
  now: Date,
): Promise<void> {
  try {
    await withTenant(db, context, (tx) =>
      tx
        .update(recurringJournals)
        .set({ lastError: describeFailure(error), failedAt: now })
        .where(
          and(
            eq(recurringJournals.tenantId, context.tenant.tenantId),
            eq(recurringJournals.id, templateId),
          ),
        ),
    );
  } catch {
    console.error("Recurring journal failure could not be recorded");
  }
}

async function generatePeriod(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  templateId: string,
  period: string,
  now: Date,
): Promise<"posted" | "skipped" | "stop"> {
  const tenantId = context.tenant.tenantId;
  const [template] = await tx
    .select()
    .from(recurringJournals)
    .where(
      and(
        eq(recurringJournals.tenantId, tenantId),
        eq(recurringJournals.id, templateId),
      ),
    )
    .for("update")
    .limit(1);
  if (!template || template.status !== "active") return "stop";
  const markGenerated = async () => {
    if (
      template.lastGeneratedPeriod === null ||
      template.lastGeneratedPeriod < period
    )
      await updateTemplate(
        tx,
        template,
        // A handled month clears the last failure shown to finance.
        { lastGeneratedPeriod: period, lastError: null, failedAt: null },
        now,
      );
  };
  const [existingRun] = await tx
    .select({ id: recurringJournalRuns.id })
    .from(recurringJournalRuns)
    .where(
      and(
        eq(recurringJournalRuns.tenantId, tenantId),
        eq(recurringJournalRuns.recurringJournalId, templateId),
        eq(recurringJournalRuns.period, period),
      ),
    )
    .limit(1);
  if (existingRun) {
    await markGenerated();
    return "skipped";
  }
  // Another worker already moved the template past this month.
  if (
    template.lastGeneratedPeriod !== null &&
    template.lastGeneratedPeriod >= period
  )
    return "skipped";
  if (template.approvedBy === null)
    throw new Error("active recurring journal has no approver");
  const entryDate = recurringOccurrenceDate(period, template.dayOfMonth);
  await assertJournalPeriodPostable(tx, context, {
    legalEntityId: template.legalEntityId,
    entryDate,
  });
  // A credit to 1102 pays out of petty cash: a short month is not generated
  // and is retried by the next run (legend-5qqb9).
  await assertJournalCredit1102Covered(
    tx,
    tenantId,
    template.legalEntityId,
    template.lines,
  );
  const entry = await postJournalInTransaction(
    tx,
    context,
    {
      legalEntityId: template.legalEntityId,
      outletId: template.outletId,
      entryDate,
      sourceType: "recurring",
      sourceId: template.id,
      description: template.description,
      lines: template.lines,
      postedBy: template.approvedBy as UserId,
      idempotencyKey: recurringJournalPostingKey(template.id, period),
    },
    now,
  );
  await tx
    .insert(recurringJournalRuns)
    .values({
      tenantId,
      recurringJournalId: template.id,
      period,
      journalEntryId: entry.id,
    })
    .onConflictDoNothing({
      target: [
        recurringJournalRuns.tenantId,
        recurringJournalRuns.recurringJournalId,
        recurringJournalRuns.period,
      ],
    });
  await markGenerated();
  return "posted";
}
