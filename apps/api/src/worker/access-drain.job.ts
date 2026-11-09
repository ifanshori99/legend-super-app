// Sweep of parked access edge rows (bead legend-0q3r).
//
// `edge_deferred_events` rows of the access aggregates (staff_pin, pos_override)
// are drained lazily when a live access event of the same outlet arrives
// (access-applier.ts). An outlet that never sends another one would stay
// parked forever, so the worker relay tick also drains them per outlet here.
//
// Each batch runs in its own tenant transaction scoped to one outlet. The
// drain locks its rows with FOR UPDATE SKIP LOCKED, so this sweep, the lazy
// drain, and overlapping sweeps never apply a row twice. A failing outlet never
// blocks the others or the relay (the next tick retries). Throttled per tenant.

import {
  assertTrustedScopedContext,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { and, asc, eq, inArray, isNull, min } from "drizzle-orm";
import { db } from "../db/index.ts";
import { edgeDeferredEvents } from "../db/schema/edge-deferred-event.ts";
import { withTenant } from "../db/tenant.ts";
import {
  ACCESS_EDGE_AGGREGATES,
  DRAIN_LIMIT,
  drainParkedAccessEvents,
} from "../edge/access-applier.ts";

/** Minimum time between two sweeps for one tenant. */
export const ACCESS_DRAIN_SWEEP_INTERVAL_MS = 60_000;
/** Outlets with parked access rows handled per sweep. */
export const ACCESS_DRAIN_OUTLET_LIMIT = 20;
/**
 * Batches (of DRAIN_LIMIT rows) drained per outlet per sweep. With the outlet
 * limit this bounds one sweep to 20 x 2 x 25 = 1000 rows, so a big backlog
 * cannot hold up the later sweeps of the relay tick; the next tick continues.
 */
export const ACCESS_DRAIN_BATCHES_PER_OUTLET = 2;

const lastRunByTenant = new Map<string, number>();

export type AccessDrainSweepResult = {
  outlets: number;
  failedOutlets: number;
  drained: number;
};

export async function sweepParkedAccessEvents(
  context: ScopedTenantContext,
  options: {
    batchLimit?: number;
    maxBatches?: number;
    outletLimit?: number;
    force?: boolean;
    now?: Date;
  } = {},
): Promise<AccessDrainSweepResult | null> {
  assertTrustedScopedContext(context);
  const batchLimit = options.batchLimit ?? DRAIN_LIMIT;
  const maxBatches = options.maxBatches ?? ACCESS_DRAIN_BATCHES_PER_OUTLET;
  const outletLimit = options.outletLimit ?? ACCESS_DRAIN_OUTLET_LIMIT;
  const now = options.now ?? new Date();
  const tenantId = context.tenant.tenantId;
  const last = lastRunByTenant.get(tenantId);
  if (
    !options.force &&
    last !== undefined &&
    now.getTime() - last < ACCESS_DRAIN_SWEEP_INTERVAL_MS
  )
    return null;
  lastRunByTenant.set(tenantId, now.getTime());

  const outletIds = await withTenant(db, context, async (tx) => {
    const rows = await tx
      .select({ outletId: edgeDeferredEvents.outletId })
      .from(edgeDeferredEvents)
      .where(
        and(
          eq(edgeDeferredEvents.tenantId, tenantId),
          inArray(edgeDeferredEvents.aggregateType, [
            ...ACCESS_EDGE_AGGREGATES,
          ]),
          isNull(edgeDeferredEvents.appliedAt),
        ),
      )
      .groupBy(edgeDeferredEvents.outletId)
      .orderBy(asc(min(edgeDeferredEvents.receivedAt)))
      .limit(outletLimit);
    return rows.map((row) => row.outletId);
  });

  const result: AccessDrainSweepResult = {
    outlets: outletIds.length,
    failedOutlets: 0,
    drained: 0,
  };
  for (const outletId of outletIds) {
    try {
      const outletContext = establishScopedTenantContext(context.tenant, {
        kind: "outlets",
        outletIds: [outletIdSchema.parse(outletId)],
      });
      const meta = {
        direction: "edge_to_cloud",
        kind: "transaction_event",
        context: outletContext,
      } as const;
      for (let batch = 0; batch < maxBatches; batch += 1) {
        const marked = await withTenant(db, outletContext, (tx) =>
          drainParkedAccessEvents(tx, meta, outletId, batchLimit),
        );
        result.drained += marked;
        if (marked !== batchLimit) break;
      }
    } catch {
      // No ids in the log line; the next tick retries.
      result.failedOutlets += 1;
      console.error("Parked access drain failed for an outlet");
    }
  }
  return result;
}

/** Test hook: forget the throttle state. */
export function resetAccessDrainSweepThrottle(): void {
  lastRunByTenant.clear();
}
