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
//   and it never blocks the other sweeps. The log carries counts only;
// - a proof file that cannot be read (not "not found") holds the slips of its
//   flags at once (migration 0481, legend-qh11l); a tenant whose finished cycles
//   keep finding one (2 cycles in a row or 24 hours) raises one
//   `PAYOUT-RECON-ALERT unreadable proof` line per cycle for operations.

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

type Cycle = {
  day: string;
  after: string | null;
  done: boolean;
  /** Unreadable proof files found by the pages of this cycle. */
  unreadable: number;
};

/** Per-tenant state of today's cycle (in memory; see the header). */
const cycles = new Map<string, Cycle>();

// One cycle is one Jakarta day (see the header), so the streak counts days: a
// one-off read error holds the slips of the flags of that operation until the
// next day's cycle reads the file again, and the alert comes on day 2 at the
// earliest (2 cycles), or when a streak is 24 hours old.

/** Per-tenant streak of finished cycles that found an unreadable proof file. */
export type UnreadableStreaks = Map<
  string,
  { firstSeenAt: number; cycles: number }
>;
const unreadableStreaks: UnreadableStreaks = new Map();

/** The streak alerts at this many cycles in a row, or at this age. */
const UNREADABLE_ALERT_CYCLES = 2;
const UNREADABLE_ALERT_MS = 24 * 3_600_000;

/** Test helper: forget every tenant's cycle and unreadable streak. */
export function __resetPayoutReconCyclesForTest(): void {
  cycles.clear();
  unreadableStreaks.clear();
}

/**
 * One finished cycle of a tenant: `unreadable` is the count of proof files it
 * could not read. A count above zero extends the streak, zero ends it. Alerts at
 * 2 cycles in a row or when the streak is 24 hours old. Pure but for `state`.
 */
export function trackUnreadable(
  state: UnreadableStreaks,
  tenantId: string,
  unreadable: number,
  nowMs: number,
): { alert: boolean; cycles: number; sinceMs: number } {
  if (unreadable <= 0) {
    state.delete(tenantId);
    return { alert: false, cycles: 0, sinceMs: 0 };
  }
  const streak = state.get(tenantId) ?? { firstSeenAt: nowMs, cycles: 0 };
  streak.cycles += 1;
  state.set(tenantId, streak);
  const sinceMs = nowMs - streak.firstSeenAt;
  return {
    alert:
      streak.cycles >= UNREADABLE_ALERT_CYCLES ||
      sinceMs >= UNREADABLE_ALERT_MS,
    cycles: streak.cycles,
    sinceMs,
  };
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
    cycle = { day, after: null, done: false, unreadable: 0 };
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
  cycle.unreadable += result.unreadable;
  if (cycle.done) {
    const streak = trackUnreadable(
      unreadableStreaks,
      tenantId,
      cycle.unreadable,
      now.getTime(),
    );
    if (streak.alert)
      console.error(
        `PAYOUT-RECON-ALERT unreadable proof: tenant ${tenantId}, ${cycle.unreadable} proof file(s) unreadable, ${streak.cycles} cycle(s) in a row, ${Math.floor(streak.sinceMs / 3_600_000)} hour(s) since the first (a read that failed or timed out, or was not tried after an earlier storage timeout in the same page, is recorded and holds the slips of its flags; a file skipped because another run held its lock raises a flag for that day and holds the slips until two people close it: check the storage and that run)`,
      );
  }
  if (result.flagged > 0 || result.unreadable > 0 || result.reraiseFailed > 0)
    console.error(
      `Payout trusted recon: operations ${result.operations}, new flags ${result.flagged}, flags raised again ${result.reraised}, raising again failed ${result.reraiseFailed}, proof files unreadable ${result.unreadable}`,
    );
  return result;
}
