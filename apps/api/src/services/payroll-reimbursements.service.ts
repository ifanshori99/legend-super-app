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
  gte,
  inArray,
  isNotNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { PermissionCode } from "@starter/shared/access";
import {
  businessDateOf,
  businessDateSchema,
  CoreError,
  createUlid,
  DEFAULT_BUSINESS_DAY_CLOCK,
  encodeCursor,
  idr,
  type BusinessDate,
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
  REIMBURSEMENT_BACKDATE_DAYS,
  reimbursementIdSchema,
  reimbursementLimitFor,
  reimbursementPaid,
  reimbursementSchema,
  reimbursementStatusSchema,
  transitionReimbursement,
  type Reimbursement,
  type ReimbursementAction,
  type ReimbursementCategory,
  type ReimbursementId,
} from "@starter/shared/hris/payroll";
import { db } from "../db/index.ts";
import { coreStorageObjects } from "../db/schema/core-storage.ts";
import { employeeDocuments, employees, positions } from "../db/schema/hris.ts";
import { leaveRequests } from "../db/schema/hris-leave.ts";
import {
  reimbursementCategories,
  reimbursements,
} from "../db/schema/payroll.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { entityLock } from "./accounting-bank-matching.ts";
import { assertCash1102CoversOutflow } from "./accounting-petty-cash.service.ts";
import { emitPayrollEvent } from "./payroll-events.ts";
import { accountingEnabledShared } from "./payroll-payout-setup.ts";
import { recordAudit } from "./core-audit.ts";
import {
  auditOutletFor,
  cursorPair,
  forbidden,
  notFound,
  uniqueViolation,
} from "./hris-access.ts";
import { idempotentHrisWrite } from "./hris-employee.service.ts";
import {
  noHrisFileSigner,
  type HrisFileSigner,
} from "./hris-contract.service.ts";
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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A receipt must be uploaded shortly before the claim that uses it. */
const RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Serialises writers that share `key` for the rest of the transaction. */
async function lockKey(tx: Tx, key: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
  );
}

/** `date` minus `days` calendar days (UTC arithmetic on a business date). */
function daysBefore(date: BusinessDate, days: number): BusinessDate {
  const moment = new Date(`${date}T00:00:00Z`);
  moment.setUTCDate(moment.getUTCDate() - days);
  return businessDateSchema.parse(moment.toISOString().slice(0, 10));
}

/** First day of the expense month and of the next one. */
function monthBounds(expenseDate: BusinessDate): [BusinessDate, BusinessDate] {
  const [year, month] = expenseDate.split("-").map(Number) as [number, number];
  const pad = (n: number) => String(n).padStart(2, "0");
  const next = month === 12 ? [year + 1, 1] : [year, month + 1];
  return [
    businessDateSchema.parse(`${year}-${pad(month)}-01`),
    businessDateSchema.parse(`${next[0]}-${pad(next[1]!)}-01`),
  ];
}

/**
 * One lock per employee, category and month: two claims (or a claim and an
 * approval) of the same month cannot both read the usage before either one
 * is stored.
 */
const capLockKey = (
  context: ScopedTenantContext,
  employeeId: string,
  categoryId: string,
  expenseDate: BusinessDate,
) =>
  `payroll:reimbursement-cap:${context.tenant.tenantId}:${employeeId}:${categoryId}:${expenseDate.slice(0, 7)}`;

/**
 * Month usage of one employee in one category: claimed amount of submitted
 * claims (reserved until decided) plus approved amount of approved and paid
 * ones. Rejected and cancelled claims free their amount.
 */
async function monthUsageIdr(
  tx: Tx,
  context: ScopedTenantContext,
  employeeId: string,
  categoryId: string,
  expenseDate: BusinessDate,
  statuses: readonly string[],
) {
  const [from, to] = monthBounds(expenseDate);
  const [row] = await tx
    .select({
      total: sql<string>`COALESCE(SUM(CASE WHEN ${reimbursements.status} = 'submitted' THEN ${reimbursements.amountIdr} ELSE ${reimbursements.approvedAmountIdr} END), 0)`,
    })
    .from(reimbursements)
    .where(
      and(
        eq(reimbursements.tenantId, context.tenant.tenantId),
        eq(reimbursements.employeeId, employeeId),
        eq(reimbursements.categoryId, categoryId as ClaimRow["categoryId"]),
        gte(reimbursements.expenseDate, from),
        lt(reimbursements.expenseDate, to),
        inArray(reimbursements.status, [...statuses]),
      ),
    );
  return idr(Number(row?.total ?? 0));
}

/**
 * The receipt must be a fresh private `receipt` object of this tenant at the
 * claimant's home outlet that nothing else references. `core_storage_objects`
 * records no uploader, so tenant, outlet, freshness and single use are what
 * stop attaching another tenant's (or another claim's) private file to read it
 * back through the signed URL.
 */
async function assertReceiptUsable(
  tx: Tx,
  context: ScopedTenantContext,
  homeOutletId: string,
  uploadRef: string,
  now: Date,
): Promise<string> {
  const invalid = () =>
    unprocessable("Foto bukti tidak ditemukan atau tidak valid.");
  if (!UUID_PATTERN.test(uploadRef)) throw invalid();
  const ref = uploadRef.toLowerCase();
  const tenantId = context.tenant.tenantId;
  // Two claims racing for the same upload: the second one sees the first.
  await lockKey(tx, `payroll:reimbursement-receipt:${tenantId}:${ref}`);
  const [object] = await tx
    .select({
      outletId: coreStorageObjects.outletId,
      purpose: coreStorageObjects.purpose,
      createdAt: coreStorageObjects.createdAt,
    })
    .from(coreStorageObjects)
    .where(
      and(
        eq(coreStorageObjects.tenantId, tenantId),
        eq(coreStorageObjects.id, ref),
      ),
    )
    .limit(1);
  if (
    !object ||
    object.purpose !== "receipt" ||
    object.outletId?.toLowerCase() !== homeOutletId.toLowerCase() ||
    object.createdAt.getTime() < now.getTime() - RECEIPT_MAX_AGE_MS
  )
    throw invalid();
  const [claim] = await tx
    .select({ id: reimbursements.id })
    .from(reimbursements)
    .where(
      and(
        eq(reimbursements.tenantId, tenantId),
        eq(reimbursements.receiptUploadRef, ref),
      ),
    )
    .limit(1);
  const [document] = await tx
    .select({ id: employeeDocuments.id })
    .from(employeeDocuments)
    .where(
      and(
        eq(employeeDocuments.tenantId, tenantId),
        eq(employeeDocuments.storageObjectId, ref),
      ),
    )
    .limit(1);
  const [leave] = await tx
    .select({ id: leaveRequests.id })
    .from(leaveRequests)
    .where(
      and(
        eq(leaveRequests.tenantId, tenantId),
        eq(leaveRequests.attachmentKey, ref),
      ),
    )
    .limit(1);
  if (claim || document || leave) throw invalid();
  return ref;
}

/**
 * Fills `receiptUrl` after the transaction: the stored idempotent response
 * never holds a signed URL (it expires), and a signer failure only hides the
 * photo instead of failing the read.
 */
async function withReceiptUrls(
  context: ScopedTenantContext,
  claims: Reimbursement[],
  signer: HrisFileSigner,
): Promise<Reimbursement[]> {
  if (signer === noHrisFileSigner || claims.length === 0) return claims;
  const refs = await withTenant(db, context, (tx) =>
    tx
      .select({
        id: reimbursements.id,
        ref: reimbursements.receiptUploadRef,
      })
      .from(reimbursements)
      .where(
        and(
          eq(reimbursements.tenantId, context.tenant.tenantId),
          inArray(
            reimbursements.id,
            claims.map((claim) => claim.id),
          ),
          isNotNull(reimbursements.receiptUploadRef),
        ),
      ),
  );
  const refOf = new Map(refs.map((row) => [row.id as string, row.ref]));
  return Promise.all(
    claims.map(async (claim) => {
      const ref = refOf.get(claim.id);
      if (!ref) return claim;
      const receiptUrl = await signer(context, ref).catch(() => null);
      return { ...claim, receiptUrl };
    }),
  );
}

const withReceiptUrl = async (
  context: ScopedTenantContext,
  claim: Reimbursement,
  signer: HrisFileSigner,
): Promise<Reimbursement> =>
  (await withReceiptUrls(context, [claim], signer))[0] ?? claim;

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
    // Signed after the transaction by `withReceiptUrls`; the stored reference
    // is never exposed.
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
    reason?: string | null;
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
      reason: entry.reason ?? null,
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
    const date = businessDateSchema.safeParse(expenseDate);
    const beforeId = reimbursementIdSchema.safeParse(id);
    if (!date.success || !beforeId.success)
      throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
    filters.push(
      or(
        lt(reimbursements.expenseDate, date.data),
        and(
          eq(reimbursements.expenseDate, date.data),
          lt(reimbursements.id, beforeId.data),
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
  signer: HrisFileSigner = noHrisFileSigner,
): Promise<Page<Reimbursement>> {
  const page = await withTenant(db, context, async (tx) => {
    await assertPayrollTenantCan(tx, context, actorUserId, APPROVE_CODE);
    const extra: SQL[] = [];
    if (query.status) extra.push(eq(reimbursements.status, query.status));
    if (query.employeeId)
      extra.push(eq(reimbursements.employeeId, query.employeeId));
    return listClaims(tx, context, query, extra);
  });
  return { ...page, data: await withReceiptUrls(context, page.data, signer) };
}

/** HR-01: own claims only; the employee comes from the session. */
export async function listMyReimbursements(
  context: ScopedTenantContext,
  actorUserId: string,
  query: z.output<typeof listMyReimbursementsEndpoint.query>,
  signer: HrisFileSigner = noHrisFileSigner,
): Promise<Page<Reimbursement>> {
  const page = await withTenant(db, context, async (tx) => {
    const self = await loadPayrollSelf(tx, context, actorUserId, SELF_CODE);
    return listClaims(tx, context, query, [
      eq(reimbursements.employeeId, self.employeeId),
    ]);
  });
  return { ...page, data: await withReceiptUrls(context, page.data, signer) };
}

// ---- Claims: writes -------------------------------------------------------

export async function createMyReimbursement(
  context: ScopedTenantContext,
  actorUserId: string,
  input: ClaimInput,
  now: Date = new Date(),
  signer: HrisFileSigner = noHrisFileSigner,
): Promise<Reimbursement> {
  const { idempotencyKey, ...body } =
    createReimbursementInputSchema.parse(input);
  const claim = await withTenant(db, context, async (tx) => {
    const self = await loadPayrollSelf(tx, context, actorUserId, SELF_CODE);
    return idempotentHrisWrite(
      tx,
      context,
      idempotencyKey,
      "payroll.reimbursement.create",
      { actor: self.actor, employeeId: self.employeeId, body },
      async () => {
        // The server clock decides "future", never the client.
        const today = businessDateOf(now, DEFAULT_BUSINESS_DAY_CLOCK);
        if (body.expenseDate > today)
          throw unprocessable("Tanggal pengeluaran tidak boleh di masa depan.");
        if (body.expenseDate < daysBefore(today, REIMBURSEMENT_BACKDATE_DAYS))
          throw unprocessable(
            `Klaim hanya bisa diajukan untuk pengeluaran ${REIMBURSEMENT_BACKDATE_DAYS} hari terakhir.`,
          );
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
        if (!employee) throw notFound();
        if (employee.status !== "active" && employee.status !== "onboarding")
          throw unprocessable(
            "Karyawan yang sudah tidak aktif tidak bisa mengajukan reimbursement.",
          );
        const receiptRef =
          body.receiptUploadRef === null
            ? null
            : await assertReceiptUsable(
                tx,
                context,
                employee.homeOutletId,
                body.receiptUploadRef,
                now,
              );
        // Per-claim and per-month limit of the employee's position (or the
        // default row). The lock makes parallel claims queue up, so the second
        // one sees the first one's amount.
        await lockKey(
          tx,
          capLockKey(
            context,
            self.employeeId,
            body.categoryId,
            body.expenseDate,
          ),
        );
        assertReimbursementWithinLimit(
          reimbursementLimitFor(
            toCategory(category),
            positionIdSchema.nullable().parse(employee.positionId),
          ),
          body.amountIdr,
          await monthUsageIdr(
            tx,
            context,
            self.employeeId,
            body.categoryId,
            body.expenseDate,
            ["submitted", "approved", "paid"],
          ),
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
            receiptUploadRef: receiptRef,
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
  return withReceiptUrl(context, claim, signer);
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
  reason: string | null = null,
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
        // The row is locked; the status guard makes cancel and pay end with
        // exactly one winner even if a caller reads a stale row.
        eq(reimbursements.status, row.status),
      ),
    )
    .returning();
  if (!updated) throw new PayrollError("PAYROLL_INVALID_TRANSITION");
  await audit(tx, context, now, {
    actor,
    outletId: null,
    action: `payroll.reimbursement.${status}`,
    objectType: "reimbursement",
    objectId: row.id,
    after: { status },
    reason,
  });
  return toClaim(updated);
}

export async function decideReimbursement(
  context: ScopedTenantContext,
  actorUserId: string,
  reimbursementId: ReimbursementId,
  input: DecisionInput,
  now: Date = new Date(),
  signer: HrisFileSigner = noHrisFileSigner,
): Promise<Reimbursement> {
  const { idempotencyKey, ...body } =
    decideReimbursementEndpoint.body.parse(input);
  const claim = await withTenant(db, context, async (tx) => {
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
        if (body.action === "cancel") {
          // Only an approved, not yet paid cash claim: a submitted one is
          // decided (rejected) or withdrawn elsewhere, a payroll payout is
          // settled by the run, a paid one has moved money (legend-d5n4j).
          if (row.status !== "approved" || row.payout !== "cash")
            throw new PayrollError("PAYROLL_INVALID_TRANSITION");
          if (body.approvedAmountIdr !== null)
            throw unprocessable(
              "Klaim yang dibatalkan tidak punya jumlah disetujui.",
            );
          if (!body.reason)
            throw new HttpError(
              422,
              "PAYROLL_CANCEL_REASON_REQUIRED",
              "Alasan pembatalan wajib diisi untuk klaim yang sudah disetujui.",
            );
          // Keeps decidedBy/decidedAt of the approver; the audit row names the
          // canceller and the reason. No event: nothing was paid.
          return moveClaim(
            tx,
            context,
            actor,
            now,
            row,
            "cancel",
            { approvedAmountIdr: null },
            body.reason,
          );
        }
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
        await assertMonthWithinLimitAtApproval(tx, context, row, approved);
        return moveClaim(tx, context, actor, now, row, "approve", {
          approvedAmountIdr: approved,
          decidedBy: actor,
          decidedAt: now,
        });
      },
    );
  });
  return withReceiptUrl(context, claim, signer);
}

/**
 * Approval re-checks the month under the same lock as a new claim: what is
 * already approved or paid plus this approved amount stays within the cap of
 * the claimant's current position. Submitted claims are not counted: each one
 * was admitted against the usage at its own submission.
 */
async function assertMonthWithinLimitAtApproval(
  tx: Tx,
  context: ScopedTenantContext,
  row: ClaimRow,
  approvedIdr: ClaimRow["amountIdr"],
): Promise<void> {
  await lockKey(
    tx,
    capLockKey(context, row.employeeId, row.categoryId, row.expenseDate),
  );
  const [category] = await tx
    .select()
    .from(reimbursementCategories)
    .where(
      and(
        eq(reimbursementCategories.tenantId, context.tenant.tenantId),
        eq(reimbursementCategories.id, row.categoryId),
      ),
    )
    .limit(1);
  const [employee] = await tx
    .select({ positionId: employees.positionId })
    .from(employees)
    .where(
      and(
        eq(employees.tenantId, context.tenant.tenantId),
        eq(employees.id, row.employeeId),
      ),
    )
    .limit(1);
  if (!category || !employee) throw notFound();
  assertReimbursementWithinLimit(
    reimbursementLimitFor(
      toCategory(category),
      positionIdSchema.nullable().parse(employee.positionId),
    ),
    idr(approvedIdr),
    await monthUsageIdr(
      tx,
      context,
      row.employeeId,
      row.categoryId,
      row.expenseDate,
      ["approved", "paid"],
    ),
  );
}

/** Unlocked read of the claimant's legal entity; null when unknown. */
async function claimEntityId(
  tx: Tx,
  context: ScopedTenantContext,
  reimbursementId: ReimbursementId,
): Promise<string | null> {
  const [claim] = await tx
    .select({ legalEntityId: employees.legalEntityId })
    .from(reimbursements)
    .innerJoin(
      employees,
      and(
        eq(employees.tenantId, reimbursements.tenantId),
        eq(employees.id, reimbursements.employeeId),
      ),
    )
    .where(
      and(
        eq(reimbursements.tenantId, context.tenant.tenantId),
        eq(reimbursements.id, reimbursementId),
      ),
    )
    .limit(1);
  return claim?.legalEntityId ?? null;
}

export async function payReimbursementCash(
  context: ScopedTenantContext,
  actorUserId: string,
  reimbursementId: ReimbursementId,
  idempotencyKey: string,
  now: Date = new Date(),
  signer: HrisFileSigner = noHrisFileSigner,
): Promise<Reimbursement> {
  const claim = await withTenant(db, context, async (tx) => {
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
        // The cash comes out of petty cash (1102): entity lock BEFORE the claim
        // lock (1053 order), so the entity is read unlocked first and
        // re-checked under the claim lock (legend-swn0m).
        const peekEntityId = await claimEntityId(tx, context, reimbursementId);
        if (peekEntityId !== null)
          await entityLock(tx, context.tenant.tenantId, peekEntityId);
        const row = await lockClaim(tx, context, reimbursementId);
        if (peekEntityId !== null) {
          const [claimant] = await tx
            .select({ legalEntityId: employees.legalEntityId })
            .from(employees)
            .where(
              and(
                eq(employees.tenantId, context.tenant.tenantId),
                eq(employees.id, row.employeeId),
              ),
            )
            .limit(1);
          if (claimant?.legalEntityId !== peekEntityId)
            throw new HttpError(
              409,
              "PAYROLL_REIMBURSEMENT_ENTITY_CHANGED",
              "Badan usaha karyawan berubah saat klaim diproses. Coba lagi.",
            );
        }
        // Separation of duties: nobody pays their own claim.
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
        // A payroll payout is paid by the run lock, never by hand.
        if (row.payout !== "cash")
          throw new PayrollError("PAYROLL_INVALID_TRANSITION");
        // Only an approved claim pays out; any other status is a plain invalid
        // transition (moveClaim answers it). Under the entity lock and before
        // the paid event, so the amount is not counted twice.
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
                "Reimburse tunai tidak bisa dibayar: karyawan belum punya badan usaha, padahal akuntansi aktif.",
              );
          } else
            await assertCash1102CoversOutflow(
              tx,
              context.tenant.tenantId,
              peekEntityId,
              Number(row.approvedAmountIdr ?? row.amountIdr),
              accountingOn,
            );
        }
        const paid = await moveClaim(tx, context, actor, now, row, "pay", {
          paidAt: now,
        });
        // The cash leaves petty cash (1102): announce it in the same
        // transaction so the GL consumer posts it and the amount is a pending
        // credit until then (legend-xf7pt). moveClaim runs once per claim
        // (status transition plus the idempotency key), so a retry never
        // announces it twice. A claimant without a legal entity has no 1102.
        if (peekEntityId !== null)
          await emitPayrollEvent(tx, context, reimbursementPaid, {
            aggregateId: row.id,
            actor: { type: "user", id: actor },
            payload: {
              reimbursementId: row.id,
              employeeId: row.employeeId,
              categoryId: row.categoryId,
              amountIdr: Number(row.approvedAmountIdr ?? row.amountIdr),
              payout: "cash",
              payrollRunId: null,
              accountingOnAtEmit: accountingOn,
              paidAt: now.toISOString(),
            },
            now,
          });
        return paid;
      },
    );
  });
  return withReceiptUrl(context, claim, signer);
}
