// Net profit of one closed fiscal period for a profit entity (PRD v1.7 §3.37
// Siklus Distribusi, SH-02; bead legend-2ljb).
//
// The figure is the contract's `buildProfitAndLoss` over the posted journal
// lines of the legal entity that fall inside the period, so a distribution uses
// exactly the profit the P&L statement shows. An outlet profit entity passes its
// outlet and only lines tagged with that outlet count (ACC-03). Journals are
// append-only, so every stored line is a posted line.
//
// Fail closed (bead 1210): payroll and other central expense journals carry no
// outlet tag, so an outlet entity would count the outlet's revenue and tagged
// cost but none of that expense and overstate its profit. Until expense can be
// allocated to outlets, an outlet entity refuses a period that has any
// untagged expense line in its legal entity.

import { and, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import {
  accountSchema,
  AccountingError,
  buildProfitAndLoss,
  periodBounds,
  type LedgerLine,
} from "@starter/shared/accounting";
import type { Idr, OutletId } from "@starter/shared/core";
import { chartOfAccounts, journalEntries, journalLines } from "../db/schema";
import type { TenantTransaction } from "./accounting-shared";

export type ClosedPeriodNetProfitInput = {
  readonly legalEntityId: string;
  /** Set for an outlet profit entity; null for a whole legal entity. */
  readonly outletId: string | null;
  /** The fiscal period key, "YYYY-MM". The caller checked that it is closed. */
  readonly period: string;
};

/**
 * Fail closed for an outlet profit entity (bead 1210): refuses while the
 * period has a ledger line in the legal entity with no outlet tag that
 * reduces profit, that is an expense or HPP line, or a debit on a revenue
 * account (sales discount, disposal loss). Its cost reaches no outlet, so the
 * outlet profit would be overstated. Call it before any payout step.
 */
export async function assertNoUnallocatedEntityExpense(
  tx: TenantTransaction,
  tenantId: string,
  input: { legalEntityId: string; outletId: string | null; period: string },
): Promise<void> {
  if (input.outletId === null) return;
  const bounds = periodBounds(input.period);
  const [unallocated] = await tx
    .select({ lines: sql<number>`count(*)::int` })
    .from(journalLines)
    .innerJoin(
      journalEntries,
      and(
        eq(journalEntries.tenantId, journalLines.tenantId),
        eq(journalEntries.id, journalLines.entryId),
      ),
    )
    .innerJoin(
      chartOfAccounts,
      and(
        eq(chartOfAccounts.tenantId, journalLines.tenantId),
        eq(chartOfAccounts.id, journalLines.accountId),
      ),
    )
    .where(
      and(
        eq(journalLines.tenantId, tenantId),
        eq(journalEntries.legalEntityId, input.legalEntityId),
        gte(journalEntries.entryDate, bounds.start),
        lte(journalEntries.entryDate, bounds.end),
        isNull(journalLines.outletId),
        or(
          and(
            eq(chartOfAccounts.type, "expense"),
            or(
              sql`${journalLines.debitIdr} <> 0`,
              sql`${journalLines.creditIdr} <> 0`,
            ),
          ),
          and(
            eq(chartOfAccounts.type, "revenue"),
            sql`${journalLines.debitIdr} > 0`,
          ),
        ),
      ),
    );
  if ((unallocated?.lines ?? 0) > 0)
    throw new AccountingError("UNALLOCATED_ENTITY_EXPENSE");
}

/** Net profit (Rp, may be zero or negative) of the period's posted ledger. */
export async function loadClosedPeriodNetProfit(
  tx: TenantTransaction,
  tenantId: string,
  input: ClosedPeriodNetProfitInput,
): Promise<Idr> {
  const bounds = periodBounds(input.period);
  if (input.outletId !== null)
    await assertNoUnallocatedEntityExpense(tx, tenantId, {
      legalEntityId: input.legalEntityId,
      outletId: input.outletId,
      period: input.period,
    });
  const accountRows = await tx
    .select()
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.tenantId, tenantId),
        eq(chartOfAccounts.legalEntityId, input.legalEntityId),
      ),
    );
  const accounts = accountRows.map((row) =>
    accountSchema.parse({
      id: row.id,
      tenantId: row.tenantId,
      legalEntityId: row.legalEntityId,
      code: row.code,
      name: row.name,
      type: row.type,
      reportGroup: row.reportGroup,
      parentId: row.parentId,
      isActive: row.isActive,
    }),
  );
  const lineRows = await tx
    .select({
      accountId: journalLines.accountId,
      debitIdr: journalLines.debitIdr,
      creditIdr: journalLines.creditIdr,
      outletId: journalLines.outletId,
      entryDate: journalEntries.entryDate,
    })
    .from(journalLines)
    .innerJoin(
      journalEntries,
      and(
        eq(journalEntries.tenantId, journalLines.tenantId),
        eq(journalEntries.id, journalLines.entryId),
      ),
    )
    .where(
      and(
        eq(journalLines.tenantId, tenantId),
        eq(journalEntries.legalEntityId, input.legalEntityId),
        gte(journalEntries.entryDate, bounds.start),
        lte(journalEntries.entryDate, bounds.end),
      ),
    );
  const lines: LedgerLine[] = lineRows.map((row) => ({
    accountId: row.accountId,
    debitIdr: row.debitIdr,
    creditIdr: row.creditIdr,
    outletId: row.outletId as OutletId | null,
    entryDate: row.entryDate,
  }));
  const statement = buildProfitAndLoss(accounts, lines, {
    legalEntityId: input.legalEntityId,
    from: bounds.start,
    to: bounds.end,
    outletId: input.outletId as OutletId | null,
    periods: [{ period: input.period, status: "closed" }],
  });
  return statement.netProfitIdr;
}
