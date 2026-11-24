// Fiscal period close and approved reopen (PRD v1.7 §3.19 "Tutup Periode";
// ACC-02; bead legend-72we, absorbs legend-xm30 BE). Decisions come from the
// contract (`decidePeriodClose`, `decidePeriodReopen`); this file owns the
// locking and the persistence.
//
// Lock order everywhere: legal entity row, then period row, then reopen
// request row; never the reverse.
//   close / approve reopen:
//     SET LOCAL lock_timeout → legal_entities … FOR NO KEY UPDATE
//     → fiscal_periods … FOR UPDATE
//     → read ALL periods of the entity → decide → (close: snapshot) → update.
//   posting and reopen requests take FOR SHARE on the same entity row, so a
//   post and a close/reopen of one entity wait for each other while other
//   entities and tenants are unaffected. NO KEY UPDATE leaves FK checks
//   (KEY SHARE) from other tables referencing legal_entities unblocked. A lock
//   wait over PERIOD_CHANGE_LOCK_TIMEOUT_MS becomes a retryable 409 CONFLICT.
// The snapshot is taken after the locks and before the status/version change,
// so it contains exactly the entries committed before the close.
//
// Idempotent close: the key is stored on the snapshot. A replay by the same
// key of a close that already happened returns the current period and writes
// no second snapshot.

import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { AccessError } from "@starter/shared/access";
import {
  AccountingError,
  assertPeriodVersion,
  assertReopenRequestable,
  decidePeriodClose,
  decidePeriodReopen,
  PERIOD_CLOSE_OVERRIDABLE_CODE,
  PERIOD_CLOSE_OVERRIDE_MAX_SOURCES,
  periodCloseBlockersSchema,
  closeFiscalPeriodOverrideInputSchema,
  periodCloseSnapshotSchema,
  periodReopenRequestSchema,
  rejectInputSchema,
  requestPeriodReopenInputSchema,
  type CloseFiscalPeriodOverrideInput,
  type FiscalPeriod,
  type PeriodCloseBlockers,
  type PeriodCloseSnapshot,
  type PeriodReopenRequest,
} from "@starter/shared/accounting";
import {
  assertTrustedScopedContext,
  businessDateOf,
  CoreError,
  DEFAULT_BUSINESS_DAY_CLOCK,
  idempotencyKeySchema,
  idrFromBigInt,
  type Idr,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import { db } from "../db";
import {
  auditLogs,
  distributionRuns,
  fiscalPeriods,
  fiscalPeriodSnapshotLines,
  fiscalPeriodSnapshots,
  inventoryItems,
  journalEntries,
  journalLines,
  periodReopenRequests,
  productionOrders,
} from "../db/schema";
import { withTenant } from "../db/tenant";
import {
  listBlockedInventoryGlUpTo,
  type BlockedInventoryGlSource,
} from "./inventory-gl-consumer.ts";
import { sourceIdToDb } from "./inventory.service.ts";
import { HttpError } from "../lib/http-error";
import {
  lockLegalEntityForPeriodChange,
  lockLegalEntityShared,
  periodLockTimeoutError,
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

type BalanceRow = { accountId: string; debitIdr: Idr; creditIdr: Idr };
type BalanceSums = Map<string, { debit: bigint; credit: bigint }>;

/** Debit/credit sums per account of the entity's lines matching `where`. */
async function sumLines(
  tx: TenantTransaction,
  tenantId: string,
  legalEntityId: string,
  scope: { fiscalPeriodId: string } | { upToPeriod: string },
): Promise<BalanceSums> {
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
        "fiscalPeriodId" in scope
          ? eq(journalEntries.fiscalPeriodId, scope.fiscalPeriodId)
          : lte(fiscalPeriods.period, scope.upToPeriod),
      ),
    )
    .groupBy(journalLines.accountId);
  return new Map(
    rows.map((row) => [
      row.accountId,
      { debit: BigInt(row.debit), credit: BigInt(row.credit) },
    ]),
  );
}

/** Lines of the latest snapshot of a period, or null when it has none. */
async function latestSnapshotSums(
  tx: TenantTransaction,
  tenantId: string,
  fiscalPeriodId: string,
): Promise<BalanceSums | null> {
  const [snapshot] = await tx
    .select({ id: fiscalPeriodSnapshots.id })
    .from(fiscalPeriodSnapshots)
    .where(
      and(
        eq(fiscalPeriodSnapshots.tenantId, tenantId),
        eq(fiscalPeriodSnapshots.fiscalPeriodId, fiscalPeriodId),
      ),
    )
    .orderBy(desc(fiscalPeriodSnapshots.version))
    .limit(1);
  if (!snapshot) return null;
  const lines = await tx
    .select({
      accountId: fiscalPeriodSnapshotLines.accountId,
      debit: fiscalPeriodSnapshotLines.debitIdr,
      credit: fiscalPeriodSnapshotLines.creditIdr,
    })
    .from(fiscalPeriodSnapshotLines)
    .where(
      and(
        eq(fiscalPeriodSnapshotLines.tenantId, tenantId),
        eq(fiscalPeriodSnapshotLines.snapshotId, snapshot.id),
      ),
    );
  return new Map(
    lines.map((line) => [
      line.accountId,
      { debit: BigInt(line.debit), credit: BigInt(line.credit) },
    ]),
  );
}

/**
 * Cumulative debit/credit per account of every journal line of the entity up
 * to and including `period`, computed incrementally: the latest snapshot of
 * the previous closed period plus this period's own lines. That is exact
 * because, under the entity lock, every earlier period is closed (close goes
 * in order) and nothing posts into a closed period or behind one, so the
 * previous snapshot still equals the journal up to that period. Only the
 * first close of an entity, or a previous period without a snapshot, sums
 * the full history.
 */
async function cumulativeBalances(
  tx: TenantTransaction,
  tenantId: string,
  period: FiscalPeriodRow,
  entityPeriods: readonly FiscalPeriodRow[],
): Promise<BalanceRow[]> {
  const previous = entityPeriods
    .filter((row) => row.period < period.period && row.status === "closed")
    .at(-1);
  const base = previous
    ? await latestSnapshotSums(tx, tenantId, previous.id)
    : null;
  const sums =
    base ??
    (await sumLines(tx, tenantId, period.legalEntityId, {
      upToPeriod: period.period,
    }));
  if (base) {
    const own = await sumLines(tx, tenantId, period.legalEntityId, {
      fiscalPeriodId: period.id,
    });
    for (const [accountId, add] of own) {
      const current = sums.get(accountId) ?? { debit: 0n, credit: 0n };
      sums.set(accountId, {
        debit: current.debit + add.debit,
        credit: current.credit + add.credit,
      });
    }
  }
  return [...sums.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([accountId, sum]) => ({
      accountId,
      debitIdr: balanceIdr(sum.debit),
      creditIdr: balanceIdr(sum.credit),
    }));
}

/**
 * Exact bigint -> Idr for a cumulative balance. Above 2^53 - 1 a snapshot
 * line cannot hold the figure exactly (Idr is a safe integer), and rounding
 * it would corrupt the ledger snapshot, so the close is refused instead
 * (legend-4lft). The surrounding transaction rolls back: nothing is written.
 */
function balanceIdr(value: bigint): Idr {
  try {
    return idrFromBigInt(value);
  } catch (error) {
    if (error instanceof RangeError)
      throw new HttpError(
        422,
        "PERIOD_BALANCE_OVERFLOW",
        "An account balance is too large to snapshot exactly; the period was not closed.",
      );
    throw error;
  }
}

/**
 * Card 1263: only incomplete production batches may be closed over, and only
 * when the closer can see every one of them.
 */
function closeBlockersOverridable(
  blocked: readonly BlockedInventoryGlSource[],
): boolean {
  return (
    blocked.length > 0 &&
    blocked.length <= PERIOD_CLOSE_OVERRIDE_MAX_SOURCES &&
    blocked.every(
      (source) =>
        source.sourceType === "production_order" &&
        source.errorCode === PERIOD_CLOSE_OVERRIDABLE_CODE,
    )
  );
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  return (
    left.size === a.length &&
    a.length === b.length &&
    b.every((id) => left.has(id))
  );
}

/**
 * The replayed key must be the override that this exact request made: same
 * reason and same sources (read back from the append-only audit row). A key
 * of a plain close, or a changed body, is a reuse, so nobody gets a success
 * for a reason that was never recorded.
 */
async function assertSameOverrideReplay(
  tx: TenantTransaction,
  tenantId: string,
  row: FiscalPeriodRow,
  override: CloseOverride,
): Promise<void> {
  const rows = await tx
    .select({ event: auditLogs.event })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.tenantId, tenantId),
        sql`${auditLogs.event}->>'action' = ${CLOSE_OVERRIDDEN_ACTION}`,
        sql`${auditLogs.event}->>'objectId' = ${row.id}`,
        // Compared as text: a masked value ("[REDACTED]") is not a number.
        sql`${auditLogs.event}->'maskedChanges'->'after'->>'version' = ${String(row.version)}`,
      ),
    );
  const same = rows.some(({ event }) => {
    const record = event as {
      reason: string | null;
      maskedChanges: {
        after: { sources?: { sourceId: string }[] | string };
      };
    };
    const { sources } = record.maskedChanges.after;
    // A masked list is a string: it proves nothing, so it never matches.
    return (
      record.reason === override.reason &&
      Array.isArray(sources) &&
      sameIds(
        sources.map((s) => s.sourceId),
        override.sourceIds,
      )
    );
  });
  if (!same)
    throw new CoreError(
      "IDEMPOTENCY_KEY_REUSED",
      "That idempotency key was already used for a different close.",
    );
}

const CLOSE_OVERRIDDEN_ACTION = "accounting.period.close_overridden";

type CloseOverride = { reason: string; sourceIds: readonly string[] };

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
  return closePeriod(context, fiscalPeriodId, input, null, actorId, now);
}

/**
 * Card 1263 (founder no. 19): closes over production batches whose rows are
 * still incomplete, with a written reason, a verified second factor and the
 * exact list of blocked sources the closer saw. Every other check of the close
 * stays. The batches stay parked: once complete they post into the next open
 * period as a late adjustment, never into the closed one.
 */
export async function closeFiscalPeriodOverride(
  context: ScopedTenantContext,
  fiscalPeriodId: string,
  input: CloseFiscalPeriodOverrideInput,
  actorId: UserId,
  options: { readonly mfaVerified: boolean },
  now = new Date(),
): Promise<FiscalPeriod> {
  assertTrustedScopedContext(context);
  if (!options.mfaVerified) throw new AccessError("MFA_REQUIRED");
  const { reason, sourceIds, ...close } =
    closeFiscalPeriodOverrideInputSchema.parse(input);
  return closePeriod(
    context,
    fiscalPeriodId,
    close,
    { reason, sourceIds },
    actorId,
    now,
  );
}

/** What a close of this period would be refused for (card 1263 screen). */
export async function listPeriodCloseBlockers(
  context: ScopedTenantContext,
  fiscalPeriodId: string,
): Promise<PeriodCloseBlockers> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const row = await readPeriod(tx, tenantId, fiscalPeriodId);
    const blocked = await listBlockedInventoryGlUpTo(
      tx,
      tenantId,
      row.legalEntityId,
      row.period,
    );
    const listed = blocked.slice(0, PERIOD_CLOSE_OVERRIDE_MAX_SOURCES);
    const batchIds = listed
      .filter((source) => source.sourceType === "production_order")
      .map((source) => sourceIdToDb(source.sourceId));
    const items = batchIds.length
      ? await tx
          .select({ id: productionOrders.id, name: inventoryItems.name })
          .from(productionOrders)
          .innerJoin(
            inventoryItems,
            and(
              eq(inventoryItems.tenantId, productionOrders.tenantId),
              eq(inventoryItems.id, productionOrders.outputItemId),
            ),
          )
          .where(
            and(
              eq(productionOrders.tenantId, tenantId),
              inArray(productionOrders.id, batchIds),
            ),
          )
      : [];
    const itemNames = new Map(items.map((item) => [item.id, item.name]));
    return periodCloseBlockersSchema.parse({
      count: blocked.length,
      overridable: row.status === "open" && closeBlockersOverridable(blocked),
      sources: listed.map((source) => ({
        ...source,
        itemName:
          source.sourceType === "production_order"
            ? (itemNames.get(sourceIdToDb(source.sourceId)) ?? null)
            : null,
      })),
    });
  });
}

async function closePeriod(
  context: ScopedTenantContext,
  fiscalPeriodId: string,
  input: { expectedVersion: number; idempotencyKey: string },
  override: CloseOverride | null,
  actorId: UserId,
  now: Date,
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
      ) {
        if (override)
          await assertSameOverrideReplay(tx, tenantId, row, override);
        return toFiscalPeriod(row);
      }
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

    // Card 1260: stock sources parked in inventory_gl_blocked up to this
    // period have no journal yet. Refuse the close (fail closed) and say how
    // many; retry or fix the mapping first.
    const blockedGl = await listBlockedInventoryGlUpTo(
      tx,
      tenantId,
      row.legalEntityId,
      row.period,
    );
    const overridden = override && closeBlockersOverridable(blockedGl);
    if (blockedGl.length > 0 && !overridden)
      throw new AccountingError(
        "PERIOD_INVENTORY_GL_BLOCKED",
        `Masih ada ${blockedGl.length} sumber persediaan yang belum terjurnal (diparkir). Selesaikan dulu, lalu tutup periode.`,
        { count: blockedGl.length, sources: blockedGl.slice(0, 20) },
      );
    // The acknowledged list must be the one blocked now, under the entity
    // lock: an empty or a different list is a stale screen.
    if (
      override &&
      !sameIds(
        blockedGl.map((source) => source.sourceId),
        override.sourceIds,
      )
    )
      throw new AccountingError("PERIOD_OVERRIDE_SOURCES_CHANGED");

    const balances = await cumulativeBalances(tx, tenantId, row, entityPeriods);
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

    // legend_app has no UPDATE on the transition columns: the database
    // function checks the close (open period, snapshot of the next version).
    await tx.execute(sql`
      select app.close_fiscal_period(
        ${tenantId}::uuid,
        ${row.id}::uuid,
        ${actorId}::text,
        ${now.toISOString()}::timestamptz
      )
    `);
    const updated = await readPeriod(tx, tenantId, row.id);
    await auditAccountingChange(tx, context, {
      actorId,
      action: "accounting.period.closed",
      objectType: "fiscal_period",
      objectId: row.id,
      before: { status: "open", version: row.version },
      after: { status: "closed", version: closed.version },
    });
    if (override)
      await auditAccountingChange(tx, context, {
        actorId,
        action: CLOSE_OVERRIDDEN_ACTION,
        objectType: "fiscal_period",
        objectId: row.id,
        reason: override.reason,
        before: null,
        after: {
          version: closed.version,
          count: blockedGl.length,
          sources: blockedGl.map(({ sourceType, sourceId, errorCode }) => ({
            sourceType,
            sourceId,
            errorCode,
          })),
        },
      });
    return toFiscalPeriod(updated);
  }).catch((error: unknown) => {
    throw periodLockTimeoutError(error);
  });
}

/**
 * The snapshot of the latest close of the period (404 when never closed),
 * with the period's current status and version: after an approved reopen the
 * snapshot is history (periodStatus "open", periodVersion > version).
 */
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
    const period = await readPeriod(tx, tenantId, fiscalPeriodId);
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
      periodStatus: period.status,
      periodVersion: period.version,
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
    // Entity FOR SHARE first: it conflicts with a close/reopen holding the
    // entity FOR NO KEY UPDATE, so the period statuses read below cannot change
    // before the request row is written, and taking it before the period lock
    // keeps the entity → period order (no deadlock with a close).
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
    // Only the latest closed period can ever be approved; refuse the others
    // now instead of leaving a request that can neither pass nor be withdrawn.
    assertReopenRequestable(
      toFiscalPeriod(period),
      request.reason,
      (await readEntityPeriods(tx, tenantId, period.legalEntityId)).map(
        toFiscalPeriod,
      ),
    );
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
    // SO 1216 F-P1a: an approved (not fully paid) distribution run of this
    // period would pay out stale profit after a reopen. Fail closed: withdraw
    // it first (cancel-approved, no line paid) or, once paid, correct it with
    // an adjustment run after the re-close. The period row lock above serializes this with an
    // approval; the DB trigger on fiscal_periods refuses the same.
    const [approvedRun] = await tx
      .select({ id: distributionRuns.id })
      .from(distributionRuns)
      .where(
        and(
          eq(distributionRuns.tenantId, tenantId),
          eq(distributionRuns.fiscalPeriodId, periodRow.id),
          eq(distributionRuns.status, "approved"),
        ),
      )
      .limit(1);
    if (approvedRun)
      throw new HttpError(
        409,
        "PERIOD_HAS_APPROVED_DISTRIBUTION",
        "Periode ini punya distribusi bagi hasil yang sudah disetujui tetapi belum dibayar. Batalkan persetujuan distribusi yang belum dibayar, atau catat koreksi sesudah periode ditutup ulang.",
      );
    const reopened = decision.period;
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
    if (!updatedRequest) throw requestNotFound();
    // The request is approved above; the database function reopens the period
    // only for an approved, unused request decided by another person.
    await tx.execute(sql`
      select app.reopen_fiscal_period(
        ${tenantId}::uuid,
        ${periodRow.id}::uuid,
        ${requestRow.id}::uuid,
        ${actorId}::text,
        ${now.toISOString()}::timestamptz
      )
    `);
    const updatedPeriod = await readPeriod(tx, tenantId, periodRow.id);
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
  }).catch((error: unknown) => {
    throw periodLockTimeoutError(error);
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
