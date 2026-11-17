// Facility operating hours with an effective date (bead legend-4us1a, card
// 987; PRD F22 "Konfigurasi Legend", FAC-02, FAC-06).
//
// The hours of a business date D are the version of
// `facility_operating_hours_versions` with the latest `effective_from` <= D;
// a date before the first version falls back to `facilities.operating_hours`.
// `facilities.operating_hours` itself stays the hours valid today. A change
// never rewrites a past day, and confirmed bookings are never revalidated.
//
// Every query filters by the tenant (RLS also scopes the rows), so a facility
// of another tenant resolves to nothing.
import { and, desc, eq, lte, sql } from "drizzle-orm";
import {
  businessDateOf,
  type BusinessDate,
  type OutletId,
  type TenantId,
} from "@starter/shared/core";
import type { FacilityDayHours } from "@starter/shared/facility";
import {
  facilities,
  facilityOperatingHoursVersions,
} from "../db/schema/facility.ts";
import { outlets } from "../db/schema/platform-org.ts";
import type { Tx } from "./facility-shared.ts";
import { outletBusinessDayClock } from "./outlet-clock.ts";

/** Version seeded at facility creation: it covers every date before a change. */
export const FIRST_HOURS_VERSION_DATE = "1970-01-01";

/**
 * Hours valid on one business date, or null when the facility is not visible
 * to the tenant.
 */
export async function resolveOperatingHoursOn(
  tx: Tx,
  tenantId: TenantId,
  facilityId: string,
  businessDate: BusinessDate,
): Promise<FacilityDayHours[] | null> {
  const [version] = await tx
    .select({ operatingHours: facilityOperatingHoursVersions.operatingHours })
    .from(facilityOperatingHoursVersions)
    .where(
      and(
        eq(facilityOperatingHoursVersions.tenantId, tenantId),
        eq(facilityOperatingHoursVersions.facilityId, facilityId),
        lte(facilityOperatingHoursVersions.effectiveFrom, businessDate),
      ),
    )
    .orderBy(desc(facilityOperatingHoursVersions.effectiveFrom))
    .limit(1);
  if (version) return version.operatingHours;
  const [facility] = await tx
    .select({ operatingHours: facilities.operatingHours })
    .from(facilities)
    .where(
      and(eq(facilities.tenantId, tenantId), eq(facilities.id, facilityId)),
    )
    .limit(1);
  return facility?.operatingHours ?? null;
}

/**
 * Writes the hours that start on `effectiveFrom`; a version already dated that
 * day is replaced (one row per facility and date).
 */
export async function upsertOperatingHoursVersion(
  tx: Tx,
  input: {
    tenantId: TenantId;
    outletId: OutletId;
    facilityId: string;
    effectiveFrom: BusinessDate;
    operatingHours: FacilityDayHours[];
  },
): Promise<void> {
  await tx
    .insert(facilityOperatingHoursVersions)
    .values({
      tenantId: input.tenantId,
      outletId: input.outletId,
      facilityId: input.facilityId,
      effectiveFrom: input.effectiveFrom,
      operatingHours: input.operatingHours,
    })
    .onConflictDoUpdate({
      target: [
        facilityOperatingHoursVersions.tenantId,
        facilityOperatingHoursVersions.facilityId,
        facilityOperatingHoursVersions.effectiveFrom,
      ],
      set: { operatingHours: input.operatingHours },
    });
}

/**
 * Copies, per facility of the outlet, the latest version with `effective_from`
 * <= `today` onto `facilities.operating_hours` (the hours valid today), only
 * where it differs, so a rerun changes nothing. `updated_at` is left alone: a
 * roll is not an admin edit and must not make an open config form stale.
 * Returns the number of facilities changed.
 */
export async function rollForwardOperatingHours(
  tx: Tx,
  input: { tenantId: TenantId; outletId: OutletId; today: BusinessDate },
): Promise<number> {
  const result = await tx.execute(sql`
    UPDATE facilities f
       SET operating_hours = v.operating_hours
      FROM (
        SELECT DISTINCT ON (facility_id) facility_id, operating_hours
          FROM facility_operating_hours_versions
         WHERE tenant_id = ${input.tenantId}
           AND outlet_id = ${input.outletId}
           AND effective_from <= ${input.today}::date
         ORDER BY facility_id, effective_from DESC
      ) v
     WHERE f.tenant_id = ${input.tenantId}
       AND f.outlet_id = ${input.outletId}
       AND f.id = v.facility_id
       AND f.operating_hours IS DISTINCT FROM v.operating_hours
    RETURNING f.id`);
  return result.rows.length;
}

/** Rolls one outlet forward to its own business date at `now`. */
export async function rollForwardOutletHoursNow(
  tx: Tx,
  tenantId: TenantId,
  outletId: OutletId,
  now: Date,
): Promise<number> {
  const [outlet] = await tx
    .select({
      timezone: outlets.timezone,
      businessDayCutoff: outlets.businessDayCutoff,
    })
    .from(outlets)
    .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId)))
    .limit(1);
  if (!outlet) return 0;
  return rollForwardOperatingHours(tx, {
    tenantId,
    outletId,
    today: businessDateOf(now, outletBusinessDayClock(outlet)),
  });
}
