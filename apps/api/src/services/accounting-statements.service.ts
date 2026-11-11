// Financial statements (PRD v1.7 §3.19 "Laporan Keuangan" and "Tutup Periode";
// ACC-02, ACC-03, TEN-01; bead legend-yc96u).
//
// Every statement is the contract's pure builder over the posted journal lines
// of one legal entity, so the figures match the drill-down, the period-close
// snapshot and the profit-share net profit. Journals are append-only and a
// closed period refuses new postings, so the ledger of a closed month is
// exactly what its snapshot froze; after an approved reopen the ledger shows the
// new postings, never a stale snapshot. The `basis` fields come from the fiscal
// period rows (`statementBasisFields`, done inside each builder): a missing row
// counts as open, so the label is `live`.

import { and, eq, lte } from "drizzle-orm";
import {
  accountSchema,
  buildBalanceSheet,
  buildCashFlow,
  buildEquityChanges,
  buildProfitAndLoss,
  buildTrialBalance,
  type Account,
  type BalanceSheet,
  type CashFlowStatement,
  type EntryLedgerLine,
  type EquityChanges,
  type ProfitAndLoss,
  type TrialBalance,
} from "@starter/shared/accounting";
import {
  assertTrustedScopedContext,
  CoreError,
  outletIdsForQuery,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { db } from "../db";
import {
  chartOfAccounts,
  fiscalPeriods,
  journalEntries,
  journalLines,
} from "../db/schema";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import {
  requireLegalEntity,
  requireOutlet,
  type TenantTransaction,
} from "./accounting-shared";

type Ledger = {
  accounts: Account[];
  periods: { period: string; status: string }[];
  lines: EntryLedgerLine[];
};

/** Accounts, fiscal periods and every posted line of the entity up to `to`. */
async function loadLedger(
  tx: TenantTransaction,
  tenantId: string,
  legalEntityId: string,
  to: string,
): Promise<Ledger> {
  await requireLegalEntity(tx, tenantId, legalEntityId);
  const accountRows = await tx
    .select()
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.tenantId, tenantId),
        eq(chartOfAccounts.legalEntityId, legalEntityId),
      ),
    );
  const periods = await tx
    .select({ period: fiscalPeriods.period, status: fiscalPeriods.status })
    .from(fiscalPeriods)
    .where(
      and(
        eq(fiscalPeriods.tenantId, tenantId),
        eq(fiscalPeriods.legalEntityId, legalEntityId),
      ),
    );
  const lineRows = await tx
    .select({
      entryId: journalLines.entryId,
      accountId: journalLines.accountId,
      debitIdr: journalLines.debitIdr,
      creditIdr: journalLines.creditIdr,
      outletId: journalLines.outletId,
      entryDate: journalEntries.entryDate,
      sourceType: journalEntries.sourceType,
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
        eq(journalEntries.legalEntityId, legalEntityId),
        lte(journalEntries.entryDate, to),
      ),
    );
  return {
    accounts: accountRows.map((row) =>
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
    ),
    periods,
    lines: lineRows.map((row) => ({
      entryId: row.entryId,
      accountId: row.accountId,
      debitIdr: row.debitIdr,
      creditIdr: row.creditIdr,
      outletId: row.outletId as OutletId | null,
      entryDate: row.entryDate,
      sourceType: row.sourceType,
    })),
  };
}

function statement<T>(
  context: ScopedTenantContext,
  legalEntityId: string,
  to: string,
  build: (ledger: Ledger) => T,
  check?: (tx: TenantTransaction, tenantId: string) => Promise<void>,
): Promise<T> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const ledger = await loadLedger(tx, tenantId, legalEntityId, to);
    if (check) await check(tx, tenantId);
    return build(ledger);
  });
}

/**
 * TEN-03: a statement without an outlet filter covers the whole legal entity
 * (entity-level lines included), so it needs tenant scope. An outlet-scoped
 * caller may only read a profit and loss filtered to one of its outlets.
 */
function assertStatementScope(
  context: ScopedTenantContext,
  outletId?: string | undefined,
): void {
  assertTrustedScopedContext(context);
  if (outletId !== undefined) {
    outletIdsForQuery(context.outletScope, [outletId]);
    return;
  }
  if (context.outletScope.kind !== "tenant")
    throw new CoreError(
      "OUTLET_OUT_OF_SCOPE",
      "Laporan keuangan tingkat badan usaha memerlukan akses seluruh tenant.",
    );
}

function assertRange(from: string, to: string): void {
  if (from > to)
    throw new HttpError(400, "VALIDATION_ERROR", "from must not be after to.");
}

export async function getTrialBalance(
  context: ScopedTenantContext,
  input: { legalEntityId: string; asOf: string },
): Promise<TrialBalance> {
  assertStatementScope(context);
  return statement(context, input.legalEntityId, input.asOf, (ledger) =>
    buildTrialBalance(
      ledger.accounts,
      ledger.lines,
      input.legalEntityId,
      input.asOf,
      ledger.periods,
    ),
  );
}

export async function getBalanceSheet(
  context: ScopedTenantContext,
  input: { legalEntityId: string; asOf: string },
): Promise<BalanceSheet> {
  assertStatementScope(context);
  return statement(context, input.legalEntityId, input.asOf, (ledger) =>
    buildBalanceSheet(ledger.accounts, ledger.lines, {
      legalEntityId: input.legalEntityId,
      asOf: input.asOf,
      periods: ledger.periods,
    }),
  );
}

export async function getProfitAndLoss(
  context: ScopedTenantContext,
  input: {
    legalEntityId: string;
    from: string;
    to: string;
    outletId?: string | undefined;
  },
): Promise<ProfitAndLoss> {
  assertStatementScope(context, input.outletId);
  assertRange(input.from, input.to);
  const { outletId } = input;
  return statement(
    context,
    input.legalEntityId,
    input.to,
    (ledger) =>
      buildProfitAndLoss(ledger.accounts, ledger.lines, {
        legalEntityId: input.legalEntityId,
        from: input.from,
        to: input.to,
        outletId: (outletId ?? null) as OutletId | null,
        periods: ledger.periods,
      }),
    outletId
      ? (tx, tenantId) => requireOutlet(tx, tenantId, outletId)
      : undefined,
  );
}

export async function getCashFlow(
  context: ScopedTenantContext,
  input: { legalEntityId: string; from: string; to: string },
): Promise<CashFlowStatement> {
  assertStatementScope(context);
  assertRange(input.from, input.to);
  return statement(context, input.legalEntityId, input.to, (ledger) => {
    const cashFlow = buildCashFlow(ledger.accounts, ledger.lines, {
      legalEntityId: input.legalEntityId,
      from: input.from,
      to: input.to,
      periods: ledger.periods,
    });
    // Closing cash must equal the cash balance at `to`; a cash movement whose
    // counter-account is missing or inactive would otherwise be dropped silently.
    const balanceSheet = buildBalanceSheet(ledger.accounts, ledger.lines, {
      legalEntityId: input.legalEntityId,
      asOf: input.to,
      periods: ledger.periods,
    });
    const cashBalance =
      balanceSheet.sections.find((s) => s.group === "cash_and_equivalents")
        ?.totalIdr ?? 0;
    if (cashFlow.closingCashIdr !== cashBalance)
      throw new HttpError(
        500,
        "INTERNAL_ERROR",
        "Cash flow does not reconcile to the cash balance.",
      );
    return cashFlow;
  });
}

export async function getEquityChanges(
  context: ScopedTenantContext,
  input: { legalEntityId: string; from: string; to: string },
): Promise<EquityChanges> {
  assertStatementScope(context);
  assertRange(input.from, input.to);
  return statement(context, input.legalEntityId, input.to, (ledger) =>
    buildEquityChanges(ledger.accounts, ledger.lines, {
      legalEntityId: input.legalEntityId,
      from: input.from,
      to: input.to,
      periods: ledger.periods,
    }),
  );
}
