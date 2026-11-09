// Reimbursement categories and claims (bead legend-gfcr, PRD v1.7 §3 D.31;
// contract `@starter/shared/hris/payroll` reimbursements.ts + endpoints.ts).
// Routes: routes/payroll-reimbursements.routes.ts.
//
// Categories carry the limits per position (JSONB, re-parsed on every read).
// A claim moves submitted -> approved | rejected, approved -> paid (cash
// only here: a payroll payout is paid by the run lock, never by this service).
// The decider is never the claimant (PAYROLL_APPROVER_NOT_DISTINCT). Audit
// rows carry field names and status only, never amounts, names or free text.

import {
  and,
  asc,
  desc,
  eq,
  inArray,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { PermissionCode } from "@starter/shared/access";
import {
  businessDateOf,
  CoreError,
  createUlid,
  DEFAULT_BUSINESS_DAY_CLOCK,
  encodeCursor,
  idr,
  type CursorPage,
  type ScopedTenantContext,
  type UserId,
  type z,
} from "@starter/shared/core";
import { positionIdSchema } from "@starter/shared/hris";
import {
  PayrollError,
  assertReimbursementWithinLimit,
  createReimbursementCategoryInputSchema,
  createReimbursementInputSchema,
  decideReimbursement as decideReimbursementEndpoint,
  listMyReimbursements as listMyReimbursementsEndpoint,
  listReimbursementCategories as listCategoriesEndpoint,
  listReimbursements as listReimbursementsEndpoint,
  reimbursementCategoryIdSchema,
  reimbursementCategorySchema,
  reimbursementIdSchema,
  reimbursementLimitFor,
  reimbursementSchema,
  reimbursementStatusSchema,
  transitionReimbursement,
  type Reimbursement,
  type ReimbursementAction,
  type ReimbursementCategory,
  type ReimbursementId,
} from "@starter/shared/hris/payroll";
import { db } from "../db/index.ts";
import { employees, positions } from "../db/schema/hris.ts";
import {
  reimbursementCategories,
  reimbursements,
} from "../db/schema/payroll.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import {
  auditOutletFor,
  cursorPair,
  forbidden,
  notFound,
  uniqueViolation,
} from "./hris-access.ts";
import { idempotentHrisWrite } from "./hris-employee.service.ts";
import { assertPayrollTenantCan, loadPayrollSelf } from "./payroll-access.ts";
import type { Tx } from "./permission-resolver.ts";

const VIEW_CODE: PermissionCode = "payroll.view";
const RUN_CODE: PermissionCode = "payroll.run";
const APPROVE_CODE: PermissionCode = "hr.reimbursement.approve";
const SELF_CODE: PermissionCode = "self.reimbursement.request";

/** Field names and enum values only. */
const AUDIT_SAFE_FIELDS = ["fields", "status"] as const;

type CategoryRow = typeof reimbursementCategories.$inferSelect;
type ClaimRow = typeof reimbursements.$inferSelect;
type CategoryInput = z.input<typeof createReimbursementCategoryInputSchema>;
type ClaimInput = z.input<typeof createReimbursementInputSchema>;
type DecisionInput = z.input<typeof decideReimbursementEndpoint.body>;
type Page<T> = CursorPage<T>;

const unprocessable = (message: string) =>
  new HttpError(422, "VALIDATION_ERROR", message);

const toCategory = (row: CategoryRow): ReimbursementCategory =>
  reimbursementCategorySchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    receiptRequired: row.receiptRequired,
    // Parsed again with the contract: a row edited outside the service fails
    // loudly instead of silently changing a limit.
    limits: row.limits,
    isActive: row.isActive,
  });

const toClaim = (row: ClaimRow): Reimbursement =>
  reimbursementSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    employeeId: row.employeeId,
    categoryId: row.categoryId,
    expenseDate: row.expenseDate,
    amountIdr: row.amountIdr,
    approvedAmountIdr: row.approvedAmountIdr,
    description: row.description,
    // TODO legend-8399r: sign `receiptUploadRef` (private bucket, short-lived
    // URL) once the payroll router receives a storage signer. Until then the
    // reference is never exposed and the URL is null.
    receiptUrl: null,
    payout: row.payout,
    status: row.status,
    payrollRunId: row.payrollRunId,
    submittedAt: row.submittedAt.toISOString(),
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    paidAt: row.paidAt?.toISOString() ?? null,
  });

async function audit(
  tx: Tx,
  context: ScopedTenantContext,
  now: Date,
  entry: {
    actor: UserId;
    outletId: string | null;
    action: string;
    objectType: string;
    objectId: string;
    after: Record<string, unknown>;
  },
) {
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: entry.outletId,
      actorType: "user",
      actorId: entry.actor,
      deviceId: null,
      action: entry.action,
      objectType: entry.objectType,
      objectId: entry.objectId,
      reason: null,
      maskedChanges: { before: null, after: entry.after },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    },
    AUDIT_SAFE_FIELDS,
  );
}

/** Either right is enough (the category list is read by payroll and approvers). */
async function assertAnyCan(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  codes: readonly PermissionCode[],
): Promise<UserId> {
  let denied: unknown = forbidden();
  for (const code of codes) {
    try {
      return await assertPayrollTenantCan(tx, context, actorUserId, code);
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 403) throw error;
      denied = error;
    }
  }
  throw denied;
}

// ---- Categories -----------------------------------------------------------

export async function listReimbursementCategories(
  context: ScopedTenantContext,
  actorUserId: string,
  query: z.output<typeof listCategoriesEndpoint.query>,
): Promise<Page<ReimbursementCategory>> {
  return withTenant(db, context, async (tx) => {
    await assertAnyCan(tx, context, actorUserId, [VIEW_CODE, APPROVE_CODE]);
    const filters: SQL[] = [
      eq(reimbursementCategories.tenantId, context.tenant.tenantId),
    ];
    if (query.cursor) {
      const [name, id] = cursorPair(query.cursor);
      const afterId = reimbursementCategoryIdSchema.parse(id);
      filters.push(
        or(
          sql`${reimbursementCategories.name} > ${name}`,
          and(
            eq(reimbursementCategories.name, name),
            sql`${reimbursementCategories.id} > ${afterId}`,
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(reimbursementCategories)
      .where(and(...filters))
      .orderBy(
        asc(reimbursementCategories.name),
        asc(reimbursementCategories.id),
      )
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toCategory),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.name, last.id])
            : null,
      },
    };
  });
}

export async function createReimbursementCategory(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CategoryInput,
  now: Date = new Date(),
): Promise<ReimbursementCategory> {
  const { idempotencyKey, ...body } =
    createReimbursementCategoryInputSchema.parse(input);
  return withTenant(db, context, async (tx) => {
    const actor = await assertPayrollTenantCan(
      tx,
      context,
      actorUserId,
      RUN_CODE,
    );
    return idempotentHrisWrite(
      tx,
      context,
      idempotencyKey,
      "payroll.reimbursement_category.create",
      { actor, body },
      async () => {
        const positionIds = [
          ...new Set(
            body.limits.flatMap((limit) =>
              limit.positionId === null ? [] : [limit.positionId],
            ),
          ),
        ];
        if (positionIds.length > 0) {
          const found = await tx
            .select({ id: positions.id })
            .from(positions)
            .where(
              and(
                eq(positions.tenantId, context.tenant.tenantId),
                inArray(positions.id, positionIds),
              ),
            );
          if (found.length !== positionIds.length)
            throw unprocessable("Jabatan pada batas tidak ditemukan.");
        }
        let row: CategoryRow | undefined;
        try {
          [row] = await tx
            .insert(reimbursementCategories)
            .values({
              tenantId: context.tenant.tenantId,
              name: body.name,
              receiptRequired: body.receiptRequired,
              limits: body.limits,
              isActive: true,
            })
            .returning();
        } catch (error) {
          if (uniqueViolation(error))
            throw new CoreError(
              "CONFLICT",
              "Nama kategori reimbursement sudah dipakai.",
            );
          throw error;
        }
        if (!row) throw new Error("Reimbursement category was not stored");
        const created = toCategory(row);
        await audit(tx, context, now, {
          actor,
          outletId: null,
          action: "payroll.reimbursement_category.created",
          objectType: "reimbursement_category",
          objectId: created.id,
          after: { fields: ["name", "receiptRequired", "limits"] },
        });
        return created;
      },
    );
  });
}

// ---- Claims: reads --------------------------------------------------------

async function listClaims(
  tx: Tx,
  context: ScopedTenantContext,
  query: { limit: number; cursor?: string | undefined },
  extra: SQL[],
): Promise<Page<Reimbursement>> {
  const filters: SQL[] = [
    eq(reimbursements.tenantId, context.tenant.tenantId),
    ...extra,
  ];
  if (query.cursor) {
    const [expenseDate, id] = cursorPair(query.cursor);
    const beforeId = reimbursementIdSchema.parse(id);
    filters.push(
      or(
        lt(reimbursements.expenseDate, expenseDate),
        and(
          eq(reimbursements.expenseDate, expenseDate),
          lt(reimbursements.id, beforeId),
        ),
      )!,
    );
  }
  const rows = await tx
    .select()
    .from(reimbursements)
    .where(and(...filters))
    .orderBy(desc(reimbursements.expenseDate), desc(reimbursements.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    data: page.map(toClaim),
    meta: {
      limit: query.limit,
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor([last.expenseDate, last.id])
          : null,
    },
  };
}

export async function listReimbursements(
  context: ScopedTenantContext,
  actorUserId: string,
  query: z.output<typeof listReimbursementsEndpoint.query>,
): Promise<Page<Reimbursement>> {
  return withTenant(db, context, async (tx) => {
    await assertPayrollTenantCan(tx, context, actorUserId, APPROVE_CODE);
    const extra: SQL[] = [];
    if (query.status) extra.push(eq(reimbursements.status, query.status));
    if (query.employeeId)
      extra.push(eq(reimbursements.employeeId, query.employeeId));
    return listClaims(tx, context, query, extra);
  });
}

/** HR-01: own claims only; the employee comes from the session. */
export async function listMyReimbursements(
  context: ScopedTenantContext,
  actorUserId: string,
  query: z.output<typeof listMyReimbursementsEndpoint.query>,
): Promise<Page<Reimbursement>> {
  return withTenant(db, context, async (tx) => {
    const self = await loadPayrollSelf(tx, context, actorUserId, SELF_CODE);
    return listClaims(tx, context, query, [
      eq(reimbursements.employeeId, self.employeeId),
    ]);
  });
}

// ---- Claims: writes -------------------------------------------------------

export async function createMyReimbursement(
  context: ScopedTenantContext,
  actorUserId: string,
  input: ClaimInput,
  now: Date = new Date(),
): Promise<Reimbursement> {
  const { idempotencyKey, ...body } =
    createReimbursementInputSchema.parse(input);
  return withTenant(db, context, async (tx) => {
    const self = await loadPayrollSelf(tx, context, actorUserId, SELF_CODE);
    return idempotentHrisWrite(
      tx,
      context,
      idempotencyKey,
      "payroll.reimbursement.create",
      { actor: self.actor, employeeId: self.employeeId, body },
      async () => {
        // The server clock decides "future", never the client.
        if (body.expenseDate > businessDateOf(now, DEFAULT_BUSINESS_DAY_CLOCK))
          throw unprocessable("Tanggal pengeluaran tidak boleh di masa depan.");
        const [category] = await tx
          .select()
          .from(reimbursementCategories)
          .where(
            and(
              eq(reimbursementCategories.tenantId, context.tenant.tenantId),
              eq(reimbursementCategories.id, body.categoryId),
            ),
          )
          .limit(1);
        if (!category) throw notFound("Kategori reimbursement");
        if (!category.isActive)
          throw unprocessable("Kategori reimbursement sudah tidak aktif.");
        if (category.receiptRequired && body.receiptUploadRef === null)
          throw unprocessable("Kategori ini wajib melampirkan foto bukti.");

        const [employee] = await tx
          .select({
            positionId: employees.positionId,
            homeOutletId: employees.homeOutletId,
          })
          .from(employees)
          .where(
            and(
              eq(employees.tenantId, context.tenant.tenantId),
              eq(employees.id, self.employeeId),
            ),
          )
          .limit(1);
        if (!employee) throw notFound();
        // Per-claim limit of the employee's position (or the default row).
        // TODO legend-8399r: the per-month cap needs the approved+paid sum of
        // the month; 0 is passed until then, so only one claim above the
        // monthly cap is refused.
        assertReimbursementWithinLimit(
          reimbursementLimitFor(
            toCategory(category),
            positionIdSchema.nullable().parse(employee.positionId),
          ),
          body.amountIdr,
          idr(0),
        );

        const [row] = await tx
          .insert(reimbursements)
          .values({
            tenantId: context.tenant.tenantId,
            employeeId: self.employeeId,
            categoryId: body.categoryId,
            expenseDate: body.expenseDate,
            amountIdr: body.amountIdr,
            description: body.description,
            receiptUploadRef: body.receiptUploadRef,
            payout: body.payout,
            status: "submitted",
            submittedAt: now,
          })
          .returning();
        if (!row) throw new Error("Reimbursement was not stored");
        await audit(tx, context, now, {
          actor: self.actor,
          outletId: auditOutletFor(context, employee.homeOutletId),
          action: "payroll.reimbursement.submitted",
          objectType: "reimbursement",
          objectId: row.id,
          after: { status: "submitted" },
        });
        return toClaim(row);
      },
    );
  });
}

async function lockClaim(
  tx: Tx,
  context: ScopedTenantContext,
  reimbursementId: ReimbursementId,
): Promise<ClaimRow> {
  // FOR UPDATE: two deciders cannot both pass the status check.
  const [row] = await tx
    .select()
    .from(reimbursements)
    .where(
      and(
        eq(reimbursements.tenantId, context.tenant.tenantId),
        eq(reimbursements.id, reimbursementId),
      ),
    )
    .limit(1)
    .for("update");
  if (!row) throw notFound("Klaim reimbursement");
  return row;
}

async function moveClaim(
  tx: Tx,
  context: ScopedTenantContext,
  actor: UserId,
  now: Date,
  row: ClaimRow,
  action: ReimbursementAction,
  values: Partial<typeof reimbursements.$inferInsert>,
): Promise<Reimbursement> {
  const status = transitionReimbursement(
    reimbursementStatusSchema.parse(row.status),
    action,
  );
  const [updated] = await tx
    .update(reimbursements)
    .set({ ...values, status, updatedAt: now })
    .where(
      and(
        eq(reimbursements.tenantId, context.tenant.tenantId),
        eq(reimbursements.id, row.id),
      ),
    )
    .returning();
  if (!updated) throw new Error("Reimbursement was not updated");
  await audit(tx, context, now, {
    actor,
    outletId: null,
    action: `payroll.reimbursement.${status}`,
    objectType: "reimbursement",
    objectId: row.id,
    after: { status },
  });
  return toClaim(updated);
}

export async function decideReimbursement(
  context: ScopedTenantContext,
  actorUserId: string,
  reimbursementId: ReimbursementId,
  input: DecisionInput,
  now: Date = new Date(),
): Promise<Reimbursement> {
  const { idempotencyKey, ...body } =
    decideReimbursementEndpoint.body.parse(input);
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
      idempotencyKey,
      "payroll.reimbursement.decide",
      { actor, reimbursementId, body },
      async () => {
        const row = await lockClaim(tx, context, reimbursementId);
        // Separation of duties: nobody decides their own claim.
        const [own] = await tx
          .select({ id: employees.id })
          .from(employees)
          .where(
            and(
              eq(employees.tenantId, context.tenant.tenantId),
              eq(employees.userId, actor),
            ),
          )
          .limit(1);
        if (own && own.id === row.employeeId)
          throw new PayrollError("PAYROLL_APPROVER_NOT_DISTINCT");
        if (body.action === "reject") {
          if (body.approvedAmountIdr !== null)
            throw unprocessable(
              "Klaim yang ditolak tidak punya jumlah disetujui.",
            );
          return moveClaim(tx, context, actor, now, row, "reject", {
            decidedBy: actor,
            decidedAt: now,
          });
        }
        // null = the full claimed amount; the approver may lower, never raise.
        const approved = body.approvedAmountIdr ?? row.amountIdr;
        if (approved > row.amountIdr)
          throw unprocessable(
            "Jumlah disetujui tidak boleh melebihi jumlah klaim.",
          );
        return moveClaim(tx, context, actor, now, row, "approve", {
          approvedAmountIdr: approved,
          decidedBy: actor,
          decidedAt: now,
        });
      },
    );
  });
}

export async function payReimbursementCash(
  context: ScopedTenantContext,
  actorUserId: string,
  reimbursementId: ReimbursementId,
  idempotencyKey: string,
  now: Date = new Date(),
): Promise<Reimbursement> {
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
      idempotencyKey,
      "payroll.reimbursement.pay_cash",
      { actor, reimbursementId },
      async () => {
        const row = await lockClaim(tx, context, reimbursementId);
        // A payroll payout is paid by the run lock, never by hand.
        if (row.payout !== "cash")
          throw new PayrollError("PAYROLL_INVALID_TRANSITION");
        return moveClaim(tx, context, actor, now, row, "pay", { paidAt: now });
      },
    );
  });
}
