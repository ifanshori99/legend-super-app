// Facility, area and unit configuration (PRD v1.7 §3 F22 "Model Generik",
// "Konfigurasi Legend"; bead legend-nm4f). Routes: routes/facility.routes.ts.
//
// Every function runs inside `withTenant` (RLS scopes rows to the tenant and
// the caller's outlets) and re-checks `facility.config.manage` on the
// facility's own outlet. Products, add-ons, entitlement rules, subscription
// plans and Wi-Fi policies live in later beads; the config read model returns
// them as empty lists until those tables land.
import { and, asc, eq } from "drizzle-orm";
import {
  type ScopedTenantContext,
  userIdSchema,
  type z,
} from "@starter/shared/core";
import {
  facilityConfigSchema,
  slotConfigSchema,
  type CreateFacilityAreaInput,
  type CreateFacilityUnitInput,
  type FacilityArea,
  type FacilityConfig,
  type FacilityUnit,
  type UpdateFacilityInput,
  type updateFacilityAreaSchema,
  type Facility,
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

type UpdateAreaInput = z.output<typeof updateFacilityAreaSchema>;

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
    const areas = await tx
      .select()
      .from(facilityAreas)
      .where(
        and(
          eq(facilityAreas.tenantId, context.tenant.tenantId),
          eq(facilityAreas.facilityId, facility.id),
        ),
      )
      .orderBy(asc(facilityAreas.sortOrder), asc(facilityAreas.name));
    const units = await tx
      .select()
      .from(facilityUnits)
      .where(
        and(
          eq(facilityUnits.tenantId, context.tenant.tenantId),
          eq(facilityUnits.facilityId, facility.id),
        ),
      )
      .orderBy(asc(facilityUnits.sortOrder), asc(facilityUnits.code));
    return facilityConfigSchema.parse({
      facility: toFacility(facility),
      areas: areas.map(toArea),
      units: units.map(toUnit),
      products: [],
      addons: [],
      entitlementRules: [],
      subscriptionPlans: [],
      wifiPolicies: [],
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
