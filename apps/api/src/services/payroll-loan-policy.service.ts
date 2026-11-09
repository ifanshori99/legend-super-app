// Kasbon limits per tenant (bead legend-hjaot; contract `loanPolicySchema` in
// `@starter/shared/hris/payroll`; table `payroll_loan_policies`, migration
// 0169). Routes: routes/payroll-loan-policy.routes.ts.
//
// Reading needs `payroll.view`, writing `payroll.run`, both tenant-wide; the
// service re-checks them inside the tenant transaction. A tenant has at most
// one row and kasbon is off until it exists (the loan service fails closed),
// so writing here is what switches kasbon on. The write replaces the whole
// policy: the body is parsed with `loanPolicySchema` again, so a row can
// never hold what the contract refuses.
//
// Concurrent writers of one tenant queue on an advisory lock, so the audit
// `before` of each change is the policy the previous change stored. Audit
// values are the five limit fields (numbers and a boolean) and nothing else.

import { and, eq, sql } from "drizzle-orm";
import type { PermissionCode } from "@starter/shared/access";
import {
  createUlid,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import {
  loanPolicyRecordSchema,
  loanPolicySchema,
  type LoanPolicy,
  type LoanPolicyRecord,
  type SetLoanPolicyInput,
} from "@starter/shared/hris/payroll";
import { db } from "../db/index.ts";
import { payrollLoanPolicies } from "../db/schema/payroll.ts";
import { withTenant } from "../db/tenant.ts";
import { recordAudit } from "./core-audit.ts";
import { idempotentHrisWrite } from "./hris-employee.service.ts";
import { assertPayrollTenantCan } from "./payroll-access.ts";

const READ_CODE: PermissionCode = "payroll.view";
const WRITE_CODE: PermissionCode = "payroll.run";

/**
 * Field names only; the values are limits, never personal data. The audit
 * masker refuses any key containing "salary", so the salary multiple is
 * logged as `principalMultipleBp` (basis points of the monthly base pay).
 */
const AUDIT_SAFE_FIELDS = [
  "maxPrincipalIdr",
  "principalMultipleBp",
  "maxTotalOpenIdr",
  "maxInstallments",
  "maxDeductionOfNetPayBp",
  "singleOpenLoan",
] as const;

type PolicyRow = typeof payrollLoanPolicies.$inferSelect;

const toLimits = (row: PolicyRow): LoanPolicy =>
  // Parsed again through the contract: a row edited outside the service fails
  // loudly instead of silently changing what an employee may borrow.
  loanPolicySchema.parse({
    maxPrincipalIdr: row.maxPrincipalIdr,
    maxPrincipalOfBaseSalaryBp: row.maxPrincipalOfBaseSalaryBp,
    maxTotalOpenIdr: row.maxTotalOpenIdr,
    maxInstallments: row.maxInstallments,
    maxDeductionOfNetPayBp: row.maxDeductionOfNetPayBp,
    singleOpenLoan: row.singleOpenLoan,
  });

const toAuditLimits = (row: PolicyRow) => ({
  maxPrincipalIdr: row.maxPrincipalIdr,
  principalMultipleBp: row.maxPrincipalOfBaseSalaryBp,
  maxTotalOpenIdr: row.maxTotalOpenIdr,
  maxInstallments: row.maxInstallments,
  maxDeductionOfNetPayBp: row.maxDeductionOfNetPayBp,
  singleOpenLoan: row.singleOpenLoan,
});

const toRecord = (row: PolicyRow): LoanPolicyRecord =>
  loanPolicyRecordSchema.parse({
    ...toLimits(row),
    updatedAt: row.updatedAt.toISOString(),
  });

/** GET /api/hris/payroll/loan-policy; null while kasbon is off. */
export async function getLoanPolicy(
  context: ScopedTenantContext,
  actorUserId: string,
): Promise<LoanPolicyRecord | null> {
  return withTenant(db, context, async (tx) => {
    await assertPayrollTenantCan(tx, context, actorUserId, READ_CODE);
    const [row] = await tx
      .select()
      .from(payrollLoanPolicies)
      .where(eq(payrollLoanPolicies.tenantId, context.tenant.tenantId))
      .limit(1);
    return row ? toRecord(row) : null;
  });
}

/** PUT /api/hris/payroll/loan-policy */
export async function setLoanPolicy(
  context: ScopedTenantContext,
  actorUserId: string,
  input: SetLoanPolicyInput,
  now: Date = new Date(),
): Promise<LoanPolicyRecord> {
  const { idempotencyKey, ...body } = input;
  const limits = loanPolicySchema.parse(body);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const actor: UserId = await assertPayrollTenantCan(
      tx,
      context,
      actorUserId,
      WRITE_CODE,
    );
    return idempotentHrisWrite(
      tx,
      context,
      idempotencyKey,
      "payroll.loan_policy.set",
      { actor, limits },
      async () => {
        // Writers of one tenant queue here: the first insert and the later
        // updates all see the previous change when they read `before`.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`payroll:loan-policy:${tenantId}`}, 0))`,
        );
        const [current] = await tx
          .select()
          .from(payrollLoanPolicies)
          .where(eq(payrollLoanPolicies.tenantId, tenantId))
          .limit(1);
        const values = {
          maxPrincipalIdr: limits.maxPrincipalIdr,
          maxPrincipalOfBaseSalaryBp: limits.maxPrincipalOfBaseSalaryBp,
          maxTotalOpenIdr: limits.maxTotalOpenIdr,
          maxInstallments: limits.maxInstallments,
          maxDeductionOfNetPayBp: limits.maxDeductionOfNetPayBp,
          singleOpenLoan: limits.singleOpenLoan,
          updatedBy: actor,
          updatedAt: now,
        };
        const [row] = current
          ? await tx
              .update(payrollLoanPolicies)
              .set(values)
              .where(
                and(
                  eq(payrollLoanPolicies.tenantId, tenantId),
                  eq(payrollLoanPolicies.id, current.id),
                ),
              )
              .returning()
          : await tx
              .insert(payrollLoanPolicies)
              .values({ tenantId, ...values, createdAt: now })
              .returning();
        if (!row) throw new Error("Loan policy was not stored");
        const saved = toRecord(row);
        await recordAudit(
          tx,
          context,
          {
            id: createUlid(now.getTime()),
            tenantId,
            outletId: null,
            actorType: "user" as const,
            actorId: actor,
            deviceId: null,
            action: "payroll.loan_policy.set",
            objectType: "payroll_loan_policy",
            objectId: row.id,
            reason: null,
            maskedChanges: {
              before: current ? toAuditLimits(current) : null,
              after: toAuditLimits(row),
            },
            ipHash: null,
            sensitiveAccess: false,
            retentionClass: "audit_2y" as const,
            createdAt: now.toISOString(),
          },
          AUDIT_SAFE_FIELDS,
        );
        return saved;
      },
    );
  });
}
