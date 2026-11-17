// Nightly reconciliation of the trusted payout boundary (bead legend-i01jp;
// design docs/briefs/905/design.md "Recon malam"; checks in
// services/payroll-payout-recon.service.ts).
//
// One tenant per call (tenant-wide worker context). The sweep is read-only
// except for `app.payout_recon_flag` (insert-only):
// - once per Jakarta day: the first tick of a new day starts a cycle from the
//   first operation; each tick checks one bounded page (200 operations) after
//   a per-tenant cursor, so a large tenant is covered over several ticks and
//   the cycle ends when a page comes back short; later ticks of that day do
//   nothing (the cursor is in memory, a restart only repeats the day's cycle);
// - idempotent: a flag already on file is never written again;
// - fail closed: an error rolls back that page only, the next tick retries it,
//   and it never blocks the other sweeps. The log carries counts only.

import {
  assertTrustedScopedContext,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { ObjectStorage } from "@starter/shared/adapters";
import {
  PAYOUT_RECON_OPERATIONS_PER_PAGE,
  reconcileTrustedPayouts,
  type PayoutReconPageResult,
} from "../services/payroll-payout-recon.service.ts";

type Cycle = { day: string; after: string | null; done: boolean };

/** Per-tenant state of today's cycle (in memory; see the header). */
const cycles = new Map<string, Cycle>();

/** Test helper: forget every tenant's cycle. */
export function __resetPayoutReconCyclesForTest(): void {
  cycles.clear();
}

/** Jakarta calendar day (UTC+7, no daylight saving) of an instant. */
const jakartaDay = (now: Date): string =>
  new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

export async function runPayoutTrustedReconSweep(
  context: ScopedTenantContext,
  now: Date = new Date(),
  options: {
    storage: ObjectStorage | null | undefined;
    pageSize?: number;
  },
): Promise<PayoutReconPageResult> {
  assertTrustedScopedContext(context);
  if (context.outletScope.kind !== "tenant")
    throw new Error("Payout trusted recon requires tenant-wide scope");
  const tenantId = context.tenant.tenantId;
  const day = jakartaDay(now);
  let cycle = cycles.get(tenantId);
  if (!cycle || cycle.day !== day) {
    cycle = { day, after: null, done: false };
    cycles.set(tenantId, cycle);
  }
  if (cycle.done)
    return {
      operations: 0,
      flagged: 0,
      reraised: 0,
      reraiseFailed: 0,
      unreadable: 0,
      last: cycle.after,
      exhausted: true,
    };
  const result = await reconcileTrustedPayouts(context, {
    storage: options.storage,
    now,
    after: cycle.after,
    limit: options.pageSize ?? PAYOUT_RECON_OPERATIONS_PER_PAGE,
  });
  // The page is only counted once it committed; a thrown page is retried.
  cycle.after = result.last ?? cycle.after;
  cycle.done = result.exhausted;
  if (result.flagged > 0 || result.unreadable > 0 || result.reraiseFailed > 0)
    console.error(
      `Payout trusted recon: operations ${result.operations}, new flags ${result.flagged}, flags raised again ${result.reraised}, raising again failed ${result.reraiseFailed}, proof files unreadable ${result.unreadable}`,
    );
  return result;
}
