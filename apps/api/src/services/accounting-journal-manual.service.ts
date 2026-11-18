// Manual journals: request -> approval -> posted ledger entry (PRD v1.7 §3.19
// "Jurnal Manual & Berulang"; ACC-01/ACC-02; AUTH-06; bead legend-vmyg).
//
// - a manual journal is a REQUEST row; `journal_entries` is written only when
//   an approver other than the requester approves (never at create/submit);
// - the period checkpoint (`assertJournalPeriodPostable`) runs at submit and
//   again at approve/settle, right before posting;
// - when the tenant's approval matrix requires a chain, the decision comes from
//   the approval inbox and `settleManualJournalForApproval` applies it (called
//   by the approve endpoint and by the outbox consumer, idempotent);
// - every write runs in `withTenant`, rows are mutated under FOR UPDATE and
//   every query filters `tenantId`. Outlet-scoped callers only see rows whose
//   outlet is in their scope; a tenant-level row (null outlet) needs tenant
//   scope. A hidden row answers 404 (no existence leak, TEN-03);
// - create is idempotent on (tenant, idempotencyKey) bound to a sha256
//   fingerprint of the request.

import { AccessError } from "@starter/shared/access";
import {
  AccountingError,
  checkJournalBalance,
  createManualJournalInputSchema,
  manualJournalSchema,
  transitionManualJournal,
  updateManualJournalInputSchema,
  type ManualJournal,
} from "@starter/shared/accounting";
import {
  assertTrustedScopedContext,
  CoreError,
  decodeCursor,
  encodeCursor,
  outletIdsForQuery,
  userIdSchema,
  type CursorPage,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import { and, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "../db";
import { manualJournals } from "../db/schema";
import { approvalRequests } from "../db/schema/platform-approval";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { approverMayPostJournal } from "./accounting-journal-approver";
import {
  assertJournalPeriodPostable,
  JOURNAL_APPROVAL_SOURCE_MODULE,
  MANUAL_JOURNAL_OBJECT_TYPE,
} from "./accounting-journal-period-gate";
import {
  assertJournalLinesPostable,
  postJournalInTransaction,
} from "./accounting-journal.service";
import { assertJournalCredit1102Covered } from "./accounting-petty-cash.service";
import {
  auditAccountingChange,
  journalRequestFingerprint,
  requireLegalEntity,
  requireOutlet,
  type TenantTransaction,
} from "./accounting-shared";
import {
  cancelApprovalRequest,
  openApprovalRequest,
  resolveApprovalChainOutcome,
} from "./platform-approval.service";

type Row = typeof manualJournals.$inferSelect;
type Lines = Row["lines"];

export type CreateManualJournalInput = ReturnType<
  typeof createManualJournalInputSchema.parse
>;
export type UpdateManualJournalInput = ReturnType<
  typeof updateManualJournalInputSchema.parse
>;
export type ListManualJournalsQuery = {
  legalEntityId: string;
  status?: Row["status"];
  limit: number;
  cursor?: string;
};

// ----------------------------------------------------------------- helpers

function toManualJournal(row: Row): ManualJournal {
  return manualJournalSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    legalEntityId: row.legalEntityId,
    outletId: row.outletId,
    entryDate: row.entryDate,
    kind: row.kind,
    description: row.description,
    lines: row.lines,
    status: row.status,
    requestedBy: row.requestedBy,
    createdAt: row.createdAt.toISOString(),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    rejectionReason: row.rejectionReason,
    postedEntryId: row.postedEntryId,
    recurringJournalId: null,
  });
}

function notFound(): HttpError {
  return new HttpError(404, "NOT_FOUND", "Manual journal not found.");
}

/** Row visibility for the caller's outlets (null outlet = tenant-level). */
function inScope(
  context: ScopedTenantContext,
  outletId: string | null,
): boolean {
  if (context.outletScope.kind === "tenant") return true;
  return (
    outletId !== null &&
    (context.outletScope.outletIds as readonly string[]).includes(outletId)
  );
}

/**
 * A caller may only create or edit a request it could also read back: the
 * header outlet and every line outlet must be inside its scope, and an
 * entity-level (null outlet) request needs tenant scope.
 */
function assertRequestScope(
  context: ScopedTenantContext,
  outletId: string | null,
  lines: Lines,
): void {
  if (outletId !== null) outletIdsForQuery(context.outletScope, [outletId]);
  if (context.outletScope.kind !== "tenant") {
    if (outletId === null)
      throw new CoreError(
        "OUTLET_OUT_OF_SCOPE",
        "Jurnal tingkat badan usaha memerlukan akses seluruh tenant.",
      );
    for (const line of lines) {
      if (line.outletId === null)
        throw new CoreError(
          "OUTLET_OUT_OF_SCOPE",
          "Baris jurnal tingkat badan usaha memerlukan akses seluruh tenant.",
        );
      outletIdsForQuery(context.outletScope, [line.outletId]);
    }
    return;
  }
  for (const line of lines)
    if (line.outletId !== null)
      outletIdsForQuery(context.outletScope, [line.outletId]);
}

function fingerprintOf(input: {
  legalEntityId: string;
  outletId: string | null;
  entryDate: string;
  kind: string;
  description: string;
  lines: Lines;
}): string {
  return journalRequestFingerprint({
    legalEntityId: input.legalEntityId,
    outletId: input.outletId,
    entryDate: input.entryDate,
    sourceType: `manual:${input.kind}`,
    sourceId: null,
    description: input.description,
    lines: input.lines,
  });
}

async function findByKey(
  tx: TenantTransaction,
  tenantId: string,
  idempotencyKey: string,
): Promise<Row | undefined> {
  const [row] = await tx
    .select()
    .from(manualJournals)
    .where(
      and(
        eq(manualJournals.tenantId, tenantId),
        eq(manualJournals.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return row;
}

/** A replay returns the row its key created; any other body or caller is a bug. */
function assertReplay(
  row: Row,
  actorId: UserId,
  fingerprint: string,
  context: ScopedTenantContext,
): Row {
  if (
    row.requestFingerprint !== fingerprint ||
    row.requestedBy !== actorId ||
    !inScope(context, row.outletId)
  )
    throw new CoreError(
      "IDEMPOTENCY_KEY_REUSED",
      "That idempotency key was used for a different journal request.",
    );
  return row;
}

/** Row of this tenant, locked FOR UPDATE when `lock`; null when missing. */
async function loadRow(
  tx: TenantTransaction,
  tenantId: string,
  id: string,
  lock: boolean,
): Promise<Row | null> {
  const query = tx
    .select()
    .from(manualJournals)
    .where(
      and(eq(manualJournals.tenantId, tenantId), eq(manualJournals.id, id)),
    )
    .limit(1);
  const [row] = lock ? await query.for("update") : await query;
  return row ?? null;
}

async function loadVisibleRow(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  id: string,
  lock: boolean,
): Promise<Row> {
  const row = await loadRow(tx, context.tenant.tenantId, id, lock);
  if (!row || !inScope(context, row.outletId)) throw notFound();
  return row;
}

function viewOf(row: Row): Pick<ManualJournal, "status" | "requestedBy"> {
  return {
    status: row.status,
    requestedBy: userIdSchema.parse(row.requestedBy),
  };
}

async function updateRow(
  tx: TenantTransaction,
  row: Row,
  patch: Partial<typeof manualJournals.$inferInsert>,
  now: Date,
): Promise<Row> {
  const [updated] = await tx
    .update(manualJournals)
    .set({ ...patch, updatedAt: now })
    .where(
      and(
        eq(manualJournals.tenantId, row.tenantId),
        eq(manualJournals.id, row.id),
      ),
    )
    .returning();
  if (!updated) throw new Error("manual journal changed under its row lock");
  return updated;
}

async function audit(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  actorId: UserId | null,
  action: string,
  row: Row,
  reason?: string,
): Promise<void> {
  await auditAccountingChange(tx, context, {
    actorId,
    action: `accounting.manual_journal.${action}`,
    objectType: MANUAL_JOURNAL_OBJECT_TYPE,
    objectId: row.id,
    outletId: row.outletId,
    reason: reason ?? null,
    before: null,
    after: { entryDate: row.entryDate },
  });
}

/**
 * Business refusals of the posting guards (closed period, inactive or foreign
 * account). A request whose chain is already approved cannot wait for these to
 * clear, so settle ends it as rejected; any other error (infra, lock timeout)
 * is rethrown so the outbox retries.
 */
const POSTING_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "PERIOD_CLOSED",
  "PERIOD_MISMATCH",
  "ACCOUNT_INACTIVE",
  "ACCOUNT_NOT_POSTABLE",
  "ACCOUNT_ENTITY_MISMATCH",
]);

function postingRefusalCode(error: unknown): string | null {
  return error instanceof AccountingError &&
    POSTING_REFUSAL_CODES.has(error.code)
    ? error.code
    : null;
}

/** Posts the approved request and marks it posted, decided by `deciderId`. */
async function postApproved(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  row: Row,
  deciderId: UserId,
  now: Date,
): Promise<Row> {
  await assertJournalPeriodPostable(tx, context, {
    legalEntityId: row.legalEntityId,
    entryDate: row.entryDate,
  });
  // A credit to 1102 pays out of petty cash: refused when the cash is short
  // (not a final refusal, the request stays pending; legend-5qqb9).
  await assertJournalCredit1102Covered(
    tx,
    context.tenant.tenantId,
    row.legalEntityId,
    row.lines,
  );
  const entry = await postJournalInTransaction(
    tx,
    context,
    {
      legalEntityId: row.legalEntityId,
      outletId: row.outletId,
      entryDate: row.entryDate,
      sourceType: "manual",
      sourceId: row.id,
      description: row.description,
      lines: row.lines,
      postedBy: deciderId,
      idempotencyKey: `manual-journal:${row.id}`,
    },
    now,
  );
  const posted = await updateRow(
    tx,
    row,
    {
      status: "posted",
      decidedBy: deciderId,
      decidedAt: now,
      postedEntryId: entry.id,
    },
    now,
  );
  await audit(tx, context, deciderId, "posted", posted);
  return posted;
}

// ------------------------------------------------------------------ create

/** Creates a draft. Writes no ledger row. Idempotent on `idempotencyKey`. */
export async function createManualJournal(
  context: ScopedTenantContext,
  actorId: UserId,
  input: CreateManualJournalInput,
): Promise<ManualJournal> {
  assertTrustedScopedContext(context);
  const request = createManualJournalInputSchema.parse(input);
  assertRequestScope(context, request.outletId, request.lines);
  const fingerprint = fingerprintOf(request);
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    const existing = await findByKey(tx, tenantId, request.idempotencyKey);
    if (existing)
      return toManualJournal(
        assertReplay(existing, actorId, fingerprint, context),
      );
    await requireLegalEntity(tx, tenantId, request.legalEntityId);
    if (request.outletId !== null)
      await requireOutlet(tx, tenantId, request.outletId);
    const [row] = await tx
      .insert(manualJournals)
      .values({
        tenantId,
        legalEntityId: request.legalEntityId,
        outletId: request.outletId,
        entryDate: request.entryDate,
        kind: request.kind,
        description: request.description,
        lines: request.lines,
        status: "draft",
        requestedBy: actorId,
        idempotencyKey: request.idempotencyKey,
        requestFingerprint: fingerprint,
      })
      .onConflictDoNothing({
        target: [manualJournals.tenantId, manualJournals.idempotencyKey],
      })
      .returning();
    if (!row) {
      const concurrent = await findByKey(tx, tenantId, request.idempotencyKey);
      if (concurrent)
        return toManualJournal(
          assertReplay(concurrent, actorId, fingerprint, context),
        );
      throw new Error("Manual journal conflicted without an existing row.");
    }
    await audit(tx, context, actorId, "created", row);
    return toManualJournal(row);
  });
}

// ------------------------------------------------------------------- reads

/** One page, newest first, keyset on (created_at desc, id desc). */
export async function listManualJournals(
  context: ScopedTenantContext,
  query: ListManualJournalsQuery,
): Promise<CursorPage<ManualJournal>> {
  assertTrustedScopedContext(context);
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    await requireLegalEntity(tx, tenantId, query.legalEntityId);
    const filters: SQL[] = [
      eq(manualJournals.tenantId, tenantId),
      eq(manualJournals.legalEntityId, query.legalEntityId),
    ];
    if (query.status) filters.push(eq(manualJournals.status, query.status));
    if (context.outletScope.kind !== "tenant") {
      const ids = [...context.outletScope.outletIds];
      if (ids.length === 0)
        return { data: [], meta: { limit: query.limit, nextCursor: null } };
      filters.push(inArray(manualJournals.outletId, ids));
    }
    if (query.cursor) {
      let keys: ReturnType<typeof decodeCursor>;
      try {
        keys = decodeCursor(query.cursor);
      } catch {
        throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
      }
      const [stamp, id] = keys;
      if (typeof stamp !== "string" || typeof id !== "string")
        throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
      // The cursor stamp is the microsecond-precision text of created_at, so
      // rows created within one millisecond never repeat or vanish.
      const cursorFilter = or(
        sql`${manualJournals.createdAt} < ${stamp}::timestamptz`,
        and(
          sql`${manualJournals.createdAt} = ${stamp}::timestamptz`,
          sql`${manualJournals.id} < ${id}`,
        ),
      );
      if (cursorFilter) filters.push(cursorFilter);
    }
    const rows = await tx
      .select({
        row: manualJournals,
        stamp: sql<string>`to_char(${manualJournals.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(manualJournals)
      .where(and(...filters))
      .orderBy(desc(manualJournals.createdAt), desc(manualJournals.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map((entry) => toManualJournal(entry.row)),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.stamp, last.row.id])
            : null,
      },
    };
  });
}

export async function getManualJournal(
  context: ScopedTenantContext,
  id: string,
): Promise<ManualJournal> {
  assertTrustedScopedContext(context);
  return withTenant(db, context, async (tx) =>
    toManualJournal(await loadVisibleRow(tx, context, id, false)),
  );
}

// ------------------------------------------------------------------ update

/** Requester edits a draft or rejected request; a rejected one returns to draft. */
export async function updateManualJournal(
  context: ScopedTenantContext,
  actorId: UserId,
  id: string,
  input: UpdateManualJournalInput,
): Promise<ManualJournal> {
  assertTrustedScopedContext(context);
  const patch = updateManualJournalInputSchema.parse(input);
  return withTenant(db, context, async (tx) => {
    const row = await loadVisibleRow(tx, context, id, true);
    const status = transitionManualJournal(viewOf(row), {
      type: "edit",
      actorId,
    });
    const next = {
      outletId: patch.outletId === undefined ? row.outletId : patch.outletId,
      lines: patch.lines ?? row.lines,
    };
    assertRequestScope(context, next.outletId, next.lines);
    if (next.outletId !== null && next.outletId !== row.outletId)
      await requireOutlet(tx, context.tenant.tenantId, next.outletId);
    const updated = await updateRow(
      tx,
      row,
      {
        status,
        outletId: next.outletId,
        lines: next.lines,
        entryDate: patch.entryDate ?? row.entryDate,
        kind: patch.kind ?? row.kind,
        description: patch.description ?? row.description,
        // A rejected request edited back to draft starts a fresh decision.
        decidedBy: null,
        decidedAt: null,
        rejectionReason: null,
        approvalChainId: null,
        submittedAt: null,
      },
      new Date(),
    );
    return toManualJournal(updated);
  });
}

// ------------------------------------------------------------------ submit

/** Requester sends the draft for approval (period gate, then approval chain). */
export async function submitManualJournal(
  context: ScopedTenantContext,
  actorId: UserId,
  id: string,
  now = new Date(),
): Promise<ManualJournal> {
  assertTrustedScopedContext(context);
  return withTenant(db, context, async (tx) => {
    const row = await loadVisibleRow(tx, context, id, true);
    const status = transitionManualJournal(viewOf(row), {
      type: "submit",
      actorId,
    });
    await assertJournalPeriodPostable(tx, context, {
      legalEntityId: row.legalEntityId,
      entryDate: row.entryDate,
    });
    await assertJournalLinesPostable(tx, context, row.legalEntityId, row.lines);
    const totalIdr = checkJournalBalance(row.lines).totalDebitIdr;
    // The approval request needs a reason of at least 3 characters.
    const requestReason =
      row.description.length >= 3
        ? row.description
        : `Jurnal manual: ${row.description}`;
    // APPROVAL_POLICY_MISSING propagates: nobody may approve, fail closed.
    const opened = await openApprovalRequest(tx, context, {
      sourceModule: JOURNAL_APPROVAL_SOURCE_MODULE,
      actionType: "manual_journal",
      objectType: MANUAL_JOURNAL_OBJECT_TYPE,
      objectId: row.id,
      amountIdr: totalIdr,
      outletId: row.outletId,
      requestedBy: actorId,
      source: "user",
      requestReason,
      now,
    });
    const updated = await updateRow(
      tx,
      row,
      {
        status,
        submittedAt: now,
        approvalChainId: opened.required ? opened.chainId : null,
      },
      now,
    );
    await audit(tx, context, actorId, "submitted", updated);
    return toManualJournal(updated);
  });
}

// ---------------------------------------------------------------- withdraw

/** Requester pulls a pending request back to draft; the chain is cancelled. */
export async function withdrawManualJournal(
  context: ScopedTenantContext,
  actorId: UserId,
  id: string,
  now = new Date(),
): Promise<ManualJournal> {
  assertTrustedScopedContext(context);
  return withTenant(db, context, async (tx) => {
    const row = await loadVisibleRow(tx, context, id, true);
    const status = transitionManualJournal(viewOf(row), {
      type: "withdraw",
      actorId,
    });
    if (row.approvalChainId !== null)
      await cancelChain(tx, context, row.approvalChainId, actorId, now);
    const updated = await updateRow(
      tx,
      row,
      { status, approvalChainId: null, submittedAt: null },
      now,
    );
    await audit(tx, context, actorId, "withdrawn", updated);
    return toManualJournal(updated);
  });
}

/**
 * Cancels the open chain. A chain that already ended "approved" cannot be
 * withdrawn or rejected any more: the decision exists, settle applies it.
 */
async function cancelChain(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  chainId: string,
  actorId: UserId,
  now: Date,
): Promise<void> {
  const outcome = await cancelApprovalRequest(tx, context, {
    chainId,
    sourceModule: JOURNAL_APPROVAL_SOURCE_MODULE,
    actorUserId: actorId,
    now,
  });
  if (outcome === "approved") throw new AccountingError("INVALID_TRANSITION");
}

// ----------------------------------------------------------------- approve

/**
 * Approves a pending request. Without a chain the actor decides here and the
 * entry posts. With a chain the decision comes from the approval inbox: this
 * settles it, or answers 409 APPROVAL_PENDING while the chain is still open.
 * An already posted request is returned unchanged (replay-safe).
 */
export async function approveManualJournal(
  context: ScopedTenantContext,
  actorId: UserId,
  id: string,
  now = new Date(),
): Promise<ManualJournal> {
  assertTrustedScopedContext(context);
  return withTenant(db, context, async (tx) => {
    const row = await loadVisibleRow(tx, context, id, true);
    if (row.requestedBy === actorId)
      throw new AccessError("APPROVER_IS_REQUESTER");
    if (row.status === "posted") return toManualJournal(row);
    transitionManualJournal(viewOf(row), { type: "approve", actorId });
    if (row.approvalChainId === null)
      return toManualJournal(
        await postApproved(tx, context, row, actorId, now),
      );
    const settled = await settleRow(tx, context, row, now);
    if (settled.status === "pending_approval")
      throw new HttpError(
        409,
        "APPROVAL_PENDING",
        "Persetujuan belum selesai di kotak masuk approval.",
      );
    return toManualJournal(settled);
  });
}

// ------------------------------------------------------------------ settle

/**
 * Applies the approval chain's outcome to a pending request, on the caller's
 * transaction (row locked FOR UPDATE). Idempotent: a request that is no longer
 * pending, or has no chain, or whose chain is still open, is returned
 * unchanged. Used by the approve endpoint and the outbox consumer.
 */
export async function settleManualJournalForApproval(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  manualJournalId: string,
  now = new Date(),
): Promise<ManualJournal> {
  const row = await loadRow(tx, context.tenant.tenantId, manualJournalId, true);
  if (!row) throw notFound();
  return toManualJournal(await settleRow(tx, context, row, now));
}

async function settleRow(
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
  if (outcome === "approved") {
    const decider = last.decidedBy;
    if (
      decider !== null &&
      decider.toLowerCase() !== row.requestedBy.toLowerCase()
    ) {
      const approverId = userIdSchema.parse(decider);
      // The inbox role can decide; the ledger still needs the post permission.
      if (
        !(await approverMayPostJournal(
          tx,
          context,
          approverId,
          { outletId: row.outletId, lines: row.lines },
          now,
        ))
      )
        return rejectSettled(
          tx,
          context,
          row,
          "approval approver lacks permission",
          null,
          now,
        );
      try {
        // Savepoint: a refused posting leaves no partial ledger write behind.
        return await tx.transaction((sp) =>
          postApproved(sp, context, row, approverId, now),
        );
      } catch (error) {
        const code = postingRefusalCode(error);
        if (code === null) throw error;
        return rejectSettled(
          tx,
          context,
          row,
          `posting refused: ${code}`,
          null,
          now,
        );
      }
    }
    return rejectSettled(
      tx,
      context,
      row,
      "approval approver invalid",
      null,
      now,
    );
  }
  return rejectSettled(
    tx,
    context,
    row,
    `approval ${outcome}`,
    last.decidedBy !== null &&
      last.decidedBy.toLowerCase() !== row.requestedBy.toLowerCase()
      ? userIdSchema.parse(last.decidedBy)
      : null,
    now,
  );
}

/** Ends a pending request as rejected by the chain or the system and audits it. */
async function rejectSettled(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  row: Row,
  reason: string,
  decidedBy: UserId | null,
  now: Date,
): Promise<Row> {
  const rejected = await updateRow(
    tx,
    row,
    {
      status: "rejected",
      rejectionReason: reason,
      decidedBy,
      decidedAt: now,
    },
    now,
  );
  await audit(tx, context, decidedBy, "rejected", rejected, reason);
  return rejected;
}

// ------------------------------------------------------------------ reject

/** Someone other than the requester rejects a pending request with a reason. */
export async function rejectManualJournal(
  context: ScopedTenantContext,
  actorId: UserId,
  id: string,
  reason: string,
  now = new Date(),
): Promise<ManualJournal> {
  assertTrustedScopedContext(context);
  return withTenant(db, context, async (tx) => {
    const row = await loadVisibleRow(tx, context, id, true);
    const status = transitionManualJournal(viewOf(row), {
      type: "reject",
      actorId,
      reason,
    });
    if (row.approvalChainId !== null)
      await cancelChain(tx, context, row.approvalChainId, actorId, now);
    const updated = await updateRow(
      tx,
      row,
      {
        status,
        rejectionReason: reason.trim(),
        decidedBy: actorId,
        decidedAt: now,
      },
      now,
    );
    await audit(tx, context, actorId, "rejected", updated, reason.trim());
    return toManualJournal(updated);
  });
}

// ------------------------------------------------------------------ cancel

/** Requester abandons a draft or rejected request. */
export async function cancelManualJournal(
  context: ScopedTenantContext,
  actorId: UserId,
  id: string,
  now = new Date(),
): Promise<ManualJournal> {
  assertTrustedScopedContext(context);
  return withTenant(db, context, async (tx) => {
    const row = await loadVisibleRow(tx, context, id, true);
    const status = transitionManualJournal(viewOf(row), {
      type: "cancel",
      actorId,
    });
    // A cancelled request is no longer decided: clear the rejection fields
    // (manual_journals_rejected_check, manualJournalSchema).
    const updated = await updateRow(
      tx,
      row,
      { status, rejectionReason: null, decidedBy: null, decidedAt: null },
      now,
    );
    await audit(tx, context, actorId, "cancelled", updated);
    return toManualJournal(updated);
  });
}
