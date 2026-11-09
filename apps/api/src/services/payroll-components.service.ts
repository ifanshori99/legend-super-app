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
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { PermissionCode } from "@starter/shared/access";
import {
  businessDateSchema,
  createUlid,
  encodeCursor,
  type BusinessDate,
  type CursorPage,
  type CursorPageQuery,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import {
  createPayComponentInputSchema,
  employeePayComponentSchema,
  payComponentIdSchema,
  payComponentKindOf,
  payComponentSchema,
  setEmployeePayComponentInputSchema,
  updatePayComponentInputSchema,
  type CreatePayComponentInput,
  type EmployeePayComponent,
  type PayComponent,
  type SetEmployeePayComponentInput,
  type UpdatePayComponentInput,
} from "@starter/shared/hris/payroll";
import { CoreError } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { employees } from "../db/schema/hris.ts";
import { employeePayComponents, payComponents } from "../db/schema/payroll.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  openPayrollAmount,
  PAYROLL_SEAL_KEY_VERSION,
  sealPayrollAmount,
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
): Promise<void> {
  const [row] = await tx
    .select({ id: employees.id })
    .from(employees)
    .where(
      and(
        eq(employees.tenantId, context.tenant.tenantId),
        eq(employees.id, employeeId),
      ),
    )
    .limit(1);
  if (!row) throw notFound();
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
 * a closed row, is a 422.
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
