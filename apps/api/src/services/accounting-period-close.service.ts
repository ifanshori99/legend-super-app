// Fiscal period close and approved reopen (PRD v1.7 §3.19 "Tutup Periode";
// ACC-02; bead legend-72we, absorbs legend-xm30 BE). Decisions come from the
// contract (`decidePeriodClose`, `decidePeriodReopen`); this file owns the
// locking and the persistence.
//
// Lock order everywhere: legal entity row, then period row, then reopen
// request row; never the reverse.
//   close / approve reopen:
//     legal_entities … FOR UPDATE → fiscal_periods … FOR UPDATE
//     → read ALL periods of the entity → decide → (close: snapshot) → update.
//   posting (accounting-period.service.ts) takes FOR KEY SHARE on the same
//   entity row, so a post and a close/reopen of one entity wait for each other
//   while other entities and tenants are unaffected.
// The snapshot is taken after the locks and before the status/version change,
// so it contains exactly the entries committed before the close.
//
// Idempotent close: the key is stored on the snapshot. A replay by the same
// key of a close that already happened returns the current period and writes
// no second snapshot.

import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
import {
  AccountingError,
  assertPeriodVersion,
  assertReopenRequestable,
  decidePeriodClose,
  decidePeriodReopen,
  periodCloseSnapshotSchema,
  periodReopenRequestSchema,
  rejectInputSchema,
  requestPeriodReopenInputSchema,
  type FiscalPeriod,
  type PeriodCloseSnapshot,
  type PeriodReopenRequest,
} from "@starter/shared/accounting";
import {
  assertTrustedScopedContext,
  businessDateOf,
  CoreError,
  DEFAULT_BUSINESS_DAY_CLOCK,
  idempotencyKeySchema,
  idr,
  type Idr,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import { db } from "../db";
import {
  fiscalPeriods,
  fiscalPeriodSnapshotLines,
  fiscalPeriodSnapshots,
  journalEntries,
  journalLines,
  periodReopenRequests,
} from "../db/schema";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import {
  lockLegalEntityForPeriodChange,
  lockLegalEntityShared,
  toFiscalPeriod,
} from "./accounting-period.service";
import {
  auditAccountingChange,
  requireLegalEntity,
  uniqueViolation,
  type TenantTransaction,
} from "./accounting-shared";

type FiscalPeriodRow = typeof fiscalPeriods.$inferSelect;
type ReopenRequestRow = typeof periodReopenRequests.$inferSelect;

const SNAPSHOT_LINE_CHUNK = 1000;

function toReopenRequest(row: ReopenRequestRow): PeriodReopenRequest {
  return periodReopenRequestSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    legalEntityId: row.legalEntityId,
    fiscalPeriodId: row.fiscalPeriodId,
    period: row.period,
    reason: row.reason,
    status: row.status,
    requestedBy: row.requestedBy,
    requestedAt: row.requestedAt.toISOString(),
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
  });
}

function periodNotFound(): HttpError {
  return new HttpError(404, "NOT_FOUND", "Fiscal period not found.");
}

function requestNotFound(): HttpError {
  return new HttpError(404, "NOT_FOUND", "Period reopen request not found.");
}

/** Unlocked read: only to learn the legal entity before taking locks in order. */
async function readPeriod(
  tx: TenantTransaction,
  tenantId: string,
  fiscalPeriodId: string,
): Promise<FiscalPeriodRow> {
  const [row] = await tx
    .select()
    .from(fiscalPeriods)
    .where(
      and(
        eq(fiscalPeriods.tenantId, tenantId),
        eq(fiscalPeriods.id, fiscalPeriodId),
      ),
    )
    .limit(1);
  if (!row) throw periodNotFound();
  return row;
}

async function lockPeriodForUpdate(
  tx: TenantTransaction,
  tenantId: string,
  fiscalPeriodId: string,
): Promise<FiscalPeriodRow> {
  const [row] = await tx
    .select()
    .from(fiscalPeriods)
    .where(
      and(
        eq(fiscalPeriods.tenantId, tenantId),
        eq(fiscalPeriods.id, fiscalPeriodId),
      ),
    )
    .limit(1)
    .for("update");
  if (!row) throw periodNotFound();
  return row;
}

function readEntityPeriods(
  tx: TenantTransaction,
  tenantId: string,
  legalEntityId: string,
): Promise<FiscalPeriodRow[]> {
  return tx
    .select()
    .from(fiscalPeriods)
    .where(
      and(
        eq(fiscalPeriods.tenantId, tenantId),
        eq(fiscalPeriods.legalEntityId, legalEntityId),
      ),
    )
    .orderBy(asc(fiscalPeriods.period));
}

/**
 * Cumulative debit/credit per account of every journal line of the entity whose
 * entry belongs to a period up to and including `period`.
 */
async function cumulativeBalances(
  tx: TenantTransaction,
  tenantId: string,
  legalEntityId: string,
  period: string,
): Promise<{ accountId: string; debitIdr: Idr; creditIdr: Idr }[]> {
  const rows = await tx
    .select({
      accountId: journalLines.accountId,
      debit: sql<string>`sum(${journalLines.debitIdr})::text`,
      credit: sql<string>`sum(${journalLines.creditIdr})::text`,
    })
    .from(journalLines)
    .innerJoin(
      journalEntries,
      and(
        eq(journalEntries.tenantId, journalLines.tenantId),
        eq(journalEntries.id, journalLines.entryId),
      ),
    )
    .innerJoin(
      fiscalPeriods,
      and(
        eq(fiscalPeriods.tenantId, journalEntries.tenantId),
        eq(fiscalPeriods.id, journalEntries.fiscalPeriodId),
      ),
    )
    .where(
      and(
        eq(journalLines.tenantId, tenantId),
        eq(journalEntries.legalEntityId, legalEntityId),
        lte(fiscalPeriods.period, period),
      ),
    )
    .groupBy(journalLines.accountId)
    .orderBy(asc(journalLines.accountId));
  return rows.map((row) => ({
    accountId: row.accountId,
    debitIdr: idr(Number(row.debit)),
    creditIdr: idr(Number(row.credit)),
  }));
}

/**
 * Closes a month with a balance snapshot (§3.19). `expectedVersion` turns a
 * stale screen into PERIOD_CHANGED; the same `idempotencyKey` replays safely.
 */
export async function closeFiscalPeriod(
  context: ScopedTenantContext,
  fiscalPeriodId: string,
  input: { expectedVersion: number; idempotencyKey: string },
  actorId: UserId,
  now = new Date(),
): Promise<FiscalPeriod> {
  assertTrustedScopedContext(context);
  const idempotencyKey = idempotencyKeySchema.parse(input.idempotencyKey);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const unlocked = await readPeriod(tx, tenantId, fiscalPeriodId);
    await lockLegalEntityForPeriodChange(tx, tenantId, unlocked.legalEntityId);
    const row = await lockPeriodForUpdate(tx, tenantId, fiscalPeriodId);

    const [replay] = await tx
      .select({
        fiscalPeriodId: fiscalPeriodSnapshots.fiscalPeriodId,
        version: fiscalPeriodSnapshots.version,
      })
      .from(fiscalPeriodSnapshots)
      .where(
        and(
          eq(fiscalPeriodSnapshots.tenantId, tenantId),
          eq(fiscalPeriodSnapshots.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    if (replay) {
      // Same key and the close it produced is still the current state.
      if (
        replay.fiscalPeriodId === row.id &&
        row.status === "closed" &&
        row.version === replay.version
      )
        return toFiscalPeriod(row);
      throw new CoreError(
        "IDEMPOTENCY_KEY_REUSED",
        "That idempotency key was already used for a different close.",
      );
    }

    assertPeriodVersion(row, input.expectedVersion);
    const entityPeriods = await readEntityPeriods(
      tx,
      tenantId,
      row.legalEntityId,
    );
    const closed = decidePeriodClose({
      period: toFiscalPeriod(row),
      entityPeriods: entityPeriods.map(toFiscalPeriod),
      today: businessDateOf(now, DEFAULT_BUSINESS_DAY_CLOCK),
      actorId,
      now: now.toISOString(),
    });

    const balances = await cumulativeBalances(
      tx,
      tenantId,
      row.legalEntityId,
      row.period,
    );
    let snapshot: { id: string } | undefined;
    try {
      [snapshot] = await tx
        .insert(fiscalPeriodSnapshots)
        .values({
          tenantId,
          legalEntityId: row.legalEntityId,
          fiscalPeriodId: row.id,
          period: row.period,
          version: closed.version,
          idempotencyKey,
          takenBy: actorId,
          takenAt: now,
        })
        .returning({ id: fiscalPeriodSnapshots.id });
    } catch (error) {
      // The replay read above is unlocked: a concurrent close of another
      // entity with the same key commits first and the unique index fires.
      // (period, version) cannot collide here: the entity lock serializes it.
      if (uniqueViolation(error))
        throw new CoreError(
          "IDEMPOTENCY_KEY_REUSED",
          "That idempotency key was already used for a different close.",
        );
      throw error;
    }
    if (!snapshot) throw new Error("Snapshot insert returned no row.");
    for (let at = 0; at < balances.length; at += SNAPSHOT_LINE_CHUNK)
      await tx.insert(fiscalPeriodSnapshotLines).values(
        balances.slice(at, at + SNAPSHOT_LINE_CHUNK).map((balance) => ({
          tenantId,
          snapshotId: snapshot.id,
          accountId: balance.accountId,
          debitIdr: balance.debitIdr,
          creditIdr: balance.creditIdr,
        })),
      );

    const [updated] = await tx
      .update(fiscalPeriods)
      .set({
        status: "closed",
        version: closed.version,
        closedBy: actorId,
        closedAt: now,
        updatedAt: now,
      })
      .where(
        and(eq(fiscalPeriods.tenantId, tenantId), eq(fiscalPeriods.id, row.id)),
      )
      .returning();
    if (!updated) throw periodNotFound();
    await auditAccountingChange(tx, context, {
      actorId,
      action: "accounting.period.closed",
      objectType: "fiscal_period",
      objectId: row.id,
      before: { status: "open", version: row.version },
      after: { status: "closed", version: closed.version },
    });
    return toFiscalPeriod(updated);
  });
}

/** The snapshot of the latest close of the period (404 when never closed). */
export async function getPeriodSnapshot(
  context: ScopedTenantContext,
  fiscalPeriodId: string,
): Promise<PeriodCloseSnapshot> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const [snapshot] = await tx
      .select()
      .from(fiscalPeriodSnapshots)
      .where(
        and(
          eq(fiscalPeriodSnapshots.tenantId, tenantId),
          eq(fiscalPeriodSnapshots.fiscalPeriodId, fiscalPeriodId),
        ),
      )
      .orderBy(desc(fiscalPeriodSnapshots.version))
      .limit(1);
    if (!snapshot)
      throw new HttpError(404, "NOT_FOUND", "Period snapshot not found.");
    const lines = await tx
      .select()
      .from(fiscalPeriodSnapshotLines)
      .where(
        and(
          eq(fiscalPeriodSnapshotLines.tenantId, tenantId),
          eq(fiscalPeriodSnapshotLines.snapshotId, snapshot.id),
        ),
      )
      .orderBy(asc(fiscalPeriodSnapshotLines.accountId));
    return periodCloseSnapshotSchema.parse({
      fiscalPeriodId: snapshot.fiscalPeriodId,
      legalEntityId: snapshot.legalEntityId,
      period: snapshot.period,
      version: snapshot.version,
      takenAt: snapshot.takenAt.toISOString(),
      takenBy: snapshot.takenBy,
      balances: lines.map((line) => ({
        accountId: line.accountId,
        debitIdr: line.debitIdr,
        creditIdr: line.creditIdr,
      })),
    });
  });
}

/** Opens a reopen request for a closed period; one pending request per period. */
export async function requestPeriodReopen(
  context: ScopedTenantContext,
  fiscalPeriodId: string,
  input: { reason: string },
  actorId: UserId,
  now = new Date(),
): Promise<PeriodReopenRequest> {
  const request = requestPeriodReopenInputSchema.parse(input);
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    // Entity KEY SHARE first (the request insert's FK check would take it
    // anyway, after the period lock, and deadlock against a close holding the
    // entity FOR UPDATE). Then FOR SHARE on the period conflicts with a
    // close/reopen FOR UPDATE, so the status checked here cannot change before
    // the request row is written.
    const unlocked = await readPeriod(tx, tenantId, fiscalPeriodId);
    await lockLegalEntityShared(tx, tenantId, unlocked.legalEntityId);
    const [period] = await tx
      .select()
      .from(fiscalPeriods)
      .where(
        and(
          eq(fiscalPeriods.tenantId, tenantId),
          eq(fiscalPeriods.id, fiscalPeriodId),
        ),
      )
      .limit(1)
      .for("share");
    if (!period) throw periodNotFound();
    assertReopenRequestable(period, request.reason);
    let row: ReopenRequestRow | undefined;
    try {
      [row] = await tx
        .insert(periodReopenRequests)
        .values({
          tenantId,
          legalEntityId: period.legalEntityId,
          fiscalPeriodId: period.id,
          period: period.period,
          reason: request.reason,
          requestedBy: actorId,
          requestedAt: now,
        })
        .returning();
    } catch (error) {
      if (uniqueViolation(error))
        throw new HttpError(
          409,
          "REOPEN_REQUEST_PENDING",
          "A reopen request for this period is already pending.",
        );
      throw error;
    }
    if (!row) throw new Error("Reopen request insert returned no row.");
    await auditAccountingChange(tx, context, {
      actorId,
      action: "accounting.period.reopen_requested",
      objectType: "fiscal_period",
      objectId: period.id,
      reason: request.reason,
      before: null,
      after: { status: "pending" },
    });
    return toReopenRequest(row);
  });
}

export async function listPeriodReopenRequests(
  context: ScopedTenantContext,
  legalEntityId: string,
): Promise<{ data: PeriodReopenRequest[] }> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    await requireLegalEntity(tx, tenantId, legalEntityId);
    const rows = await tx
      .select()
      .from(periodReopenRequests)
      .where(
        and(
          eq(periodReopenRequests.tenantId, tenantId),
          eq(periodReopenRequests.legalEntityId, legalEntityId),
        ),
      )
      .orderBy(
        desc(periodReopenRequests.requestedAt),
        desc(periodReopenRequests.id),
      );
    return { data: rows.map(toReopenRequest) };
  });
}

async function readRequest(
  tx: TenantTransaction,
  tenantId: string,
  requestId: string,
  lock: boolean,
): Promise<ReopenRequestRow> {
  const query = tx
    .select()
    .from(periodReopenRequests)
    .where(
      and(
        eq(periodReopenRequests.tenantId, tenantId),
        eq(periodReopenRequests.id, requestId),
      ),
    )
    .limit(1);
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw requestNotFound();
  return row;
}

/**
 * Approves a reopen request: reopens the latest closed period of the entity.
 * The approver differs from the requester and from whoever closed the period.
 */
export async function approvePeriodReopen(
  context: ScopedTenantContext,
  requestId: string,
  input: { note: string | null },
  actorId: UserId,
  now = new Date(),
): Promise<{ request: PeriodReopenRequest; period: FiscalPeriod }> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    // Unlocked read only to learn entity and period, then lock in order.
    const unlocked = await readRequest(tx, tenantId, requestId, false);
    await lockLegalEntityForPeriodChange(tx, tenantId, unlocked.legalEntityId);
    const periodRow = await lockPeriodForUpdate(
      tx,
      tenantId,
      unlocked.fiscalPeriodId,
    );
    const requestRow = await readRequest(tx, tenantId, requestId, true);
    const entityPeriods = await readEntityPeriods(
      tx,
      tenantId,
      periodRow.legalEntityId,
    );
    const decision = decidePeriodReopen({
      request: toReopenRequest(requestRow),
      period: toFiscalPeriod(periodRow),
      entityPeriods: entityPeriods.map(toFiscalPeriod),
      decision: "approve",
      actorId,
      now: now.toISOString(),
    });
    if (decision.requestStatus !== "approved")
      throw new AccountingError("INVALID_TRANSITION");
    const reopened = decision.period;
    const [updatedPeriod] = await tx
      .update(fiscalPeriods)
      .set({
        status: "open",
        version: reopened.version,
        closedBy: null,
        closedAt: null,
        reopenedReason: reopened.reopenedReason,
        reopenedBy: actorId,
        reopenedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(fiscalPeriods.tenantId, tenantId),
          eq(fiscalPeriods.id, periodRow.id),
        ),
      )
      .returning();
    const [updatedRequest] = await tx
      .update(periodReopenRequests)
      .set({
        status: "approved",
        decidedBy: actorId,
        decidedAt: now,
        decisionNote: input.note,
        updatedAt: now,
      })
      .where(
        and(
          eq(periodReopenRequests.tenantId, tenantId),
          eq(periodReopenRequests.id, requestRow.id),
        ),
      )
      .returning();
    if (!updatedPeriod || !updatedRequest) throw requestNotFound();
    await auditAccountingChange(tx, context, {
      actorId,
      action: "accounting.period.reopened",
      objectType: "fiscal_period",
      objectId: periodRow.id,
      reason: reopened.reopenedReason,
      before: { status: "closed", version: periodRow.version },
      after: { status: "open", version: reopened.version },
    });
    return {
      request: toReopenRequest(updatedRequest),
      period: toFiscalPeriod(updatedPeriod),
    };
  });
}

/** Rejects a pending reopen request; the period is not touched. */
export async function rejectPeriodReopen(
  context: ScopedTenantContext,
  requestId: string,
  input: { reason: string },
  actorId: UserId,
  now = new Date(),
): Promise<PeriodReopenRequest> {
  const rejection = rejectInputSchema.parse(input);
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    // Takes only the request lock (the last in the order); the period is read
    // unlocked because a rejection never changes it.
    const requestRow = await readRequest(tx, tenantId, requestId, true);
    const periodRow = await readPeriod(tx, tenantId, requestRow.fiscalPeriodId);
    const decision = decidePeriodReopen({
      request: toReopenRequest(requestRow),
      period: toFiscalPeriod(periodRow),
      entityPeriods: [],
      decision: "reject",
      actorId,
      now: now.toISOString(),
    });
    if (decision.requestStatus !== "rejected")
      throw new AccountingError("INVALID_TRANSITION");
    const [updated] = await tx
      .update(periodReopenRequests)
      .set({
        status: "rejected",
        decidedBy: actorId,
        decidedAt: now,
        decisionNote: rejection.reason,
        updatedAt: now,
      })
      .where(
        and(
          eq(periodReopenRequests.tenantId, tenantId),
          eq(periodReopenRequests.id, requestRow.id),
        ),
      )
      .returning();
    if (!updated) throw requestNotFound();
    await auditAccountingChange(tx, context, {
      actorId,
      action: "accounting.period.reopen_rejected",
      objectType: "fiscal_period",
      objectId: periodRow.id,
      reason: rejection.reason,
      before: { status: "pending" },
      after: { status: "rejected" },
    });
    return toReopenRequest(updated);
  });
}
