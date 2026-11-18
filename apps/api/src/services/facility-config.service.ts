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
import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import {
  businessDateOf,
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
  type CreateFacilityInput,
  type CreateFacilityUnitInput,
  type Facility,
  type FacilityListItem,
  type FacilityArea,
  type FacilityConfig,
  type FacilityUnit,
  type UpdateFacilityInput,
  type UpdateFacilityUnitConfigInput,
  type updateFacilityAreaSchema,
} from "@starter/shared/facility";
import { db } from "../db/index.ts";
import {
  accessTickets,
  facilities,
  facilityAreas,
  facilityUnits,
} from "../db/schema/facility.ts";
import { outlets } from "../db/schema/platform-org.ts";
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
  type Tx,
} from "./facility-shared.ts";
import {
  listEntitlementRules,
  listFacilityAddons,
  listFacilityProducts,
  listFacilitySubscriptionPlans,
} from "./facility-products.service.ts";
import { listWifiPoliciesForFacility } from "./wifi-policy.service.ts";
import {
  ensureBaselineHoursVersion,
  FIRST_HOURS_VERSION_DATE,
  rollForwardOutletHoursNow,
  upsertOperatingHoursVersion,
} from "./facility-hours-versions.service.ts";
import { outletBusinessDayClock } from "./outlet-clock.ts";
import {
  assertConfigFresh,
  createOnce,
  lockConfigRow,
} from "./facility-config-guard.ts";

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
  now = new Date(),
): Promise<CursorPage<FacilityListItem>> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    // Hours whose effective date has arrived reach the column before the
    // page is read, so the admin never sees stale hours (legend-4us1a).
    const hoursOutlets = await tx
      .selectDistinct({ outletId: facilities.outletId })
      .from(facilities)
      .where(eq(facilities.tenantId, context.tenant.tenantId));
    for (const { outletId } of hoursOutlets)
      await rollForwardOutletHoursNow(
        tx,
        context.tenant.tenantId,
        outletId,
        now,
      );
    const filters = [eq(facilities.tenantId, context.tenant.tenantId)];
    if (query.cursor) {
      const cursor = decodeFacilityCursor(query.cursor);
      const cursorFilter = or(
        gt(facilities.name, cursor.name),
        and(eq(facilities.name, cursor.name), gt(facilities.id, cursor.id)),
      );
      if (cursorFilter) filters.push(cursorFilter);
    }
    // The child counts ride on the same statement as correlated scalar
    // subqueries (one round trip for the page, no per-facility reads). Columns
    // are written qualified: drizzle renders a column of a single-table select
    // unqualified, which would bind to the subquery's own table.
    const childCount = (table: string, extra = sql``) => sql<number>`(
          SELECT count(*)::int FROM ${sql.identifier(table)}
          WHERE ${sql.identifier(table)}.tenant_id = "facilities"."tenant_id"
            AND ${sql.identifier(table)}.facility_id = "facilities"."id"
            ${extra}
        )`;
    const rows = await tx
      .select({
        facility: facilities,
        areaCount: childCount("facility_areas"),
        // Retired units (legend-etawy) are not counted.
        unitCount: childCount(
          "facility_units",
          sql`AND ${sql.identifier("facility_units")}.retired_at IS NULL`,
        ),
        // Active = every status except maintenance (the admin unit summary rule).
        activeUnitCount: childCount(
          "facility_units",
          sql`AND ${sql.identifier("facility_units")}.status <> 'maintenance'
            AND ${sql.identifier("facility_units")}.retired_at IS NULL`,
        ),
        productCount: childCount("facility_products"),
      })
      .from(facilities)
      .where(and(...filters))
      .orderBy(asc(facilities.name), asc(facilities.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const outlets = [...new Set(page.map((row) => row.facility.outletId))];
    for (const outletId of outlets)
      await assertFacilityPermission(
        tx,
        context,
        actor,
        CONFIG_PERMISSION,
        outletId,
      );
    return {
      data: page.map((row) => ({
        ...toFacility(row.facility),
        areaCount: row.areaCount,
        unitCount: row.unitCount,
        activeUnitCount: row.activeUnitCount,
        productCount: row.productCount,
      })),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.facility.name, last.facility.id])
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
  now = new Date(),
): Promise<FacilityConfig> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const found = await loadFacility(tx, context, query.facilityId);
    await assertFacilityPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      found.outletId,
    );
    // Hours whose effective date has arrived reach the column first, so the
    // admin never sees stale hours (legend-4us1a); reload the row after.
    await rollForwardOutletHoursNow(
      tx,
      context.tenant.tenantId,
      found.outletId,
      now,
    );
    const facility = await loadFacility(tx, context, query.facilityId);
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
    const { expectedUpdatedAt, effectiveFrom, ...changes } = input;
    assertConfigFresh(locked.updatedAt, expectedUpdatedAt);
    // New hours start on `effectiveFrom` (default: today, outlet business
    // date). The past is never rewritten, and a future date leaves the hours
    // valid today (`facilities.operating_hours`) alone (legend-4us1a).
    const newHours = changes.operatingHours;
    let hoursStart: string | null = null;
    let hoursApplyNow = false;
    if (newHours !== undefined) {
      const [outlet] = await tx
        .select({
          timezone: outlets.timezone,
          businessDayCutoff: outlets.businessDayCutoff,
        })
        .from(outlets)
        .where(
          and(
            eq(outlets.tenantId, context.tenant.tenantId),
            eq(outlets.id, locked.outletId),
          ),
        )
        .limit(1);
      if (!outlet) throw notFound("Outlet");
      const today = businessDateOf(now, outletBusinessDayClock(outlet));
      hoursStart = effectiveFrom ?? today;
      if (hoursStart < today)
        throw new HttpError(
          422,
          "VALIDATION_ERROR",
          "Tanggal berlaku jam operasional tidak boleh di masa lalu.",
        );
      hoursApplyNow = hoursStart <= today;
    }
    if (!hoursApplyNow) delete changes.operatingHours;
    const before = toFacility(locked);
    const merged = { ...before, ...changes };
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
    const next = toFacility({ ...locked, ...changes });
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
    if (hoursStart !== null) {
      // A facility without a 1970-01-01 baseline (imported, or created before
      // the versions) keeps its current hours for every earlier day.
      await ensureBaselineHoursVersion(tx, {
        tenantId: context.tenant.tenantId,
        outletId: locked.outletId,
        facilityId: locked.id,
        operatingHours: before.operatingHours,
      });
      await upsertOperatingHoursVersion(tx, {
        tenantId: context.tenant.tenantId,
        outletId: locked.outletId,
        facilityId: locked.id,
        effectiveFrom: hoursStart,
        operatingHours: newHours ?? before.operatingHours,
      });
    }
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
    const { idempotencyKey, ...payload } = input;
    return createOnce(tx, context, {
      idempotencyKey,
      payload,
      outletId: facility.outletId,
      resultTable: "facility_areas",
      label: "Area",
      load: async (id) => loadArea(tx, context, id),
      map: toArea,
      create: async () => {
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
        return row;
      },
    });
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
    const found = await loadArea(tx, context, areaId);
    await assertFacilityPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      found.outletId,
    );
    await lockConfigRow(tx, "facility_areas", context, areaId);
    const existing = await loadArea(tx, context, areaId);
    assertConfigFresh(existing.updatedAt, input.expectedUpdatedAt);
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
    const { idempotencyKey, ...payload } = input;
    return createOnce(tx, context, {
      idempotencyKey,
      payload,
      outletId: facility.outletId,
      resultTable: "facility_units",
      label: "Bilik",
      load: async (id) => loadUnit(tx, context, id),
      map: toUnit,
      create: async () => {
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
        return row;
      },
    });
  });
}

/**
 * PATCH /units/:unitId/config — code, area, devices and order of a unit. The
 * operational state (maintenance flag, cleaning) is not touched here.
 */
export async function updateFacilityUnitConfig(
  context: ScopedTenantContext,
  actorUserId: string,
  unitId: string,
  input: UpdateFacilityUnitConfigInput,
  now = new Date(),
): Promise<FacilityUnit> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const found = await loadUnit(tx, context, unitId);
    if (!found) throw notFound("Bilik");
    await assertFacilityPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      found.outletId,
    );
    await lockConfigRow(tx, "facility_units", context, unitId);
    const existing = await loadUnit(tx, context, unitId);
    if (!existing) throw notFound("Bilik");
    assertConfigFresh(existing.updatedAt, input.expectedUpdatedAt);
    if (input.areaId !== undefined) {
      const area = await loadArea(tx, context, input.areaId);
      if (area.facilityId !== existing.facilityId)
        throw new HttpError(
          422,
          "VALIDATION_ERROR",
          "Area bukan bagian dari fasilitas ini.",
        );
      if (input.areaId !== existing.areaId) {
        const [active] = await tx
          .select({ id: accessTickets.id })
          .from(accessTickets)
          .where(
            and(
              eq(accessTickets.tenantId, context.tenant.tenantId),
              eq(accessTickets.unitId, unitId),
              inArray(accessTickets.status, [
                "pending_payment",
                "issued",
                "in_use",
              ]),
            ),
          )
          .limit(1);
        if (active)
          throw new HttpError(
            409,
            "CONFLICT",
            "Bilik masih punya tiket aktif, jadi tidak bisa dipindah ke area lain. Selesaikan atau batalkan tiketnya dulu.",
          );
      }
    }
    let row;
    try {
      [row] = await tx
        .update(facilityUnits)
        .set({
          ...(input.areaId !== undefined && { areaId: input.areaId }),
          ...(input.code !== undefined && { code: input.code }),
          ...(input.lockDeviceId !== undefined && {
            lockDeviceId: input.lockDeviceId,
          }),
          ...(input.panicDeviceId !== undefined && {
            panicDeviceId: input.panicDeviceId,
          }),
          ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
          updatedAt: now,
        })
        .where(
          and(
            eq(facilityUnits.tenantId, context.tenant.tenantId),
            eq(facilityUnits.id, unitId),
          ),
        )
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
      action: "facility_unit.config_updated",
      objectType: "facility_unit",
      objectId: row.id,
      outletId: row.outletId,
      before: {
        id: existing.id,
        areaId: existing.areaId,
        code: existing.code,
        lockDeviceId: existing.lockDeviceId,
        panicDeviceId: existing.panicDeviceId,
        sortOrder: existing.sortOrder,
      },
      after: {
        id: row.id,
        areaId: row.areaId,
        code: row.code,
        lockDeviceId: row.lockDeviceId,
        panicDeviceId: row.panicDeviceId,
        sortOrder: row.sortOrder,
      },
    });
    return toUnit(row);
  });
}

async function loadUnit(tx: Tx, context: ScopedTenantContext, unitId: string) {
  const [row] = await tx
    .select()
    .from(facilityUnits)
    .where(
      and(
        eq(facilityUnits.tenantId, context.tenant.tenantId),
        eq(facilityUnits.id, unitId),
      ),
    )
    .limit(1);
  return row;
}

/**
 * POST /facilities — one facility of an outlet, idempotent per key. The
 * caller must hold `facility.config.manage` on the named outlet (TEN-03); an
 * outlet outside the caller's reach is hidden by RLS (404).
 */
export async function createFacility(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateFacilityInput,
  now = new Date(),
): Promise<Facility> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const [outlet] = await tx
      .select({ id: outlets.id })
      .from(outlets)
      .where(
        and(
          eq(outlets.tenantId, context.tenant.tenantId),
          eq(outlets.id, input.outletId),
        ),
      )
      .limit(1);
    if (!outlet) throw notFound("Outlet");
    await assertFacilityPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      outlet.id,
    );
    const slot = slotConfigSchema.safeParse({
      sessionMinutes: input.sessionMinutes,
      cleaningMinutes: input.cleaningMinutes,
    });
    if (!slot.success)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        slot.error.issues[0]?.message ?? "Periksa durasi sesi.",
      );
    const { idempotencyKey, ...payload } = input;
    return createOnce(tx, context, {
      idempotencyKey,
      payload,
      outletId: outlet.id,
      resultTable: "facilities",
      label: "Fasilitas",
      load: async (id) => {
        const [row] = await tx
          .select()
          .from(facilities)
          .where(
            and(
              eq(facilities.tenantId, context.tenant.tenantId),
              eq(facilities.id, id),
            ),
          )
          .limit(1);
        return row;
      },
      map: toFacility,
      create: async () => {
        const [row] = await tx
          .insert(facilities)
          .values({
            tenantId: context.tenant.tenantId,
            outletId: input.outletId,
            name: input.name,
            type: input.type,
            sessionMinutes: input.sessionMinutes,
            cleaningMinutes: input.cleaningMinutes,
            arrivalGraceMinutes: input.arrivalGraceMinutes,
            operatingHours: input.operatingHours,
            overtimePolicy: input.overtimePolicy,
            cancellationPolicy: input.cancellationPolicy,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        await upsertOperatingHoursVersion(tx, {
          tenantId: context.tenant.tenantId,
          outletId: row.outletId,
          facilityId: row.id,
          effectiveFrom: FIRST_HOURS_VERSION_DATE,
          operatingHours: row.operatingHours,
        });
        await auditFacility(tx, context, actor, now, {
          action: "facility.created",
          objectType: "facility",
          objectId: row.id,
          outletId: row.outletId,
          before: null,
          after: {
            id: row.id,
            type: row.type,
            sessionMinutes: row.sessionMinutes,
            cleaningMinutes: row.cleaningMinutes,
            arrivalGraceMinutes: row.arrivalGraceMinutes,
          },
        });
        return row;
      },
    });
  });
}
