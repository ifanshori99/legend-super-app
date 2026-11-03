// Par-level critical stock alert job (PRD v1.7 §3 F16 "Par Level & Saran
// Pembelian": "peringatan stok kritis"; §3 "Notifikasi Operasional ... stok
// kritis"; bead legend-ugo).
//
// The writes of this bead (waste, transfer, production) re-evaluate their own
// location/item pairs in the same transaction. This sweep catches every other
// movement (sales deducted by recipe, receipts, stock counts) and par level
// edits: per outlet, under that outlet's location locks, it raises a deduped
// `par_critical` alert + one `stock.critical` outbox event per new breach and
// resolves alerts whose stock recovered. Runs from the worker relay tick per
// tenant (wired by the lead), throttled; failures never block the relay.

import {
  assertTrustedScopedContext,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { listJobOutletIds } from "../services/inventory-ops.shared.ts";
import { evaluateParAlertsForOutlet } from "../services/inventory-par-alerts.service.ts";
import type { InventoryAlertJobResult } from "./inventory-expiry.job.ts";

/** Minimum time between two runs for one tenant. */
export const INVENTORY_PAR_ALERT_JOB_INTERVAL_MS = 5 * 60_000;

const lastRunByTenant = new Map<string, number>();

export async function runInventoryParAlertJob(
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
    now.getTime() - last < INVENTORY_PAR_ALERT_JOB_INTERVAL_MS
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
        evaluateParAlertsForOutlet(tx, context, outletId, now),
      );
      result.raised += outcome.raised;
      result.resolved += outcome.resolved;
    } catch {
      result.failedOutlets += 1;
      console.error("Inventory par alert evaluation failed for an outlet");
    }
  }
  return result;
}

/** Test hook: forget the throttle state. */
export function resetInventoryParAlertJobThrottle(): void {
  lastRunByTenant.clear();
}
