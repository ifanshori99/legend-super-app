// Kasbon (employee loans) API service (bead legend-gfcr slice D, PRD v1.7 §3
// D.31; contract `@starter/shared/hris/payroll` loans.ts + endpoints.ts).
// Routes: routes/payroll-loans.routes.ts.
//
// Reading the HR list needs `payroll.view` or `hr.loan.approve`, deciding and
// disbursing needs `hr.loan.approve`, all tenant-wide. An employee reaches only
// their own rows through /me (HR-01: the employee id comes from the session,
// never from input). The approver can never be the borrower. Every write is
// idempotent and audited with field names only (no amounts, no free text).
//
// Installments are deducted by the payroll engine (locked runs only); this
// service never changes `outstanding_idr` after the request.

import { randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { PermissionCode } from "@starter/shared/access";
import {
  businessDateOf,
  businessDateSchema,
  createUlid,
  DEFAULT_BUSINESS_DAY_CLOCK,
  encodeCursor,
  idr,
  type BusinessDate,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import {
  PayrollError,
  assertLoanWithinPolicy,
  decideEmployeeLoan as decideEmployeeLoanEndpoint,
  employeeLoanIdSchema,
  disburseEmployeeLoan as disburseEmployeeLoanEndpoint,
  employeeLoanDisbursed,
  employeeLoanSchema,
  listEmployeeLoans as listEmployeeLoansEndpoint,
  listMyLoans as listMyLoansEndpoint,
  loanInstallmentFor,
  loanPolicySchema,
  transitionEmployeeLoan,
  type EmployeeLoan,
  type EmployeeLoanAction,
  type EmployeeLoanStatus,
} from "@starter/shared/hris/payroll";
import type { z } from "zod";
import { db } from "../db/index.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  employeeLoans,
  employeePayComponents,
  payComponents,
  payrollLoanPolicies,
} from "../db/schema/payroll.ts";
import { employees } from "../db/schema/hris.ts";
import { hrisOffboardings } from "../db/schema/hris-lifecycle.ts";
import { withTenant } from "../db/tenant.ts";
import { openPayrollAmount } from "../lib/payroll-sealed.ts";
import { entityLock } from "./accounting-bank-matching.ts";
import { emitPayrollEvent } from "./payroll-events.ts";
import { accountingEnabledShared } from "./payroll-payout-setup.ts";
import { assertCash1102CoversOutflow } from "./accounting-petty-cash.service.ts";
import { recordAudit } from "./core-audit.ts";
import { cursorPair, notFound } from "./hris-access.ts";
import { idempotentHrisWrite } from "./hris-employee.service.ts";
import { assertPayrollTenantCan, loadPayrollSelf } from "./payroll-access.ts";
import type { Tx } from "./permission-resolver.ts";

const VIEW_CODE: PermissionCode = "payroll.view";
const APPROVE_CODE: PermissionCode = "hr.loan.approve";
/** Own kasbon record: the employee template code, not the profile code (HR-01, legend-krvk7). */
const SELF_CODE: PermissionCode = "self.loan.request";

const AUDIT_ACTION: Record<EmployeeLoanAction, string> = {
  approve: "payroll.loan.approved",
  reject: "payroll.loan.rejected",
  cancel: "payroll.loan.cancelled",
  disburse: "payroll.loan.disbursed",
};

/** Field names only; no amounts and no free text reach the audit log. */
const AUDIT_SAFE_FIELDS = ["status", "installmentCount"] as const;

type LoanRow = typeof employeeLoans.$inferSelect;
type ListQuery = z.infer<typeof listEmployeeLoansEndpoint.query>;
type PageQuery = z.infer<typeof listMyLoansEndpoint.query>;
type DecideInput = z.infer<typeof decideEmployeeLoanEndpoint.body>;
type DisburseInput = z.infer<typeof disburseEmployeeLoanEndpoint.body>;
type LoanPage = z.output<typeof listEmployeeLoansEndpoint.response>;
type CreateInput = {
  principalIdr: number;
  installmentCount: number;
  reason: string;
  idempotencyKey: string;
};

/** A loan that still counts against "one open loan at a time". */
const OPEN_LOAN_STATUSES = ["pending", "approved", "disbursed"] as const;

/** Sum of the employee's base-salary components valid on `today` (sealed). */
async function monthlyBaseSalaryIdr(
  tx: Tx,
  context: ScopedTenantContext,
  employeeId: string,
  today: BusinessDate,
) {
  const rows = await tx
    .select({
      id: employeePayComponents.id,
      tenantId: employeePayComponents.tenantId,
      amountEncrypted: employeePayComponents.amountEncrypted,
      piiKeyVersion: employeePayComponents.piiKeyVersion,
    })
    .from(employeePayComponents)
    .innerJoin(
      payComponents,
      and(
        eq(payComponents.tenantId, employeePayComponents.tenantId),
        eq(payComponents.id, employeePayComponents.componentId),
      ),
    )
    .where(
      and(
        eq(employeePayComponents.tenantId, context.tenant.tenantId),
        eq(employeePayComponents.employeeId, employeeId),
        eq(payComponents.category, "base_salary"),
        lte(employeePayComponents.effectiveFrom, today),
        or(
          isNull(employeePayComponents.effectiveTo),
          gte(employeePayComponents.effectiveTo, today),
        ),
      ),
    );
  return idr(
    rows.reduce(
      (sum, row) =>
        sum +
        openPayrollAmount(
          row.amountEncrypted,
          {
            tenantId: row.tenantId,
            table: "employee_pay_components",
            rowId: row.id,
            field: "amount",
          },
          row.piiKeyVersion,
        ),
      0,
    ),
  );
}

/**
 * Kasbon limits (PRD D.31 "batas maksimal"). Runs at request and at approval
 * under one lock per employee, so two parallel requests cannot both pass the
 * "one open loan" or ceiling check before either one is stored. No policy row
 * for the tenant means no kasbon (fail closed). `excludeLoanId` is the loan
 * being approved: it must not count against itself.
 */
async function assertLoanAllowed(
  tx: Tx,
  context: ScopedTenantContext,
  employeeId: string,
  request: { principalIdr: number; installmentCount: number },
  today: BusinessDate,
  excludeLoanId?: string,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`payroll:loan:${tenantId}:${employeeId}`}, 0))`,
  );
  const [policyRow] = await tx
    .select()
    .from(payrollLoanPolicies)
    .where(eq(payrollLoanPolicies.tenantId, tenantId))
    .limit(1);
  if (!policyRow) throw new PayrollError("PAYROLL_LOAN_LIMIT_EXCEEDED");
  const policy = loanPolicySchema.parse({
    maxPrincipalIdr: policyRow.maxPrincipalIdr,
    maxPrincipalOfBaseSalaryBp: policyRow.maxPrincipalOfBaseSalaryBp,
    maxTotalOpenIdr: policyRow.maxTotalOpenIdr,
    maxInstallments: policyRow.maxInstallments,
    maxDeductionOfNetPayBp: policyRow.maxDeductionOfNetPayBp,
    singleOpenLoan: policyRow.singleOpenLoan,
  });
  const open = await tx
    .select({
      id: employeeLoans.id,
      outstandingIdr: employeeLoans.outstandingIdr,
    })
    .from(employeeLoans)
    .where(
      and(
        eq(employeeLoans.tenantId, tenantId),
        eq(employeeLoans.employeeId, employeeId),
        inArray(employeeLoans.status, [...OPEN_LOAN_STATUSES]),
        excludeLoanId
          ? ne(employeeLoans.id, excludeLoanId as LoanRow["id"])
          : undefined,
      ),
    );
  assertLoanWithinPolicy(policy, {
    principalIdr: idr(request.principalIdr),
    installmentCount: request.installmentCount,
    // Only read when the policy has a salary multiple; none found = 0, so the
    // ceiling is 0 and the request fails closed.
    monthlyBaseSalaryIdr:
      policy.maxPrincipalOfBaseSalaryBp === null
        ? idr(0)
        : await monthlyBaseSalaryIdr(tx, context, employeeId, today),
    openLoanCount: open.length,
    // pending and approved loans hold their full principal as outstanding
    // (table check), a disbursed one the unpaid rest.
    openOutstandingIdr: idr(
      open.reduce((sum, loan) => sum + Number(loan.outstandingIdr), 0),
    ),
  });
}

const toLoan = (row: LoanRow): EmployeeLoan =>
  employeeLoanSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    employeeId: row.employeeId,
    principalIdr: row.principalIdr,
    installmentIdr: row.installmentIdr,
    installmentCount: row.installmentCount,
    outstandingIdr: row.outstandingIdr,
    firstDeductionPeriod: row.firstDeductionPeriod,
    reason: row.reason,
    status: row.status,
    requestedAt: row.requestedAt.toISOString(),
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    disbursedAt: row.disbursedAt?.toISOString() ?? null,
    settledAt: row.settledAt?.toISOString() ?? null,
  });

/** `payroll.view` or `hr.loan.approve`, both tenant-wide. */
async function assertCanRead(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
): Promise<void> {
  try {
    await assertPayrollTenantCan(tx, context, actorUserId, VIEW_CODE);
  } catch (error) {
    if (!isForbidden(error)) throw error;
    await assertPayrollTenantCan(tx, context, actorUserId, APPROVE_CODE);
  }
}

function isForbidden(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { status?: unknown }).status === 403
  );
}

async function loadPage(
  tx: Tx,
  context: ScopedTenantContext,
  query: PageQuery & { status?: EmployeeLoanStatus; employeeId?: string },
  employeeId?: string,
): Promise<LoanPage> {
  const filters = [eq(employeeLoans.tenantId, context.tenant.tenantId)];
  if (employeeId) filters.push(eq(employeeLoans.employeeId, employeeId));
  else if (query.employeeId)
    filters.push(eq(employeeLoans.employeeId, query.employeeId));
  if (query.status) filters.push(eq(employeeLoans.status, query.status));
  if (query.cursor) {
    const [requestedAt, id] = cursorPair(query.cursor);
    const at = new Date(requestedAt);
    const beforeId = employeeLoanIdSchema.safeParse(id);
    if (Number.isNaN(at.getTime()) || !beforeId.success)
      throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
    filters.push(
      or(
        lt(employeeLoans.requestedAt, at),
        and(
          eq(employeeLoans.requestedAt, at),
          sql`${employeeLoans.id} < ${beforeId.data}`,
        ),
      )!,
    );
  }
  const rows = await tx
    .select()
    .from(employeeLoans)
    .where(and(...filters))
    .orderBy(desc(employeeLoans.requestedAt), desc(employeeLoans.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return listEmployeeLoansEndpoint.response.parse({
    data: page.map(toLoan),
    meta: {
      limit: query.limit,
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor([last.requestedAt.toISOString(), last.id])
          : null,
    },
  });
}

export async function listEmployeeLoans(
  context: ScopedTenantContext,
  actorUserId: string,
  query: ListQuery,
): Promise<LoanPage> {
  return withTenant(db, context, async (tx) => {
    await assertCanRead(tx, context, actorUserId);
    return loadPage(tx, context, query);
  });
}

export async function listMyLoans(
  context: ScopedTenantContext,
  actorUserId: string,
  query: PageQuery,
): Promise<LoanPage> {
  return withTenant(db, context, async (tx) => {
    const self = await loadPayrollSelf(tx, context, actorUserId, SELF_CODE);
    return loadPage(tx, context, query, self.employeeId);
  });
}

/** First day of the month after `today`: the first installment period. */
export function firstDeductionPeriodAfter(today: BusinessDate): BusinessDate {
  const [year, month] = today.split("-").map(Number) as [number, number];
  const next = month === 12 ? [year + 1, 1] : [year, month + 1];
  return businessDateSchema.parse(
    `${next[0]}-${String(next[1]).padStart(2, "0")}-01`,
  );
}

export async function createMyLoan(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateInput,
  now: Date = new Date(),
): Promise<EmployeeLoan> {
  return withTenant(db, context, async (tx) => {
    const self = await loadPayrollSelf(tx, context, actorUserId, SELF_CODE);
    const { idempotencyKey, ...request } = input;
    return idempotentHrisWrite(
      tx,
      context,
      idempotencyKey,
      "payroll.loan.create",
      { actor: self.actor, employeeId: self.employeeId, ...request },
      async () => {
        const today = businessDateOf(now, DEFAULT_BUSINESS_DAY_CLOCK);
        const [home] = await tx
          .select({
            homeOutletId: employees.homeOutletId,
            status: employees.status,
          })
          .from(employees)
          .where(
            and(
              eq(employees.tenantId, context.tenant.tenantId),
              eq(employees.id, self.employeeId),
            ),
          )
          .limit(1);
        if (!home) throw notFound();
        if (home.status !== "active" && home.status !== "onboarding")
          throw new HttpError(
            422,
            "VALIDATION_ERROR",
            "Karyawan yang sudah tidak aktif tidak bisa mengajukan kasbon.",
          );
        await assertLoanAllowed(tx, context, self.employeeId, request, today);
        const [row] = await tx
          .insert(employeeLoans)
          .values({
            id: randomUUID() as LoanRow["id"],
            tenantId: context.tenant.tenantId,
            employeeId: self.employeeId,
            principalIdr: request.principalIdr as LoanRow["principalIdr"],
            installmentIdr: loanInstallmentFor(
              request.principalIdr as Parameters<typeof loanInstallmentFor>[0],
              request.installmentCount,
            ),
            installmentCount: request.installmentCount,
            outstandingIdr: request.principalIdr as LoanRow["outstandingIdr"],
            firstDeductionPeriod: firstDeductionPeriodAfter(today),
            reason: request.reason,
            status: "pending",
            requestedAt: now,
            updatedAt: now,
          })
          .returning();
        if (!row) throw new Error("Loan was not stored");
        const created = toLoan(row);
        await auditLoan(tx, context, self.actor, now, {
          // The caller's scope may be outlet-bound: audit on the home outlet.
          outletId:
            context.outletScope.kind === "tenant" ? null : home.homeOutletId,
          action: "payroll.loan.requested",
          loanId: created.id,
          before: null,
          after: {
            status: created.status,
            installmentCount: created.installmentCount,
          },
        });
        return created;
      },
    );
  });
}

async function auditLoan(
  tx: Tx,
  context: ScopedTenantContext,
  actor: UserId,
  now: Date,
  entry: {
    outletId: string | null;
    action: string;
    loanId: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown>;
    reason?: string | null;
  },
): Promise<void> {
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: entry.outletId,
      actorType: "user",
      actorId: actor,
      deviceId: null,
      action: entry.action,
      objectType: "employee_loan",
      objectId: entry.loanId,
      reason: entry.reason ?? null,
      maskedChanges: { before: entry.before, after: entry.after },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    },
    AUDIT_SAFE_FIELDS,
  );
}

/** Locks the loan row; the approver may not be the borrower. */
async function lockLoanForDecision(
  tx: Tx,
  context: ScopedTenantContext,
  actor: UserId,
  loanId: string,
): Promise<LoanRow> {
  const [row] = await tx
    .select()
    .from(employeeLoans)
    .where(
      and(
        eq(employeeLoans.tenantId, context.tenant.tenantId),
        eq(employeeLoans.id, loanId as LoanRow["id"]),
      ),
    )
    .for("update")
    .limit(1);
  if (!row) throw notFound("Kasbon");
  const [borrower] = await tx
    .select({ userId: employees.userId })
    .from(employees)
    .where(
      and(
        eq(employees.tenantId, context.tenant.tenantId),
        eq(employees.id, row.employeeId),
      ),
    )
    .limit(1);
  if (borrower?.userId === actor)
    throw new PayrollError("PAYROLL_APPROVER_NOT_DISTINCT");
  return row;
}

async function applyTransition(
  tx: Tx,
  context: ScopedTenantContext,
  actor: UserId,
  row: LoanRow,
  action: EmployeeLoanAction,
  now: Date,
  reason: string | null = null,
): Promise<EmployeeLoan> {
  const next = transitionEmployeeLoan(row.status as EmployeeLoanStatus, action);
  const changes =
    action === "disburse"
      ? { status: next, disbursedAt: now, updatedAt: now }
      : action === "cancel" && row.decidedBy !== null
        ? // Keep the approver of an approved loan; the audit entry names the canceller.
          { status: next, updatedAt: now }
        : { status: next, decidedBy: actor, decidedAt: now, updatedAt: now };
  const [updated] = await tx
    .update(employeeLoans)
    .set(changes)
    .where(
      and(
        eq(employeeLoans.tenantId, context.tenant.tenantId),
        eq(employeeLoans.id, row.id),
        eq(employeeLoans.status, row.status),
      ),
    )
    .returning();
  if (!updated) throw new PayrollError("PAYROLL_INVALID_TRANSITION");
  const loan = toLoan(updated);
  await auditLoan(tx, context, actor, now, {
    outletId: null,
    action: AUDIT_ACTION[action],
    loanId: loan.id,
    before: { status: row.status },
    after: { status: loan.status },
    reason,
  });
  return loan;
}

export async function decideEmployeeLoan(
  context: ScopedTenantContext,
  actorUserId: string,
  loanId: string,
  input: DecideInput,
  now: Date = new Date(),
): Promise<EmployeeLoan> {
  return withTenant(db, context, async (tx) => {
    const actor = await assertPayrollTenantCan(
      tx,
      context,
      actorUserId,
      APPROVE_CODE,
    );
    return idempotentHrisWrite(
      tx,
      context,
      input.idempotencyKey,
      "payroll.loan.decide",
      { actor, loanId, action: input.action, reason: input.reason ?? null },
      async () => {
        const row = await lockLoanForDecision(tx, context, actor, loanId);
        // Cancelling an approved kasbon (not paid yet) needs a reason for the
        // audit trail; no money moves, so no journal and no event (legend-d5n4j).
        // A disbursed or already cancelled kasbon is a plain invalid transition.
        if (
          input.action === "cancel" &&
          row.status === "approved" &&
          !input.reason
        )
          throw new HttpError(
            422,
            "PAYROLL_CANCEL_REASON_REQUIRED",
            "Alasan pembatalan wajib diisi untuk kasbon yang sudah disetujui.",
          );
        // Approving re-checks the limits against the policy of today and the
        // other open loans of the borrower (this loan excluded).
        // Only a pending loan is checked: any other status is a plain invalid
        // transition (applyTransition answers it).
        if (input.action === "approve" && row.status === "pending")
          await assertLoanAllowed(
            tx,
            context,
            row.employeeId,
            {
              principalIdr: row.principalIdr,
              installmentCount: row.installmentCount,
            },
            businessDateOf(now, DEFAULT_BUSINESS_DAY_CLOCK),
            row.id,
          );
        return applyTransition(
          tx,
          context,
          actor,
          row,
          input.action,
          now,
          input.reason ?? null,
        );
      },
    );
  });
}

async function employeeEntityId(
  tx: Tx,
  context: ScopedTenantContext,
  employeeId: LoanRow["employeeId"],
): Promise<string | null> {
  const [employee] = await tx
    .select({ legalEntityId: employees.legalEntityId })
    .from(employees)
    .where(
      and(
        eq(employees.tenantId, context.tenant.tenantId),
        eq(employees.id, employeeId),
      ),
    )
    .limit(1);
  return employee?.legalEntityId ?? null;
}

/** Unlocked read of the borrower's legal entity; null when unknown. */
async function loanEntityId(
  tx: Tx,
  context: ScopedTenantContext,
  loanId: string,
): Promise<string | null> {
  const [loan] = await tx
    .select({ employeeId: employeeLoans.employeeId })
    .from(employeeLoans)
    .where(
      and(
        eq(employeeLoans.tenantId, context.tenant.tenantId),
        eq(employeeLoans.id, loanId as LoanRow["id"]),
      ),
    )
    .limit(1);
  return loan ? employeeEntityId(tx, context, loan.employeeId) : null;
}

export async function disburseEmployeeLoan(
  context: ScopedTenantContext,
  actorUserId: string,
  loanId: string,
  input: DisburseInput,
  now: Date = new Date(),
): Promise<EmployeeLoan> {
  return withTenant(db, context, async (tx) => {
    const actor = await assertPayrollTenantCan(
      tx,
      context,
      actorUserId,
      APPROVE_CODE,
    );
    return idempotentHrisWrite(
      tx,
      context,
      input.idempotencyKey,
      "payroll.loan.disburse",
      { actor, loanId },
      async () => {
        // Loan lock first (same order as assertNoPendingPayrollDeduction in
        // hris-offboarding.service.ts), then the offboarding check: no money
        // leaves to an employee whose offboarding is active (open or revoked)
        // or completed. Only cancelled or no offboarding may disburse.
        //
        // A cash disbursement pays out of petty cash (1102): the entity lock
        // comes BEFORE the loan lock (1053 order: entity, then rows), so the
        // entity is read unlocked first and re-checked under the loan lock
        // (legend-swn0m).
        const peekEntityId = await loanEntityId(tx, context, loanId);
        if (peekEntityId !== null)
          await entityLock(tx, context.tenant.tenantId, peekEntityId);
        const row = await lockLoanForDecision(tx, context, actor, loanId);
        if (peekEntityId !== null) {
          const lockedEntityId = await employeeEntityId(
            tx,
            context,
            row.employeeId,
          );
          if (lockedEntityId !== peekEntityId)
            throw new HttpError(
              409,
              "PAYROLL_LOAN_ENTITY_CHANGED",
              "Badan usaha karyawan berubah saat kasbon diproses. Coba lagi.",
            );
        }
        const offboardings = await tx
          .select({ status: hrisOffboardings.status })
          .from(hrisOffboardings)
          .where(
            and(
              eq(hrisOffboardings.tenantId, context.tenant.tenantId),
              eq(hrisOffboardings.employeeId, row.employeeId),
              inArray(hrisOffboardings.status, [
                "open",
                "revoked",
                "completed",
              ]),
            ),
          );
        if (offboardings.some((o) => o.status === "completed"))
          throw new HttpError(
            409,
            "PAYROLL_LOAN_OFFBOARDING_COMPLETED",
            "Kasbon tidak bisa dicairkan: offboarding karyawan sudah selesai.",
          );
        if (offboardings.length > 0)
          throw new HttpError(
            409,
            "PAYROLL_LOAN_OFFBOARDING_ACTIVE",
            "Kasbon tidak bisa dicairkan: karyawan sedang dalam proses offboarding.",
          );
        // Only an approved loan pays out; any other status is a plain invalid
        // transition (applyTransition answers it). Under the entity lock and
        // before the disbursed event, so the amount is not counted twice.
        const accountingOn = await accountingEnabledShared(
          tx,
          context.tenant.tenantId,
        );
        if (row.status === "approved") {
          // No legal entity means no 1102 to check and no journal to post:
          // with accounting on the cash would leave unrecorded, so refuse
          // (legend-cv00j).
          if (peekEntityId === null) {
            if (accountingOn)
              throw new HttpError(
                422,
                "PAYROLL_CASH_ENTITY_MISSING",
                "Kasbon tunai tidak bisa dicairkan: karyawan belum punya badan usaha, padahal akuntansi aktif.",
              );
          } else
            await assertCash1102CoversOutflow(
              tx,
              context.tenant.tenantId,
              peekEntityId,
              Number(row.principalIdr),
              accountingOn,
            );
        }
        const disbursed = await applyTransition(
          tx,
          context,
          actor,
          row,
          "disburse",
          now,
        );
        // The cash leaves petty cash (1102): announce it in the same
        // transaction so the GL consumer posts Dr employee receivable / Cr
        // 1102 and the amount is a pending credit until then (legend-xf7pt).
        // The transition above runs once per loan (status guard plus the
        // idempotency key), so a retry never announces it twice. A borrower
        // without a legal entity has no 1102 to credit.
        if (peekEntityId !== null)
          await emitPayrollEvent(tx, context, employeeLoanDisbursed, {
            aggregateId: row.id,
            actor: { type: "user", id: actor },
            payload: {
              employeeLoanId: row.id,
              employeeId: row.employeeId,
              legalEntityId: peekEntityId,
              principalIdr: Number(row.principalIdr),
              disbursedVia: "cash",
              accountingOnAtEmit: accountingOn,
              disbursedBy: actor,
              disbursedAt: now.toISOString(),
            },
            now,
          });
        return disbursed;
      },
    );
  });
}
