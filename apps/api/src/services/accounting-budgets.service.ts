// Budgets vs actual (PRD v1.7 §3.19 "Anggaran [P0] — Anggaran per akun dan
// outlet dengan laporan realisasi"; §6 F `budgets`; bead legend-hpgo).
// Contract: budgets.ts (`upsertBudgetsInputSchema`, `budgetVariance`).
//
// - Upsert is a bulk PUT, unique per (legal entity, outlet, account, period)
//   (outlet NULL = whole entity; the key is NULLS NOT DISTINCT). PUT is
//   naturally idempotent, so the contract carries no idempotency key; the
//   UNIQUE key + ON CONFLICT make concurrent PUTs converge to the last write.
// - Actual = posted journal lines of the period on the budget's account, in
//   the account's natural sign (debit-normal for asset/expense, credit-normal
//   for liability/equity/revenue). An outlet budget counts that outlet's
//   lines; an entity budget (outlet NULL) counts every line of the entity.
// - The report lists budgeted rows only (PRD "laporan realisasi" of the
//   budget; decision, bead report).
// - TEN-03: an outlet-scoped caller sees only its outlets' budgets; entity
//   budgets need tenant scope.

import { and, asc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import {
  budgetSchema,
  budgetVariance,
  budgetVsActualRowSchema,
  periodBounds,
  upsertBudgetsInputSchema,
  type Budget,
  type BudgetVsActualRow,
} from "@starter/shared/accounting";
import {
  assertTrustedScopedContext,
  outletIdsForQuery,
  type Idr,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import { db } from "../db";
import {
  chartOfAccounts,
  journalEntries,
  journalLines,
} from "../db/schema/accounting.ts";
import { budgets, type BudgetRow } from "../db/schema/accounting-ap-fa.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  advisoryLock,
  assertOutletReach,
  auditApFa,
  type TenantTransaction,
} from "./accounting-ap-fa-shared.ts";
import { requireLegalEntity, requireOutlet } from "./accounting-shared.ts";

export type BudgetQuery = {
  legalEntityId: string;
  period: string;
  outletId?: string;
};

function toBudget(row: BudgetRow): Budget {
  return budgetSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    legalEntityId: row.legalEntityId,
    outletId: row.outletId,
    accountId: row.accountId,
    period: row.period,
    amountIdr: row.amountIdr,
  });
}

/** Rows the caller may see for this query (outlet filter + TEN-03 scope). */
async function visibleBudgets(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  query: BudgetQuery,
): Promise<BudgetRow[]> {
  const filters: SQL[] = [
    eq(budgets.tenantId, context.tenant.tenantId),
    eq(budgets.legalEntityId, query.legalEntityId),
    eq(budgets.period, query.period),
  ];
  const outlets = outletIdsForQuery(
    context.outletScope,
    query.outletId ? [query.outletId] : undefined,
  );
  if (outlets.kind === "outlets")
    filters.push(inArray(budgets.outletId, [...outlets.outletIds]));
  return tx
    .select()
    .from(budgets)
    .where(and(...filters))
    .orderBy(asc(budgets.accountId), asc(budgets.outletId));
}

export async function listBudgets(
  context: ScopedTenantContext,
  query: BudgetQuery,
): Promise<{ data: Budget[] }> {
  return withTenant(db, context, async (tx) => {
    await requireLegalEntity(tx, context.tenant.tenantId, query.legalEntityId);
    return { data: (await visibleBudgets(tx, context, query)).map(toBudget) };
  });
}

/** Bulk upsert (contract `upsertBudgets`); audited as one budget change. */
export async function upsertBudgets(
  context: ScopedTenantContext,
  rawInput: unknown,
  actorId: UserId,
): Promise<{ data: Budget[] }> {
  const input = upsertBudgetsInputSchema.parse(rawInput);
  assertTrustedScopedContext(context);
  for (const row of input.rows) assertOutletReach(context, row.outletId);
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    await requireLegalEntity(tx, tenantId, input.legalEntityId);
    const accountIds = [...new Set(input.rows.map((row) => row.accountId))];
    const accounts = await tx
      .select({ id: chartOfAccounts.id })
      .from(chartOfAccounts)
      .where(
        and(
          eq(chartOfAccounts.tenantId, tenantId),
          eq(chartOfAccounts.legalEntityId, input.legalEntityId),
          inArray(chartOfAccounts.id, accountIds),
        ),
      );
    if (accounts.length !== accountIds.length)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Every budget account must belong to the legal entity.",
      );
    for (const outletId of new Set(input.rows.map((row) => row.outletId)))
      if (outletId !== null) await requireOutlet(tx, tenantId, outletId);
    // One budget editor per entity at a time keeps the audit trail ordered.
    await advisoryLock(tx, `budget:${tenantId}:${input.legalEntityId}`);
    const now = new Date();
    const rows = await tx
      .insert(budgets)
      .values(
        input.rows.map((row) => ({
          tenantId,
          legalEntityId: input.legalEntityId,
          outletId: row.outletId,
          accountId: row.accountId,
          period: row.period,
          amountIdr: row.amountIdr,
          updatedBy: actorId,
        })),
      )
      .onConflictDoUpdate({
        target: [
          budgets.tenantId,
          budgets.legalEntityId,
          budgets.outletId,
          budgets.accountId,
          budgets.period,
        ],
        set: {
          amountIdr: sql`excluded.amount_idr`,
          updatedBy: actorId,
          updatedAt: now,
        },
      })
      .returning();
    await auditApFa(tx, context, {
      actorId,
      action: "accounting.budget.upserted",
      objectType: "legal_entity",
      objectId: input.legalEntityId,
      before: null,
      after: {
        count: rows.length,
        period: [...new Set(input.rows.map((row) => row.period))]
          .sort()
          .join(","),
      },
    });
    return {
      data: rows
        .map(toBudget)
        .sort(
          (a, b) =>
            a.period.localeCompare(b.period) ||
            a.accountId.localeCompare(b.accountId) ||
            (a.outletId ?? "").localeCompare(b.outletId ?? ""),
        ),
    };
  });
}

/** Natural sign of an account type (statements use the same convention). */
const DEBIT_NORMAL = new Set(["asset", "expense"]);

/**
 * Laporan realisasi (§3.19 Anggaran): per budget row the actual of the
 * period, variance = actual − budget and the variance in basis points
 * (contract `budgetVariance`, half_up; null for a zero budget).
 */
export async function getBudgetVsActual(
  context: ScopedTenantContext,
  query: BudgetQuery,
): Promise<{ data: BudgetVsActualRow[] }> {
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    await requireLegalEntity(tx, tenantId, query.legalEntityId);
    const rows = await visibleBudgets(tx, context, query);
    if (rows.length === 0) return { data: [] };
    const accountIds = [...new Set(rows.map((row) => row.accountId))];
    const accounts = await tx
      .select({
        id: chartOfAccounts.id,
        code: chartOfAccounts.code,
        name: chartOfAccounts.name,
        type: chartOfAccounts.type,
      })
      .from(chartOfAccounts)
      .where(
        and(
          eq(chartOfAccounts.tenantId, tenantId),
          inArray(chartOfAccounts.id, accountIds),
        ),
      );
    const accountById = new Map(accounts.map((row) => [row.id, row]));
    const { start, end } = periodBounds(query.period);
    const totals = await tx
      .select({
        accountId: journalLines.accountId,
        outletId: journalLines.outletId,
        debitIdr: sql<string>`coalesce(sum(${journalLines.debitIdr}), 0)`,
        creditIdr: sql<string>`coalesce(sum(${journalLines.creditIdr}), 0)`,
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
          eq(journalEntries.legalEntityId, query.legalEntityId),
          gte(journalEntries.entryDate, start),
          lte(journalEntries.entryDate, end),
          inArray(journalLines.accountId, accountIds),
        ),
      )
      .groupBy(journalLines.accountId, journalLines.outletId);
    const data = rows.map((row) => {
      const account = accountById.get(row.accountId);
      if (!account) throw new Error("Budget account vanished.");
      let debit = 0;
      let credit = 0;
      for (const total of totals) {
        if (total.accountId !== row.accountId) continue;
        if (row.outletId !== null && total.outletId !== row.outletId) continue;
        debit += Number(total.debitIdr);
        credit += Number(total.creditIdr);
      }
      const actualIdr = (
        DEBIT_NORMAL.has(account.type) ? debit - credit : credit - debit
      ) as Idr;
      const { varianceIdr, varianceBp } = budgetVariance(
        row.amountIdr,
        actualIdr,
      );
      return budgetVsActualRowSchema.parse({
        accountId: row.accountId,
        accountCode: account.code,
        accountName: account.name,
        outletId: row.outletId,
        budgetIdr: row.amountIdr,
        actualIdr,
        varianceIdr,
        varianceBp,
      });
    });
    data.sort(
      (a, b) =>
        a.accountCode.localeCompare(b.accountCode) ||
        (a.outletId ?? "").localeCompare(b.outletId ?? ""),
    );
    return { data };
  });
}
