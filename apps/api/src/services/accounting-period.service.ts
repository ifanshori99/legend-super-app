// Fiscal periods (PRD v1.7 §3.19 "Tutup Periode"; ACC-02; bead legend-kwxj).
//
// Close/reopen with snapshot and approval is bead legend-xm30; this service
// owns the table, the list endpoint and the posting guard every journal write
// goes through:
//
//   SELECT … FROM fiscal_periods WHERE … FOR SHARE
//   → assertPostingAllowed(period, entryDate) → INSERT entry + lines
//
// FOR SHARE conflicts with the close/reopen FOR UPDATE lock, so a close waits
// for in-flight posts and a post that starts after the close commits reads
// `closed` and fails PERIOD_CLOSED (contract/period.ts). A period row is
// created lazily on first use inside the same transaction, protected by the
// (tenant, legal entity, period) unique key.

import { and, desc, eq } from "drizzle-orm";
import {
  assertPeriodVersion,
  assertPostingAllowed,
  fiscalPeriodSchema,
  periodOf,
  type FiscalPeriod,
} from "@starter/shared/accounting";
import type { BusinessDate } from "@starter/shared/core";
import type { ScopedTenantContext } from "@starter/shared/core";
import { db } from "../db";
import { fiscalPeriods } from "../db/schema";
import { withTenant } from "../db/tenant";
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
 * ACC-02 posting guard. Returns the locked period or throws PERIOD_CLOSED /
 * PERIOD_MISMATCH / PERIOD_CHANGED before any journal row is written.
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
  const row = await lockFiscalPeriod(
    tx,
    context.tenant.tenantId,
    input.legalEntityId,
    input.entryDate,
  );
  assertPostingAllowed(row, input.entryDate);
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
