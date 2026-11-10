// Cook reads (bead legend-gt7f; PRD v1.7 §3 F12; contract @starter/shared/kitchen
// `listKitchenStationLabels` + `getStationCapacityRules`).
//
// A cook or barista who holds only `kds.ticket.process` (often on one station)
// reads what the KDS screen needs about their stations: the label and target
// time, and the capacity rules. The menu station list needs `menu.item.view`
// and the capacity config read needs `kds.station.manage`; neither is loosened.
//
// - Reach is enforced in SQL: `stationScopeCondition(stations.id, permitted)`
//   plus explicit tenant and outlet filters, on top of tenant and outlet RLS.
// - The rows are slim views: no row id, tenant, outlet, printer or timestamps.

import { and, asc, eq, isNull } from "drizzle-orm";
import {
  assertOutletInScope,
  CoreError,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  stationCapacityRuleSchema,
  stationLabelSchema,
  type StationCapacityRule,
  type StationLabel,
} from "@starter/shared/kitchen";
import { db } from "../db/index.ts";
import { outlets, stations } from "../db/schema/index.ts";
import { kitchenCapacityRules } from "../db/schema/kds-capacity.ts";
import { withTenant } from "../db/tenant.ts";
import {
  assertStationPermission,
  permittedStationIds,
  stationScopeCondition,
} from "./station-access.ts";
import type { KdsActor } from "./kds.service.ts";

const PROCESS = "kds.ticket.process";

/**
 * Active stations of the outlet the caller may process, by name. A station-only
 * caller gets only their own stations; an empty reach answers an empty list.
 */
export async function listStationLabels(
  context: ScopedTenantContext,
  actor: KdsActor,
  outletRef: string,
  now: Date,
): Promise<StationLabel[]> {
  const outletId = outletIdSchema.parse(outletRef);
  return withTenant(db, context, async (tx) => {
    assertOutletInScope(context.outletScope, outletId);
    // An outlet of another tenant (or an unknown one) answers 404, not an
    // empty 200, so the status cannot be used to probe which outlets exist.
    const [outlet] = await tx
      .select({ id: outlets.id })
      .from(outlets)
      .where(
        and(
          eq(outlets.tenantId, context.tenant.tenantId),
          eq(outlets.id, outletId),
        ),
      );
    if (!outlet) throw new CoreError("NOT_FOUND", "Outlet tidak ditemukan.");
    const permitted = await permittedStationIds(
      tx,
      context,
      actor.userId,
      PROCESS,
      now,
    );
    const rows = await tx
      .select({
        id: stations.id,
        name: stations.name,
        type: stations.type,
        targetSeconds: stations.targetSeconds,
      })
      .from(stations)
      .where(
        and(
          eq(stations.tenantId, context.tenant.tenantId),
          eq(stations.outletId, outletId),
          isNull(stations.deletedAt),
          stationScopeCondition(stations.id, permitted),
        ),
      )
      .orderBy(asc(stations.name), asc(stations.id));
    return rows.map((row) =>
      stationLabelSchema.parse({
        stationId: row.id,
        name: row.name,
        type: row.type,
        targetSeconds: row.targetSeconds,
      }),
    );
  });
}

/**
 * Capacity rules of one station the caller may process, ordered by window, then
 * row id. The station must be an active station of the path outlet (404
 * otherwise, so the path cannot probe a station of another outlet).
 */
export async function listStationCapacityRules(
  context: ScopedTenantContext,
  actor: KdsActor,
  outletRef: string,
  stationId: string,
  now: Date,
): Promise<StationCapacityRule[]> {
  const outletId = outletIdSchema.parse(outletRef);
  return withTenant(db, context, async (tx) => {
    await assertStationPermission(
      tx,
      context,
      actor.userId,
      PROCESS,
      stationId,
      now,
    );
    const [station] = await tx
      .select({ id: stations.id })
      .from(stations)
      .where(
        and(
          eq(stations.tenantId, context.tenant.tenantId),
          eq(stations.outletId, outletId),
          eq(stations.id, stationId),
          isNull(stations.deletedAt),
        ),
      );
    if (!station)
      throw new CoreError(
        "NOT_FOUND",
        "Stasiun dapur tidak ditemukan di outlet ini.",
      );
    const rows = await tx
      .select()
      .from(kitchenCapacityRules)
      .where(
        and(
          eq(kitchenCapacityRules.tenantId, context.tenant.tenantId),
          eq(kitchenCapacityRules.outletId, outletId),
          eq(kitchenCapacityRules.stationId, stationId),
        ),
      )
      .orderBy(
        asc(kitchenCapacityRules.windowMinutes),
        asc(kitchenCapacityRules.id),
      );
    return rows.map((row) =>
      stationCapacityRuleSchema.parse({
        stationId: row.stationId,
        windowMinutes: row.windowMinutes,
        capacityPoints: row.capacityPoints,
        nearCapacityBp: row.nearCapacityBp,
        schedule: row.schedule,
        channelPriority: row.channelPriority,
      }),
    );
  });
}
