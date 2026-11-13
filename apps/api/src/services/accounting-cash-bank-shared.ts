// Shared plumbing for the cash & bank services (bead legend-fnxl, WS-07;
// PRD v1.7 §3.19 Kas & Bank; ACC-04, ACC-05). Row → contract DTO mappers and
// the loaders every slice needs, so the bank account, statement line, cash
// deposit and case services read rows the same way. Wire shapes come from
// `@starter/shared/accounting` banking.ts; nothing here redefines them.
//
// - Bank accounts, statement imports, lines and matches belong to a legal
//   entity (no outlet): reading them needs tenant scope (assertTenantScope),
//   like the other entity-level accounting tables. A cross-tenant id is
//   "not found" (RLS hides it), never "forbidden".
// - The account number never leaves the database in clear: the mask is
//   built from `account_number_last4`.

import { and, asc, eq, inArray } from "drizzle-orm";
import type {
  BankAccount,
  CashBankEntry,
  BankStatementLine,
  CashDeposit,
  ReconciliationCase,
  ReconciliationRef,
} from "@starter/shared/accounting";
import {
  bankAccounts,
  bankStatementLineMatches,
  type BankAccountRow,
  type BankReconciliationCaseRow,
  type BankStatementLineMatchRow,
  type BankStatementLineRow,
  type CashDepositRow,
} from "../db/schema/accounting-cash-bank.ts";
import type { CashBankEntryRow } from "../db/schema/accounting-cash-bank-entries.ts";
import type { TenantId } from "@starter/shared/core";
import { HttpError } from "../lib/http-error.ts";
import type { TenantTransaction } from "./accounting-shared.ts";

export const notFound = (what: string) =>
  new HttpError(404, "NOT_FOUND", `${what} tidak ditemukan.`);

export function bankAccountDto(row: BankAccountRow): BankAccount {
  return {
    id: row.id,
    tenantId: row.tenantId,
    legalEntityId: row.legalEntityId,
    bank: row.bank,
    accountName: row.accountName,
    accountNumberMasked: `****${row.accountNumberLast4}`,
    glAccountId: row.glAccountId,
    isActive: row.isActive,
  } as BankAccount;
}

export function statementLineDto(
  row: BankStatementLineRow,
  matches: readonly Pick<BankStatementLineMatchRow, "refType" | "refId">[],
): BankStatementLine {
  return {
    id: row.id,
    tenantId: row.tenantId,
    bankAccountId: row.bankAccountId,
    importId: row.importId,
    postedOn: row.postedOn,
    amountIdr: row.amountIdr,
    description: row.description,
    externalRef: row.externalRef,
    dedupeKey: row.dedupeKey,
    matchStatus: row.matchStatus,
    matchedRefs: matches.map((match) => ({
      type: match.refType as ReconciliationRef["type"],
      id: match.refId,
    })),
    reconciliationCaseId: row.reconciliationCaseId,
    excludedReason: row.excludedReason,
  } as BankStatementLine;
}

export function cashDepositDto(row: CashDepositRow): CashDeposit {
  return {
    id: row.id,
    tenantId: row.tenantId,
    legalEntityId: row.legalEntityId,
    outletId: row.outletId,
    bankAccountId: row.bankAccountId,
    amountIdr: row.amountIdr,
    coversFrom: row.coversFrom,
    coversTo: row.coversTo,
    depositedAt: row.depositedAt.toISOString(),
    depositedBy: row.depositedBy,
    slipReference: row.slipReference,
    bankStatementLineId: row.bankStatementLineId,
    reconciliationCaseId: row.reconciliationCaseId,
    journalEntryId: row.journalEntryId,
    status: row.status,
  } as CashDeposit;
}

export function reconciliationCaseDto(
  row: BankReconciliationCaseRow,
): ReconciliationCase {
  return {
    id: row.id,
    tenantId: row.tenantId,
    legalEntityId: row.legalEntityId,
    outletId: row.outletId,
    type: row.type,
    differenceIdr: row.differenceIdr,
    ownerId: row.ownerId,
    status: row.status,
    dueAt: row.dueAt.toISOString(),
    refs: row.refs,
    openedAt: row.openedAt.toISOString(),
    resolvedBy: row.resolvedBy,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    resolutionNote: row.resolutionNote,
    adjustmentJournalEntryId: row.adjustmentJournalEntryId,
  } as ReconciliationCase;
}

/** The bank account, or NOT_FOUND (also for another tenant's id). */
export async function loadBankAccount(
  tx: TenantTransaction,
  tenantId: TenantId,
  bankAccountId: string,
  options: { forUpdate?: boolean } = {},
): Promise<BankAccountRow> {
  const query = tx
    .select()
    .from(bankAccounts)
    .where(
      and(
        eq(bankAccounts.tenantId, tenantId),
        eq(bankAccounts.id, bankAccountId),
      ),
    )
    .limit(1);
  const [row] = options.forUpdate ? await query.for("update") : await query;
  if (!row) throw notFound("Rekening bank");
  return row;
}

/** Match rows of several lines, grouped by line id (stable order). */
export async function loadMatchesByLine(
  tx: TenantTransaction,
  tenantId: TenantId,
  lineIds: readonly string[],
): Promise<Map<string, BankStatementLineMatchRow[]>> {
  const byLine = new Map<string, BankStatementLineMatchRow[]>();
  if (lineIds.length === 0) return byLine;
  const rows = await tx
    .select()
    .from(bankStatementLineMatches)
    .where(
      and(
        eq(bankStatementLineMatches.tenantId, tenantId),
        inArray(bankStatementLineMatches.lineId, [...lineIds]),
      ),
    )
    .orderBy(
      asc(bankStatementLineMatches.matchedAt),
      asc(bankStatementLineMatches.id),
    );
  for (const row of rows) {
    const list = byLine.get(row.lineId) ?? [];
    list.push(row);
    byLine.set(row.lineId, list);
  }
  return byLine;
}

export function cashBankEntryDto(row: CashBankEntryRow): CashBankEntry {
  return {
    id: row.id,
    tenantId: row.tenantId,
    legalEntityId: row.legalEntityId,
    outletId: row.outletId,
    kind: row.kind,
    entryDate: row.entryDate,
    amountIdr: row.amountIdr,
    bankAccountId: row.bankAccountId,
    toBankAccountId: row.toBankAccountId,
    counterAccountId: row.counterAccountId,
    description: row.description,
    reference: row.reference,
    status: row.status,
    approverId: row.approverId,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionReason: row.decisionReason,
    journalEntryId: row.journalEntryId,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  } as CashBankEntry;
}
