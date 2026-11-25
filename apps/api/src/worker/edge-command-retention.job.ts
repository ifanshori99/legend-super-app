// Retention of edge command results in the cloud (card F1, brief 1269): a result
// can hold personal data and is forgotten after 90 days. Throttled per tenant.
import type { ScopedTenantContext } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { purgeEdgeCommandResults } from "../services/edge-cloud-command.service.ts";

/** Minimum time between two purges for one tenant. */
export const EDGE_COMMAND_RETENTION_INTERVAL_MS = 60 * 60_000;

const lastRunByTenant = new Map<string, number>();

/** Null when throttled, else the number of results forgotten. */
export async function sweepEdgeCommandResults(
  context: ScopedTenantContext,
  now: Date = new Date(),
): Promise<number | null> {
  const tenantId = context.tenant.tenantId;
  const last = lastRunByTenant.get(tenantId);
  if (
    last !== undefined &&
    now.getTime() - last < EDGE_COMMAND_RETENTION_INTERVAL_MS
  )
    return null;
  lastRunByTenant.set(tenantId, now.getTime());
  return purgeEdgeCommandResults(db, context, now);
}
