// Chart of accounts and posting-account mappings (PRD v1.7 §3.19 "Chart of
// Accounts [P0] — CoA standar F&B yang dapat disesuaikan, per badan usaha";
// §6 F chart_of_accounts / account_mappings; bead legend-kwxj).
//
// The contract owns the rules; this service stores them: one chart per legal
// entity, unique codes, a parent in the same entity and type, no cycles,
// report groups that match the account type, and every posting role mapped to
// a postable account of that entity. `chartOfAccountsIssues` and
// `accountMappingIssues` validate the whole chart after each mutation, so a
// change can never leave the chart in a state the contract rejects.
//
// Chart and mapping changes are sensitive master-data writes: each one records
// an audit row in the same transaction. The database repeats the structural
// rules (migration 0025), so a direct SQL write cannot bypass them either.
//
// Owner writers (`createAccount`, `updateAccount`,
// `replaceAccountMappingsForEntity`) take the per-entity chart advisory lock
// (`lockChartOfAccounts`) first, the same lock standard-chart provisioning
// holds, so a backfill never sees the chart as empty while an owner write is
// about to commit.

import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import {
  AccountingError,
  accountMappingIssues,
  accountMappingSchema,
  accountSchema,
  chartOfAccountsIssues,
  createAccountInputSchema,
  replaceAccountMappings,
  updateAccount as updateAccountEndpoint,
  type Account,
  type AccountMapping,
} from "@starter/shared/accounting";
import type { ScopedTenantContext, UserId } from "@starter/shared/core";
import type { z } from "zod";
import { db } from "../db";
import { accountMappings, chartOfAccounts } from "../db/schema";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { assertCashMappingTargetsHaveNoHistory } from "./accounting-cash-mapping-history";
import {
  auditAccountingChange,
  requireLegalEntity,
  uniqueViolation,
  type TenantTransaction,
} from "./accounting-shared";
import { lockChartOfAccounts } from "./tenant-config-locks";

export type CreateAccountInput = z.infer<typeof createAccountInputSchema>;
export type UpdateAccountInput = z.infer<typeof updateAccountEndpoint.body>;
export type ReplaceAccountMappingsInput = z.infer<
  typeof replaceAccountMappings.body
>;

type AccountRow = typeof chartOfAccounts.$inferSelect;
type MappingRow = typeof accountMappings.$inferSelect;

function toAccount(row: AccountRow): Account {
  return accountSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    legalEntityId: row.legalEntityId,
    code: row.code,
    name: row.name,
    type: row.type,
    reportGroup: row.reportGroup,
    parentId: row.parentId,
    isActive: row.isActive,
  });
}

function toMapping(row: MappingRow): AccountMapping {
  return accountMappingSchema.parse({
    tenantId: row.tenantId,
    legalEntityId: row.legalEntityId,
    role: row.role,
    accountId: row.accountId,
  });
}

async function chartRows(
  tx: TenantTransaction,
  tenantId: string,
  legalEntityId: string,
): Promise<AccountRow[]> {
  return tx
    .select()
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.tenantId, tenantId),
        eq(chartOfAccounts.legalEntityId, legalEntityId),
      ),
    )
    .orderBy(asc(chartOfAccounts.code), asc(chartOfAccounts.id));
}

/** The structural problems of a candidate chart, as a 422 (empty = valid). */
function assertChartValid(accounts: readonly Account[]): void {
  const issues = chartOfAccountsIssues(accounts);
  if (issues.length > 0)
    throw new HttpError(422, "VALIDATION_ERROR", issues.join("; "));
}

function accountAuditShape(
  account: Account,
  chart: readonly Account[],
): Record<string, unknown> {
  return {
    code: account.code,
    type: account.type,
    reportGroup: account.reportGroup,
    isActive: account.isActive,
    parentCode: chart.find((row) => row.id === account.parentId)?.code ?? null,
  };
}

export async function listAccounts(
  context: ScopedTenantContext,
  legalEntityId: string,
): Promise<{ data: Account[] }> {
  return withTenant(db, context, async (tx) => {
    await requireLegalEntity(tx, context.tenant.tenantId, legalEntityId);
    const rows = await chartRows(tx, context.tenant.tenantId, legalEntityId);
    return { data: rows.map(toAccount) };
  });
}

export async function createAccount(
  context: ScopedTenantContext,
  legalEntityId: string,
  input: CreateAccountInput,
  actorId: UserId,
): Promise<Account> {
  return withTenant(db, context, async (tx) => {
    await lockChartOfAccounts(tx, context.tenant.tenantId, legalEntityId);
    await requireLegalEntity(tx, context.tenant.tenantId, legalEntityId);
    const existing = (
      await chartRows(tx, context.tenant.tenantId, legalEntityId)
    ).map(toAccount);
    if (existing.some((account) => account.code === input.code))
      throw new AccountingError("ACCOUNT_CODE_TAKEN");
    const candidate = accountSchema.parse({
      id: randomUUID(),
      tenantId: context.tenant.tenantId,
      legalEntityId,
      code: input.code,
      name: input.name,
      type: input.type,
      reportGroup: input.reportGroup,
      parentId: input.parentId,
      isActive: true,
    });
    const chart = [...existing, candidate];
    assertChartValid(chart);
    try {
      const [row] = await tx
        .insert(chartOfAccounts)
        .values({
          id: candidate.id,
          tenantId: context.tenant.tenantId,
          legalEntityId,
          code: candidate.code,
          name: candidate.name,
          type: candidate.type,
          reportGroup: candidate.reportGroup,
          parentId: candidate.parentId,
          isActive: candidate.isActive,
        })
        .returning();
      await auditAccountingChange(tx, context, {
        actorId,
        action: "accounting.account.created",
        objectType: "account",
        objectId: candidate.id,
        before: null,
        after: accountAuditShape(candidate, chart),
      });
      return toAccount(row);
    } catch (error) {
      if (uniqueViolation(error))
        throw new AccountingError("ACCOUNT_CODE_TAKEN");
      throw error;
    }
  });
}

export async function updateAccount(
  context: ScopedTenantContext,
  accountId: string,
  input: UpdateAccountInput,
  actorId: UserId,
): Promise<Account> {
  return withTenant(db, context, async (tx) => {
    // Plain read only to learn the entity; the row is read again under the lock.
    const [entityRow] = await tx
      .select({ legalEntityId: chartOfAccounts.legalEntityId })
      .from(chartOfAccounts)
      .where(
        and(
          eq(chartOfAccounts.tenantId, context.tenant.tenantId),
          eq(chartOfAccounts.id, accountId),
        ),
      )
      .limit(1);
    if (!entityRow) throw new HttpError(404, "NOT_FOUND", "Account not found.");
    await lockChartOfAccounts(
      tx,
      context.tenant.tenantId,
      entityRow.legalEntityId,
    );
    const [row] = await tx
      .select()
      .from(chartOfAccounts)
      .where(
        and(
          eq(chartOfAccounts.tenantId, context.tenant.tenantId),
          eq(chartOfAccounts.id, accountId),
        ),
      )
      .limit(1);
    if (!row) throw new HttpError(404, "NOT_FOUND", "Account not found.");
    const before = toAccount(row);
    const candidate = accountSchema.parse({
      id: row.id,
      tenantId: row.tenantId,
      legalEntityId: row.legalEntityId,
      code: row.code,
      // The type is immutable: statements would move history (contract).
      type: row.type,
      name: input.name ?? row.name,
      reportGroup: input.reportGroup ?? row.reportGroup,
      parentId: input.parentId === undefined ? row.parentId : input.parentId,
      isActive: input.isActive ?? row.isActive,
    });
    const existing = (
      await chartRows(tx, context.tenant.tenantId, row.legalEntityId)
    ).map((chartRow) =>
      chartRow.id === row.id ? candidate : toAccount(chartRow),
    );
    assertChartValid(existing);
    const [updated] = await tx
      .update(chartOfAccounts)
      .set({
        name: candidate.name,
        reportGroup: candidate.reportGroup,
        parentId: candidate.parentId,
        isActive: candidate.isActive,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(chartOfAccounts.tenantId, context.tenant.tenantId),
          eq(chartOfAccounts.id, accountId),
        ),
      )
      .returning();
    await auditAccountingChange(tx, context, {
      actorId,
      action: "accounting.account.updated",
      objectType: "account",
      objectId: accountId,
      before: accountAuditShape(before, existing),
      after: accountAuditShape(candidate, existing),
    });
    return toAccount(updated);
  });
}

export async function listAccountMappings(
  context: ScopedTenantContext,
  legalEntityId: string,
): Promise<{ data: AccountMapping[] }> {
  return withTenant(db, context, async (tx) => {
    await requireLegalEntity(tx, context.tenant.tenantId, legalEntityId);
    const rows = await tx
      .select()
      .from(accountMappings)
      .where(
        and(
          eq(accountMappings.tenantId, context.tenant.tenantId),
          eq(accountMappings.legalEntityId, legalEntityId),
        ),
      )
      .orderBy(asc(accountMappings.role));
    return { data: rows.map(toMapping) };
  });
}

export async function replaceAccountMappingsForEntity(
  context: ScopedTenantContext,
  legalEntityId: string,
  input: ReplaceAccountMappingsInput,
  actorId: UserId,
): Promise<{ data: AccountMapping[] }> {
  return withTenant(db, context, async (tx) => {
    await lockChartOfAccounts(tx, context.tenant.tenantId, legalEntityId);
    await requireLegalEntity(tx, context.tenant.tenantId, legalEntityId);
    const chart = (
      await chartRows(tx, context.tenant.tenantId, legalEntityId)
    ).map(toAccount);
    const candidates = input.mappings.map((mapping) =>
      accountMappingSchema.parse({
        tenantId: context.tenant.tenantId,
        legalEntityId,
        role: mapping.role,
        accountId: mapping.accountId,
      }),
    );
    const issues = accountMappingIssues(candidates, chart);
    if (issues.length > 0)
      throw new HttpError(422, "VALIDATION_ERROR", issues.join("; "));
    const beforeRows = await tx
      .select()
      .from(accountMappings)
      .where(
        and(
          eq(accountMappings.tenantId, context.tenant.tenantId),
          eq(accountMappings.legalEntityId, legalEntityId),
        ),
      )
      .orderBy(asc(accountMappings.role));
    await assertCashMappingTargetsHaveNoHistory(
      tx,
      context.tenant.tenantId,
      legalEntityId,
      candidates,
      beforeRows,
    );
    const auditShape = (rows: readonly AccountMapping[]) => ({
      count: rows.length,
      mappings: rows.map((mapping) => ({
        role: mapping.role,
        glCode:
          chart.find((account) => account.id === mapping.accountId)?.code ??
          null,
      })),
    });
    await tx
      .delete(accountMappings)
      .where(
        and(
          eq(accountMappings.tenantId, context.tenant.tenantId),
          eq(accountMappings.legalEntityId, legalEntityId),
        ),
      );
    if (candidates.length > 0)
      await tx.insert(accountMappings).values(
        candidates.map((mapping) => ({
          tenantId: mapping.tenantId,
          legalEntityId: mapping.legalEntityId,
          role: mapping.role,
          accountId: mapping.accountId,
        })),
      );
    await auditAccountingChange(tx, context, {
      actorId,
      action: "accounting.account_mappings.replaced",
      objectType: "account_mapping",
      objectId: legalEntityId,
      before: auditShape(beforeRows.map(toMapping)),
      after: auditShape(candidates),
    });
    const rows = await tx
      .select()
      .from(accountMappings)
      .where(
        and(
          eq(accountMappings.tenantId, context.tenant.tenantId),
          eq(accountMappings.legalEntityId, legalEntityId),
        ),
      )
      .orderBy(asc(accountMappings.role));
    return { data: rows.map(toMapping) };
  });
}
