// Scheduled gateway probe (bead legend-5ffks, follow-up of legend-8vgid).
//
// Failover incidents are recorded from guest requests (payment-failover.service).
// Without guest traffic nothing would notice that the gateway came back, and a
// long outage would look "unobserved" and alert again after STALE_OPEN_MS. This
// sweep probes the outlets that have an OPEN incident, so a recovery is recorded
// without traffic and a still-down reading keeps the incident alive.
//
// Only open incidents are probed: a healthy outlet costs nothing. One outlet's
// failing probe never blocks the others or the relay tick (the next tick
// retries). Self-throttled per tenant, like the other relay sweeps.
import {
  assertTrustedScopedContext,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { outletGatewayHealth } from "../services/payment-gateway-select.ts";
import {
  listOutletsWithOpenIncident,
  syncGatewayHealth,
} from "../services/payment-failover.service.ts";

/** Minimum time between two probe sweeps of one tenant. */
export const GATEWAY_PROBE_INTERVAL_MS = 5 * 60_000;
/** Open incidents probed per sweep. */
export const GATEWAY_PROBE_OUTLET_LIMIT = 10;
/** Probes in flight at once (each can wait on the gateway for ~10 seconds). */
export const GATEWAY_PROBE_CONCURRENCY = 5;

const lastRunByTenant = new Map<string, number>();

export type GatewayProbeSweepResult = {
  outlets: number;
  failed: number;
  recovered: number;
  stillDown: number;
};

export async function sweepGatewayHealth(
  context: ScopedTenantContext,
  options: { force?: boolean; now?: Date; outletLimit?: number } = {},
): Promise<GatewayProbeSweepResult | null> {
  assertTrustedScopedContext(context);
  const now = options.now ?? new Date();
  const tenantId = context.tenant.tenantId;
  const last = lastRunByTenant.get(tenantId);
  if (
    !options.force &&
    last !== undefined &&
    now.getTime() - last < GATEWAY_PROBE_INTERVAL_MS
  )
    return null;
  lastRunByTenant.set(tenantId, now.getTime());

  const outletIds = await listOutletsWithOpenIncident(
    context,
    now,
    options.outletLimit ?? GATEWAY_PROBE_OUTLET_LIMIT,
  );
  const result: GatewayProbeSweepResult = {
    outlets: outletIds.length,
    failed: 0,
    recovered: 0,
    stillDown: 0,
  };
  const probe = async (outletId: string) => {
    try {
      const outletContext = establishScopedTenantContext(context.tenant, {
        kind: "outlets",
        outletIds: [outletIdSchema.parse(outletId)],
      });
      const health = await outletGatewayHealth(outletContext, outletId);
      // The reading is as old as the answer, not as old as the sweep: a guest
      // request may have recorded a newer state while the gateway was slow.
      const synced = await syncGatewayHealth(
        outletContext,
        outletId,
        health,
        options.now ?? new Date(),
        health.provider,
      );
      if (synced.transition === "recovered") result.recovered += 1;
      else if (synced.openIncident !== null) result.stillDown += 1;
    } catch {
      // No ids in the log line; the next tick retries.
      result.failed += 1;
      console.error("Gateway health probe failed for an outlet");
    }
  };
  for (let i = 0; i < outletIds.length; i += GATEWAY_PROBE_CONCURRENCY)
    await Promise.all(
      outletIds.slice(i, i + GATEWAY_PROBE_CONCURRENCY).map(probe),
    );
  return result;
}

const running = new Set<string>();

/**
 * Starts the sweep without waiting for it, for the worker relay: a gateway
 * outage hits every tenant at once and each probe can wait ~10 seconds, which
 * must not hold up the outbox relay. At most one sweep per tenant runs; the
 * returned promise never rejects, and is null when one is already running.
 */
export function startGatewayProbeSweep(
  context: ScopedTenantContext,
): Promise<void> | null {
  const tenantId = context.tenant.tenantId;
  if (running.has(tenantId)) return null;
  running.add(tenantId);
  return sweepGatewayHealth(context)
    .then(() => undefined)
    .catch(() => {
      console.error("Gateway health probe sweep failed");
    })
    .finally(() => {
      running.delete(tenantId);
    });
}
