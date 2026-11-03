// Facility, area and unit configuration (PRD v1.7 §3 F22/F25 "Model Generik",
// "Konfigurasi Legend", "Produk & Hak Akses"; beads legend-nm4f + legend-8dpm).
// Routes: routes/facility.routes.ts.
//
// Every function runs inside `withTenant` (RLS scopes rows to the tenant and
// the caller's outlets) and re-checks `facility.config.manage` on the
// facility's own outlet. The config read model returns the real products,
// add-ons, entitlement rules, subscription plans and Wi-Fi policies; their
// writes live in facility-products.service.ts and wifi-policy.service.ts.
//
// `listFacilities` backs the config index (GET /facilities): the facility ids
// cannot be invented by a screen, so the list is gated by the config
// permission and re-checked per distinct outlet of the page.
import { and, asc, eq, gt, or } from "drizzle-orm";
import {
  decodeCursor,
  encodeCursor,
  type CursorPage,
  type ScopedTenantContext,
  userIdSchema,
  uuidSchema,
  type z,
} from "@starter/shared/core";
import {
  facilityConfigSchema,
  slotConfigSchema,
  type CreateFacilityAreaInput,
  type CreateFacilityUnitInput,
  type Facility,
  type FacilityArea,
  type FacilityConfig,
  type FacilityUnit,
  type UpdateFacilityInput,
  type updateFacilityAreaSchema,
} from "@starter/shared/facility";
import { db } from "../db/index.ts";
import {
  facilities,
  facilityAreas,
  facilityUnits,
} from "../db/schema/facility.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  assertFacilityPermission,
  auditFacility,
  CONFIG_PERMISSION,
  loadArea,
  loadFacility,
  notFound,
  PG_UNIQUE_VIOLATION,
  pgErrorCode,
  toArea,
  toFacility,
  toUnit,
} from "./facility-shared.ts";
import {
  listEntitlementRules,
  listFacilityAddons,
  listFacilityProducts,
  listFacilitySubscriptionPlans,
} from "./facility-products.service.ts";
import { listWifiPoliciesForFacility } from "./wifi-policy.service.ts";

type UpdateAreaInput = z.output<typeof updateFacilityAreaSchema>;

/**
 * The tenant's facilities for the config index, `name` then `id` as the
 * keyset (both bounded columns). RLS limits the rows to the caller's outlet
 * reach; the permission is re-checked per distinct outlet of the page because
 * the list spans outlets (TEN-03).
 */
export async function listFacilities(
  context: ScopedTenantContext,
  actorUserId: string,
  query: { cursor?: string; limit: number },
): Promise<CursorPage<Facility>> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const filters = [eq(facilities.tenantId, context.tenant.tenantId)];
    if (query.cursor) {
      const cursor = decodeFacilityCursor(query.cursor);
      const cursorFilter = or(
        gt(facilities.name, cursor.name),
        and(eq(facilities.name, cursor.name), gt(facilities.id, cursor.id)),
      );
      if (cursorFilter) filters.push(cursorFilter);
    }
    const rows = await tx
      .select()
      .from(facilities)
      .where(and(...filters))
      .orderBy(asc(facilities.name), asc(facilities.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const outlets = [...new Set(page.map((row) => row.outletId))];
    for (const outletId of outlets)
      await assertFacilityPermission(
        tx,
        context,
        actor,
        CONFIG_PERMISSION,
        outletId,
      );
    return {
      data: page.map(toFacility),
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

/** Strict keyset decode; a tampered cursor is a 422, never a 500. */
function decodeFacilityCursor(cursor: string): { name: string; id: string } {
  let keys: ReturnType<typeof decodeCursor>;
  try {
    keys = decodeCursor(cursor);
  } catch {
    throw new HttpError(422, "VALIDATION_ERROR", "Periksa cursor.");
  }
  const [name, id] = keys;
  const parsedId = typeof id === "string" ? uuidSchema.safeParse(id) : null;
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    parsedId === null ||
    !parsedId.success
  )
    throw new HttpError(422, "VALIDATION_ERROR", "Periksa cursor.");
  return { name, id: parsedId.data };
}

export async function getFacilityConfig(
  context: ScopedTenantContext,
  actorUserId: string,
  query: { facilityId: string },
): Promise<FacilityConfig> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const facility = await loadFacility(tx, context, query.facilityId);
    await assertFacilityPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      facility.outletId,
    );
    const tenantId = context.tenant.tenantId;
    const areas = await tx
      .select()
      .from(facilityAreas)
      .where(
        and(
          eq(facilityAreas.tenantId, tenantId),
          eq(facilityAreas.facilityId, facility.id),
        ),
      )
      .orderBy(asc(facilityAreas.sortOrder), asc(facilityAreas.name));
    const units = await tx
      .select()
      .from(facilityUnits)
      .where(
        and(
          eq(facilityUnits.tenantId, tenantId),
          eq(facilityUnits.facilityId, facility.id),
        ),
      )
      .orderBy(asc(facilityUnits.sortOrder), asc(facilityUnits.code));
    return facilityConfigSchema.parse({
      facility: toFacility(facility),
      areas: areas.map(toArea),
      units: units.map(toUnit),
      products: await listFacilityProducts(tx, tenantId, facility.id),
      addons: await listFacilityAddons(tx, tenantId, facility.id),
      entitlementRules: await listEntitlementRules(tx, tenantId, facility.id),
      subscriptionPlans: await listFacilitySubscriptionPlans(
        tx,
        tenantId,
        facility.id,
      ),
      wifiPolicies: await listWifiPoliciesForFacility(
        tx,
        tenantId,
        facility.outletId,
        facility.id,
      ),
    });
  });
}

export async function updateFacility(
  context: ScopedTenantContext,
  actorUserId: string,
  facilityId: string,
  input: UpdateFacilityInput,
  now = new Date(),
): Promise<Facility> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const [locked] = await tx
      .select()
      .from(facilities)
      .where(
        and(
          eq(facilities.tenantId, context.tenant.tenantId),
          eq(facilities.id, facilityId),
        ),
      )
      .limit(1)
      .for("update");
    if (!locked) throw notFound("Fasilitas");
    await assertFacilityPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      locked.outletId,
    );
    const before = toFacility(locked);
    const merged = { ...before, ...input };
    const slot = slotConfigSchema.safeParse({
      sessionMinutes: merged.sessionMinutes,
      cleaningMinutes: merged.cleaningMinutes,
    });
    if (!slot.success)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        slot.error.issues[0]?.message ?? "Periksa durasi sesi.",
      );
    const next = toFacility({ ...locked, ...input });
    const [row] = await tx
      .update(facilities)
      .set({
        name: next.name,
        type: next.type,
        sessionMinutes: next.sessionMinutes,
        cleaningMinutes: next.cleaningMinutes,
        arrivalGraceMinutes: next.arrivalGraceMinutes,
        operatingHours: next.operatingHours,
        overtimePolicy: next.overtimePolicy,
        cancellationPolicy: next.cancellationPolicy,
        updatedAt: now,
      })
      .where(
        and(
          eq(facilities.tenantId, context.tenant.tenantId),
          eq(facilities.id, facilityId),
        ),
      )
      .returning();
    const after = toFacility(row);
    await auditFacility(tx, context, actor, now, {
      action: "facility.updated",
      objectType: "facility",
      objectId: after.id,
      outletId: after.outletId,
      before: {
        id: before.id,
        type: before.type,
        sessionMinutes: before.sessionMinutes,
        cleaningMinutes: before.cleaningMinutes,
        arrivalGraceMinutes: before.arrivalGraceMinutes,
      },
      after: {
        id: after.id,
        type: after.type,
        sessionMinutes: after.sessionMinutes,
        cleaningMinutes: after.cleaningMinutes,
        arrivalGraceMinutes: after.arrivalGraceMinutes,
      },
    });
    return after;
  });
}

export async function createFacilityArea(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateFacilityAreaInput,
  now = new Date(),
): Promise<FacilityArea> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const facility = await loadFacility(tx, context, input.facilityId);
    await assertFacilityPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      facility.outletId,
    );
    let row;
    try {
      [row] = await tx
        .insert(facilityAreas)
        .values({
          tenantId: context.tenant.tenantId,
          outletId: facility.outletId,
          facilityId: facility.id,
          name: input.name,
          entranceLockDeviceId: input.entranceLockDeviceId ?? null,
          sortOrder: input.sortOrder ?? 0,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
    } catch (error) {
      if (pgErrorCode(error) === PG_UNIQUE_VIOLATION)
        throw new HttpError(
          409,
          "FACILITY_AREA_NAME_TAKEN",
          "Nama area sudah dipakai di fasilitas ini.",
        );
      throw error;
    }
    await auditFacility(tx, context, actor, now, {
      action: "facility_area.created",
      objectType: "facility_area",
      objectId: row.id,
      outletId: row.outletId,
      before: null,
      after: {
        id: row.id,
        facilityId: row.facilityId,
        sortOrder: row.sortOrder,
      },
    });
    return toArea(row);
  });
}

export async function updateFacilityArea(
  context: ScopedTenantContext,
  actorUserId: string,
  areaId: string,
  input: UpdateAreaInput,
  now = new Date(),
): Promise<FacilityArea> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const existing = await loadArea(tx, context, areaId);
    await assertFacilityPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      existing.outletId,
    );
    let row;
    try {
      [row] = await tx
        .update(facilityAreas)
        .set({
          ...(input.name !== undefined && { name: input.name }),
          ...(input.entranceLockDeviceId !== undefined && {
            entranceLockDeviceId: input.entranceLockDeviceId,
          }),
          ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
          updatedAt: now,
        })
        .where(
          and(
            eq(facilityAreas.tenantId, context.tenant.tenantId),
            eq(facilityAreas.id, areaId),
          ),
        )
        .returning();
    } catch (error) {
      if (pgErrorCode(error) === PG_UNIQUE_VIOLATION)
        throw new HttpError(
          409,
          "FACILITY_AREA_NAME_TAKEN",
          "Nama area sudah dipakai di fasilitas ini.",
        );
      throw error;
    }
    await auditFacility(tx, context, actor, now, {
      action: "facility_area.updated",
      objectType: "facility_area",
      objectId: row.id,
      outletId: row.outletId,
      before: { id: existing.id, sortOrder: existing.sortOrder },
      after: { id: row.id, sortOrder: row.sortOrder },
    });
    return toArea(row);
  });
}

export async function createFacilityUnit(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateFacilityUnitInput,
  now = new Date(),
): Promise<FacilityUnit> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const facility = await loadFacility(tx, context, input.facilityId);
    await assertFacilityPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      facility.outletId,
    );
    const area = await loadArea(tx, context, input.areaId);
    if (area.facilityId !== facility.id)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Area bukan bagian dari fasilitas ini.",
      );
    let row;
    try {
      [row] = await tx
        .insert(facilityUnits)
        .values({
          tenantId: context.tenant.tenantId,
          outletId: facility.outletId,
          facilityId: facility.id,
          areaId: area.id,
          code: input.code,
          lockDeviceId: input.lockDeviceId ?? null,
          panicDeviceId: input.panicDeviceId ?? null,
          // A new unit is clean and ready (FAC-06 starts from `available`).
          status: "available",
          sortOrder: input.sortOrder ?? 0,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
    } catch (error) {
      if (pgErrorCode(error) === PG_UNIQUE_VIOLATION)
        throw new HttpError(
          409,
          "FACILITY_UNIT_CODE_TAKEN",
          "Kode bilik sudah dipakai di fasilitas ini.",
        );
      throw error;
    }
    await auditFacility(tx, context, actor, now, {
      action: "facility_unit.created",
      objectType: "facility_unit",
      objectId: row.id,
      outletId: row.outletId,
      before: null,
      after: {
        id: row.id,
        facilityId: row.facilityId,
        areaId: row.areaId,
        code: row.code,
        status: row.status,
      },
    });
    return toUnit(row);
  });
}
