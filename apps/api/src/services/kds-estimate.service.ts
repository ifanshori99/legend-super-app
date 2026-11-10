// Serving-time estimate (bead legend-gyc; PRD v1.7 §3 F12 "Estimasi Waktu Saji
// Real-time", KDS-05; contract @starter/shared/kitchen `estimateServingTime`).
//
// ETA of an outlet = the slowest station the cart touches: the time the
// channel's queue ahead needs to clear at the station's throughput, plus the
// service time (history median or the longest line's prep time). Pure maths
// lives in kds-pacing-core.ts; queue and history reads in kds-pacing.service.ts.
//
// Two entry points share one computation:
// - `estimateServingTime`: the staff endpoint, which only knows a channel and
//   the cart's load points, so it measures the outlet's most loaded station.
// - `kdsServingEstimatePort`: the QR/POS cart port, which knows the lines.

import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  servingTimeEstimateSchema,
  type ServingTimeEstimate,
} from "@starter/shared/kitchen";
import {
  outletIdSchema,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { db } from "../db/index.ts";
import { menuItems, outlets, stations } from "../db/schema/index.ts";
import { kitchenCapacityRules } from "../db/schema/kds-capacity.ts";
import { kitchenMenuLoads } from "../db/schema/kds-pacing.ts";
import { withTenant } from "../db/tenant.ts";
import {
  FALLBACK_SERVICE_SECONDS,
  etaMinutes,
  etaRange,
  pickActiveRule,
  queueAheadPoints,
  serviceSeconds,
  stationDelayMinutes,
  type PacingRule,
} from "./kds-pacing-core.ts";
import {
  evaluatePacingIfStale,
  readStationHistory,
  readStationQueue,
  resolveItemStations,
} from "./kds-pacing.service.ts";
import type { Tx } from "./menu-internals.ts";
import { QR_PRICE_CHANNEL } from "./qr-order-pricing.ts";
import {
  setQrOrderServingEstimatePort,
  type ServingEstimatePort,
} from "./qr-order-ports.ts";

type StationEta = {
  etaMinutes: number;
  queueItems: number;
  queueLoadPoints: number;
};

/** Minutes of a whole outlet are capped by the contract (`estimatedMinutes`). */
const MAX_ESTIMATE_MINUTES = 720;

async function activeRules(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
  now: Date,
): Promise<Map<string, PacingRule>> {
  const [outlet] = await tx
    .select({ timezone: outlets.timezone })
    .from(outlets)
    .where(
      and(
        eq(outlets.tenantId, context.tenant.tenantId),
        eq(outlets.id, outletId),
      ),
    );
  const rows = await tx
    .select()
    .from(kitchenCapacityRules)
    .where(
      and(
        eq(kitchenCapacityRules.tenantId, context.tenant.tenantId),
        eq(kitchenCapacityRules.outletId, outletId),
      ),
    );
  const byStation = new Map<string, PacingRule[]>();
  for (const row of rows) {
    const list = byStation.get(row.stationId) ?? [];
    list.push({
      stationId: row.stationId,
      windowMinutes: row.windowMinutes,
      capacityPoints: row.capacityPoints,
      nearCapacityBp: row.nearCapacityBp,
      schedule: row.schedule,
      channelPriority: row.channelPriority,
    });
    byStation.set(row.stationId, list);
  }
  const active = new Map<string, PacingRule>();
  for (const [stationId, rules] of byStation) {
    const rule = pickActiveRule(rules, now, outlet?.timezone ?? "UTC");
    if (rule) active.set(stationId, rule);
  }
  return active;
}

/**
 * ETA per station. `touched` maps a station to the longest prep seconds among
 * the cart's lines there (null when unknown); `null` = no cart lines, so the
 * outlet's most loaded station with a rule stands in.
 */
async function stationEtas(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
  input: {
    channel: string;
    touched: Map<string, number | null> | null;
    /** The cart's own points: one figure for all, or per touched station. */
    cartPoints: number | ReadonlyMap<string, number>;
  },
  now: Date,
): Promise<StationEta[]> {
  const rules = await activeRules(tx, context, outletId, now);
  const queues = new Map(
    (await readStationQueue(tx, context, outletId)).map((entry) => [
      entry.stationId,
      entry.items,
    ]),
  );
  const usedOf = (stationId: string) =>
    (queues.get(stationId) ?? []).reduce((sum, item) => sum + item.points, 0);

  let touched = input.touched;
  if (touched === null) {
    let busiest: string | null = null;
    let busiestRatio = -1;
    for (const [stationId, rule] of rules) {
      const ratio = usedOf(stationId) / rule.capacityPoints;
      if (ratio > busiestRatio) {
        busiest = stationId;
        busiestRatio = ratio;
      }
    }
    touched = new Map(busiest === null ? [] : [[busiest, null]]);
  }
  if (touched.size === 0)
    return [
      {
        etaMinutes: etaMinutes({
          delayMinutes: 0,
          serviceSeconds: serviceSeconds({
            historyMedianSeconds: null,
            longestLinePrepSeconds: null,
          }),
        }),
        queueItems: 0,
        queueLoadPoints: 0,
      },
    ];

  const result: StationEta[] = [];
  for (const [stationId, longestLinePrepSeconds] of touched) {
    const rule = rules.get(stationId) ?? null;
    const items = queues.get(stationId) ?? [];
    // No active rule: no throughput to divide by, so no queue delay.
    const delayMinutes = rule
      ? stationDelayMinutes({
          aheadPoints:
            queueAheadPoints(items, input.channel, rule.channelPriority) +
            (typeof input.cartPoints === "number"
              ? input.cartPoints
              : (input.cartPoints.get(stationId) ?? 0)),
          capacityPoints: rule.capacityPoints,
          windowMinutes: rule.windowMinutes,
        })
      : 0;
    const history = await readStationHistory(
      tx,
      context,
      outletId,
      stationId,
      now,
    );
    result.push({
      etaMinutes: etaMinutes({
        delayMinutes,
        serviceSeconds: serviceSeconds({
          historyMedianSeconds: history,
          longestLinePrepSeconds,
        }),
      }),
      queueItems: items.reduce((sum, item) => sum + item.quantity, 0),
      queueLoadPoints: usedOf(stationId),
    });
  }
  return result;
}

export async function estimateServingTime(
  context: ScopedTenantContext,
  outletId: OutletId,
  query: { channel: string; loadPoints: number },
  now: Date,
): Promise<ServingTimeEstimate> {
  // KDS-05: refresh pacing state (pauses, alerts) before answering.
  await evaluatePacingIfStale(context, outletId, now);
  return withTenant(db, context, async (tx) => {
    const etas = await stationEtas(
      tx,
      context,
      outletId,
      { channel: query.channel, touched: null, cartPoints: query.loadPoints },
      now,
    );
    const slowest = etas.reduce((a, b) =>
      b.etaMinutes > a.etaMinutes ? b : a,
    );
    const minutes = Math.min(slowest.etaMinutes, MAX_ESTIMATE_MINUTES);
    return servingTimeEstimateSchema.parse({
      tenantId: context.tenant.tenantId,
      outletId,
      channel: query.channel,
      queueItems: slowest.queueItems,
      queueLoadPoints: slowest.queueLoadPoints,
      estimatedMinutes: minutes,
      estimatedReadyAt: new Date(
        now.getTime() + minutes * 60_000,
      ).toISOString(),
      computedAt: now.toISOString(),
    });
  });
}

/**
 * Station of each cart line, by the real KDS routing (`resolveItemStations`),
 * with the longest prep seconds of its lines there: the line's load row (item
 * level, else the slowest variant row), else the station target, else the
 * fallback. `points` is the cart's own load per station (load points x
 * quantity, item-level row, else the heaviest variant row, else 1). Lines that
 * resolve to no station do not touch one.
 */
async function touchedStations(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
  lines: readonly { menuItemId: string; quantity: number }[],
): Promise<{
  prep: Map<string, number | null>;
  points: Map<string, number>;
}> {
  const touched = new Map<string, number | null>();
  const points = new Map<string, number>();
  const itemIds = [...new Set(lines.map((line) => line.menuItemId))];
  if (itemIds.length === 0) return { prep: touched, points };
  const tenantId = context.tenant.tenantId;
  const items = await tx
    .select({
      id: menuItems.id,
      stationId: menuItems.stationId,
      stationType: menuItems.stationType,
    })
    .from(menuItems)
    .where(
      and(eq(menuItems.tenantId, tenantId), inArray(menuItems.id, itemIds)),
    );
  const stationOfItem = await resolveItemStations(tx, context, outletId, items);
  const stationIds = [...new Set(stationOfItem.values())];
  if (stationIds.length === 0) return { prep: touched, points };
  const stationRows = await tx
    .select({ id: stations.id, targetSeconds: stations.targetSeconds })
    .from(stations)
    .where(
      and(
        eq(stations.tenantId, tenantId),
        eq(stations.outletId, outletId),
        inArray(stations.id, stationIds),
        isNull(stations.deletedAt),
      ),
    );
  const targetOf = new Map(
    stationRows.map((row) => [row.id, row.targetSeconds]),
  );
  const loads = await tx
    .select({
      menuItemId: kitchenMenuLoads.menuItemId,
      variantId: kitchenMenuLoads.variantId,
      loadPoints: kitchenMenuLoads.loadPoints,
      prepSeconds: kitchenMenuLoads.prepSeconds,
    })
    .from(kitchenMenuLoads)
    .where(
      and(
        eq(kitchenMenuLoads.tenantId, tenantId),
        eq(kitchenMenuLoads.outletId, outletId),
        inArray(kitchenMenuLoads.menuItemId, itemIds),
      ),
    );
  const loadOfItem = (
    itemId: string,
    stationTarget: number | null,
  ): { prep: number; points: number } => {
    const own = loads.filter((load) => load.menuItemId === itemId);
    const itemLevel = own.find((load) => load.variantId === null);
    if (itemLevel)
      return { prep: itemLevel.prepSeconds, points: itemLevel.loadPoints };
    if (own.length > 0)
      return {
        prep: Math.max(...own.map((load) => load.prepSeconds)),
        points: Math.max(...own.map((load) => load.loadPoints)),
      };
    return { prep: stationTarget ?? FALLBACK_SERVICE_SECONDS, points: 1 };
  };
  const quantityOf = new Map<string, number>();
  for (const line of lines)
    quantityOf.set(
      line.menuItemId,
      (quantityOf.get(line.menuItemId) ?? 0) + line.quantity,
    );
  for (const item of items) {
    const stationId = stationOfItem.get(item.id);
    if (!stationId || !targetOf.has(stationId)) continue;
    const load = loadOfItem(item.id, targetOf.get(stationId) ?? null);
    const known = touched.get(stationId);
    touched.set(
      stationId,
      known === undefined || known === null
        ? load.prep
        : Math.max(known, load.prep),
    );
    points.set(
      stationId,
      (points.get(stationId) ?? 0) +
        load.points * (quantityOf.get(item.id) ?? 0),
    );
  }
  return { prep: touched, points };
}

/**
 * Cart port (ORD-11 / KDS-05): replaces the station-target default. The cart
 * port carries no channel; today only the QR table order calls it, which is
 * the `dine_in` channel (QR_PRICE_CHANNEL).
 */
export const kdsServingEstimatePort: ServingEstimatePort = async (
  tx,
  context,
  input,
) => {
  const outletId = outletIdSchema.parse(input.outletId);
  // No evaluation here: this runs inside the caller's tx and the ETA reads the
  // live queue; a second connection could deadlock against it.
  const { prep, points } = await touchedStations(
    tx,
    context,
    outletId,
    input.lines,
  );
  const etas = await stationEtas(
    tx,
    context,
    outletId,
    { channel: QR_PRICE_CHANNEL, touched: prep, cartPoints: points },
    input.at,
  );
  return etaRange(Math.max(...etas.map((entry) => entry.etaMinutes)));
};

/** Wires the pacing-aware estimator into the QR order flow (app start). */
export function installKdsServingEstimate(): void {
  setQrOrderServingEstimatePort(kdsServingEstimatePort);
}
