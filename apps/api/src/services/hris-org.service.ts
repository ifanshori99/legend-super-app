// Organisation structure: org units, position grades, positions (PRD v1.7 §3
// F26 "Struktur Organisasi"; §6 H `org_units` / `positions`; bead
// legend-qe1z). Routes: routes/hris.routes.ts.
//
// The structure is tenant-wide master data without PII. Reading it needs an
// HR read code (hr.employee.view / hr.employee.manage / payroll.view) with
// any reach; creating it needs tenant-wide `hr.employee.manage` (the contract
// has no create endpoints yet, so these are service-level for import tooling
// and the onboarding bead).

import { and, asc, eq, gt, or, type SQL } from "drizzle-orm";
import {
  createUlid,
  encodeCursor,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  orgUnitSchema,
  positionGradeSchema,
  positionSchema,
  listOrgUnits as listOrgUnitsEndpoint,
  listPositionGrades as listPositionGradesEndpoint,
  listPositions as listPositionsEndpoint,
  type OrgUnit,
  type Position,
  type PositionGrade,
} from "@starter/shared/hris";
import type { z } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { orgUnits, positionGrades, positions } from "../db/schema/hris.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import {
  HRIS_AUDIT_SAFE_FIELDS,
  HRIS_READ_CODES,
  cursorPair,
  forbidden,
  loadHrisAccess,
  uniqueViolation,
  type Tx,
} from "./hris-access.ts";

type Page<T> = {
  data: T[];
  meta: { limit: number; nextCursor: string | null };
};
type OrgUnitsQuery = z.output<typeof listOrgUnitsEndpoint.query>;
type GradesQuery = z.output<typeof listPositionGradesEndpoint.query>;
type PositionsQuery = z.output<typeof listPositionsEndpoint.query>;

async function assertCanRead(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
): Promise<void> {
  const access = await loadHrisAccess(tx, context, actorUserId);
  if (access.reach(HRIS_READ_CODES) === null) throw forbidden();
}

async function assertCanManage(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
): Promise<string> {
  const access = await loadHrisAccess(tx, context, actorUserId);
  // Tenant-wide structure: tenant-wide right and a tenant-wide context.
  if (
    context.outletScope.kind !== "tenant" ||
    !access.snapshot.allows("hr.employee.manage", { type: "tenant" })
  )
    throw forbidden();
  return access.actorUserId;
}

function page<Row, T>(
  rows: Row[],
  limit: number,
  map: (row: Row) => T,
  keys: (row: Row) => [string, string],
): Page<T> {
  const data = rows.slice(0, limit);
  const last = data.at(-1);
  return {
    data: data.map(map),
    meta: {
      limit,
      nextCursor: rows.length > limit && last ? encodeCursor(keys(last)) : null,
    },
  };
}

const toOrgUnit = (row: typeof orgUnits.$inferSelect): OrgUnit =>
  orgUnitSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    parentId: row.parentId,
    code: row.code,
    name: row.name,
    isActive: row.isActive,
  });

const toGrade = (row: typeof positionGrades.$inferSelect): PositionGrade =>
  positionGradeSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    name: row.name,
    level: row.level,
  });

const toPosition = (row: typeof positions.$inferSelect): Position =>
  positionSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    gradeId: row.gradeId,
    orgUnitId: row.orgUnitId,
    serviceChargePoints: row.serviceChargePoints,
    isActive: row.isActive,
  });

export async function listOrgUnits(
  context: ScopedTenantContext,
  actorUserId: string,
  query: OrgUnitsQuery,
): Promise<Page<OrgUnit>> {
  return withTenant(db, context, async (tx) => {
    await assertCanRead(tx, context, actorUserId);
    const filters: SQL[] = [eq(orgUnits.tenantId, context.tenant.tenantId)];
    if (query.cursor) {
      const [code, id] = cursorPair(query.cursor);
      filters.push(
        or(
          gt(orgUnits.code, code),
          and(eq(orgUnits.code, code), gt(orgUnits.id, id)),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(orgUnits)
      .where(and(...filters))
      .orderBy(asc(orgUnits.code), asc(orgUnits.id))
      .limit(query.limit + 1);
    return page(rows, query.limit, toOrgUnit, (row) => [row.code, row.id]);
  });
}

export async function listPositionGrades(
  context: ScopedTenantContext,
  actorUserId: string,
  query: GradesQuery,
): Promise<Page<PositionGrade>> {
  return withTenant(db, context, async (tx) => {
    await assertCanRead(tx, context, actorUserId);
    const filters: SQL[] = [
      eq(positionGrades.tenantId, context.tenant.tenantId),
    ];
    if (query.cursor) {
      const [code, id] = cursorPair(query.cursor);
      filters.push(
        or(
          gt(positionGrades.code, code),
          and(eq(positionGrades.code, code), gt(positionGrades.id, id)),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(positionGrades)
      .where(and(...filters))
      .orderBy(asc(positionGrades.code), asc(positionGrades.id))
      .limit(query.limit + 1);
    return page(rows, query.limit, toGrade, (row) => [row.code, row.id]);
  });
}

export async function listPositions(
  context: ScopedTenantContext,
  actorUserId: string,
  query: PositionsQuery,
): Promise<Page<Position>> {
  return withTenant(db, context, async (tx) => {
    await assertCanRead(tx, context, actorUserId);
    const filters: SQL[] = [eq(positions.tenantId, context.tenant.tenantId)];
    if (query.orgUnitId) filters.push(eq(positions.orgUnitId, query.orgUnitId));
    if (query.cursor) {
      const [name, id] = cursorPair(query.cursor);
      filters.push(
        or(
          gt(positions.name, name),
          and(eq(positions.name, name), gt(positions.id, id)),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(positions)
      .where(and(...filters))
      .orderBy(asc(positions.name), asc(positions.id))
      .limit(query.limit + 1);
    return page(rows, query.limit, toPosition, (row) => [row.name, row.id]);
  });
}

// ------------------------------------------------- service-level creates

function conflict(error: unknown, message: string): never {
  if (uniqueViolation(error)) throw new HttpError(409, "CONFLICT", message);
  throw error;
}

async function auditCreated(
  tx: Tx,
  context: ScopedTenantContext,
  actor: string,
  now: Date,
  objectType: string,
  objectId: string,
) {
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: null,
      actorType: "user",
      actorId: actor,
      deviceId: null,
      action: `hris.${objectType}.created`,
      objectType,
      objectId,
      reason: null,
      maskedChanges: { before: null, after: null },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    },
    HRIS_AUDIT_SAFE_FIELDS,
  );
}

export async function createOrgUnit(
  context: ScopedTenantContext,
  actorUserId: string,
  input: Pick<OrgUnit, "parentId" | "code" | "name"> & { isActive?: boolean },
  now = new Date(),
): Promise<OrgUnit> {
  return withTenant(db, context, async (tx) => {
    const actor = await assertCanManage(tx, context, actorUserId);
    const [row] = await tx
      .insert(orgUnits)
      .values({
        tenantId: context.tenant.tenantId,
        parentId: input.parentId,
        code: input.code,
        name: input.name,
        isActive: input.isActive ?? true,
      })
      .returning()
      .catch((error: unknown) => conflict(error, "Kode unit sudah dipakai."));
    if (!row) throw new Error("Org unit insert returned no row");
    await auditCreated(tx, context, actor, now, "org_unit", row.id);
    return toOrgUnit(row);
  });
}

export async function createPositionGrade(
  context: ScopedTenantContext,
  actorUserId: string,
  input: Pick<PositionGrade, "code" | "name" | "level">,
  now = new Date(),
): Promise<PositionGrade> {
  return withTenant(db, context, async (tx) => {
    const actor = await assertCanManage(tx, context, actorUserId);
    const [row] = await tx
      .insert(positionGrades)
      .values({ tenantId: context.tenant.tenantId, ...input })
      .returning()
      .catch((error: unknown) => conflict(error, "Kode grade sudah dipakai."));
    if (!row) throw new Error("Grade insert returned no row");
    await auditCreated(tx, context, actor, now, "position_grade", row.id);
    return toGrade(row);
  });
}

export async function createPosition(
  context: ScopedTenantContext,
  actorUserId: string,
  input: Pick<
    Position,
    "name" | "gradeId" | "orgUnitId" | "serviceChargePoints"
  > & { isActive?: boolean },
  now = new Date(),
): Promise<Position> {
  return withTenant(db, context, async (tx) => {
    const actor = await assertCanManage(tx, context, actorUserId);
    const [row] = await tx
      .insert(positions)
      .values({
        tenantId: context.tenant.tenantId,
        name: input.name,
        gradeId: input.gradeId,
        orgUnitId: input.orgUnitId,
        serviceChargePoints: input.serviceChargePoints,
        isActive: input.isActive ?? true,
      })
      .returning();
    if (!row) throw new Error("Position insert returned no row");
    await auditCreated(tx, context, actor, now, "position", row.id);
    return toPosition(row);
  });
}
