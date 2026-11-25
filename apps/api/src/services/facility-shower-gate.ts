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
import { and, eq, inArray, sql } from "drizzle-orm";
import type { TenantId } from "@starter/shared/core";
import { FacilityError } from "@starter/shared/facility";
import { env } from "../config/env.ts";
import { eqId } from "../db/branded-ids.ts";
import {
  entitlementRules,
  facilities,
  facilityProducts,
  facilitySubscriptionPlans,
} from "../db/schema/facility.ts";
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
  tenantId: TenantId,
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
  tenantId: TenantId,
  facilityIds: readonly string[],
): Promise<void> {
  if ((await closedShowerFacilityIds(tx, tenantId, facilityIds)).size > 0)
    throw new FacilityError("FACILITY_SHOWER_DISABLED");
}

/** The ids among `productIds` that belong to a closed shower (empty when the switch is on). */
export async function closedShowerProductIds(
  tx: Tx,
  tenantId: TenantId,
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
  tenantId: TenantId,
  productId: string,
): Promise<void> {
  if ((await closedShowerProductIds(tx, tenantId, [productId])).size > 0)
    throw new FacilityError("FACILITY_SHOWER_DISABLED");
}

/**
 * The menu items among `menuItemIds` that may not be sold at the outlet while
 * the shower is closed (empty when the switch is on): the item of a shower's
 * facility product, and a menu package whose enabled rule gives a shower right.
 * Sold, they would take money for a right nobody can use.
 */
export async function closedShowerMenuItemIds(
  tx: Tx,
  tenantId: TenantId,
  outletId: string,
  menuItemIds: readonly string[],
): Promise<Set<string>> {
  if (facilityShowerEnabled() || menuItemIds.length === 0) return new Set();
  const ids = [...new Set(menuItemIds)];
  const products = await tx
    .select({ menuItemId: facilityProducts.menuItemId })
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
        eqId(facilityProducts.outletId, outletId),
        eq(facilities.type, "shower"),
        inArray(facilityProducts.menuItemId, ids),
      ),
    );
  const packageItem = sql<string>`${entitlementRules.condition}->>'menuItemId'`;
  const packages = await tx
    .select({ menuItemId: packageItem })
    .from(entitlementRules)
    .innerJoin(
      facilities,
      and(
        eq(facilities.tenantId, entitlementRules.tenantId),
        eq(facilities.id, entitlementRules.facilityId),
      ),
    )
    .where(
      and(
        eq(entitlementRules.tenantId, tenantId),
        eqId(entitlementRules.outletId, outletId),
        eq(entitlementRules.type, "package"),
        eq(entitlementRules.isEnabled, true),
        eq(facilities.type, "shower"),
        inArray(packageItem, ids),
      ),
    );
  return new Set(
    [...products, ...packages].flatMap((row) =>
      row.menuItemId === null ? [] : [row.menuItemId],
    ),
  );
}

/**
 * Throws FACILITY_SHOWER_DISABLED when the recurring plan (by its provider plan
 * id) pays for a plan of a closed shower: the guest would be charged every
 * month for a quota that is never granted.
 */
export async function assertRecurringPlanOpen(
  tx: Tx,
  tenantId: TenantId,
  plan: { outletId: string; providerPlanId: string },
): Promise<void> {
  if (facilityShowerEnabled()) return;
  const rows = await tx
    .select({ facilityId: facilitySubscriptionPlans.facilityId })
    .from(facilitySubscriptionPlans)
    .where(
      and(
        eq(facilitySubscriptionPlans.tenantId, tenantId),
        eqId(facilitySubscriptionPlans.outletId, plan.outletId),
        eq(facilitySubscriptionPlans.providerPlanId, plan.providerPlanId),
      ),
    );
  await assertFacilityIdsOpen(
    tx,
    tenantId,
    rows.map((row) => row.facilityId),
  );
}
