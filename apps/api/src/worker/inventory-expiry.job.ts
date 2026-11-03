// FEFO expiry alert job (PRD v1.7 §3 F16 "Batch & Kedaluwarsa": "peringatan
// menjelang kedaluwarsa"; bead legend-ugo).
//
// Runs from the worker relay tick per tenant (the lead wires it in
// worker-main.ts next to the other sweeps). Each outlet is evaluated in its
// own tenant transaction holding that outlet's location locks; alerts are
// deduped in the database, so a repeated or overlapping run raises nothing
// twice. A failing outlet never blocks the others or the relay (fail closed:
// the next tick retries). Throttled per tenant: the relay ticks far more often
// than expiry status can change (it moves with the outlet business date and
// with stock movements, which the next run picks up).

import {
  assertTrustedScopedContext,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { evaluateExpiryAlertsForOutlet } from "../services/inventory-expiry.service.ts";
import { listJobOutletIds } from "../services/inventory-ops.shared.ts";

/** Minimum time between two runs for one tenant. */
export const INVENTORY_EXPIRY_JOB_INTERVAL_MS = 15 * 60_000;

const lastRunByTenant = new Map<string, number>();

export type InventoryAlertJobResult = {
  outlets: number;
  failedOutlets: number;
  raised: number;
  resolved: number;
};

export async function runInventoryExpiryJob(
  context: ScopedTenantContext,
  now: Date = new Date(),
  options: { force?: boolean } = {},
): Promise<InventoryAlertJobResult | null> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const last = lastRunByTenant.get(tenantId);
  if (
    !options.force &&
    last !== undefined &&
    now.getTime() - last < INVENTORY_EXPIRY_JOB_INTERVAL_MS
  )
    return null;
  lastRunByTenant.set(tenantId, now.getTime());
  const outletIds = await withTenant(db, context, (tx) =>
    listJobOutletIds(tx, context),
  );
  const result: InventoryAlertJobResult = {
    outlets: outletIds.length,
    failedOutlets: 0,
    raised: 0,
    resolved: 0,
  };
  for (const outletId of outletIds) {
    try {
      const outcome = await withTenant(db, context, (tx) =>
        evaluateExpiryAlertsForOutlet(tx, context, outletId, now),
      );
      result.raised += outcome.raised;
      result.resolved += outcome.resolved;
    } catch {
      // No ids or stock data in the log line; the next tick retries.
      result.failedOutlets += 1;
      console.error("Inventory expiry alert evaluation failed for an outlet");
    }
  }
  return result;
}

/** Test hook: forget the throttle state. */
export function resetInventoryExpiryJobThrottle(): void {
  lastRunByTenant.clear();
}
