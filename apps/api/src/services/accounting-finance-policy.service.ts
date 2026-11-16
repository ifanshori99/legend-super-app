// Tenant finance policy (legend-pxcs; PRD v1.7 §3.19, ACC-04 matching date
// tolerance, ACC-05 "batas hari" for cash left undeposited). Contract:
// finance-policy.ts.
//
// - One row per tenant (finance_policies.tenant_id is the primary key); no row
//   means the shared defaults (2 days / 2 days), so a read never writes.
// - PUT replaces the whole policy and converges under concurrent writers
//   through INSERT .. ON CONFLICT (last write wins, one audit row per write).
// - The tenant comes from the server-minted context, never from the body.
// - `loadCashDepositPolicy` is the seam for the ACC-05 alert consumer: the API
//   has no undeposited-cash alert endpoint yet, and the consumer must read the
//   configured limit instead of a fixed number.

import { eq } from "drizzle-orm";
import {
  DEFAULT_FINANCE_POLICY,
  financePolicySchema,
  putFinancePolicyInputSchema,
  type CashDepositPolicy,
  type FinancePolicy,
  type MatchingPolicy,
  type ReconciliationPolicy,
} from "@starter/shared/accounting";
import {
  assertTrustedScopedContext,
  createUlid,
  type ScopedTenantContext,
  type TenantId,
  type UserId,
} from "@starter/shared/core";
import { db } from "../db";
import { financePolicies } from "../db/schema/accounting-ap-fa.ts";
import { withTenant } from "../db/tenant.ts";
import { recordAudit } from "./core-audit.ts";
import type { TenantTransaction } from "./accounting-shared.ts";

/** Field names the policy audit row may keep unmasked (default-deny). */
const AUDIT_SAFE_FIELDS = [
  "maxDaysUndeposited",
  "dateToleranceDays",
  "caseDueDays",
] as const;

function defaultPolicy(): FinancePolicy {
  return financePolicySchema.parse(DEFAULT_FINANCE_POLICY);
}

async function readPolicy(
  tx: TenantTransaction,
  tenantId: TenantId,
): Promise<FinancePolicy> {
  const [row] = await tx
    .select({
      maxDaysUndeposited: financePolicies.maxDaysUndeposited,
      dateToleranceDays: financePolicies.bankMatchingDateToleranceDays,
      caseDueDays: financePolicies.reconCaseDueDays,
    })
    .from(financePolicies)
    .where(eq(financePolicies.tenantId, tenantId))
    .limit(1);
  if (!row) return defaultPolicy();
  return financePolicySchema.parse({
    cashDepositPolicy: { maxDaysUndeposited: row.maxDaysUndeposited },
    matchingPolicy: { dateToleranceDays: row.dateToleranceDays },
    reconciliationPolicy: { caseDueDays: row.caseDueDays },
  });
}

/**
 * legend-fnxl.9: the due-days a new reconciliation case gets, read inside the
 * caller's transaction (no row = the shared default of 7).
 */
export async function loadReconciliationPolicyInTx(
  tx: TenantTransaction,
  tenantId: TenantId,
): Promise<ReconciliationPolicy> {
  return (await readPolicy(tx, tenantId)).reconciliationPolicy;
}

/** The tenant's policy, or the defaults when none was saved. */
export async function getFinancePolicy(
  context: ScopedTenantContext,
): Promise<FinancePolicy> {
  return withTenant(db, context, (tx) =>
    readPolicy(tx, context.tenant.tenantId),
  );
}

/** ACC-05: the limit `undepositedCashAlerts` must use for this tenant. */
export async function loadCashDepositPolicy(
  context: ScopedTenantContext,
): Promise<CashDepositPolicy> {
  return (await getFinancePolicy(context)).cashDepositPolicy;
}

/** ACC-04: the date window automatic bank matching must use for this tenant. */
export async function loadMatchingPolicy(
  context: ScopedTenantContext,
): Promise<MatchingPolicy> {
  return (await getFinancePolicy(context)).matchingPolicy;
}

/** Replaces the whole policy (contract `putFinancePolicy`); audited. */
export async function putFinancePolicy(
  context: ScopedTenantContext,
  rawInput: unknown,
  actorId: UserId,
  now: Date = new Date(),
): Promise<FinancePolicy> {
  const input = putFinancePolicyInputSchema.parse(rawInput);
  assertTrustedScopedContext(context);
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    const before = await readPolicy(tx, tenantId);
    const values = {
      bankMatchingDateToleranceDays: input.matchingPolicy.dateToleranceDays,
      maxDaysUndeposited: input.cashDepositPolicy.maxDaysUndeposited,
      reconCaseDueDays: input.reconciliationPolicy.caseDueDays,
      updatedBy: actorId,
      updatedAt: now,
    };
    await tx
      .insert(financePolicies)
      .values({ tenantId, ...values, createdAt: now })
      .onConflictDoUpdate({ target: financePolicies.tenantId, set: values });
    await recordAudit(
      tx,
      context,
      {
        id: createUlid(),
        tenantId,
        outletId: null,
        actorType: "user",
        actorId,
        deviceId: null,
        action: "accounting.finance_policy.updated",
        objectType: "finance_policy",
        objectId: tenantId,
        reason: null,
        maskedChanges: {
          before: {
            ...before.cashDepositPolicy,
            ...before.matchingPolicy,
            ...before.reconciliationPolicy,
          },
          after: {
            ...input.cashDepositPolicy,
            ...input.matchingPolicy,
            ...input.reconciliationPolicy,
          },
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: now.toISOString(),
      },
      AUDIT_SAFE_FIELDS,
    );
    return input;
  });
}
