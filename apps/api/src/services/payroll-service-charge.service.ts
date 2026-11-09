// Service-charge pools, configuration side (bead legend-gfcr, PRD v1.7 §3 D.30
// "Distribusi Service Charge", §6 H; contract `@starter/shared/hris/payroll`
// service-charge.ts). Routes: routes/payroll-service-charge.routes.ts.
//
// This slice stores a pool in `draft` and reads pools and their allocations.
// Calculate and approve belong to the payroll engine (bead legend-pf9u7) and
// are not registered here. Reading needs `payroll.view`, creating `payroll.run`,
// both tenant-wide (payroll/endpoints.ts header). A pool is outlet owned, so
// the table also carries the outlet RLS backstop (TEN-03).
//
// A new pool may not overlap a live (not cancelled) pool of the same outlet:
// the unique index only catches an identical period, the service checks the
// range. Both answer 409 CONFLICT.

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, lt, lte, ne, or, sql } from "drizzle-orm";
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
  type ServiceChargeAllocation,
  type ServiceChargePool,
  type ServiceChargePoolId,
} from "@starter/shared/hris/payroll";
import type { z } from "@starter/shared/core";
import { db } from "../db/index.ts";
import {
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
): Promise<PoolRow> {
  const [row] = await tx
    .select()
    .from(serviceChargePools)
    .where(
      and(
        eq(serviceChargePools.tenantId, context.tenant.tenantId),
        eq(serviceChargePools.id, poolId as ServiceChargePoolId),
      ),
    )
    .limit(1);
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
