// Facility operating hours roll-forward job (bead legend-4us1a, card 987).
//
// `facilities.operating_hours` is the hours valid today; a version dated in
// the future only applies once its date arrives. Per outlet, on the outlet's
// own business date, this sweep copies the latest version with
// `effective_from` <= today onto the column (idempotent: only a differing
// column is written). Runs from the worker relay tick per tenant, throttled;
// failures never block the relay.

import {
  assertTrustedScopedContext,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { rollForwardOutletHoursNow } from "../services/facility-hours-versions.service.ts";
import { listJobOutletIds } from "../services/inventory-ops.shared.ts";

/** Minimum time between two runs for one tenant. */
export const FACILITY_HOURS_ROLL_JOB_INTERVAL_MS = 10 * 60_000;

export type FacilityHoursRollJobResult = {
  outlets: number;
  failedOutlets: number;
  rolled: number;
};

const lastRunByTenant = new Map<string, number>();

export async function runFacilityHoursRollJob(
  context: ScopedTenantContext,
  now: Date = new Date(),
  options: { force?: boolean } = {},
): Promise<FacilityHoursRollJobResult | null> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const last = lastRunByTenant.get(tenantId);
  if (
    !options.force &&
    last !== undefined &&
    now.getTime() - last < FACILITY_HOURS_ROLL_JOB_INTERVAL_MS
  )
    return null;
  lastRunByTenant.set(tenantId, now.getTime());
  const outletIds = await withTenant(db, context, (tx) =>
    listJobOutletIds(tx, context),
  );
  const result: FacilityHoursRollJobResult = {
    outlets: outletIds.length,
    failedOutlets: 0,
    rolled: 0,
  };
  for (const outletId of outletIds) {
    try {
      result.rolled += await withTenant(db, context, (tx) =>
        rollForwardOutletHoursNow(
          tx,
          tenantId,
          outletIdSchema.parse(outletId),
          now,
        ),
      );
    } catch {
      result.failedOutlets += 1;
      console.error("Facility hours roll-forward failed for an outlet");
    }
  }
  return result;
}

/** Test hook: forget the throttle state. */
export function resetFacilityHoursRollJobThrottle(): void {
  lastRunByTenant.clear();
}
