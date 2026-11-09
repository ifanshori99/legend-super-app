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
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import type { PermissionCode } from "@starter/shared/access";
import {
  businessDateOf,
  businessDateSchema,
  createUlid,
  DEFAULT_BUSINESS_DAY_CLOCK,
  encodeCursor,
  type BusinessDate,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import {
  PayrollError,
  decideEmployeeLoan as decideEmployeeLoanEndpoint,
  disburseEmployeeLoan as disburseEmployeeLoanEndpoint,
  employeeLoanSchema,
  listEmployeeLoans as listEmployeeLoansEndpoint,
  listMyLoans as listMyLoansEndpoint,
  loanInstallmentFor,
  transitionEmployeeLoan,
  type EmployeeLoan,
  type EmployeeLoanAction,
  type EmployeeLoanStatus,
} from "@starter/shared/hris/payroll";
import type { z } from "zod";
import { db } from "../db/index.ts";
import { HttpError } from "../lib/http-error.ts";
import { employeeLoans } from "../db/schema/payroll.ts";
import { employees } from "../db/schema/hris.ts";
import { withTenant } from "../db/tenant.ts";
import { recordAudit } from "./core-audit.ts";
import { cursorPair, notFound } from "./hris-access.ts";
import { idempotentHrisWrite } from "./hris-employee.service.ts";
import { assertPayrollTenantCan, loadPayrollSelf } from "./payroll-access.ts";
import type { Tx } from "./permission-resolver.ts";

const VIEW_CODE: PermissionCode = "payroll.view";
const APPROVE_CODE: PermissionCode = "hr.loan.approve";
/** No kasbon-specific self code exists: own record needs a profile (HR-01). */
const SELF_CODE: PermissionCode = "self.profile.view";

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
    if (Number.isNaN(at.getTime()))
      throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
    filters.push(
      or(
        lt(employeeLoans.requestedAt, at),
        and(
          eq(employeeLoans.requestedAt, at),
          sql`${employeeLoans.id} < ${id}`,
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
        // TODO legend-fij0l: assertLoanWithinPolicy needs a tenant loan policy
        // (limits, single open loan, salary multiple). No storage exists yet,
        // so no limit is enforced here.
        const today = businessDateOf(now, DEFAULT_BUSINESS_DAY_CLOCK);
        const [home] = await tx
          .select({ homeOutletId: employees.homeOutletId })
          .from(employees)
          .where(
            and(
              eq(employees.tenantId, context.tenant.tenantId),
              eq(employees.id, self.employeeId),
            ),
          )
          .limit(1);
        if (!home) throw notFound();
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
      reason: null,
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
): Promise<EmployeeLoan> {
  const next = transitionEmployeeLoan(row.status as EmployeeLoanStatus, action);
  const changes =
    action === "disburse"
      ? { status: next, disbursedAt: now, updatedAt: now }
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
      { actor, loanId, action: input.action },
      async () =>
        applyTransition(
          tx,
          context,
          actor,
          await lockLoanForDecision(tx, context, actor, loanId),
          input.action,
          now,
        ),
    );
  });
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
      async () =>
        applyTransition(
          tx,
          context,
          actor,
          await lockLoanForDecision(tx, context, actor, loanId),
          "disburse",
          now,
        ),
    );
  });
}
