// A refund reverses the accounts actually used by its sale. New rule postings
// keep the complete role map on the immutable journal row; old sales can be
// reconstructed from mapping audits only while that evidence is available.
import { and, asc, eq, sql } from "drizzle-orm";
import {
  postingAccountRoleSchema,
  type PostingAccountRole,
} from "@starter/shared/accounting";
import type { ScopedTenantContext } from "@starter/shared/core";
import {
  accountMappings,
  auditLogs,
  chartOfAccounts,
  journalEntries,
  journalLines,
} from "../db/schema/index.ts";
import type { Tx } from "./inventory-ops.shared.ts";

type TenantId = ScopedTenantContext["tenant"]["tenantId"];
export type SalePostingAccounts = {
  legalEntityId: string;
  byRole: Partial<Record<PostingAccountRole, string>>;
};

/** No inferred tax identity: every original tax credit must match the recovered map. */
export async function salePostingAccountsOf(
  tx: Tx,
  tenantId: TenantId,
  saleKey: string,
): Promise<SalePostingAccounts | string | null> {
  const [entry] = await tx
    .select({
      id: journalEntries.id,
      legalEntityId: journalEntries.legalEntityId,
      snapshot: journalEntries.postingAccountSnapshot,
    })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.tenantId, tenantId),
        eq(journalEntries.idempotencyKey, saleKey),
      ),
    )
    .limit(1);
  if (!entry) return null;
  const chart = await tx
    .select({
      id: chartOfAccounts.id,
      code: chartOfAccounts.code,
      type: chartOfAccounts.type,
    })
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.tenantId, tenantId),
        eq(chartOfAccounts.legalEntityId, entry.legalEntityId),
      ),
    );
  const byRole: SalePostingAccounts["byRole"] = {};
  if (entry.snapshot !== null) {
    if (typeof entry.snapshot !== "object" || Array.isArray(entry.snapshot))
      return "Sale posting account snapshot cannot be read";
    for (const [rawRole, accountId] of Object.entries(entry.snapshot)) {
      const role = postingAccountRoleSchema.safeParse(rawRole);
      if (!role.success || !chart.some((account) => account.id === accountId))
        return "Sale posting account snapshot does not match its legal entity";
      byRole[role.data] = accountId;
    }
  } else {
    // Mapping audits store immutable GL codes. The first replacement after
    // posting records the mapping that existed at sale time in its before side.
    const [replacement] = await tx
      .select({ event: auditLogs.event })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.tenantId, tenantId),
          sql`${auditLogs.event}->>'action' = 'accounting.account_mappings.replaced'`,
          sql`${auditLogs.event}->>'objectId' = ${entry.legalEntityId}`,
          // Compare in PostgreSQL: JS Date would discard microseconds and can
          // put a same-transaction audit on the wrong side of the sale.
          sql`${auditLogs.createdAt} > (SELECT created_at FROM journal_entries WHERE tenant_id = ${tenantId}::uuid AND id = ${entry.id}::uuid)`,
        ),
      )
      .orderBy(asc(auditLogs.createdAt), asc(auditLogs.id))
      .limit(1);
    if (replacement) {
      const before = replacement.event.maskedChanges.before;
      const mappings =
        before !== null && typeof before === "object" && !Array.isArray(before)
          ? before.mappings
          : null;
      if (!Array.isArray(mappings))
        return "Legacy sale mapping audit cannot be read";
      for (const row of mappings) {
        if (row === null || typeof row !== "object" || Array.isArray(row))
          return "Legacy sale mapping audit cannot be read";
        const role = postingAccountRoleSchema.safeParse(row.role);
        const account = chart.find(
          (candidate) => candidate.code === row.glCode,
        );
        if (!role.success || !account || byRole[role.data])
          return "Legacy sale mapping audit is ambiguous";
        byRole[role.data] = account.id;
      }
    } else {
      // Unchanged pre-snapshot mappings are usable only after the same ledger
      // check as audited history. Remapped/missing evidence fails closed below.
      const mappings = await tx
        .select({
          role: accountMappings.role,
          accountId: accountMappings.accountId,
        })
        .from(accountMappings)
        .where(
          and(
            eq(accountMappings.tenantId, tenantId),
            eq(accountMappings.legalEntityId, entry.legalEntityId),
          ),
        );
      for (const mapping of mappings) {
        const role = postingAccountRoleSchema.safeParse(mapping.role);
        if (!role.success) return "Legacy sale mapping role cannot be read";
        byRole[role.data] = mapping.accountId;
      }
    }
  }
  const taxIds = new Set(
    [
      byRole.tax_payable_pbjt,
      byRole.tax_payable_ppn,
      byRole.tax_payable_other,
    ].filter((id): id is string => id !== undefined),
  );
  const credits = await tx
    .select({
      accountId: journalLines.accountId,
      net: sql<string>`sum(${journalLines.creditIdr} - ${journalLines.debitIdr})::text`,
    })
    .from(journalLines)
    .where(
      and(
        eq(journalLines.tenantId, tenantId),
        eq(journalLines.entryId, entry.id),
      ),
    )
    .groupBy(journalLines.accountId);
  // service_charge may be mapped to a liability (POSTING_ROLE_ALLOWED_TYPES):
  // its credit is a known role, not an unidentified tax account. What a refund
  // may reverse of it stays capped by refundComponentsOf (collected minus
  // already refunded on that account), so it never exceeds the sale's own.
  const serviceChargeId = byRole.service_charge;
  for (const credit of credits) {
    const account = chart.find(
      (candidate) => candidate.id === credit.accountId,
    );
    if (
      Number(credit.net) > 0 &&
      account?.type === "liability" &&
      !taxIds.has(credit.accountId) &&
      credit.accountId !== serviceChargeId
    )
      return "Historical sale tax accounts cannot be established from its ledger";
  }
  return { legalEntityId: entry.legalEntityId, byRole };
}
