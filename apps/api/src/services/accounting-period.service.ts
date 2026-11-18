// Fiscal periods (PRD v1.7 §3.19 "Tutup Periode"; ACC-02; beads legend-kwxj,
// legend-72we).
//
// This service owns the list endpoint and the posting guard every journal
// write goes through. Close/reopen with snapshot and approval lives in
// accounting-period-close.service.ts. Lock order everywhere: legal entity row,
// then period row, then reopen-request row; never the reverse.
//
//   post:         SELECT … FROM legal_entities … FOR SHARE
//                 → SELECT … FROM fiscal_periods … FOR SHARE
//                 → assertPostingAllowed(period, entryDate)
//                 → no later period of the entity is closed
//                 → INSERT entry + lines
//   close/reopen: SET LOCAL lock_timeout → SELECT … FROM legal_entities …
//                 FOR NO KEY UPDATE → period row FOR UPDATE → read all
//                 periods of the entity
//
// FOR SHARE on the entity conflicts with the close/reopen FOR NO KEY UPDATE, so a
// close waits for in-flight posts of that entity and a post waits for a close
// that is running; posts never block each other, and other entities or tenants
// are unaffected. NO KEY UPDATE does not conflict with the KEY SHARE that FK
// checks take, so inserts into the many tables referencing legal_entities
// (outlets, employees, chart_of_accounts, …) never wait for a close. A post that starts after the close commits reads `closed`
// and fails PERIOD_CLOSED (contract/period.ts). A lazily created earlier
// period must not accept posts behind a closed later one (the cumulative
// close snapshot would go stale), so that also fails PERIOD_CLOSED. A period
// row is created lazily on first use inside the same transaction, protected
// by the (tenant, legal entity, period) unique key.

import { and, desc, eq, gt, gte, sql } from "drizzle-orm";
import {
  AccountingError,
  assertPeriodVersion,
  assertPostingAllowed,
  fiscalPeriodSchema,
  periodOf,
  type FiscalPeriod,
} from "@starter/shared/accounting";
import type { BusinessDate } from "@starter/shared/core";
import {
  assertTrustedScopedContext,
  CoreError,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { db } from "../db";
import { fiscalPeriods, legalEntities } from "../db/schema";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { entityLock } from "./accounting-bank-matching";
import {
  requireLegalEntity,
  type TenantTransaction,
} from "./accounting-shared";

type FiscalPeriodRow = typeof fiscalPeriods.$inferSelect;

export function toFiscalPeriod(row: FiscalPeriodRow): FiscalPeriod {
  return fiscalPeriodSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    legalEntityId: row.legalEntityId,
    period: row.period,
    status: row.status,
    version: row.version,
    closedBy: row.closedBy,
    closedAt: row.closedAt?.toISOString() ?? null,
    reopenedReason: row.reopenedReason,
    reopenedBy: row.reopenedBy,
    reopenedAt: row.reopenedAt?.toISOString() ?? null,
  });
}

async function lockLegalEntity(
  tx: TenantTransaction,
  tenantId: string,
  legalEntityId: string,
  strength: "no key update" | "share",
): Promise<void> {
  const [row] = await tx
    .select({ id: legalEntities.id })
    .from(legalEntities)
    .where(
      and(
        eq(legalEntities.tenantId, tenantId),
        eq(legalEntities.id, legalEntityId),
      ),
    )
    .limit(1)
    .for(strength);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Legal entity not found.");
}

/**
 * Shared entity lock (FOR SHARE) for writers that must not race a close or
 * reopen of the entity but may run alongside each other (posts, reopen
 * requests). Taken before any period row to keep the entity → period order.
 */
export function lockLegalEntityShared(
  tx: TenantTransaction,
  tenantId: string,
  legalEntityId: string,
): Promise<void> {
  return lockLegalEntity(tx, tenantId, legalEntityId, "share");
}

/**
 * Close/reopen entry lock: legal entity row FOR NO KEY UPDATE, always taken
 * before any period row. Waits for in-flight posts of the entity (FOR SHARE)
 * but not for FK inserts elsewhere (KEY SHARE). Callers set lock_timeout.
 */
export async function lockLegalEntityForPeriodChange(
  tx: TenantTransaction,
  tenantId: string,
  legalEntityId: string,
): Promise<void> {
  // A steady stream of posts keeps FOR SHARE on the entity; bound the wait so
  // a close fails fast with a retryable 409 instead of hanging (see
  // periodLockTimeoutError). SET LOCAL ends with the transaction.
  await tx.execute(
    sql.raw(`SET LOCAL lock_timeout = '${PERIOD_CHANGE_LOCK_TIMEOUT_MS}ms'`),
  );
  await lockLegalEntity(tx, tenantId, legalEntityId, "no key update");
}

/** Lock wait bound for close and approve-reopen transactions. */
export const PERIOD_CHANGE_LOCK_TIMEOUT_MS = 3000;

function lockNotAvailable(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return (
    candidate.code === "55P03" || lockNotAvailable(candidate.cause, depth + 1)
  );
}

/**
 * Maps a lock_timeout (55P03) raised inside a close/approve transaction to a
 * retryable 409 CONFLICT; nothing was written because the transaction rolled
 * back. Any other error is returned unchanged.
 */
export function periodLockTimeoutError(error: unknown): unknown {
  if (!lockNotAvailable(error)) return error;
  return new CoreError(
    "CONFLICT",
    "Periode sedang dipakai transaksi lain. Coba lagi sebentar lagi.",
  );
}

/**
 * Creates the period row when it does not exist yet, then locks it FOR SHARE
 * for the rest of the caller's transaction. Must run inside `withTenant`.
 */
export async function lockFiscalPeriod(
  tx: TenantTransaction,
  tenantId: string,
  legalEntityId: string,
  entryDate: BusinessDate,
): Promise<FiscalPeriodRow> {
  const period = periodOf(entryDate);
  await tx
    .insert(fiscalPeriods)
    .values({ tenantId, legalEntityId, period })
    .onConflictDoNothing({
      target: [
        fiscalPeriods.tenantId,
        fiscalPeriods.legalEntityId,
        fiscalPeriods.period,
      ],
    });
  const [row] = await tx
    .select()
    .from(fiscalPeriods)
    .where(
      and(
        eq(fiscalPeriods.tenantId, tenantId),
        eq(fiscalPeriods.legalEntityId, legalEntityId),
        eq(fiscalPeriods.period, period),
      ),
    )
    .limit(1)
    .for("share");
  if (!row) throw new Error("Fiscal period vanished between insert and lock.");
  return row;
}

/**
 * ACC-02 posting guard. Returns the locked period or throws PERIOD_CLOSED
 * (also when a later period of the entity is closed) / PERIOD_MISMATCH /
 * PERIOD_CHANGED before any journal row is written.
 */
export async function assertPeriodOpenForPosting(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  input: {
    legalEntityId: string;
    entryDate: BusinessDate;
    expectedVersion?: number | null;
  },
): Promise<FiscalPeriodRow> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  await lockLegalEntity(tx, tenantId, input.legalEntityId, "share");
  const row = await lockFiscalPeriod(
    tx,
    tenantId,
    input.legalEntityId,
    input.entryDate,
  );
  assertPostingAllowed(row, input.entryDate);
  // The entity FOR SHARE lock keeps close/reopen out, so this read is stable.
  const [laterClosed] = await tx
    .select({ id: fiscalPeriods.id })
    .from(fiscalPeriods)
    .where(
      and(
        eq(fiscalPeriods.tenantId, tenantId),
        eq(fiscalPeriods.legalEntityId, input.legalEntityId),
        gt(fiscalPeriods.period, row.period),
        eq(fiscalPeriods.status, "closed"),
      ),
    )
    .limit(1);
  if (laterClosed) throw new AccountingError("PERIOD_CLOSED");
  if (input.expectedVersion != null)
    assertPeriodVersion(row, input.expectedVersion);
  return row;
}

/**
 * Side-effect-free probe of the `assertPeriodOpenForPosting` PERIOD_CLOSED
 * rule: true when posting into `period` would fail because the month itself
 * or any LATER month of the entity is closed. Creates no period row. Takes the
 * entity FOR SHARE lock like the guard so close/reopen cannot race the read.
 */
export async function wouldPostingBeBlockedByClosedPeriod(
  tx: TenantTransaction,
  tenantId: string,
  legalEntityId: string,
  period: string,
): Promise<boolean> {
  // Canonical lock order (legend-f250r): entity advisory lock before the
  // entity row share, same as postJournalInTransaction.
  await entityLock(tx, tenantId, legalEntityId);
  await lockLegalEntity(tx, tenantId, legalEntityId, "share");
  const [closed] = await tx
    .select({ id: fiscalPeriods.id })
    .from(fiscalPeriods)
    .where(
      and(
        eq(fiscalPeriods.tenantId, tenantId),
        eq(fiscalPeriods.legalEntityId, legalEntityId),
        gte(fiscalPeriods.period, period),
        eq(fiscalPeriods.status, "closed"),
      ),
    )
    .limit(1);
  return closed !== undefined;
}

export async function listFiscalPeriods(
  context: ScopedTenantContext,
  legalEntityId: string,
): Promise<{ data: FiscalPeriod[] }> {
  return withTenant(db, context, async (tx) => {
    await requireLegalEntity(tx, context.tenant.tenantId, legalEntityId);
    const rows = await tx
      .select()
      .from(fiscalPeriods)
      .where(
        and(
          eq(fiscalPeriods.tenantId, context.tenant.tenantId),
          eq(fiscalPeriods.legalEntityId, legalEntityId),
        ),
      )
      .orderBy(desc(fiscalPeriods.period), desc(fiscalPeriods.id));
    return { data: rows.map(toFiscalPeriod) };
  });
}
