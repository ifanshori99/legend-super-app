// Fiscal periods (PRD v1.7 §3.19 "Tutup Periode"; ACC-02; beads legend-kwxj,
// legend-72we).
//
// This service owns the list endpoint and the posting guard every journal
// write goes through. Close/reopen with snapshot and approval lives in
// accounting-period-close.service.ts. Lock order everywhere: legal entity row,
// then period row, then reopen-request row; never the reverse.
//
//   post:         SELECT … FROM legal_entities … FOR KEY SHARE
//                 → SELECT … FROM fiscal_periods … FOR SHARE
//                 → assertPostingAllowed(period, entryDate)
//                 → no later period of the entity is closed
//                 → INSERT entry + lines
//   close/reopen: SELECT … FROM legal_entities … FOR UPDATE
//                 → period row FOR UPDATE → read all periods of the entity
//
// FOR KEY SHARE on the entity conflicts with the close/reopen FOR UPDATE, so a
// close waits for in-flight posts of that entity and a post waits for a close
// that is running; posts never block each other, and other entities or tenants
// are unaffected. A post that starts after the close commits reads `closed`
// and fails PERIOD_CLOSED (contract/period.ts). A lazily created earlier
// period must not accept posts behind a closed later one (the cumulative
// close snapshot would go stale), so that also fails PERIOD_CLOSED. A period
// row is created lazily on first use inside the same transaction, protected
// by the (tenant, legal entity, period) unique key.

import { and, desc, eq, gt } from "drizzle-orm";
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
  type ScopedTenantContext,
} from "@starter/shared/core";
import { db } from "../db";
import { fiscalPeriods, legalEntities } from "../db/schema";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
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
  strength: "update" | "key share",
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
 * Shared entity lock (KEY SHARE) for writers that must not race a close or
 * reopen of the entity but may run alongside each other (posts, reopen
 * requests). Taken before any period row to keep the entity → period order.
 */
export function lockLegalEntityShared(
  tx: TenantTransaction,
  tenantId: string,
  legalEntityId: string,
): Promise<void> {
  return lockLegalEntity(tx, tenantId, legalEntityId, "key share");
}

/**
 * Close/reopen entry lock: legal entity row FOR UPDATE, always taken before
 * any period row. Waits for in-flight posts of the entity (KEY SHARE).
 */
export function lockLegalEntityForPeriodChange(
  tx: TenantTransaction,
  tenantId: string,
  legalEntityId: string,
): Promise<void> {
  return lockLegalEntity(tx, tenantId, legalEntityId, "update");
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
  await lockLegalEntity(tx, tenantId, input.legalEntityId, "key share");
  const row = await lockFiscalPeriod(
    tx,
    tenantId,
    input.legalEntityId,
    input.entryDate,
  );
  assertPostingAllowed(row, input.entryDate);
  // The entity KEY SHARE lock keeps close/reopen out, so this read is stable.
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
