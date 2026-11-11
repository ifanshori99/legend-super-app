// Service-charge pools, configuration side (bead legend-gfcr, PRD v1.7 §3 D.30
// "Distribusi Service Charge", §6 H; contract `@starter/shared/hris/payroll`
// service-charge.ts). Routes: routes/payroll-service-charge.routes.ts.
//
// This slice stores a pool in `draft`, reads pools and their allocations, and
// (bead legend-pf9u7) calculates the allocations and distributes an approved
// pool to a payroll run. Approve is not registered here. Reading needs
// `payroll.view`, creating `payroll.run`, both tenant-wide (payroll/endpoints.ts
// header). A pool is outlet owned, so the table also carries the outlet RLS
// backstop (TEN-03).
//
// Calculate and distribute repeat the `payroll.run` check inside the tenant
// transaction (assertPayrollTenantCan), like the route gate does.
// Money rule: the allocations of a pool always add up to `amount_idr`, checked
// when they are written and again before the pool is distributed.
//
// A new pool may not overlap a live (not cancelled) pool of the same outlet:
// the unique index only catches an identical period, the service checks the
// range. Both answer 409 CONFLICT.

import { randomUUID } from "node:crypto";
import {
  and,
  asc,
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
import type { SQL } from "drizzle-orm";
import {
  businessDateSchema,
  encodeCursor,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  createServiceChargePool as createServiceChargePoolEndpoint,
  listServiceChargeAllocations as listServiceChargeAllocationsEndpoint,
  listServiceChargePools as listServiceChargePoolsEndpoint,
  serviceChargeAllocationSchema,
  serviceChargePoolSchema,
  serviceChargeRuleSchema,
  distributeServiceChargePool,
  payrollRunIdSchema,
  PayrollError,
  transitionServiceChargePool,
  type ServiceChargeAllocation,
  type ServiceChargeParticipant,
  type ServiceChargePool,
  type ServiceChargePoolId,
} from "@starter/shared/hris/payroll";
import type { EmployeeId } from "@starter/shared/hris";
import type { z } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { attendanceLogs } from "../db/schema/hris-attendance.ts";
import { employees, positions } from "../db/schema/hris.ts";
import {
  payrollRuns,
  serviceChargeAllocations,
  serviceChargePools,
} from "../db/schema/payroll.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import {
  cursorPair,
  hrisAuditEntry,
  notFound,
  uniqueViolation,
  type Tx,
} from "./hris-access.ts";
import { idempotentHrisWrite } from "./hris-employee.service.ts";
import { assertPayrollTenantCan } from "./payroll-access.ts";

type ListPoolsQuery = z.infer<typeof listServiceChargePoolsEndpoint.query>;
type ListAllocationsQuery = z.infer<
  typeof listServiceChargeAllocationsEndpoint.query
>;
type CreatePoolBody = z.infer<typeof createServiceChargePoolEndpoint.body>;
type Page<T> = {
  data: T[];
  meta: { limit: number; nextCursor: string | null };
};
type PoolRow = typeof serviceChargePools.$inferSelect;
type AllocationRow = typeof serviceChargeAllocations.$inferSelect;

/** Field names only: no amount, no rule detail reaches the audit values. */
const AUDIT_SAFE_FIELDS = ["periodStart", "periodEnd", "status"] as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const badCursor = () =>
  new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");

/** A `[date, id]` cursor with typed parts: a bad one is a 422, not a cast error. */
function cursorDateId(cursor: string): [string, string] {
  const [date, id] = cursorPair(cursor);
  if (!businessDateSchema.safeParse(date).success || !UUID_PATTERN.test(id))
    throw badCursor();
  return [date, id];
}

/** A `[uuid, uuid]` cursor. */
function cursorIdPair(cursor: string): [string, string] {
  const [first, second] = cursorPair(cursor);
  if (!UUID_PATTERN.test(first) || !UUID_PATTERN.test(second))
    throw badCursor();
  return [first, second];
}

const toPool = (row: PoolRow): ServiceChargePool =>
  serviceChargePoolSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    amountIdr: row.amountIdr,
    // Parsed again on read: a row edited outside the service fails loudly.
    rule: serviceChargeRuleSchema.parse(row.rule),
    status: row.status,
    payrollRunId: row.payrollRunId,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  });

const toAllocation = (row: AllocationRow): ServiceChargeAllocation =>
  serviceChargeAllocationSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    poolId: row.poolId,
    employeeId: row.employeeId,
    points: row.points,
    attendanceDays: row.attendanceDays,
    weight: row.weight,
    amountIdr: row.amountIdr,
  });

const overlappingPool = () =>
  new HttpError(
    409,
    "CONFLICT",
    "Sudah ada pool service charge aktif untuk outlet dan periode yang bertumpuk.",
  );

function foreignKeyViolation(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return (
    candidate.code === "23503" ||
    foreignKeyViolation(candidate.cause, depth + 1)
  );
}

async function loadPool(
  tx: Tx,
  context: ScopedTenantContext,
  poolId: string,
  lock = false,
): Promise<PoolRow> {
  const query = tx
    .select()
    .from(serviceChargePools)
    .where(
      and(
        eq(serviceChargePools.tenantId, context.tenant.tenantId),
        eq(serviceChargePools.id, poolId as ServiceChargePoolId),
      ),
    )
    .limit(1);
  // FOR UPDATE: two calculations or distributions of one pool queue here.
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw notFound("Pool service charge");
  return row;
}

/** GET /api/hris/payroll/service-charge-pools: newest period first. */
export async function listServiceChargePools(
  context: ScopedTenantContext,
  actorUserId: string,
  query: ListPoolsQuery,
): Promise<Page<ServiceChargePool>> {
  return withTenant(db, context, async (tx) => {
    await assertPayrollTenantCan(tx, context, actorUserId, "payroll.view");
    const filters: SQL[] = [
      eq(serviceChargePools.tenantId, context.tenant.tenantId),
    ];
    if (query.outletId)
      filters.push(eq(serviceChargePools.outletId, query.outletId));
    if (query.status) filters.push(eq(serviceChargePools.status, query.status));
    if (query.cursor) {
      const [date, id] = cursorDateId(query.cursor);
      filters.push(
        or(
          lt(serviceChargePools.periodStart, date),
          and(
            eq(serviceChargePools.periodStart, date),
            lt(serviceChargePools.id, id as ServiceChargePoolId),
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(serviceChargePools)
      .where(and(...filters))
      .orderBy(
        desc(serviceChargePools.periodStart),
        desc(serviceChargePools.id),
      )
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toPool),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.periodStart, last.id])
            : null,
      },
    };
  });
}

/** POST /api/hris/payroll/service-charge-pools: a draft pool. */
export async function createServiceChargePool(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreatePoolBody,
  now: Date = new Date(),
): Promise<ServiceChargePool> {
  const { idempotencyKey, ...body } = input;
  return withTenant(db, context, async (tx) => {
    const actor = await assertPayrollTenantCan(
      tx,
      context,
      actorUserId,
      "payroll.run",
    );
    return idempotentHrisWrite(
      tx,
      context,
      idempotencyKey,
      "payroll.service_charge_pool.create",
      { actor, ...body },
      async () => {
        // The pool contract refines this, the client input schema does not.
        if (body.periodEnd < body.periodStart)
          throw new HttpError(
            422,
            "VALIDATION_ERROR",
            "Akhir periode tidak boleh sebelum awal periode.",
          );
        const [outlet] = await tx
          .select({ id: outlets.id })
          .from(outlets)
          .where(
            and(
              eq(outlets.tenantId, context.tenant.tenantId),
              eq(outlets.id, body.outletId),
            ),
          )
          .limit(1);
        if (!outlet)
          throw new HttpError(
            422,
            "VALIDATION_ERROR",
            "Outlet tidak ditemukan.",
          );

        // Two creates for one outlet queue here, so the overlap check below
        // sees the first one's row.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`payroll:scpool:${context.tenant.tenantId}:${body.outletId}`}, 0))`,
        );
        const [overlap] = await tx
          .select({ id: serviceChargePools.id })
          .from(serviceChargePools)
          .where(
            and(
              eq(serviceChargePools.tenantId, context.tenant.tenantId),
              eq(serviceChargePools.outletId, body.outletId),
              ne(serviceChargePools.status, "cancelled"),
              lte(serviceChargePools.periodStart, body.periodEnd),
              gte(serviceChargePools.periodEnd, body.periodStart),
            ),
          )
          .limit(1);
        if (overlap) throw overlappingPool();

        let row: PoolRow | undefined;
        try {
          // A savepoint keeps the transaction usable after a constraint error.
          row = await tx.transaction(async (inner) => {
            const [created] = await inner
              .insert(serviceChargePools)
              .values({
                id: randomUUID() as PoolRow["id"],
                tenantId: context.tenant.tenantId,
                outletId: body.outletId,
                periodStart: body.periodStart,
                periodEnd: body.periodEnd,
                amountIdr: body.amountIdr,
                rule: body.rule,
                status: "draft",
                createdBy: actor,
                createdAt: now,
                updatedAt: now,
              })
              .returning();
            return created;
          });
        } catch (error) {
          if (uniqueViolation(error)) throw overlappingPool();
          if (foreignKeyViolation(error))
            throw new HttpError(
              422,
              "VALIDATION_ERROR",
              "Outlet tidak ditemukan.",
            );
          throw error;
        }
        if (!row) throw new Error("Service charge pool was not stored");
        await recordAudit(
          tx,
          context,
          hrisAuditEntry(context, actor, now, {
            outletId: row.outletId,
            action: "payroll.service_charge_pool.created",
            objectType: "service_charge_pool",
            objectId: row.id,
            after: {
              periodStart: row.periodStart,
              periodEnd: row.periodEnd,
              status: row.status,
            },
          }),
          AUDIT_SAFE_FIELDS,
        );
        return toPool(row);
      },
    );
  });
}

/** GET /api/hris/payroll/service-charge-pools/:poolId/allocations. */
export async function listServiceChargeAllocations(
  context: ScopedTenantContext,
  actorUserId: string,
  poolId: string,
  query: ListAllocationsQuery,
): Promise<Page<ServiceChargeAllocation>> {
  return withTenant(db, context, async (tx) => {
    await assertPayrollTenantCan(tx, context, actorUserId, "payroll.view");
    // 404 for a pool of another tenant (RLS hides it) or one that is absent.
    await loadPool(tx, context, poolId);
    const filters: SQL[] = [
      eq(serviceChargeAllocations.tenantId, context.tenant.tenantId),
      eq(serviceChargeAllocations.poolId, poolId as ServiceChargePoolId),
    ];
    if (query.cursor) {
      const [employeeId, id] = cursorIdPair(query.cursor);
      filters.push(
        or(
          sql`${serviceChargeAllocations.employeeId} > ${employeeId}::uuid`,
          and(
            eq(serviceChargeAllocations.employeeId, employeeId),
            sql`${serviceChargeAllocations.id} > ${id}::uuid`,
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(serviceChargeAllocations)
      .where(and(...filters))
      .orderBy(
        asc(serviceChargeAllocations.employeeId),
        asc(serviceChargeAllocations.id),
      )
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toAllocation),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.employeeId, last.id])
            : null,
      },
    };
  });
}

/** Sum of a pool's allocations and how many there are (bigint: no float drift). */
async function allocationTotal(
  tx: Tx,
  context: ScopedTenantContext,
  poolId: string,
): Promise<{ total: bigint; count: number }> {
  const [row] = await tx
    .select({
      total: sql<string>`COALESCE(SUM(${serviceChargeAllocations.amountIdr}), 0)::text`,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(serviceChargeAllocations)
    .where(
      and(
        eq(serviceChargeAllocations.tenantId, context.tenant.tenantId),
        eq(serviceChargeAllocations.poolId, poolId as ServiceChargePoolId),
      ),
    );
  return { total: BigInt(row?.total ?? "0"), count: row?.count ?? 0 };
}

/**
 * Participants of a pool: active employees of the pool outlet whose position
 * carries points, whose employment type is in the rule and who were employed
 * in the period. Ordered by id so a recalculation gives the same shares.
 */
async function loadParticipants(
  tx: Tx,
  context: ScopedTenantContext,
  pool: PoolRow,
  rule: z.infer<typeof serviceChargeRuleSchema>,
): Promise<ServiceChargeParticipant[]> {
  const rows = await tx
    .select({
      employeeId: employees.id,
      employmentType: employees.employmentType,
      points: positions.serviceChargePoints,
    })
    .from(employees)
    .innerJoin(
      positions,
      and(
        eq(positions.tenantId, employees.tenantId),
        eq(positions.id, employees.positionId),
      ),
    )
    .where(
      and(
        eq(employees.tenantId, context.tenant.tenantId),
        eq(employees.homeOutletId, pool.outletId),
        eq(employees.status, "active"),
        inArray(employees.employmentType, rule.eligibleEmploymentTypes),
        sql`${positions.serviceChargePoints} > 0`,
        lte(employees.joinDate, pool.periodEnd),
        or(isNull(employees.endDate), gte(employees.endDate, pool.periodStart)),
      ),
    )
    .orderBy(asc(employees.id));
  if (rows.length === 0) return [];

  // Days present: distinct business days with a valid clock-out in the period.
  const days = await tx
    .select({
      employeeId: attendanceLogs.employeeId,
      days: sql<number>`COUNT(DISTINCT ${attendanceLogs.businessDate})::int`,
    })
    .from(attendanceLogs)
    .where(
      and(
        eq(attendanceLogs.tenantId, context.tenant.tenantId),
        inArray(
          attendanceLogs.employeeId,
          rows.map((row) => row.employeeId),
        ),
        eq(attendanceLogs.type, "out"),
        eq(attendanceLogs.validity, "valid"),
        gte(attendanceLogs.businessDate, pool.periodStart),
        lte(attendanceLogs.businessDate, pool.periodEnd),
      ),
    )
    .groupBy(attendanceLogs.employeeId);
  const daysOf = new Map(days.map((row) => [row.employeeId, row.days]));

  return rows.map((row) => ({
    employeeId: row.employeeId as EmployeeId,
    employmentType: row.employmentType,
    points: row.points,
    // The column holds 0..31.
    attendanceDays: Math.min(31, daysOf.get(row.employeeId) ?? 0),
  }));
}

/**
 * Calculates (or recalculates) the allocations of a pool: draft | calculated ->
 * calculated. The old allocations are replaced in the same transaction, so a
 * repeat gives the same shares. The shares add up to the pool amount exactly;
 * a pool with money and nobody to pay is refused and nothing is written.
 */
export async function calculateServiceChargePoolAllocations(
  context: ScopedTenantContext,
  actorUserId: string,
  poolId: string,
  now: Date = new Date(),
): Promise<ServiceChargePool> {
  return withTenant(db, context, async (tx) => {
    await assertPayrollTenantCan(tx, context, actorUserId, "payroll.run");
    const pool = await loadPool(tx, context, poolId, true);
    const next = transitionServiceChargePool(
      pool.status as ServiceChargePool["status"],
      "calculate",
    );
    const rule = serviceChargeRuleSchema.parse(pool.rule);
    const participants = await loadParticipants(tx, context, pool, rule);
    // Throws PAYROLL_INVALID_TRANSITION for money without an eligible person.
    const shares = distributeServiceChargePool(
      pool.amountIdr,
      rule,
      participants,
    ).filter((share) => share.weight > 0);

    const total = shares.reduce(
      (sum, share) => sum + BigInt(share.amountIdr),
      0n,
    );
    if (total !== BigInt(pool.amountIdr))
      throw new PayrollError(
        "PAYROLL_INVALID_TRANSITION",
        "Pembagian service charge tidak sama dengan jumlah pool.",
      );

    await tx
      .delete(serviceChargeAllocations)
      .where(
        and(
          eq(serviceChargeAllocations.tenantId, context.tenant.tenantId),
          eq(serviceChargeAllocations.poolId, pool.id),
        ),
      );
    if (shares.length > 0)
      await tx.insert(serviceChargeAllocations).values(
        shares.map((share) => ({
          id: randomUUID() as AllocationRow["id"],
          tenantId: context.tenant.tenantId,
          poolId: pool.id,
          employeeId: share.employeeId,
          points: share.points,
          attendanceDays: share.attendanceDays,
          weight: share.weight,
          amountIdr: share.amountIdr,
        })),
      );

    const [row] = await tx
      .update(serviceChargePools)
      .set({ status: next, updatedAt: now })
      .where(
        and(
          eq(serviceChargePools.tenantId, context.tenant.tenantId),
          eq(serviceChargePools.id, pool.id),
        ),
      )
      .returning();
    if (!row) throw new Error("Service charge pool was not updated");
    await recordAudit(
      tx,
      context,
      hrisAuditEntry(context, actorUserId, now, {
        outletId: row.outletId,
        action: "payroll.service_charge_pool.calculated",
        objectType: "service_charge_pool",
        objectId: row.id,
        after: {
          periodStart: row.periodStart,
          periodEnd: row.periodEnd,
          status: row.status,
        },
      }),
      AUDIT_SAFE_FIELDS,
    );
    return toPool(row);
  });
}

/**
 * Hands an approved pool to a payroll run: approved -> distributed, once. The
 * pool row is locked, so two distributions queue and the second sees
 * `distributed`. A locked, paid or reversed run is frozen (PAYR-02) and takes
 * nothing. The allocations must add up to the pool amount, else nothing moves.
 * Lock order is always pool first, then run, so two distributions cannot
 * deadlock. Once both rows are locked the run must be a regular run of the
 * legal entity that owns the pool's outlet, and its period must cover the
 * whole pool period; otherwise 409 and nothing moves.
 */
export async function distributeServiceChargePoolToRun(
  context: ScopedTenantContext,
  actorUserId: string,
  poolId: string,
  input: { payrollRunId: string },
  now: Date = new Date(),
): Promise<ServiceChargePool> {
  const payrollRunId = payrollRunIdSchema.parse(input.payrollRunId);
  return withTenant(db, context, async (tx) => {
    await assertPayrollTenantCan(tx, context, actorUserId, "payroll.run");
    const pool = await loadPool(tx, context, poolId, true);
    const next = transitionServiceChargePool(
      pool.status as ServiceChargePool["status"],
      "distribute",
    );

    const [run] = await tx
      .select({
        id: payrollRuns.id,
        status: payrollRuns.status,
        runType: payrollRuns.runType,
        legalEntityId: payrollRuns.legalEntityId,
        periodStart: payrollRuns.periodStart,
        periodEnd: payrollRuns.periodEnd,
      })
      .from(payrollRuns)
      .where(
        and(
          eq(payrollRuns.tenantId, context.tenant.tenantId),
          eq(payrollRuns.id, payrollRunId),
        ),
      )
      .limit(1)
      .for("update");
    if (!run) throw notFound("Payroll run");
    if (["locked", "paid", "reversed"].includes(run.status))
      throw new PayrollError("PAYROLL_RUN_FROZEN");

    const [outlet] = await tx
      .select({ legalEntityId: outlets.legalEntityId })
      .from(outlets)
      .where(
        and(
          eq(outlets.tenantId, context.tenant.tenantId),
          eq(outlets.id, pool.outletId),
        ),
      )
      .limit(1);
    if (!outlet) throw notFound("Outlet");
    if (
      run.runType !== "regular" ||
      run.legalEntityId !== outlet.legalEntityId ||
      run.periodStart > pool.periodStart ||
      run.periodEnd < pool.periodEnd
    )
      throw new HttpError(
        409,
        "CONFLICT",
        "Pool service charge hanya bisa dibagikan ke run reguler badan hukum outlet yang periodenya mencakup seluruh periode pool.",
      );

    const { total, count } = await allocationTotal(tx, context, pool.id);
    if (total !== BigInt(pool.amountIdr) || (count === 0 && pool.amountIdr > 0))
      throw new PayrollError(
        "PAYROLL_INVALID_TRANSITION",
        "Pembagian service charge tidak sama dengan jumlah pool; hitung ulang sebelum dibagikan.",
      );

    const [row] = await tx
      .update(serviceChargePools)
      .set({ status: next, payrollRunId: run.id, updatedAt: now })
      .where(
        and(
          eq(serviceChargePools.tenantId, context.tenant.tenantId),
          eq(serviceChargePools.id, pool.id),
          eq(serviceChargePools.status, "approved"),
        ),
      )
      .returning();
    if (!row) throw new PayrollError("PAYROLL_INVALID_TRANSITION");
    await recordAudit(
      tx,
      context,
      hrisAuditEntry(context, actorUserId, now, {
        outletId: row.outletId,
        action: "payroll.service_charge_pool.distributed",
        objectType: "service_charge_pool",
        objectId: row.id,
        after: {
          periodStart: row.periodStart,
          periodEnd: row.periodEnd,
          status: row.status,
        },
      }),
      AUDIT_SAFE_FIELDS,
    );
    return toPool(row);
  });
}
