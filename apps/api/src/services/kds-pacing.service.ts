// Order pacing (bead legend-gyc; PRD v1.7 F12 "Order Pacing", KDS-05, KDS-06;
// contract @starter/shared/kitchen `getPacing`, `menuLoadSchema`,
// `channelPauseSchema`).
//
// - `evaluatePacing`: per station, the open queue (tickets new|in_progress,
//   items not yet ready) against the capacity rule in force now. It also
//   keeps the automatic channel pauses and the last-level state in step:
//   at capacity, long-prep lines are paused for every channel except the top
//   priority one; below capacity those pauses are released. A move to a worse
//   level raises one supervisor alert.
// - Evaluate-on-read: there is no hook on ticket changes, so readers call
//   `evaluatePacingIfStale` (before their own tx opens; the pacing and estimate
//   routes, the POS and QR order paths) when the stored state is older than
//   10 s, which keeps KDS-05 (<= 30 s). `readPausedMenuLines` only reads.
// - Evaluations of one outlet run one after the other (advisory lock), so the
//   level transition and its alert are decided once, not by two readers.
// - Manual pauses (`reason = manual`) are never touched here.

import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import {
  assertOutletInScope,
  CoreError,
  createUlid,
  toIsoDateTime,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  capacityLevelFor,
  channelPauseSchema,
  menuLoadSchema,
  pacingSnapshotSchema,
  type CapacityLevel,
  type ChannelPause,
  type ManualChannelPauseInput,
  type MenuLoad,
  type PacingSnapshot,
} from "@starter/shared/kitchen";
import { db } from "../db/index.ts";
import { logger } from "../lib/logger.ts";
import {
  itemVariants,
  menuItems,
  outlets,
  stations,
} from "../db/schema/index.ts";
import { kitchenCapacityRules } from "../db/schema/kds-capacity.ts";
import { kitchenTicketItems, kitchenTickets } from "../db/schema/kds.ts";
import {
  kitchenChannelPauses,
  kitchenMenuLoads,
  kitchenPacingState,
} from "../db/schema/kds-pacing.ts";
import { orders } from "../db/schema/qr-order.ts";
import { withTenant } from "../db/tenant.ts";
import { permittedStationIds } from "./station-access.ts";
import { recordAudit } from "./core-audit.ts";
import { notifyKitchenPacing } from "./kds-staff-alerts.ts";
import type { KdsActor } from "./kds-support.ts";
import {
  FALLBACK_SERVICE_SECONDS,
  decidePauses,
  medianSeconds,
  orderPriceChannel,
  pickActiveRule,
  shouldAlert,
  windowStartFor,
  type PacingRule,
} from "./kds-pacing-core.ts";
import type { Tx } from "./menu-internals.ts";

const HISTORY_DAYS = 14;
const HISTORY_LIMIT = 200;
const EVALUATION_MAX_AGE_MS = 10_000;

type QueueItem = {
  channel: string;
  points: number;
  prepSeconds: number;
  /** Units on the line; the snapshot's `queuedItems` counts these. */
  quantity: number;
};
type StationQueue = { stationId: string; items: QueueItem[] };
type LoadValue = { loadPoints: number; prepSeconds: number };

const lineKey = (menuItemId: string, variantId: string | null) =>
  `${menuItemId}:${variantId ?? ""}`;

/** Serializes writers of one outlet's pacing state (released with the tx). */
async function lockOutletPacing(tx: Tx, outletId: string): Promise<void> {
  // A stuck holder must not hold the caller: past this the lock fails.
  await tx.execute(sql.raw(`SET LOCAL lock_timeout = '2000ms'`));
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kitchen-pacing:${outletId}`}, 0))`,
  );
}

async function readStations(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
) {
  return tx
    .select({
      id: stations.id,
      name: stations.name,
      targetSeconds: stations.targetSeconds,
    })
    .from(stations)
    .where(
      and(
        eq(stations.tenantId, context.tenant.tenantId),
        eq(stations.outletId, outletId),
        isNull(stations.deletedAt),
      ),
    )
    .orderBy(asc(stations.id));
}

/** Load of every configured line, keyed `${menuItemId}:${variantId ?? ''}`. */
async function readLoadMap(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
): Promise<Map<string, LoadValue>> {
  const rows = await tx
    .select({
      menuItemId: kitchenMenuLoads.menuItemId,
      variantId: kitchenMenuLoads.variantId,
      loadPoints: kitchenMenuLoads.loadPoints,
      prepSeconds: kitchenMenuLoads.prepSeconds,
    })
    .from(kitchenMenuLoads)
    .where(
      and(
        eq(kitchenMenuLoads.tenantId, context.tenant.tenantId),
        eq(kitchenMenuLoads.outletId, outletId),
      ),
    );
  return new Map(
    rows.map((row) => [
      lineKey(row.menuItemId, row.variantId),
      { loadPoints: row.loadPoints, prepSeconds: row.prepSeconds },
    ]),
  );
}

/** Exact variant row, else the item-level row, else null (caller defaults). */
function loadOf(
  loads: Map<string, LoadValue>,
  menuItemId: string,
  variantId: string | null,
): LoadValue | null {
  return (
    loads.get(lineKey(menuItemId, variantId)) ??
    loads.get(lineKey(menuItemId, null)) ??
    null
  );
}

async function readRules(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
): Promise<Map<string, PacingRule[]>> {
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
    const rule: PacingRule = {
      stationId: row.stationId,
      windowMinutes: row.windowMinutes,
      capacityPoints: row.capacityPoints,
      nearCapacityBp: row.nearCapacityBp,
      schedule: row.schedule,
      channelPriority: row.channelPriority,
    };
    byStation.set(row.stationId, [
      ...(byStation.get(row.stationId) ?? []),
      rule,
    ]);
  }
  return byStation;
}

/**
 * The open queue per station of the outlet (every active station, possibly
 * empty): lines of tickets still new or in progress whose item is not ready,
 * served or voided. `channel` is the menu channel of the order (`channelSchema`
 * value), so priority works on the same names as the capacity rules.
 */
export async function readStationQueue(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
): Promise<{ stationId: string; items: QueueItem[] }[]> {
  const tenantId = context.tenant.tenantId;
  const [stationRows, loads, lines] = await Promise.all([
    readStations(tx, context, outletId),
    readLoadMap(tx, context, outletId),
    tx
      .select({
        stationId: kitchenTickets.stationId,
        orderChannel: orders.channel,
        serviceType: orders.serviceType,
        menuItemId: kitchenTicketItems.menuItemId,
        variantId: kitchenTicketItems.variantId,
        quantity: kitchenTicketItems.quantity,
      })
      .from(kitchenTicketItems)
      .innerJoin(
        kitchenTickets,
        and(
          eq(kitchenTickets.tenantId, kitchenTicketItems.tenantId),
          eq(kitchenTickets.id, kitchenTicketItems.ticketId),
        ),
      )
      .innerJoin(
        orders,
        and(
          eq(orders.tenantId, kitchenTickets.tenantId),
          eq(orders.id, kitchenTickets.orderId),
        ),
      )
      .where(
        and(
          eq(kitchenTicketItems.tenantId, tenantId),
          eq(kitchenTicketItems.outletId, outletId),
          eq(kitchenTickets.outletId, outletId),
          eq(orders.outletId, outletId),
          inArray(kitchenTickets.status, ["new", "in_progress"]),
          inArray(kitchenTicketItems.status, ["queued", "in_progress"]),
        ),
      ),
  ]);
  const queues = new Map<string, StationQueue>(
    stationRows.map((station) => [
      station.id,
      { stationId: station.id, items: [] },
    ]),
  );
  const targetSeconds = new Map(
    stationRows.map((station) => [station.id, station.targetSeconds]),
  );
  for (const line of lines) {
    const queue = queues.get(line.stationId);
    if (!queue) continue;
    const load = loadOf(loads, line.menuItemId, line.variantId);
    queue.items.push({
      channel: orderPriceChannel(line.orderChannel, line.serviceType),
      points: (load?.loadPoints ?? 1) * line.quantity,
      prepSeconds:
        load?.prepSeconds ??
        targetSeconds.get(line.stationId) ??
        FALLBACK_SERVICE_SECONDS,
      quantity: line.quantity,
    });
  }
  return [...queues.values()];
}

/** Median seconds of the newest finished tickets of a station; null if too few. */
export async function readStationHistory(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
  stationId: string,
  now: Date,
): Promise<number | null> {
  const since = new Date(now.getTime() - HISTORY_DAYS * 24 * 60 * 60 * 1000);
  const rows = await tx
    .select({
      startedAt: kitchenTickets.startedAt,
      doneAt: kitchenTickets.doneAt,
    })
    .from(kitchenTickets)
    .where(
      and(
        eq(kitchenTickets.tenantId, context.tenant.tenantId),
        eq(kitchenTickets.outletId, outletId),
        eq(kitchenTickets.stationId, stationId),
        eq(kitchenTickets.status, "done"),
        gt(kitchenTickets.doneAt, since),
      ),
    )
    .orderBy(desc(kitchenTickets.doneAt))
    .limit(HISTORY_LIMIT);
  const samples: number[] = [];
  for (const row of rows) {
    if (!row.startedAt || !row.doneAt) continue;
    const seconds = (row.doneAt.getTime() - row.startedAt.getTime()) / 1000;
    if (seconds >= 0) samples.push(seconds);
  }
  return medianSeconds(samples);
}

type MenuItemRouting = {
  id: string;
  stationId: string | null;
  stationType: string | null;
};

/**
 * Station that receives each menu item's tickets in `outletId`. Mirrors
 * `resolveStations` in kds.service.ts (~lines 459-542): `menu_items.station_id`
 * is only an override when it is a live station of this outlet; otherwise the
 * brand-level `station_type` (or, for a legacy row, the override's type) maps
 * to the outlet's first live station of that type by name, id. Items that
 * resolve to nothing are left out (the KDS would not route them either). An
 * inactive target falls back to the first active station by display order,
 * name, id, or stays unchanged when no active station exists.
 */
export async function resolveItemStations(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
  items: readonly MenuItemRouting[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (items.length === 0) return result;
  const tenantId = context.tenant.tenantId;
  const live = await tx
    .select({
      id: stations.id,
      type: stations.type,
      isActive: stations.isActive,
    })
    .from(stations)
    .where(
      and(
        eq(stations.tenantId, tenantId),
        eq(stations.outletId, outletId),
        isNull(stations.deletedAt),
      ),
    )
    .orderBy(asc(stations.name), asc(stations.id));
  const [fallback] = await tx
    .select({ id: stations.id })
    .from(stations)
    .where(
      and(
        eq(stations.tenantId, tenantId),
        eq(stations.outletId, outletId),
        eq(stations.isActive, true),
        isNull(stations.deletedAt),
      ),
    )
    .orderBy(asc(stations.displayOrder), asc(stations.name), asc(stations.id))
    .limit(1);
  const liveById = new Map(live.map((row) => [row.id, row]));
  const liveIds = new Set(liveById.keys());
  const firstOfType = new Map<string, string>();
  for (const row of live)
    if (!firstOfType.has(row.type)) firstOfType.set(row.type, row.id);
  const foreignIds = [
    ...new Set(
      items.flatMap((item) =>
        item.stationId && !liveIds.has(item.stationId) && !item.stationType
          ? [item.stationId]
          : [],
      ),
    ),
  ];
  const foreign =
    foreignIds.length === 0
      ? []
      : await tx
          .select({ id: stations.id, type: stations.type })
          .from(stations)
          .where(
            and(
              eq(stations.tenantId, tenantId),
              inArray(stations.id, foreignIds),
            ),
          );
  const foreignType = new Map(foreign.map((row) => [row.id, row.type]));
  for (const item of items) {
    if (item.stationId && liveIds.has(item.stationId)) {
      const station = liveById.get(item.stationId)!;
      result.set(
        item.id,
        station.isActive ? station.id : (fallback?.id ?? station.id),
      );
      continue;
    }
    const type =
      item.stationType ??
      (item.stationId ? (foreignType.get(item.stationId) ?? null) : null);
    const stationId = type === null ? null : (firstOfType.get(type) ?? null);
    if (stationId !== null) {
      const station = liveById.get(stationId)!;
      result.set(
        item.id,
        station.isActive ? station.id : (fallback?.id ?? station.id),
      );
    }
  }
  return result;
}

type StationLine = {
  menuItemId: string;
  variantId: string | null;
  prepSeconds: number;
};

/**
 * Auto pauses of one station: lines it owns with a configured prep time, one
 * entry per effective line (menuItemId + variantId). An item-level load row
 * expands to every live variant that has no load row of its own (those use
 * their own prep time, as `loadOf` does); an item without live variants stays
 * one item-level line.
 */
async function readStationLines(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
): Promise<Map<string, StationLine[]>> {
  // Only lines with an explicit load row can be "long prep": a line nobody
  // configured has no declared prep time, so it is never paused.
  const rows = await tx
    .select({
      itemStationId: menuItems.stationId,
      itemStationType: menuItems.stationType,
      menuItemId: kitchenMenuLoads.menuItemId,
      variantId: kitchenMenuLoads.variantId,
      prepSeconds: kitchenMenuLoads.prepSeconds,
    })
    .from(kitchenMenuLoads)
    .innerJoin(
      menuItems,
      and(
        eq(menuItems.tenantId, kitchenMenuLoads.tenantId),
        eq(menuItems.id, kitchenMenuLoads.menuItemId),
      ),
    )
    .where(
      and(
        eq(kitchenMenuLoads.tenantId, context.tenant.tenantId),
        eq(kitchenMenuLoads.outletId, outletId),
        isNull(menuItems.deletedAt),
      ),
    );
  const byStation = new Map<string, StationLine[]>();
  if (rows.length === 0) return byStation;
  const itemIds = [...new Set(rows.map((row) => row.menuItemId))];
  const routing = new Map<string, MenuItemRouting>(
    rows.map((row) => [
      row.menuItemId,
      {
        id: row.menuItemId,
        stationId: row.itemStationId,
        stationType: row.itemStationType,
      },
    ]),
  );
  const [stationOfItem, variantRows] = await Promise.all([
    resolveItemStations(tx, context, outletId, [...routing.values()]),
    tx
      .select({ id: itemVariants.id, menuItemId: itemVariants.menuItemId })
      .from(itemVariants)
      .where(
        and(
          eq(itemVariants.tenantId, context.tenant.tenantId),
          inArray(itemVariants.menuItemId, itemIds),
          isNull(itemVariants.deletedAt),
        ),
      ),
  ]);
  const variantsOf = new Map<string, string[]>();
  for (const variant of variantRows)
    variantsOf.set(variant.menuItemId, [
      ...(variantsOf.get(variant.menuItemId) ?? []),
      variant.id,
    ]);
  const ownVariantRows = new Set(
    rows.flatMap((row) =>
      row.variantId ? [lineKey(row.menuItemId, row.variantId)] : [],
    ),
  );
  const push = (stationId: string, line: StationLine) =>
    byStation.set(stationId, [...(byStation.get(stationId) ?? []), line]);
  for (const row of rows) {
    const stationId = stationOfItem.get(row.menuItemId);
    if (!stationId) continue;
    const variants = variantsOf.get(row.menuItemId) ?? [];
    if (row.variantId) {
      if (variants.includes(row.variantId))
        push(stationId, {
          menuItemId: row.menuItemId,
          variantId: row.variantId,
          prepSeconds: row.prepSeconds,
        });
      continue;
    }
    if (variants.length === 0) {
      push(stationId, {
        menuItemId: row.menuItemId,
        variantId: null,
        prepSeconds: row.prepSeconds,
      });
      continue;
    }
    for (const variantId of variants)
      if (!ownVariantRows.has(lineKey(row.menuItemId, variantId)))
        push(stationId, {
          menuItemId: row.menuItemId,
          variantId,
          prepSeconds: row.prepSeconds,
        });
  }
  return byStation;
}

/** Brings the automatic pauses of one station in line with its level. */
async function syncStationPauses(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
  stationId: string,
  wanted: {
    menuItemId: string;
    variantId: string | null;
    channels: string[];
  }[],
  now: Date,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const live = await tx
    .select()
    .from(kitchenChannelPauses)
    .where(
      and(
        eq(kitchenChannelPauses.tenantId, tenantId),
        eq(kitchenChannelPauses.outletId, outletId),
        eq(kitchenChannelPauses.stationId, stationId),
        eq(kitchenChannelPauses.reason, "station_capacity"),
        isNull(kitchenChannelPauses.releasedAt),
      ),
    );
  const liveByLine = new Map(
    live.map((row) => [lineKey(row.menuItemId, row.variantId), row]),
  );
  const wantedKeys = new Set<string>();
  for (const pause of wanted) {
    const key = lineKey(pause.menuItemId, pause.variantId);
    wantedKeys.add(key);
    const existing = liveByLine.get(key);
    if (!existing) {
      await tx.insert(kitchenChannelPauses).values({
        tenantId,
        outletId,
        menuItemId: pause.menuItemId,
        variantId: pause.variantId,
        stationId,
        channels: pause.channels,
        reason: "station_capacity",
        pausedUntil: null,
        createdBy: null,
        createdAt: now,
      });
    } else if (
      existing.channels.length !== pause.channels.length ||
      existing.channels.some((channel, i) => channel !== pause.channels[i])
    ) {
      await tx
        .update(kitchenChannelPauses)
        .set({ channels: pause.channels })
        .where(
          and(
            eq(kitchenChannelPauses.tenantId, tenantId),
            eq(kitchenChannelPauses.id, existing.id),
          ),
        );
    }
  }
  const release = live.filter(
    (row) => !wantedKeys.has(lineKey(row.menuItemId, row.variantId)),
  );
  if (release.length > 0)
    await tx
      .update(kitchenChannelPauses)
      .set({ releasedAt: now })
      .where(
        and(
          eq(kitchenChannelPauses.tenantId, tenantId),
          inArray(
            kitchenChannelPauses.id,
            release.map((row) => row.id),
          ),
        ),
      );
}

type StationEvaluation = {
  station: { id: string; name: string };
  rule: PacingRule | null;
  level: CapacityLevel;
  usedPoints: number;
  queuedItems: number;
  windowStart: Date;
  prev: typeof kitchenPacingState.$inferSelect | undefined;
  wantedPauses: ReturnType<typeof decidePauses>;
};

/**
 * The pacing computation both the writer (`evaluatePacing`) and the read-only
 * snapshot share. Reads only; the caller decides what to persist.
 */
async function computePacing(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
  now: Date,
): Promise<{
  stationRows: Awaited<ReturnType<typeof readStations>>;
  evaluations: StationEvaluation[];
  lastEvaluatedAt: Date | null;
}> {
  const tenantId = context.tenant.tenantId;
  const [outlet] = await tx
    .select({ timezone: outlets.timezone })
    .from(outlets)
    .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId)));
  if (!outlet) throw new CoreError("NOT_FOUND", "Outlet tidak ditemukan.");
  const [stationRows, rulesByStation, queues, stationLines, states] =
    await Promise.all([
      readStations(tx, context, outletId),
      readRules(tx, context, outletId),
      readStationQueue(tx, context, outletId),
      readStationLines(tx, context, outletId),
      tx
        .select()
        .from(kitchenPacingState)
        .where(
          and(
            eq(kitchenPacingState.tenantId, tenantId),
            eq(kitchenPacingState.outletId, outletId),
          ),
        ),
    ]);
  const queueOf = new Map(
    queues.map((queue) => [queue.stationId, queue.items]),
  );
  const stateOf = new Map(states.map((state) => [state.stationId, state]));
  const evaluations: StationEvaluation[] = [];
  for (const station of stationRows) {
    const rule = pickActiveRule(
      rulesByStation.get(station.id) ?? [],
      now,
      outlet.timezone,
    );
    const items = queueOf.get(station.id) ?? [];
    const prev = stateOf.get(station.id);
    const usedPoints = items.reduce((sum, item) => sum + item.points, 0);
    // No rule in force: the station is not paced, so it counts as available.
    const level: CapacityLevel = rule
      ? capacityLevelFor(usedPoints, rule.capacityPoints, rule.nearCapacityBp)
      : "available";
    evaluations.push({
      station: { id: station.id, name: station.name },
      rule,
      level,
      usedPoints,
      queuedItems: items.reduce((sum, item) => sum + item.quantity, 0),
      windowStart: rule
        ? windowStartFor(now, rule.windowMinutes)
        : (prev?.windowStart ?? now),
      prev,
      wantedPauses: rule
        ? decidePauses({
            level,
            channelPriority: rule.channelPriority,
            lines: stationLines.get(station.id) ?? [],
          })
        : [],
    });
  }
  const lastEvaluatedAt = states.reduce<Date | null>(
    (latest, state) =>
      latest === null || state.evaluatedAt > latest
        ? state.evaluatedAt
        : latest,
    null,
  );
  return { stationRows, evaluations, lastEvaluatedAt };
}

function buildSnapshot(
  context: ScopedTenantContext,
  outletId: OutletId,
  now: Date,
  evaluations: readonly StationEvaluation[],
): PacingSnapshot {
  const tenantId = context.tenant.tenantId;
  const rows: PacingSnapshot["stations"] = [];
  for (const entry of evaluations) {
    if (!entry.rule) continue;
    rows.push({
      tenantId,
      outletId,
      stationId: entry.station.id,
      windowMinutes: entry.rule.windowMinutes,
      windowStart: toIsoDateTime(entry.windowStart),
      capacityPoints: entry.rule.capacityPoints,
      nearCapacityBp: entry.rule.nearCapacityBp,
      usedPoints: entry.usedPoints,
      queuedItems: entry.queuedItems,
      status: entry.level,
    } as PacingSnapshot["stations"][number]);
  }
  rows.sort((a, b) => (a.stationId < b.stationId ? -1 : 1));
  return pacingSnapshotSchema.parse({
    tenantId,
    outletId,
    generatedAt: toIsoDateTime(now),
    stations: rows,
  });
}

/**
 * True when the stored state needs a refresh. Only LIVE stations with a
 * capacity rule count: no such station and no live automatic pause means there
 * is nothing to keep in step, so never stale.
 */
async function isPacingStale(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
  now: Date,
  maxAgeMs: number,
): Promise<boolean> {
  const tenantId = context.tenant.tenantId;
  const [rulesByStation, stationRows, [livePause]] = await Promise.all([
    readRules(tx, context, outletId),
    readStations(tx, context, outletId),
    tx
      .select({ id: kitchenChannelPauses.id })
      .from(kitchenChannelPauses)
      .where(
        and(
          eq(kitchenChannelPauses.tenantId, tenantId),
          eq(kitchenChannelPauses.outletId, outletId),
          eq(kitchenChannelPauses.reason, "station_capacity"),
          isNull(kitchenChannelPauses.releasedAt),
        ),
      )
      .limit(1),
  ]);
  const ruled = stationRows.filter((row) => rulesByStation.has(row.id));
  if (ruled.length === 0) return livePause !== undefined;
  const [[outlet], states] = await Promise.all([
    tx
      .select({ timezone: outlets.timezone })
      .from(outlets)
      .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId))),
    tx
      .select({
        stationId: kitchenPacingState.stationId,
        evaluatedAt: kitchenPacingState.evaluatedAt,
      })
      .from(kitchenPacingState)
      .where(
        and(
          eq(kitchenPacingState.tenantId, tenantId),
          eq(kitchenPacingState.outletId, outletId),
        ),
      ),
  ]);
  const stateOf = new Map(
    states.map((row) => [row.stationId, row.evaluatedAt]),
  );
  let oldest: Date | null = null;
  for (const station of ruled) {
    const evaluatedAt = stateOf.get(station.id);
    if (!evaluatedAt) {
      const rule = pickActiveRule(
        rulesByStation.get(station.id) ?? [],
        now,
        outlet?.timezone ?? "UTC",
      );
      if (rule) return true;
      continue;
    }
    if (oldest === null || evaluatedAt < oldest) oldest = evaluatedAt;
  }
  if (oldest === null) return livePause !== undefined;
  const age = now.getTime() - oldest.getTime();
  return !(age >= 0 && age < maxAgeMs);
}

/**
 * Evaluates every station of the outlet at `now`, persists the level state and
 * the automatic pauses, raises the alerts. With `onlyIfStaleMs` set, the
 * staleness is checked again once the outlet lock is held and `null` is
 * returned when another evaluator just ran.
 */
async function runEvaluation(
  context: ScopedTenantContext,
  outletId: OutletId,
  now: Date,
  onlyIfStaleMs: number | null,
): Promise<PacingSnapshot | null> {
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    await lockOutletPacing(tx, outletId);
    if (
      onlyIfStaleMs !== null &&
      !(await isPacingStale(tx, context, outletId, now, onlyIfStaleMs))
    )
      return null;
    const { stationRows, evaluations, lastEvaluatedAt } = await computePacing(
      tx,
      context,
      outletId,
      now,
    );
    // Time never goes back: a reader with an older clock reuses the last stamp.
    const effectiveNow =
      lastEvaluatedAt && lastEvaluatedAt > now ? lastEvaluatedAt : now;

    // Pauses of stations that are gone (soft-deleted or other outlet) would
    // never be synced below, so release them here.
    const liveStationIds = stationRows.map((row) => row.id);
    await tx
      .update(kitchenChannelPauses)
      .set({ releasedAt: effectiveNow })
      .where(
        and(
          eq(kitchenChannelPauses.tenantId, tenantId),
          eq(kitchenChannelPauses.outletId, outletId),
          eq(kitchenChannelPauses.reason, "station_capacity"),
          isNull(kitchenChannelPauses.releasedAt),
          liveStationIds.length === 0
            ? undefined
            : or(
                isNull(kitchenChannelPauses.stationId),
                notInArray(kitchenChannelPauses.stationId, liveStationIds),
              ),
        ),
      );

    for (const entry of evaluations) {
      const { station, rule, level, usedPoints, prev } = entry;
      await syncStationPauses(
        tx,
        context,
        outletId,
        station.id,
        entry.wantedPauses,
        effectiveNow,
      );

      if (!prev) {
        if (!rule) continue;
        await tx.insert(kitchenPacingState).values({
          tenantId,
          outletId,
          stationId: station.id,
          level,
          usedPoints,
          windowStart: entry.windowStart,
          changedAt: effectiveNow,
          evaluatedAt: effectiveNow,
        });
      } else {
        const changed = prev.level !== level;
        await tx
          .update(kitchenPacingState)
          .set({
            level,
            usedPoints,
            windowStart: entry.windowStart,
            changedAt: changed ? effectiveNow : prev.changedAt,
            evaluatedAt: effectiveNow,
          })
          .where(
            and(
              eq(kitchenPacingState.tenantId, tenantId),
              eq(kitchenPacingState.id, prev.id),
            ),
          );
      }

      const previousLevel = prev ? (prev.level as CapacityLevel) : null;
      if (rule && level !== "available" && shouldAlert(previousLevel, level))
        await notifyKitchenPacing(tx, context, {
          outletId,
          stationId: station.id,
          stationName: station.name,
          level,
          usedPoints,
          capacityPoints: rule.capacityPoints,
          changedAt: effectiveNow,
        });
    }
    return buildSnapshot(context, outletId, now, evaluations);
  });
}

/** Writer path: evaluates now and returns the snapshot it persisted. */
export async function evaluatePacing(
  context: ScopedTenantContext,
  outletId: OutletId,
  now: Date,
): Promise<PacingSnapshot> {
  const snapshot = await runEvaluation(context, outletId, now, null);
  if (!snapshot) throw new Error("pacing evaluation returned no snapshot");
  return snapshot;
}

/**
 * Evaluates only when the stored state is older than `maxAgeMs`. Runs its own
 * transactions and never throws (callers run it before their order tx): a
 * failure is logged and the caller proceeds with the stored pauses.
 */
export async function evaluatePacingIfStale(
  context: ScopedTenantContext,
  outletId: OutletId,
  now: Date,
  maxAgeMs = EVALUATION_MAX_AGE_MS,
): Promise<void> {
  try {
    const stale = await withTenant(db, context, (tx) =>
      isPacingStale(tx, context, outletId, now, maxAgeMs),
    );
    if (!stale) return;
    await runEvaluation(context, outletId, now, maxAgeMs);
  } catch (error) {
    logger.warn(
      { err: error, outletId },
      "kds pacing: evaluation on read failed",
    );
  }
}

/**
 * Staff snapshot: refreshes the stored state when stale, then answers from a
 * read-only computation (no writes, no lock).
 */
export async function getPacingSnapshot(
  context: ScopedTenantContext,
  outletId: OutletId,
  now: Date,
  actor: { userId: string },
): Promise<PacingSnapshot> {
  assertOutletInScope(context.outletScope, outletId);
  await evaluatePacingIfStale(context, outletId, now);
  return withTenant(db, context, async (tx) => {
    // Only the stations the caller may process: an outlet-wide holder sees all,
    // a station-scoped cook only theirs, and no reach answers an empty list.
    const permitted = new Set(
      await permittedStationIds(
        tx,
        context,
        actor.userId,
        "kds.ticket.process",
        now,
      ),
    );
    const { evaluations } = await computePacing(tx, context, outletId, now);
    return buildSnapshot(
      context,
      outletId,
      now,
      evaluations.filter((entry) => permitted.has(entry.station.id)),
    );
  });
}

/** A pause is live until released, and until `pausedUntil` passes. */
function livePauseCondition(
  context: ScopedTenantContext,
  outletId: OutletId,
  now: Date,
) {
  return and(
    eq(kitchenChannelPauses.tenantId, context.tenant.tenantId),
    eq(kitchenChannelPauses.outletId, outletId),
    isNull(kitchenChannelPauses.releasedAt),
    or(
      isNull(kitchenChannelPauses.pausedUntil),
      gt(kitchenChannelPauses.pausedUntil, now),
    ),
  );
}

export async function listChannelPauses(
  context: ScopedTenantContext,
  outletId: OutletId,
  now: Date,
): Promise<ChannelPause[]> {
  return withTenant(db, context, async (tx) => {
    const rows = await tx
      .select()
      .from(kitchenChannelPauses)
      .where(livePauseCondition(context, outletId, now))
      .orderBy(
        asc(kitchenChannelPauses.createdAt),
        asc(kitchenChannelPauses.id),
      );
    return rows.map(pauseDto);
  });
}

/**
 * Lines paused for `channel` right now, as `${menuItemId}:${variantId ?? ''}`.
 * A plain read on the caller's tx: callers refresh the pacing first with
 * `evaluatePacingIfStale`, before their own transaction opens.
 */
export async function readPausedMenuLines(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
  channel: string,
  now: Date,
): Promise<Set<string>> {
  const rows = await tx
    .select({
      menuItemId: kitchenChannelPauses.menuItemId,
      variantId: kitchenChannelPauses.variantId,
    })
    .from(kitchenChannelPauses)
    .where(
      and(
        livePauseCondition(context, outletId, now),
        sql`${kitchenChannelPauses.channels} @> ${JSON.stringify([channel])}::jsonb`,
      ),
    );
  return new Set(rows.map((row) => lineKey(row.menuItemId, row.variantId)));
}

/**
 * Exact line key, or the item-level key. Automatic pauses are stored per
 * effective line (see `readStationLines`), so an item-level key only exists
 * for a pause made at item level (manual) or an item without variants.
 */
export function isLinePaused(
  paused: ReadonlySet<string>,
  menuItemId: string,
  variantId: string | null,
): boolean {
  return (
    paused.has(lineKey(menuItemId, variantId)) ||
    paused.has(lineKey(menuItemId, null))
  );
}

type MenuLoadRow = typeof kitchenMenuLoads.$inferSelect;

function loadDto(row: MenuLoadRow): MenuLoad {
  return menuLoadSchema.parse({
    tenantId: row.tenantId,
    outletId: row.outletId,
    id: row.id,
    menuItemId: row.menuItemId,
    variantId: row.variantId,
    loadPoints: row.loadPoints,
    prepSeconds: row.prepSeconds,
  });
}

const LOAD_AUDIT_FIELDS = [
  "id",
  "menuItemId",
  "variantId",
  "loadPoints",
  "prepSeconds",
  "channels",
  "pausedUntil",
  "reason",
];

/** One audit row for a menu load or manual pause change (same tx). */
async function auditPacingAdmin(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    action: string;
    objectType: "kitchen_menu_load" | "kitchen_channel_pause";
    objectId: string;
    outletId: OutletId;
    actor: KdsActor | null;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  },
  now: Date,
): Promise<void> {
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: input.outletId,
      actorType: input.actor === null ? "system" : "user",
      actorId: input.actor?.userId ?? null,
      deviceId: input.actor?.deviceId ?? null,
      action: input.action,
      objectType: input.objectType,
      objectId: input.objectId,
      reason: null,
      maskedChanges: { before: input.before, after: input.after },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: toIsoDateTime(now),
    },
    LOAD_AUDIT_FIELDS,
  );
}

/**
 * Upserts the load of each line. The menu item must belong to the outlet's
 * brand and a variant to that item, else NOT_FOUND. A repeated line in one
 * call: the last entry wins. A line whose values already match is left
 * alone and not audited; a new or changed line is audited.
 */
export async function setMenuLoads(
  context: ScopedTenantContext,
  outletId: OutletId,
  loads: {
    menuItemId: string;
    variantId: string | null;
    loadPoints: number;
    prepSeconds: number;
  }[],
  now: Date,
  actor: KdsActor | null = null,
): Promise<MenuLoad[]> {
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '2000ms'`));
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kitchen-menu-loads:${outletId}`}, 0))`,
    );
    const [outlet] = await tx
      .select({ brandId: outlets.brandId })
      .from(outlets)
      .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId)));
    if (!outlet) throw new CoreError("NOT_FOUND", "Outlet tidak ditemukan.");

    const result: MenuLoad[] = [];
    for (const load of loads) {
      const [item] = await tx
        .select({ id: menuItems.id })
        .from(menuItems)
        .where(
          and(
            eq(menuItems.tenantId, tenantId),
            eq(menuItems.id, load.menuItemId),
            eq(menuItems.brandId, outlet.brandId),
            isNull(menuItems.deletedAt),
          ),
        );
      if (!item)
        throw new CoreError("NOT_FOUND", "Menu tidak ditemukan di outlet ini.");
      if (load.variantId) {
        const [variant] = await tx
          .select({ id: itemVariants.id })
          .from(itemVariants)
          .where(
            and(
              eq(itemVariants.tenantId, tenantId),
              eq(itemVariants.id, load.variantId),
              eq(itemVariants.menuItemId, load.menuItemId),
              isNull(itemVariants.deletedAt),
            ),
          );
        if (!variant)
          throw new CoreError("NOT_FOUND", "Varian menu tidak ditemukan.");
      }
      const [existing] = await tx
        .select()
        .from(kitchenMenuLoads)
        .where(
          and(
            eq(kitchenMenuLoads.tenantId, tenantId),
            eq(kitchenMenuLoads.outletId, outletId),
            eq(kitchenMenuLoads.menuItemId, load.menuItemId),
            load.variantId
              ? eq(kitchenMenuLoads.variantId, load.variantId)
              : isNull(kitchenMenuLoads.variantId),
          ),
        );
      if (
        existing &&
        existing.loadPoints === load.loadPoints &&
        existing.prepSeconds === load.prepSeconds
      ) {
        result.push(loadDto(existing));
        continue;
      }
      const [row] = existing
        ? await tx
            .update(kitchenMenuLoads)
            .set({
              loadPoints: load.loadPoints,
              prepSeconds: load.prepSeconds,
              updatedAt: now,
            })
            .where(
              and(
                eq(kitchenMenuLoads.tenantId, tenantId),
                eq(kitchenMenuLoads.id, existing.id),
              ),
            )
            .returning()
        : await tx
            .insert(kitchenMenuLoads)
            .values({
              tenantId,
              outletId,
              menuItemId: load.menuItemId,
              variantId: load.variantId,
              loadPoints: load.loadPoints,
              prepSeconds: load.prepSeconds,
              createdAt: now,
              updatedAt: now,
            })
            .returning();
      await auditPacingAdmin(
        tx,
        context,
        {
          action: "kitchen_menu_load.set",
          objectType: "kitchen_menu_load",
          objectId: row.id,
          outletId,
          actor,
          before: existing
            ? {
                loadPoints: existing.loadPoints,
                prepSeconds: existing.prepSeconds,
              }
            : null,
          after: { loadPoints: row.loadPoints, prepSeconds: row.prepSeconds },
        },
        now,
      );
      result.push(loadDto(row));
    }
    return result;
  });
}

export async function listMenuLoads(
  context: ScopedTenantContext,
  outletId: OutletId,
): Promise<MenuLoad[]> {
  return withTenant(db, context, async (tx) => {
    const rows = await tx
      .select()
      .from(kitchenMenuLoads)
      .where(
        and(
          eq(kitchenMenuLoads.tenantId, context.tenant.tenantId),
          eq(kitchenMenuLoads.outletId, outletId),
        ),
      )
      .orderBy(
        asc(kitchenMenuLoads.menuItemId),
        sql`${kitchenMenuLoads.variantId} ASC NULLS FIRST`,
        asc(kitchenMenuLoads.id),
      );
    return rows.map(loadDto);
  });
}

/**
 * Removes one load line. A line already gone (or of another outlet or tenant)
 * answers `removed: false`: no error, no audit.
 */
export async function deleteMenuLoad(
  context: ScopedTenantContext,
  actor: KdsActor,
  outletId: OutletId,
  loadId: string,
  now: Date,
): Promise<{ id: string; removed: boolean }> {
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '2000ms'`));
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kitchen-menu-loads:${outletId}`}, 0))`,
    );
    const [row] = await tx
      .delete(kitchenMenuLoads)
      .where(
        and(
          eq(kitchenMenuLoads.tenantId, tenantId),
          eq(kitchenMenuLoads.outletId, outletId),
          eq(kitchenMenuLoads.id, loadId),
        ),
      )
      .returning();
    if (!row) return { id: loadId, removed: false };
    await auditPacingAdmin(
      tx,
      context,
      {
        action: "kitchen_menu_load.deleted",
        objectType: "kitchen_menu_load",
        objectId: row.id,
        outletId,
        actor,
        before: {
          menuItemId: row.menuItemId,
          variantId: row.variantId,
          loadPoints: row.loadPoints,
          prepSeconds: row.prepSeconds,
        },
        after: null,
      },
      now,
    );
    return { id: row.id, removed: true };
  });
}

type ChannelPauseRow = typeof kitchenChannelPauses.$inferSelect;

function pauseDto(row: ChannelPauseRow): ChannelPause {
  return channelPauseSchema.parse({
    tenantId: row.tenantId,
    outletId: row.outletId,
    id: row.id,
    menuItemId: row.menuItemId,
    variantId: row.variantId,
    channels: row.channels,
    reason: row.reason,
    pausedUntil: row.pausedUntil ? toIsoDateTime(row.pausedUntil) : null,
    createdAt: toIsoDateTime(row.createdAt),
    createdBy: row.createdBy,
  });
}

const sameChannels = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length &&
  [...a].sort().join("\n") === [...b].sort().join("\n");

/**
 * Pauses a menu line by hand. The item must belong to the outlet's brand and
 * a variant to that item, else NOT_FOUND; `pausedUntil` must be in the future
 * (VALIDATION_ERROR). One live manual pause per line: a repeat updates its
 * channels and end time (no audit when nothing changes). The automatic pacing
 * only touches `station_capacity` rows, so it never edits this one.
 */
export async function setManualChannelPause(
  context: ScopedTenantContext,
  actor: KdsActor,
  outletId: OutletId,
  input: ManualChannelPauseInput,
  now: Date,
): Promise<ChannelPause> {
  const pausedUntil =
    input.pausedUntil === null ? null : new Date(input.pausedUntil);
  if (pausedUntil !== null && pausedUntil.getTime() <= now.getTime())
    throw new CoreError("VALIDATION_ERROR", "Waktu jeda harus di masa depan.");
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '2000ms'`));
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kitchen-channel-pauses:${outletId}`}, 0))`,
    );
    const [outlet] = await tx
      .select({ brandId: outlets.brandId })
      .from(outlets)
      .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId)));
    if (!outlet) throw new CoreError("NOT_FOUND", "Outlet tidak ditemukan.");
    const [item] = await tx
      .select({ id: menuItems.id })
      .from(menuItems)
      .where(
        and(
          eq(menuItems.tenantId, tenantId),
          eq(menuItems.id, input.menuItemId),
          eq(menuItems.brandId, outlet.brandId),
          isNull(menuItems.deletedAt),
        ),
      );
    if (!item)
      throw new CoreError("NOT_FOUND", "Menu tidak ditemukan di outlet ini.");
    if (input.variantId) {
      const [variant] = await tx
        .select({ id: itemVariants.id })
        .from(itemVariants)
        .where(
          and(
            eq(itemVariants.tenantId, tenantId),
            eq(itemVariants.id, input.variantId),
            eq(itemVariants.menuItemId, input.menuItemId),
            isNull(itemVariants.deletedAt),
          ),
        );
      if (!variant)
        throw new CoreError("NOT_FOUND", "Varian menu tidak ditemukan.");
    }
    const [existing] = await tx
      .select()
      .from(kitchenChannelPauses)
      .where(
        and(
          livePauseCondition(context, outletId, now),
          eq(kitchenChannelPauses.reason, "manual"),
          eq(kitchenChannelPauses.menuItemId, input.menuItemId),
          input.variantId
            ? eq(kitchenChannelPauses.variantId, input.variantId)
            : isNull(kitchenChannelPauses.variantId),
        ),
      )
      .orderBy(
        asc(kitchenChannelPauses.createdAt),
        asc(kitchenChannelPauses.id),
      )
      .limit(1);
    if (
      existing &&
      sameChannels(existing.channels, input.channels) &&
      (existing.pausedUntil?.getTime() ?? null) ===
        (pausedUntil?.getTime() ?? null)
    )
      return pauseDto(existing);
    const [row] = existing
      ? await tx
          .update(kitchenChannelPauses)
          .set({ channels: input.channels, pausedUntil })
          .where(
            and(
              eq(kitchenChannelPauses.tenantId, tenantId),
              eq(kitchenChannelPauses.id, existing.id),
            ),
          )
          .returning()
      : await tx
          .insert(kitchenChannelPauses)
          .values({
            tenantId,
            outletId,
            menuItemId: input.menuItemId,
            variantId: input.variantId,
            stationId: null,
            channels: input.channels,
            reason: "manual",
            pausedUntil,
            createdBy: actor.userId,
            createdAt: now,
          })
          .returning();
    await auditPacingAdmin(
      tx,
      context,
      {
        action: "kitchen_channel_pause.paused",
        objectType: "kitchen_channel_pause",
        objectId: row.id,
        outletId,
        actor,
        before: existing
          ? {
              channels: existing.channels,
              pausedUntil: existing.pausedUntil
                ? toIsoDateTime(existing.pausedUntil)
                : null,
            }
          : null,
        after: {
          menuItemId: row.menuItemId,
          variantId: row.variantId,
          channels: row.channels,
          pausedUntil: row.pausedUntil ? toIsoDateTime(row.pausedUntil) : null,
          reason: row.reason,
        },
      },
      now,
    );
    return pauseDto(row);
  });
}

/**
 * Lifts a manual pause. Only `manual` pauses: an unknown id, an automatic
 * pause or one of another outlet or tenant is NOT_FOUND. Already lifted:
 * `released: false`, no audit.
 */
export async function releaseManualChannelPause(
  context: ScopedTenantContext,
  actor: KdsActor,
  outletId: OutletId,
  pauseId: string,
  now: Date,
): Promise<{ id: string; released: boolean }> {
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '2000ms'`));
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kitchen-channel-pauses:${outletId}`}, 0))`,
    );
    const [row] = await tx
      .select()
      .from(kitchenChannelPauses)
      .where(
        and(
          eq(kitchenChannelPauses.tenantId, tenantId),
          eq(kitchenChannelPauses.outletId, outletId),
          eq(kitchenChannelPauses.id, pauseId),
          eq(kitchenChannelPauses.reason, "manual"),
        ),
      );
    if (!row) throw new CoreError("NOT_FOUND", "Jeda tidak ditemukan.");
    // Lifted already, or expired on its own: nothing live to release.
    if (
      row.releasedAt !== null ||
      (row.pausedUntil !== null && row.pausedUntil.getTime() <= now.getTime())
    )
      return { id: row.id, released: false };
    await tx
      .update(kitchenChannelPauses)
      .set({ releasedAt: now })
      .where(
        and(
          eq(kitchenChannelPauses.tenantId, tenantId),
          eq(kitchenChannelPauses.id, row.id),
        ),
      );
    await auditPacingAdmin(
      tx,
      context,
      {
        action: "kitchen_channel_pause.released",
        objectType: "kitchen_channel_pause",
        objectId: row.id,
        outletId,
        actor,
        before: {
          menuItemId: row.menuItemId,
          variantId: row.variantId,
          channels: row.channels,
          pausedUntil: row.pausedUntil ? toIsoDateTime(row.pausedUntil) : null,
          reason: row.reason,
        },
        after: null,
      },
      now,
    );
    return { id: row.id, released: true };
  });
}
