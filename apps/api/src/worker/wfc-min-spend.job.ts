// WFC minimum spend per hour reminder job (PRD v1.7 §3 F39 "Wi-Fi Berbasis
// Belanja"; bead legend-e24cz).
//
// Per outlet of the tenant, `evaluateMinSpend` writes one polite reminder per
// completed hour to each signed-in guest of an open WFC session that has not
// reached the minimum spend (peak window only). Idempotent through the
// notification dedupe key, so the throttle only limits load. Runs from the
// worker relay tick per tenant, throttled; a failing outlet never blocks the
// relay or the other outlets.

import {
  assertTrustedScopedContext,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { listJobOutletIds } from "../services/inventory-ops.shared.ts";
import { evaluateMinSpend } from "../services/wfc-min-spend.service.ts";

/** Minimum time between two runs for one tenant. */
export const WFC_MIN_SPEND_JOB_INTERVAL_MS = 5 * 60_000;

export type WfcMinSpendJobResult = {
  outlets: number;
  failedOutlets: number;
  reminders: number;
};

const lastRunByTenant = new Map<string, number>();

export async function runWfcMinSpendJob(
  context: ScopedTenantContext,
  now: Date = new Date(),
  options: { force?: boolean } = {},
): Promise<WfcMinSpendJobResult | null> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const last = lastRunByTenant.get(tenantId);
  if (
    !options.force &&
    last !== undefined &&
    now.getTime() - last < WFC_MIN_SPEND_JOB_INTERVAL_MS
  )
    return null;
  lastRunByTenant.set(tenantId, now.getTime());
  const outletIds = await withTenant(db, context, (tx) =>
    listJobOutletIds(tx, context),
  );
  const result: WfcMinSpendJobResult = {
    outlets: outletIds.length,
    failedOutlets: 0,
    reminders: 0,
  };
  for (const outletId of outletIds) {
    try {
      const outcome = await withTenant(db, context, (tx) =>
        evaluateMinSpend(tx, {
          context,
          tenantId,
          outletId: outletIdSchema.parse(outletId),
          now,
        }),
      );
      result.reminders += outcome.reminders;
    } catch {
      result.failedOutlets += 1;
      console.error("WFC minimum spend evaluation failed for an outlet");
    }
  }
  return result;
}

/** Test hook: forget the throttle state. */
export function resetWfcMinSpendJobThrottle(): void {
  lastRunByTenant.clear();
}
