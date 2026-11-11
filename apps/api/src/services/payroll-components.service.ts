// Pay components and per-employee amounts (bead legend-gfcr, PRD v1.7 §3 D.30
// "Komponen Gaji"; contract `@starter/shared/hris/payroll` components.ts and
// endpoints.ts). Routes: routes/payroll-components.routes.ts.
//
// Reading needs `payroll.view`, writing `payroll.run`, both tenant-wide
// (assertPayrollTenantCan); the route gate is repeated inside the tenant
// transaction. Components are never deleted (the app role has no DELETE
// privilege): a component leaves use by `isActive = false`.
//
// Update merges the stored row with the patch and parses the merged object
// with `payComponentSchema` again, server side: a patch that is valid on its
// own cannot make a deduction taxable or a reimbursement income (zjwa).
//
// Employee amounts are salary data (HR-03): sealed with `sealPayrollAmount`,
// bound to tenant, table, row and field, and opened only on the way out. The
// rows are append-only except `effective_to`: a new amount closes the open row
// the day before it starts; an amount is never rewritten. The idempotency
// record stores the new row id, never the amount.

import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { PermissionCode } from "@starter/shared/access";
import {
  businessDateSchema,
  createUlid,
  encodeCursor,
  formatDecimal4,
  idr,
  type BusinessDate,
  type CursorPage,
  type CursorPageQuery,
  type Idr,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import {
  createPayComponentInputSchema,
  employeePayComponentSchema,
  computeOvertimePay,
  FROZEN_PAYROLL_RUN_STATUSES,
  OVERTIME_DAY_TYPES,
  payComponentIdSchema,
  payComponentKindOf,
  overtimeParametersSchema,
  PayrollError,
  payComponentSchema,
  payslipLineSchema,
  setEmployeePayComponentInputSchema,
  updatePayComponentInputSchema,
  type CreatePayComponentInput,
  type EmployeePayComponent,
  type OvertimeParameters,
  type OvertimeDayType,
  type PayComponent,
  type PayslipLine,
  type SetEmployeePayComponentInput,
  type UpdatePayComponentInput,
} from "@starter/shared/hris/payroll";
import { CoreError } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { employees } from "../db/schema/hris.ts";
import { attendanceLogs } from "../db/schema/hris-attendance.ts";
import { overtimeRequests } from "../db/schema/hris-leave.ts";
import { outlets } from "../db/schema/platform-org.ts";
import {
  employeePayComponents,
  payComponents,
  payrollRuns,
} from "../db/schema/payroll.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  openPayrollAmount,
  PAYROLL_SEAL_KEY_VERSION,
  sealPayrollAmount,
  sealPayrollValue,
} from "../lib/payroll-sealed.ts";
import { recordAudit } from "./core-audit.ts";
import {
  cursorPair,
  notFound,
  uniqueViolation,
  type Tx,
} from "./hris-access.ts";
import { idempotentHrisWrite } from "./hris-employee.service.ts";
import { assertPayrollTenantCan } from "./payroll-access.ts";

const READ_CODE: PermissionCode = "payroll.view";
const WRITE_CODE: PermissionCode = "payroll.run";

/** Field names only: never a name, code, or amount. */
const AUDIT_SAFE_FIELDS = [
  "category",
  "kind",
  "recurrence",
  "taxable",
  "taxScheme",
  "bpjsBase",
  "overtimeBase",
  "thrBase",
  "displayOrder",
  "isActive",
  "changedFields",
  "employeeId",
  "componentId",
  "effectiveFrom",
  "closedPreviousUntil",
] as const;

type ComponentRow = typeof payComponents.$inferSelect;
type EmployeeComponentRow = typeof employeePayComponents.$inferSelect;

const COMPONENT_NOT_FOUND = "Komponen gaji";

function invalid(message: string): HttpError {
  return new HttpError(422, "VALIDATION_ERROR", message);
}

function addDays(date: BusinessDate, days: number): BusinessDate {
  return businessDateSchema.parse(
    new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
      .toISOString()
      .slice(0, 10),
  );
}

const toComponent = (row: ComponentRow): PayComponent =>
  payComponentSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    name: row.name,
    category: row.category,
    recurrence: row.recurrence,
    taxable: row.taxable,
    taxScheme: row.taxScheme,
    bpjsBase: row.bpjsBase,
    overtimeBase: row.overtimeBase,
    thrBase: row.thrBase,
    displayOrder: row.displayOrder,
    kind: row.kind,
    isSystem: row.isSystem,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });

/** Opens the sealed amount (throws on any binding mismatch: fail closed). */
const toEmployeeComponent = (row: EmployeeComponentRow): EmployeePayComponent =>
  employeePayComponentSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    employeeId: row.employeeId,
    componentId: row.componentId,
    amountIdr: openPayrollAmount(
      row.amountEncrypted,
      {
        tenantId: row.tenantId,
        table: "employee_pay_components",
        rowId: row.id,
        field: "amount",
      },
      row.piiKeyVersion,
    ),
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    createdAt: row.createdAt.toISOString(),
  });

function componentAudit(
  context: ScopedTenantContext,
  actor: UserId,
  now: Date,
  action: string,
  objectType: "pay_component" | "employee_pay_component",
  objectId: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
) {
  return {
    id: createUlid(now.getTime()),
    tenantId: context.tenant.tenantId,
    outletId: null,
    actorType: "user" as const,
    actorId: actor,
    deviceId: null,
    action,
    objectType,
    objectId,
    reason: null,
    maskedChanges: { before, after },
    ipHash: null,
    // A write by a payroll role, not a support read: no reason is required.
    sensitiveAccess: false,
    retentionClass: "audit_2y" as const,
    createdAt: now.toISOString(),
  };
}

function flagsOf(component: PayComponent) {
  return {
    category: component.category,
    kind: component.kind,
    recurrence: component.recurrence,
    taxable: component.taxable,
    taxScheme: component.taxScheme,
    bpjsBase: component.bpjsBase,
    overtimeBase: component.overtimeBase,
    thrBase: component.thrBase,
    displayOrder: component.displayOrder,
    isActive: component.isActive,
  };
}

// ---- Pay components -------------------------------------------------------

/** Components of the tenant ordered by code, then id. */
export async function listPayComponents(
  context: ScopedTenantContext,
  actorUserId: string,
  query: CursorPageQuery,
): Promise<CursorPage<PayComponent>> {
  return withTenant(db, context, async (tx) => {
    await assertPayrollTenantCan(tx, context, actorUserId, READ_CODE);
    const filters = [eq(payComponents.tenantId, context.tenant.tenantId)];
    if (query.cursor) {
      const [codeKey, idKey] = cursorPair(query.cursor);
      const id = payComponentIdSchema.safeParse(idKey);
      if (!id.success) throw invalid("Check the cursor.");
      filters.push(
        sql`(${payComponents.code}, ${payComponents.id}) > (${codeKey}, ${id.data}::uuid)`,
      );
    }
    const rows = await tx
      .select()
      .from(payComponents)
      .where(and(...filters))
      .orderBy(asc(payComponents.code), asc(payComponents.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toComponent),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.code, last.id])
            : null,
      },
    };
  });
}

export async function createPayComponent(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreatePayComponentInput,
  now: Date = new Date(),
): Promise<PayComponent> {
  const { idempotencyKey, ...body } =
    createPayComponentInputSchema.parse(input);
  return withTenant(db, context, async (tx) => {
    const actor = await assertPayrollTenantCan(
      tx,
      context,
      actorUserId,
      WRITE_CODE,
    );
    return idempotentHrisWrite(
      tx,
      context,
      idempotencyKey,
      "payroll.component.create",
      { actor, body },
      async () => {
        let row: ComponentRow | undefined;
        try {
          [row] = await tx
            .insert(payComponents)
            .values({
              tenantId: context.tenant.tenantId,
              ...body,
              kind: payComponentKindOf(body.category),
              isSystem: false,
              isActive: true,
              createdAt: now,
              updatedAt: now,
            })
            .returning();
        } catch (error) {
          if (uniqueViolation(error))
            throw new CoreError(
              "CONFLICT",
              "Kode komponen gaji sudah dipakai. Pakai kode lain.",
            );
          throw error;
        }
        if (!row) throw new Error("Pay component was not stored");
        const created = toComponent(row);
        await recordAudit(
          tx,
          context,
          componentAudit(
            context,
            actor,
            now,
            "payroll.component.created",
            "pay_component",
            created.id,
            null,
            flagsOf(created),
          ),
          AUDIT_SAFE_FIELDS,
        );
        return created;
      },
    );
  });
}

export async function updatePayComponent(
  context: ScopedTenantContext,
  actorUserId: string,
  componentId: string,
  input: UpdatePayComponentInput & { idempotencyKey: string },
  now: Date = new Date(),
): Promise<PayComponent> {
  const id = payComponentIdSchema.parse(componentId);
  const { idempotencyKey, ...rest } = input;
  const patch = updatePayComponentInputSchema.parse(rest);
  const changed = Object.keys(patch);
  if (changed.length === 0) throw invalid("Tidak ada perubahan.");
  return withTenant(db, context, async (tx) => {
    const actor = await assertPayrollTenantCan(
      tx,
      context,
      actorUserId,
      WRITE_CODE,
    );
    return idempotentHrisWrite(
      tx,
      context,
      idempotencyKey,
      "payroll.component.update",
      { actor, componentId: id, patch },
      async () => {
        const [existing] = await tx
          .select()
          .from(payComponents)
          .where(
            and(
              eq(payComponents.tenantId, context.tenant.tenantId),
              eq(payComponents.id, id),
            ),
          )
          .limit(1)
          .for("update");
        if (!existing) throw notFound(COMPONENT_NOT_FOUND);
        const before = toComponent(existing);
        // The merged object, not the patch, is what must be valid: code,
        // category, kind and isSystem come from the stored row only.
        const merged = payComponentSchema.safeParse({
          ...before,
          ...patch,
          updatedAt: now.toISOString(),
        });
        if (!merged.success)
          throw invalid(
            merged.error.issues[0]?.message ?? "Komponen gaji tidak valid.",
          );
        const next = merged.data;
        const [row] = await tx
          .update(payComponents)
          .set({
            name: next.name,
            taxable: next.taxable,
            taxScheme: next.taxScheme,
            bpjsBase: next.bpjsBase,
            overtimeBase: next.overtimeBase,
            thrBase: next.thrBase,
            displayOrder: next.displayOrder,
            isActive: next.isActive,
            updatedAt: now,
          })
          .where(
            and(
              eq(payComponents.tenantId, context.tenant.tenantId),
              eq(payComponents.id, id),
            ),
          )
          .returning();
        if (!row) throw new Error("Pay component was not updated");
        const updated = toComponent(row);
        await recordAudit(
          tx,
          context,
          componentAudit(
            context,
            actor,
            now,
            "payroll.component.updated",
            "pay_component",
            updated.id,
            { ...flagsOf(before) },
            { ...flagsOf(updated), changedFields: changed.join(",") },
          ),
          AUDIT_SAFE_FIELDS,
        );
        return updated;
      },
    );
  });
}

// ---- Employee pay components (HR-03) --------------------------------------

async function assertEmployeeInTenant(
  tx: Tx,
  context: ScopedTenantContext,
  employeeId: string,
): Promise<Pick<typeof employees.$inferSelect, "id" | "joinDate" | "endDate">> {
  const [row] = await tx
    .select({
      id: employees.id,
      joinDate: employees.joinDate,
      endDate: employees.endDate,
    })
    .from(employees)
    .where(
      and(
        eq(employees.tenantId, context.tenant.tenantId),
        eq(employees.id, employeeId),
      ),
    )
    .limit(1);
  if (!row) throw notFound();
  return row;
}

/**
 * The latest period end among the frozen (locked, paid, reversed) payroll runs
 * that cover this employee, or null when none is frozen (legend-8xf32). The
 * employee's legal entity is the one on the employee row, else the one of the
 * home outlet; when neither resolves, every legal entity of the tenant counts
 * (the rule that pays less). Runs of every type count: a frozen run never
 * changes, whatever it paid. Share locks also cover mutable runs that could
 * freeze over the new effective date before this amount transaction commits.
 */
async function latestFrozenPeriodEnd(
  tx: Tx,
  context: ScopedTenantContext,
  employeeId: string,
  effectiveFrom: BusinessDate,
): Promise<BusinessDate | null> {
  const [employee] = await tx
    .select({
      legalEntityId: employees.legalEntityId,
      outletLegalEntityId: outlets.legalEntityId,
    })
    .from(employees)
    .leftJoin(
      outlets,
      and(
        eq(outlets.tenantId, employees.tenantId),
        eq(outlets.id, employees.homeOutletId),
      ),
    )
    .where(
      and(
        eq(employees.tenantId, context.tenant.tenantId),
        eq(employees.id, employeeId),
      ),
    )
    .limit(1);
  if (!employee) throw notFound();
  const legalEntityId =
    employee.legalEntityId ?? employee.outletLegalEntityId ?? null;
  const runs = await tx
    .select({
      periodEnd: payrollRuns.periodEnd,
      status: payrollRuns.status,
    })
    .from(payrollRuns)
    .where(
      and(
        eq(payrollRuns.tenantId, context.tenant.tenantId),
        gte(payrollRuns.periodEnd, effectiveFrom),
        ...(legalEntityId
          ? [eq(payrollRuns.legalEntityId, legalEntityId)]
          : []),
      ),
    )
    .orderBy(desc(payrollRuns.periodEnd), asc(payrollRuns.id))
    .for("share");
  // A lock wait can expose updated dates after PostgreSQL has sorted the rows.
  // Recompute the maximum from the locked values instead of trusting SQL order.
  const latest = runs.reduce<string | null>((periodEnd, run) => {
    if (!FROZEN_PAYROLL_RUN_STATUSES.some((status) => status === run.status))
      return periodEnd;
    return periodEnd === null || run.periodEnd > periodEnd
      ? run.periodEnd
      : periodEnd;
  }, null);
  return latest ? businessDateSchema.parse(latest) : null;
}

/** Amount history of one employee, newest start first. */
export async function listEmployeePayComponents(
  context: ScopedTenantContext,
  actorUserId: string,
  employeeId: string,
  query: CursorPageQuery,
): Promise<CursorPage<EmployeePayComponent>> {
  return withTenant(db, context, async (tx) => {
    await assertPayrollTenantCan(tx, context, actorUserId, READ_CODE);
    await assertEmployeeInTenant(tx, context, employeeId);
    const filters = [
      eq(employeePayComponents.tenantId, context.tenant.tenantId),
      eq(employeePayComponents.employeeId, employeeId),
    ];
    if (query.cursor) {
      const [fromKey, idKey] = cursorPair(query.cursor);
      const date = businessDateSchema.safeParse(fromKey);
      const rowId = payComponentIdSchema.safeParse(idKey);
      if (!date.success || !rowId.success) throw invalid("Check the cursor.");
      filters.push(
        sql`(${employeePayComponents.effectiveFrom}, ${employeePayComponents.id}) < (${date.data}::date, ${rowId.data}::uuid)`,
      );
    }
    const rows = await tx
      .select()
      .from(employeePayComponents)
      .where(and(...filters))
      .orderBy(
        desc(employeePayComponents.effectiveFrom),
        desc(employeePayComponents.id),
      )
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toEmployeeComponent),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.effectiveFrom, last.id])
            : null,
      },
    };
  });
}

/**
 * Sets an amount from `effectiveFrom`. The open row of the same (employee,
 * component) ends the day before; the same start date is a 409 (amounts are
 * never rewritten), an earlier start than the open row's, or one that overlaps
 * a closed row, is a 422. A start on or before the period end of the latest
 * frozen payroll run is a 409 PAYROLL_RUN_FROZEN: closing the previous row
 * backwards would rewrite the amount of a month already locked or paid. The
 * explicit rapel (back-pay) flow has no contract yet, so it is refused too.
 */
export async function setEmployeePayComponent(
  context: ScopedTenantContext,
  actorUserId: string,
  employeeId: string,
  input: SetEmployeePayComponentInput,
  now: Date = new Date(),
): Promise<EmployeePayComponent> {
  const { idempotencyKey, ...body } =
    setEmployeePayComponentInputSchema.parse(input);
  return withTenant(db, context, async (tx) => {
    const actor = await assertPayrollTenantCan(
      tx,
      context,
      actorUserId,
      WRITE_CODE,
    );
    const created = await idempotentHrisWrite(
      tx,
      context,
      idempotencyKey,
      "payroll.employee_component.set",
      { actor, employeeId, body },
      async () => {
        await assertEmployeeInTenant(tx, context, employeeId);
        const [component] = await tx
          .select({
            id: payComponents.id,
            isActive: payComponents.isActive,
          })
          .from(payComponents)
          .where(
            and(
              eq(payComponents.tenantId, context.tenant.tenantId),
              eq(payComponents.id, body.componentId),
            ),
          )
          .limit(1);
        if (!component) throw notFound(COMPONENT_NOT_FOUND);
        if (!component.isActive) throw invalid("Komponen gaji tidak aktif.");

        // One writer per (employee, component) at a time.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`payroll:emp-component:${context.tenant.tenantId}:${employeeId}:${body.componentId}`}, 0))`,
        );
        const history = await tx
          .select({
            id: employeePayComponents.id,
            effectiveFrom: employeePayComponents.effectiveFrom,
            effectiveTo: employeePayComponents.effectiveTo,
          })
          .from(employeePayComponents)
          .where(
            and(
              eq(employeePayComponents.tenantId, context.tenant.tenantId),
              eq(employeePayComponents.employeeId, employeeId),
              eq(employeePayComponents.componentId, body.componentId),
            ),
          );
        if (history.some((row) => row.effectiveFrom === body.effectiveFrom))
          throw new CoreError(
            "CONFLICT",
            "Sudah ada nominal komponen ini dengan tanggal berlaku yang sama.",
          );
        const open = history.find((row) => row.effectiveTo === null);
        if (open && body.effectiveFrom < open.effectiveFrom)
          throw invalid(
            "Tanggal berlaku tidak boleh sebelum nominal yang sedang berlaku.",
          );
        // No open row: every row is closed; a new start inside or before one
        // would overlap it.
        if (
          !open &&
          history.some(
            (row) =>
              row.effectiveTo !== null && body.effectiveFrom <= row.effectiveTo,
          )
        )
          throw invalid("Tanggal berlaku bertumpuk dengan nominal sebelumnya.");

        const frozenUntil = await latestFrozenPeriodEnd(
          tx,
          context,
          employeeId,
          body.effectiveFrom,
        );
        if (frozenUntil && body.effectiveFrom <= frozenUntil)
          throw new PayrollError(
            "PAYROLL_RUN_FROZEN",
            "Tanggal berlaku jatuh di periode payroll yang sudah dikunci. Pakai tanggal setelah periode itu.",
          );

        const closeUntil = open ? addDays(body.effectiveFrom, -1) : null;
        if (open && closeUntil)
          await tx
            .update(employeePayComponents)
            .set({ effectiveTo: closeUntil })
            .where(
              and(
                eq(employeePayComponents.tenantId, context.tenant.tenantId),
                eq(employeePayComponents.id, open.id),
              ),
            );

        // The id comes first: the seal binds to it.
        const rowId = randomUUID() as EmployeeComponentRow["id"];
        try {
          await tx.insert(employeePayComponents).values({
            id: rowId,
            tenantId: context.tenant.tenantId,
            employeeId,
            componentId: body.componentId,
            amountEncrypted: sealPayrollAmount(body.amountIdr, {
              tenantId: context.tenant.tenantId,
              table: "employee_pay_components",
              rowId,
              field: "amount",
            }),
            piiKeyVersion: PAYROLL_SEAL_KEY_VERSION,
            effectiveFrom: body.effectiveFrom,
            effectiveTo: null,
            createdBy: actor,
            createdAt: now,
          });
        } catch (error) {
          // Lost a race for the same start date or the open slot.
          if (uniqueViolation(error))
            throw new CoreError(
              "CONFLICT",
              "Nominal komponen baru saja diubah. Muat ulang lalu coba lagi.",
            );
          throw error;
        }
        await recordAudit(
          tx,
          context,
          componentAudit(
            context,
            actor,
            now,
            "payroll.employee_component.set",
            "employee_pay_component",
            rowId,
            null,
            {
              employeeId,
              componentId: body.componentId,
              effectiveFrom: body.effectiveFrom,
              ...(closeUntil ? { closedPreviousUntil: closeUntil } : {}),
            },
          ),
          AUDIT_SAFE_FIELDS,
        );
        // HR-03: the idempotency record keeps the id, never the amount.
        return { id: rowId };
      },
    );
    const [row] = await tx
      .select()
      .from(employeePayComponents)
      .where(
        and(
          eq(employeePayComponents.tenantId, context.tenant.tenantId),
          eq(
            employeePayComponents.id,
            created.id as EmployeeComponentRow["id"],
          ),
        ),
      )
      .limit(1);
    if (!row) throw new Error("Employee pay component was not stored");
    return toEmployeeComponent(row);
  });
}

// ---- Gross engine (bead legend-8di9d) -------------------------------------

export type EmployeeGrossInput = {
  employeeId: string;
  periodStart: BusinessDate;
  periodEnd: BusinessDate;
  /** Payslip row id the sealed calculation binds to. */
  payslipId: string;
  overtimeParameters: OvertimeParameters;
};

export type EmployeeGross = {
  grossIdr: Idr;
  deductionsIdr: Idr;
  netIdr: Idr;
  overtimeIdr: Idr;
  /** Approved overtime minutes inside the period (one value per day). */
  overtimeMinutes: number;
  lines: PayslipLine[];
  /** `payslips.calculation`: bound to tenant, table, row and field. */
  sealed: { calculation: Buffer; keyVersion: number };
};

const OVERTIME_CODE = "LEMBUR";

/** Whole hours as Decimal4, rounded down: a fraction is never paid. */
const hoursOf = (minutes: number) =>
  formatDecimal4((BigInt(minutes) * 10_000n) / 60n);

/**
 * Gross, deductions, net and overtime of one employee for a period, from the
 * pay components in effect during the period and approved overtime requests,
 * bounded by the period's attendance (PRD §3 D.29/D.30). Nothing is written: the caller
 * stores `sealed.calculation` on the payslip row.
 *
 * Money guards (never pay more): an amount is never negative and a zero amount
 * has no line; a component appears once, prorated by calendar day over the
 * rows that overlap the period (floor, never above the full amount);
 * deductions are cut, later display order first, so net is never below zero;
 * overtime requires an approved request and `out` logs that are valid, or
 * flagged and then accepted, capped by the largest attendance value and 720
 * minutes per day, on the overtime base of the employee's own earnings only.
 */
export async function computeEmployeeGross(
  context: ScopedTenantContext,
  actorUserId: string,
  input: EmployeeGrossInput,
): Promise<EmployeeGross> {
  const start = businessDateSchema.safeParse(input.periodStart);
  const end = businessDateSchema.safeParse(input.periodEnd);
  if (!start.success || !end.success) throw invalid("Periode tidak valid.");
  if (end.data < start.data)
    throw invalid("Akhir periode tidak boleh sebelum awal periode.");
  const parameters = overtimeParametersSchema.safeParse(
    input.overtimeParameters,
  );
  if (!parameters.success) throw invalid("Aturan lembur tidak valid.");
  const { employeeId, payslipId } = input;
  const periodStart = start.data;
  const periodEnd = end.data;
  return withTenant(db, context, async (tx) => {
    // The employee comes first: another tenant's employee is a plain 404.
    const employee = await assertEmployeeInTenant(tx, context, employeeId);
    await assertPayrollTenantCan(tx, context, actorUserId, WRITE_CODE);
    const employmentStart =
      employee.joinDate > periodStart ? employee.joinDate : periodStart;
    const employmentEnd =
      employee.endDate && employee.endDate < periodEnd
        ? employee.endDate
        : periodEnd;

    const rows = await tx
      .select({ amount: employeePayComponents, component: payComponents })
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
          eq(payComponents.isActive, true),
          // Every row that overlaps [periodStart, periodEnd] (inclusive dates).
          lte(employeePayComponents.effectiveFrom, periodEnd),
          or(
            isNull(employeePayComponents.effectiveTo),
            gte(employeePayComponents.effectiveTo, periodStart),
          ),
        ),
      );

    // Proration by calendar day: one amount per component, the sum over its
    // overlapping employment days of floor(amount * activeDays / periodDays)
    // in BigInt; the divisor remains the full payroll period.
    // Employment and a row covering the whole period pay the full amount; rows of one
    // component never overlap (setEmployeePayComponent closes the open row),
    // so the sum is never above the largest amount. Zero rows add nothing.
    const dayNumber = (date: string) =>
      Math.floor(Date.parse(date) / 86_400_000);
    const periodDays = BigInt(
      dayNumber(periodEnd) - dayNumber(periodStart) + 1,
    );
    const byComponent = new Map<
      string,
      {
        component: (typeof rows)[number]["component"];
        amountIdr: number;
        /**
         * Overtime base of this component: the LOWEST positive nominal among
         * its rows overlapping the period, not prorated. Pay-limiting choice
         * (when in doubt, cap what is paid): a mid-period raise never lifts
         * the overtime rate for the whole period. Summed over the employee's
         * overtimeBase earning components; a component with no positive row
         * adds nothing.
         */
        baseIdr: number;
      }
    >();
    for (const { amount, component } of rows) {
      const nominal = toEmployeeComponent(amount).amountIdr;
      if (nominal <= 0) continue;
      const activeDays = BigInt(
        dayNumber(
          amount.effectiveTo && amount.effectiveTo < employmentEnd
            ? amount.effectiveTo
            : employmentEnd,
        ) -
          dayNumber(
            amount.effectiveFrom > employmentStart
              ? amount.effectiveFrom
              : employmentStart,
          ) +
          1,
      );
      if (activeDays <= 0n) continue;
      const share = Number((BigInt(nominal) * activeDays) / periodDays);
      const entry = byComponent.get(component.id);
      if (entry) {
        entry.amountIdr += share;
        entry.baseIdr = Math.min(entry.baseIdr, nominal);
      } else {
        byComponent.set(component.id, {
          component,
          amountIdr: share,
          baseIdr: nominal,
        });
      }
    }
    const amounts = [...byComponent.values()]
      .filter(({ amountIdr }) => amountIdr > 0)
      .sort(
        (a, b) =>
          a.component.displayOrder - b.component.displayOrder ||
          a.component.code.localeCompare(b.component.code),
      );

    const lineOf = (
      { component }: (typeof amounts)[number],
      amount: Idr,
    ): PayslipLine =>
      payslipLineSchema.parse({
        componentCode: component.code,
        name: component.name,
        category: component.category,
        kind: component.kind,
        amountIdr: amount,
        taxable: component.taxable,
        quantity: null,
        sourceId: null,
      });

    const earningLines = amounts
      .filter(({ component }) => component.kind === "earning")
      .map((entry) => lineOf(entry, idr(entry.amountIdr)));
    const overtimeBase = idr(
      amounts
        .filter(
          ({ component }) =>
            component.kind === "earning" && component.overtimeBase,
        )
        .reduce((sum, { baseIdr }) => sum + baseIdr, 0),
    );

    // Attendance limits the approved requests; it never authorizes overtime.
    const logs = await tx
      .select({
        businessDate: attendanceLogs.businessDate,
        minutes: sql<number>`max(${attendanceLogs.overtimeMinutes})::int`,
      })
      .from(attendanceLogs)
      .where(
        and(
          eq(attendanceLogs.tenantId, context.tenant.tenantId),
          eq(attendanceLogs.employeeId, employeeId),
          eq(attendanceLogs.type, "out"),
          gte(attendanceLogs.businessDate, employmentStart),
          lte(attendanceLogs.businessDate, employmentEnd),
          sql`${attendanceLogs.overtimeMinutes} > 0`,
          or(
            and(
              eq(attendanceLogs.validity, "valid"),
              inArray(attendanceLogs.reviewStatus, ["none", "accepted"]),
            ),
            and(
              eq(attendanceLogs.validity, "flagged"),
              eq(attendanceLogs.reviewStatus, "accepted"),
            ),
          ),
        ),
      )
      .groupBy(attendanceLogs.businessDate);
    const requests = await tx
      .select({
        date: overtimeRequests.date,
        minutes: overtimeRequests.minutes,
        dayType: overtimeRequests.dayType,
      })
      .from(overtimeRequests)
      .where(
        and(
          eq(overtimeRequests.tenantId, context.tenant.tenantId),
          eq(overtimeRequests.employeeId, employeeId),
          eq(overtimeRequests.status, "approved"),
          gte(overtimeRequests.date, employmentStart),
          lte(overtimeRequests.date, employmentEnd),
          gte(overtimeRequests.minutes, 1),
          lte(overtimeRequests.minutes, 720),
          inArray(overtimeRequests.dayType, [...OVERTIME_DAY_TYPES]),
        ),
      );
    const requestsByDay = new Map<string, Map<OvertimeDayType, number>>();
    for (const request of requests) {
      const day =
        requestsByDay.get(request.date) ?? new Map<OvertimeDayType, number>();
      day.set(
        request.dayType,
        (day.get(request.dayType) ?? 0) + request.minutes,
      );
      requestsByDay.set(request.date, day);
    }
    const payableOvertime: { minutes: number; dayType: OvertimeDayType }[] = [];
    for (const log of logs) {
      const day = requestsByDay.get(log.businessDate);
      if (!day) continue;
      let remaining = Math.min(log.minutes, 720);
      // Conflicting day types consume one shared cap, cheaper tariff first.
      const groups = [...day].sort(
        ([left], [right]) =>
          computeOvertimePay(
            parameters.data,
            left,
            hoursOf(remaining),
            overtimeBase,
          ) -
            computeOvertimePay(
              parameters.data,
              right,
              hoursOf(remaining),
              overtimeBase,
            ) || left.localeCompare(right),
      );
      for (const [dayType, approvedMinutes] of groups) {
        const minutes = Math.min(approvedMinutes, remaining);
        if (minutes <= 0) continue;
        payableOvertime.push({ minutes, dayType });
        remaining -= minutes;
      }
    }
    const overtimeMinutes = payableOvertime.reduce(
      (sum, entry) => sum + entry.minutes,
      0,
    );
    // No overtime base, no overtime pay: the minutes stay reported, unpaid.
    let overtimeIdr = idr(0);
    if (overtimeBase > 0)
      for (const entry of payableOvertime)
        overtimeIdr = idr(
          overtimeIdr +
            computeOvertimePay(
              parameters.data,
              entry.dayType,
              hoursOf(entry.minutes),
              overtimeBase,
            ),
        );
    if (overtimeIdr > 0)
      earningLines.push(
        payslipLineSchema.parse({
          componentCode: OVERTIME_CODE,
          name: "Lembur",
          category: "overtime",
          kind: "earning",
          amountIdr: overtimeIdr,
          taxable: true,
          quantity: hoursOf(overtimeMinutes),
          sourceId: null,
        }),
      );
    const grossIdr = idr(
      earningLines.reduce((sum, line) => sum + line.amountIdr, 0),
    );

    // Deductions never take net below zero: later display order is cut first.
    let room = grossIdr as number;
    const deductionLines: PayslipLine[] = [];
    for (const entry of amounts.filter(
      ({ component }) => component.kind === "deduction",
    )) {
      const taken = Math.min(entry.amountIdr, room);
      if (taken <= 0) continue;
      room -= taken;
      deductionLines.push(lineOf(entry, idr(taken)));
    }
    const deductionsIdr = idr(
      deductionLines.reduce((sum, line) => sum + line.amountIdr, 0),
    );
    const netIdr = idr(grossIdr - deductionsIdr);
    const lines = [...earningLines, ...deductionLines];

    const calculation = sealPayrollValue(
      JSON.stringify({ grossIdr, deductionsIdr, netIdr, overtimeIdr, lines }),
      {
        tenantId: context.tenant.tenantId,
        table: "payslips",
        rowId: payslipId,
        field: "calculation",
      },
    );
    return {
      grossIdr,
      deductionsIdr,
      netIdr,
      overtimeIdr,
      overtimeMinutes,
      lines,
      sealed: { calculation, keyVersion: PAYROLL_SEAL_KEY_VERSION },
    };
  });
}
