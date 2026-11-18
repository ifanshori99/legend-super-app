// Cloud "edge offline" alarm (bead legend-5ab0l; docs/design/edge-status-cloud.md
// section 8, D9-D12). A worker sweeps every active tenant: an active edge node
// whose outlet is open and whose last heartbeat is `thresholdMinutes` old gets
// one `edge_offline` alert and one owner and supervisor notification per
// episode. The clock counts open time only: the gap is measured from the later
// of the last heartbeat and the start of the outlet's current open window.
// No money is touched.
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import {
  outletIdSchema,
  tenantIdSchema,
  type OutletId,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { OpeningHours } from "@starter/shared/platform";
import { db } from "../db/index.ts";
import { edgeNodeAlerts } from "../db/schema/edge-node-alert.ts";
import { edgeNodes } from "../db/schema/edge-node.ts";
import { outlets, tenants } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import { logger } from "../lib/logger.ts";
import {
  raiseEdgeNodeAlert,
  resolveEdgeNodeAlerts,
} from "./edge-node-alert.service.ts";
import type { EdgeTx } from "./edge-queue.service.ts";
import { notifyOutletSupervisors } from "./edge-sync-conflict-alert.ts";

type Database = typeof db;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const WEEKDAYS: readonly (keyof OpeningHours)[] = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
];

export type EdgeOfflineSweepResult = {
  /** Alerts newly opened by this sweep. */
  raised: number;
  /** Open alerts closed by this sweep. */
  resolved: number;
  /** Nodes (or tenants) whose handling threw. */
  failed: number;
};

/** Milliseconds from midnight for an "HH:mm" time. */
function minutesOfDay(time: string): number {
  const [hours = "0", minutes = "0"] = time.split(":");
  return (Number(hours) * 60 + Number(minutes)) * MINUTE_MS;
}

/** Wall-clock fields of `at` in `timeZone`, as milliseconds on a UTC axis. */
function localAxis(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(at);
  const field = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return (
    Date.UTC(
      field("year"),
      field("month") - 1,
      field("day"),
      field("hour"),
      field("minute"),
      field("second"),
    ) +
    (at.getTime() % 1000)
  );
}

/**
 * Convert a scheduled wall time with the offsets around that date, rather
 * than the offset at sweep time. A repeated time uses its first occurrence;
 * a skipped time moves forward by the gap. These choices keep the opening
 * stable across both sides of a DST transition.
 */
function scheduledInstant(wall: number, timeZone: string): number {
  const offsets = new Set(
    [wall - DAY_MS, wall, wall + DAY_MS].map(
      (sample) => localAxis(new Date(sample), timeZone) - sample,
    ),
  );
  const candidates = [...offsets].map((offset) => {
    const instant = wall - offset;
    return { instant, local: localAxis(new Date(instant), timeZone) };
  });
  const exact = candidates
    .filter((candidate) => candidate.local === wall)
    .map((candidate) => candidate.instant);
  if (exact.length > 0) return Math.min(...exact);
  // No exact instant means this wall time was skipped. Choose the nearest
  // wall time after it, preserving minutes within the forward clock gap.
  const after = candidates
    .filter((candidate) => candidate.local > wall)
    .sort((a, b) => a.local - b.local || a.instant - b.instant)[0];
  if (!after) throw new RangeError("Opening time cannot be resolved");
  return after.instant;
}

/**
 * Start of the outlet's CURRENT open window, or null when it is closed at
 * `now`. Hours are read in `timeZone`; a `null` day is closed; `closes` earlier
 * than `opens` runs into the next local day, so yesterday's window can still be
 * open after midnight. A window is [opens, closes).
 */
export function outletOpenSince(
  openingHours: OpeningHours,
  timeZone: string,
  now: Date,
): Date | null {
  const nowLocal = localAxis(now, timeZone);
  const today = nowLocal - (((nowLocal % DAY_MS) + DAY_MS) % DAY_MS);
  // Today's window first: it starts later than a window left from yesterday.
  for (const dayStart of [today, today - DAY_MS]) {
    const hours = openingHours[WEEKDAYS[new Date(dayStart).getUTCDay()]!];
    if (!hours) continue;
    const start = scheduledInstant(
      dayStart + minutesOfDay(hours.opens),
      timeZone,
    );
    const closes = minutesOfDay(hours.closes);
    const end = scheduledInstant(
      dayStart + closes + (closes < minutesOfDay(hours.opens) ? DAY_MS : 0),
      timeZone,
    );
    if (start <= now.getTime() && now.getTime() < end) return new Date(start);
  }
  return null;
}

type SweepNode = {
  edgeNodeId: string;
  outletId: OutletId;
  outletName: string;
  timeZone: string;
  openingHours: OpeningHours;
  lastHeartbeatAt: Date;
};

async function notifyEdgeOffline(
  tx: EdgeTx,
  context: ScopedTenantContext,
  node: SweepNode,
  alertId: string,
  thresholdMinutes: number,
  now: Date,
): Promise<void> {
  await notifyOutletSupervisors(
    tx,
    context,
    {
      tenantId: context.tenant.tenantId,
      outletId: node.outletId,
      alsoOwners: true,
      id: alertId,
      eventName: "edge_offline.raised",
      aggregateType: "edge_offline",
      aggregateId: alertId,
      payload: {
        edgeNodeId: node.edgeNodeId,
        thresholdMinutes: String(thresholdMinutes),
      },
      title: `Edge outlet tidak terhubung lebih dari ${thresholdMinutes} menit saat jam buka`,
      body: `${node.outletName}. Lihat Kelola > Status edge.`,
    },
    now,
  );
}

/**
 * Handles one node inside its own savepoint. Returns what changed: an alert
 * opened (`raised`) or closed (`resolved`), 0 or 1 each.
 */
async function sweepNode(
  tx: EdgeTx,
  context: ScopedTenantContext,
  node: SweepNode,
  openAlertRaisedAt: Date | undefined,
  now: Date,
  thresholdMinutes: number,
): Promise<{ raised: number; resolved: number }> {
  const thresholdMs = thresholdMinutes * MINUTE_MS;
  const tenantId = context.tenant.tenantId;
  let resolved = 0;
  // A heartbeat after the persisted episode proves recovery even if the
  // worker next runs only after that heartbeat has itself gone stale. The
  // SQL guard cannot close a replacement episode from a concurrent sweep.
  if (
    openAlertRaisedAt &&
    node.lastHeartbeatAt.getTime() > openAlertRaisedAt.getTime()
  ) {
    resolved = await resolveEdgeNodeAlerts(tx, {
      tenantId,
      edgeNodeId: node.edgeNodeId,
      kind: "edge_offline",
      at: node.lastHeartbeatAt,
      raisedBefore: node.lastHeartbeatAt,
    });
  }
  // A heartbeat inside the threshold ends the episode, open outlet or not.
  if (now.getTime() - node.lastHeartbeatAt.getTime() < thresholdMs) {
    if (openAlertRaisedAt && resolved === 0)
      resolved = await resolveEdgeNodeAlerts(tx, {
        tenantId,
        edgeNodeId: node.edgeNodeId,
        kind: "edge_offline",
        at: now,
        quietSince: now,
      });
    return { raised: 0, resolved };
  }
  const openSince = outletOpenSince(node.openingHours, node.timeZone, now);
  if (!openSince) return { raised: 0, resolved };
  const since = Math.max(node.lastHeartbeatAt.getTime(), openSince.getTime());
  const offlineMs = now.getTime() - since;
  if (offlineMs < thresholdMs) return { raised: 0, resolved };
  const { opened } = await raiseEdgeNodeAlert(tx, {
    tenantId,
    outletId: node.outletId,
    edgeNodeId: node.edgeNodeId,
    kind: "edge_offline",
    at: now,
    detail: {
      offlineMinutes: Math.floor(offlineMs / MINUTE_MS),
      lastHeartbeatAt: node.lastHeartbeatAt.toISOString(),
    },
  });
  if (!opened) return { raised: 0, resolved };
  const [alert] = await tx
    .select({ id: edgeNodeAlerts.id })
    .from(edgeNodeAlerts)
    .where(
      and(
        eq(edgeNodeAlerts.tenantId, tenantId),
        eq(edgeNodeAlerts.edgeNodeId, node.edgeNodeId),
        eq(edgeNodeAlerts.kind, "edge_offline"),
        isNull(edgeNodeAlerts.resolvedAt),
      ),
    );
  if (!alert) throw new Error("Edge offline alert missing after raise");
  await notifyEdgeOffline(tx, context, node, alert.id, thresholdMinutes, now);
  return { raised: 1, resolved };
}

async function sweepTenant(
  database: Database,
  tenantId: TenantId,
  now: Date,
  thresholdMinutes: number,
): Promise<EdgeOfflineSweepResult> {
  const context = establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "job" }),
    { kind: "tenant" },
  );
  return withTenant(database, context, async (tx) => {
    const result: EdgeOfflineSweepResult = {
      raised: 0,
      resolved: 0,
      failed: 0,
    };
    const rows = await tx
      .select({
        edgeNodeId: edgeNodes.id,
        outletId: edgeNodes.outletId,
        outletName: outlets.name,
        timeZone: outlets.timezone,
        openingHours: outlets.openingHours,
        lastHeartbeatAt: edgeNodes.lastHeartbeatAt,
      })
      .from(edgeNodes)
      .innerJoin(
        outlets,
        and(
          eq(outlets.tenantId, edgeNodes.tenantId),
          eq(outlets.id, edgeNodes.outletId),
        ),
      )
      .where(
        and(
          eq(edgeNodes.tenantId, tenantId),
          eq(edgeNodes.status, "active"),
          eq(outlets.status, "active"),
          isNotNull(edgeNodes.lastHeartbeatAt),
        ),
      );
    const openAlerts = await tx
      .select({
        edgeNodeId: edgeNodeAlerts.edgeNodeId,
        raisedAt: edgeNodeAlerts.raisedAt,
        nodeStatus: edgeNodes.status,
        outletStatus: outlets.status,
      })
      .from(edgeNodeAlerts)
      .innerJoin(
        edgeNodes,
        and(
          eq(edgeNodes.tenantId, edgeNodeAlerts.tenantId),
          eq(edgeNodes.id, edgeNodeAlerts.edgeNodeId),
        ),
      )
      .innerJoin(
        outlets,
        and(
          eq(outlets.tenantId, edgeNodeAlerts.tenantId),
          eq(outlets.id, edgeNodeAlerts.outletId),
        ),
      )
      .where(
        and(
          eq(edgeNodeAlerts.tenantId, tenantId),
          eq(edgeNodeAlerts.kind, "edge_offline"),
          isNull(edgeNodeAlerts.resolvedAt),
        ),
      );
    const withAlert = new Map(
      openAlerts.map((row) => [row.edgeNodeId, row.raisedAt]),
    );

    // A revoked node or a closed outlet no longer reports: its alert closes.
    // This also handles a node whose heartbeat has been cleared to null.
    const retired = openAlerts
      .filter(
        (row) => row.nodeStatus === "revoked" || row.outletStatus === "closed",
      )
      .map((row) => row.edgeNodeId);
    if (retired.length > 0) {
      try {
        result.resolved += await tx.transaction(async (savepoint) => {
          let closed = 0;
          for (const edgeNodeId of retired)
            closed += await resolveEdgeNodeAlerts(savepoint, {
              tenantId,
              edgeNodeId,
              kind: "edge_offline",
              at: now,
            });
          return closed;
        });
      } catch (error) {
        result.failed += 1;
        logger.warn(
          {
            errName: error instanceof Error ? error.name : "Error",
            tenantId,
            nodes: retired.length,
          },
          "Edge offline sweep: resolving retired nodes failed",
        );
      }
    }

    for (const row of rows) {
      if (!row.lastHeartbeatAt) continue;
      const node: SweepNode = {
        edgeNodeId: row.edgeNodeId,
        outletId: outletIdSchema.parse(row.outletId),
        outletName: row.outletName,
        timeZone: row.timeZone,
        openingHours: row.openingHours,
        lastHeartbeatAt: row.lastHeartbeatAt,
      };
      try {
        const done = await tx.transaction((savepoint) =>
          sweepNode(
            savepoint,
            context,
            node,
            withAlert.get(node.edgeNodeId),
            now,
            thresholdMinutes,
          ),
        );
        result.raised += done.raised;
        result.resolved += done.resolved;
      } catch (error) {
        result.failed += 1;
        logger.warn(
          {
            errName: error instanceof Error ? error.name : "Error",
            tenantId,
            edgeNodeId: node.edgeNodeId,
          },
          "Edge offline sweep: node failed",
        );
      }
    }
    return result;
  });
}

/** One pass over every active tenant. A failing tenant or node never stops it. */
export async function sweepEdgeOfflineAlerts(
  database: Database,
  options: { now?: Date; thresholdMinutes: number },
): Promise<EdgeOfflineSweepResult> {
  const now = options.now ?? new Date();
  const total: EdgeOfflineSweepResult = { raised: 0, resolved: 0, failed: 0 };
  const tenantRows = await database
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.status, "active"));
  for (const { id } of tenantRows) {
    const tenantId = tenantIdSchema.parse(id);
    try {
      const done = await sweepTenant(
        database,
        tenantId,
        now,
        options.thresholdMinutes,
      );
      total.raised += done.raised;
      total.resolved += done.resolved;
      total.failed += done.failed;
    } catch (error) {
      total.failed += 1;
      logger.warn(
        { errName: error instanceof Error ? error.name : "Error", tenantId },
        "Edge offline sweep: tenant failed",
      );
    }
  }
  return total;
}

export function startEdgeOfflineSweepWorker(
  database: Database,
  options: { intervalMs: number; thresholdMinutes: number },
  sweep: typeof sweepEdgeOfflineAlerts = sweepEdgeOfflineAlerts,
): { stop(): Promise<void> } {
  let stopped = false;
  let pending: Promise<void> | null = null;
  const run = () => {
    if (!stopped && !pending)
      pending = Promise.resolve()
        .then(() =>
          sweep(database, { thresholdMinutes: options.thresholdMinutes }),
        )
        .then(() => undefined)
        .catch((error: unknown) => {
          logger.warn(
            { errName: error instanceof Error ? error.name : "Error" },
            "Edge offline sweep failed",
          );
        })
        .finally(() => {
          pending = null;
        });
  };
  run();
  const timer = setInterval(run, options.intervalMs);
  timer.unref();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (pending) await pending;
    },
  };
}
