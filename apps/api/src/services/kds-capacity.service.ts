// Kitchen capacity rules (beads legend-w4nq4 + legend-44jm; PRD v1.7 §6
// `kitchen_capacity_rules`, F12, KDS-05; contract @starter/shared/kitchen
// `listCapacityRules` + `updateCapacityRules`).
//
// - `listCapacityRules`: every rule of the outlet, in a stable order: station
//   id, then `window_minutes`, then row id. Tenant and outlet RLS plus an
//   explicit outlet filter keep other tenants and outlets out.
// - `replaceCapacityRules`: replaces ONE station's whole list in one
//   `withTenant` transaction (delete, then insert). The station row is locked
//   (FOR NO KEY UPDATE, so ticket routing keeps its FK checks) so two
//   concurrent replaces of the same station run one after the other and the
//   final list is exactly one of the two bodies, never a mix.

import { and, asc, eq, isNull } from "drizzle-orm";
import {
  CoreError,
  createUlid,
  toIsoDateTime,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  capacityRuleSchema,
  type CapacityRule,
  type CapacityRuleInput,
} from "@starter/shared/kitchen";
import { db } from "../db/index.ts";
import { stations } from "../db/schema/index.ts";
import { kitchenCapacityRules } from "../db/schema/kds-capacity.ts";
import { withTenant } from "../db/tenant.ts";
import { recordAudit } from "./core-audit.ts";
import type { KdsActor } from "./kds-support.ts";
import type { Tx } from "./menu-internals.ts";

type RuleRow = typeof kitchenCapacityRules.$inferSelect;

const stationNotFound = () =>
  new CoreError("NOT_FOUND", "Stasiun dapur tidak ditemukan di outlet ini.");

function ruleDto(row: RuleRow): CapacityRule {
  return capacityRuleSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    stationId: row.stationId,
    windowMinutes: row.windowMinutes,
    capacityPoints: row.capacityPoints,
    nearCapacityBp: row.nearCapacityBp,
    schedule: row.schedule,
    channelPriority: row.channelPriority,
  });
}

/** Station must be an active station of this outlet; locks it for the replace. */
async function lockStationInOutlet(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
  stationId: string,
): Promise<void> {
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
    )
    .for("no key update");
  if (!station) throw stationNotFound();
}

export async function listCapacityRules(
  context: ScopedTenantContext,
  outletId: OutletId,
): Promise<CapacityRule[]> {
  return withTenant(db, context, async (tx) => {
    const rows = await tx
      .select()
      .from(kitchenCapacityRules)
      .where(
        and(
          eq(kitchenCapacityRules.tenantId, context.tenant.tenantId),
          eq(kitchenCapacityRules.outletId, outletId),
        ),
      )
      .orderBy(
        asc(kitchenCapacityRules.stationId),
        asc(kitchenCapacityRules.windowMinutes),
        asc(kitchenCapacityRules.id),
      );
    return rows.map(ruleDto);
  });
}

export async function replaceCapacityRules(
  context: ScopedTenantContext,
  outletId: OutletId,
  stationId: string,
  rules: CapacityRuleInput[],
  actor: KdsActor,
  now: Date,
): Promise<CapacityRule[]> {
  return withTenant(db, context, async (tx) => {
    await lockStationInOutlet(tx, context, outletId, stationId);
    const removed = await tx
      .delete(kitchenCapacityRules)
      .where(
        and(
          eq(kitchenCapacityRules.tenantId, context.tenant.tenantId),
          eq(kitchenCapacityRules.outletId, outletId),
          eq(kitchenCapacityRules.stationId, stationId),
        ),
      )
      .returning({ id: kitchenCapacityRules.id });
    const rows = await tx
      .insert(kitchenCapacityRules)
      .values(
        rules.map((rule) => ({
          tenantId: context.tenant.tenantId,
          outletId,
          stationId,
          windowMinutes: rule.windowMinutes,
          capacityPoints: rule.capacityPoints,
          nearCapacityBp: rule.nearCapacityBp,
          schedule: rule.schedule,
          channelPriority: rule.channelPriority,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .returning();
    // Who changed a station's capacity rules (same tx; the actor is the acting
    // cashier when the request carries a live X-Acting-Staff token).
    await recordAudit(
      tx,
      context,
      {
        id: createUlid(now.getTime()),
        tenantId: context.tenant.tenantId,
        outletId,
        actorType: "user",
        actorId: actor.userId,
        deviceId: actor.deviceId,
        action: "kitchen_capacity_rules.replaced",
        objectType: "kitchen_station",
        objectId: stationId,
        reason: null,
        maskedChanges: {
          before: { stationId, ruleCount: removed.length },
          after: { stationId, ruleCount: rows.length },
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: toIsoDateTime(now),
      },
      ["stationId", "ruleCount"],
    );
    return rows
      .sort(
        (a, b) => a.windowMinutes - b.windowMinutes || (a.id < b.id ? -1 : 1),
      )
      .map(ruleDto);
  });
}
