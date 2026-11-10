// Guest Wi-Fi quota policy per floor zone (PRD v1.7 §3 F22/F25 "Wi-Fi Berbasis
// Belanja", "Jam Ramai & Jam Sepi", §3 F39; FAC-12..FAC-14; bead legend-8dpm).
// Routes: routes/wifi.routes.ts (PUT /api/wifi/policies/:policyId); the config
// read model lists the same rows (facility-config.service.ts).
//
// The policy is configuration: an admin changes the numbers and the next
// quota computation reads them, with no redeploy (FAC-14). One policy per
// zone: PUT replaces the zone's row wholesale. The zone belongs to WS-03's
// `floor_zones`, so its outlet is resolved there and the permission is
// re-checked on that outlet (TEN-03); the tenant never comes from the body
// (TEN-02).
import { and, asc, eq, isNull, or } from "drizzle-orm";
import {
  userIdSchema,
  type OutletId,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  wifiPolicySchema,
  type PutWifiPolicyInput,
  type WifiPolicy,
} from "@starter/shared/facility";
import { db } from "../db/index.ts";
import { floorZones } from "../db/schema/floor.ts";
import { wifiPolicies } from "../db/schema/facility.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { assertConfigFresh } from "./facility-config-guard.ts";
import {
  assertFacilityPermission,
  auditFacility,
  CONFIG_PERMISSION,
  loadFacility,
  notFound,
  PG_UNIQUE_VIOLATION,
  pgErrorCode,
  type Tx,
} from "./facility-shared.ts";

type PolicyRow = typeof wifiPolicies.$inferSelect;

/**
 * Runs the upsert and translates the one-per-zone unique violation into a 409;
 * the path id stays the key, so a second policy for the same zone is refused.
 */
async function guardingZonePolicyWrite<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION)
      throw new HttpError(
        409,
        "WIFI_POLICY_ZONE_TAKEN",
        "Zona ini sudah memiliki kebijakan Wi-Fi.",
      );
    throw error;
  }
}

export function toWifiPolicy(row: PolicyRow): WifiPolicy {
  return wifiPolicySchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    zoneId: row.zoneId,
    freeMinutes: row.freeMinutes,
    peakFreeMinutes: row.peakFreeMinutes,
    spendPerExtraHourIdr: row.spendPerExtraHourIdr,
    extraMinutes: row.extraMinutes,
    maxDevices: row.maxDevices,
    peakSchedule: row.peakSchedule,
    baseSpeedKbps: row.baseSpeedKbps,
    fullSpeedKbps: row.fullSpeedKbps,
    minSpendPerHourIdr: row.minSpendPerHourIdr,
    tierBonusMinutes: row.tierBonusMinutes,
    // A null column reads as no mode (the contract default, per_day_multiple).
    spendMode: row.spendMode ?? undefined,
    updatedAt: row.updatedAt.toISOString(),
  });
}

/**
 * The policies that apply to one facility: its own rows plus the outlet-wide
 * ones (`facility_id` null applies to the zone wherever the facility is), so
 * a policy created without a facility is still visible in the config screen.
 */
export async function listWifiPoliciesForFacility(
  tx: Tx,
  tenantId: TenantId,
  outletId: OutletId,
  facilityId: string,
): Promise<WifiPolicy[]> {
  const rows = await tx
    .select()
    .from(wifiPolicies)
    .where(
      and(
        eq(wifiPolicies.tenantId, tenantId),
        or(
          eq(wifiPolicies.facilityId, facilityId),
          and(
            eq(wifiPolicies.outletId, outletId),
            isNull(wifiPolicies.facilityId),
          ),
        ),
      ),
    )
    .orderBy(asc(wifiPolicies.createdAt), asc(wifiPolicies.id));
  return rows.map(toWifiPolicy);
}

/**
 * PUT /policies/:policyId — upsert keyed by the path id. The row is replaced
 * wholesale, so every number in the body is the new policy; a body that
 * violates a cross-field rule of `wifiPolicySchema` (peak allowance above the
 * off-peak one, full speed not above the base speed, a zero spend step with
 * extra minutes) fails before anything is written.
 */
export async function putWifiPolicy(
  context: ScopedTenantContext,
  actorUserId: string,
  policyId: string,
  input: PutWifiPolicyInput,
  now = new Date(),
): Promise<WifiPolicy> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const zone = await loadZone(tx, context, input.zoneId);
    await assertFacilityPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      zone.outletId,
    );
    if (input.facilityId !== undefined) {
      const facility = await loadFacility(tx, context, input.facilityId);
      if (facility.outletId !== zone.outletId)
        throw new HttpError(
          422,
          "VALIDATION_ERROR",
          "Fasilitas bukan bagian dari outlet zona ini.",
        );
    }
    // The contract's cross-field rules are not expressible per field, so the
    // whole policy is validated before the write (a failed parse is a 422).
    wifiPolicySchema.parse({
      id: policyId,
      tenantId: context.tenant.tenantId,
      outletId: zone.outletId,
      zoneId: input.zoneId,
      freeMinutes: input.freeMinutes,
      peakFreeMinutes: input.peakFreeMinutes,
      spendPerExtraHourIdr: input.spendPerExtraHourIdr,
      extraMinutes: input.extraMinutes,
      maxDevices: input.maxDevices,
      peakSchedule: input.peakSchedule,
      baseSpeedKbps: input.baseSpeedKbps,
      fullSpeedKbps: input.fullSpeedKbps,
      minSpendPerHourIdr: input.minSpendPerHourIdr,
      tierBonusMinutes: input.tierBonusMinutes,
      spendMode: input.spendMode,
      updatedAt: now.toISOString(),
    });
    const [existing] = await tx
      .select()
      .from(wifiPolicies)
      .where(
        and(
          eq(wifiPolicies.tenantId, context.tenant.tenantId),
          eq(wifiPolicies.id, policyId),
        ),
      )
      .limit(1)
      .for("update");
    // A replace may move the policy to a zone of another outlet: the caller
    // must also hold the permission on the outlet the policy leaves (TEN-03).
    if (existing && existing.outletId !== zone.outletId)
      await assertFacilityPermission(
        tx,
        context,
        actor,
        CONFIG_PERMISSION,
        existing.outletId,
      );
    // Optimistic lock (legend-6jms): `null` = create, a stamp = replace that
    // exact version; anything else is a 409.
    assertConfigFresh(existing?.updatedAt ?? null, input.expectedUpdatedAt);
    const values = {
      tenantId: context.tenant.tenantId,
      outletId: zone.outletId,
      zoneId: input.zoneId,
      facilityId: input.facilityId ?? null,
      freeMinutes: input.freeMinutes,
      peakFreeMinutes: input.peakFreeMinutes,
      spendPerExtraHourIdr: input.spendPerExtraHourIdr,
      extraMinutes: input.extraMinutes,
      maxDevices: input.maxDevices,
      peakSchedule: input.peakSchedule,
      baseSpeedKbps: input.baseSpeedKbps,
      fullSpeedKbps: input.fullSpeedKbps,
      minSpendPerHourIdr: input.minSpendPerHourIdr,
      tierBonusMinutes: input.tierBonusMinutes,
      spendMode: input.spendMode ?? null,
      updatedAt: now,
    };
    const [row] = await guardingZonePolicyWrite(() =>
      existing
        ? tx
            .update(wifiPolicies)
            .set(values)
            .where(
              and(
                eq(wifiPolicies.tenantId, context.tenant.tenantId),
                eq(wifiPolicies.id, policyId),
              ),
            )
            .returning()
        : tx
            .insert(wifiPolicies)
            .values({ id: policyId, createdAt: now, ...values })
            .returning(),
    );
    await auditFacility(tx, context, actor, now, {
      action: existing ? "wifi_policy.replaced" : "wifi_policy.created",
      objectType: "wifi_policy",
      objectId: row.id,
      outletId: row.outletId,
      before: existing ? policyAuditValues(existing) : null,
      after: policyAuditValues(row),
    });
    return toWifiPolicy(row);
  });
}

/** Quota numbers of a policy, kept readable in the audit (old + new). */
function policyAuditValues(row: PolicyRow): Record<string, unknown> {
  return {
    id: row.id,
    facilityId: row.facilityId,
    freeMinutes: row.freeMinutes,
    peakFreeMinutes: row.peakFreeMinutes,
    spendPerExtraHourIdr: row.spendPerExtraHourIdr,
    extraMinutes: row.extraMinutes,
    maxDevices: row.maxDevices,
    minSpendPerHourIdr: row.minSpendPerHourIdr,
    baseSpeedKbps: row.baseSpeedKbps,
    fullSpeedKbps: row.fullSpeedKbps,
    // Audit values are JSON: the key is left out while the mode is unset.
    ...(row.spendMode ? { spendMode: row.spendMode } : {}),
  };
}

/** The floor zone a policy applies to; RLS hides other outlets (TEN-03). */
async function loadZone(
  tx: Tx,
  context: ScopedTenantContext,
  zoneId: string,
): Promise<{ id: string; outletId: OutletId }> {
  const [row] = await tx
    .select({ id: floorZones.id, outletId: floorZones.outletId })
    .from(floorZones)
    .where(
      and(
        eq(floorZones.tenantId, context.tenant.tenantId),
        eq(floorZones.id, zoneId),
      ),
    )
    .limit(1);
  if (!row) throw notFound("Zona");
  return { id: row.id, outletId: row.outletId };
}
