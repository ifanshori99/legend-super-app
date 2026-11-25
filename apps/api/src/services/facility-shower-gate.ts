// 1269 F0 (founder 25 Nov 2026): the paid shower room is deferred past release
// 1. `FACILITY_SHOWER_ENABLED` (off by default) closes ONLY facilities whose
// `facilities.type` is 'shower'; coworking (paid WFC), meeting rooms, lockers
// and guest Wi-Fi are untouched. The type always comes from the database row of
// the facility, never from the request. Every door that creates a shower
// ticket, hold, quota, right or claim calls one of these guards after it has
// loaded the facility and before it writes anything, so a refusal writes no
// row and takes no money. The flag is read at call time and anything but
// exactly `true` is off (fail closed). Refunds and cancellations of old
// transactions and the staff emergency unit button do not call these guards.
import { and, eq, inArray } from "drizzle-orm";
import { FacilityError } from "@starter/shared/facility";
import { env } from "../config/env.ts";
import { facilities, facilityProducts } from "../db/schema/facility.ts";
import type { Tx } from "./inventory-ops.shared.ts";

export function facilityShowerEnabled(): boolean {
  return env.FACILITY_SHOWER_ENABLED === true;
}

/** True when a facility of this type is closed right now (a shower, switch off). */
export function isShowerClosed(type: string): boolean {
  return type === "shower" && !facilityShowerEnabled();
}

/** For a facility row the caller already loaded from the database. */
export function assertFacilityOpen(facility: { type: string }): void {
  if (isShowerClosed(facility.type))
    throw new FacilityError("FACILITY_SHOWER_DISABLED");
}

/** The ids among `facilityIds` that are closed showers (empty when the switch is on). */
export async function closedShowerFacilityIds(
  tx: Tx,
  tenantId: string,
  facilityIds: readonly string[],
): Promise<Set<string>> {
  if (facilityShowerEnabled() || facilityIds.length === 0) return new Set();
  const rows = await tx
    .select({ id: facilities.id })
    .from(facilities)
    .where(
      and(
        eq(facilities.tenantId, tenantId),
        eq(facilities.type, "shower"),
        inArray(facilities.id, [...new Set(facilityIds)]),
      ),
    );
  return new Set(rows.map((row) => row.id));
}

/** Throws FACILITY_SHOWER_DISABLED when any of the facilities is a closed shower. */
export async function assertFacilityIdsOpen(
  tx: Tx,
  tenantId: string,
  facilityIds: readonly string[],
): Promise<void> {
  if ((await closedShowerFacilityIds(tx, tenantId, facilityIds)).size > 0)
    throw new FacilityError("FACILITY_SHOWER_DISABLED");
}

/** The ids among `productIds` that belong to a closed shower (empty when the switch is on). */
export async function closedShowerProductIds(
  tx: Tx,
  tenantId: string,
  productIds: readonly string[],
): Promise<Set<string>> {
  if (facilityShowerEnabled() || productIds.length === 0) return new Set();
  const rows = await tx
    .select({ id: facilityProducts.id })
    .from(facilityProducts)
    .innerJoin(
      facilities,
      and(
        eq(facilities.tenantId, facilityProducts.tenantId),
        eq(facilities.id, facilityProducts.facilityId),
      ),
    )
    .where(
      and(
        eq(facilityProducts.tenantId, tenantId),
        eq(facilities.type, "shower"),
        inArray(facilityProducts.id, [...new Set(productIds)]),
      ),
    );
  return new Set(rows.map((row) => row.id));
}

/** Throws FACILITY_SHOWER_DISABLED when the facility product belongs to a closed shower. */
export async function assertFacilityProductOpen(
  tx: Tx,
  tenantId: string,
  productId: string,
): Promise<void> {
  if ((await closedShowerProductIds(tx, tenantId, [productId])).size > 0)
    throw new FacilityError("FACILITY_SHOWER_DISABLED");
}
