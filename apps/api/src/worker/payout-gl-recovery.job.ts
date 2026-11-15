// Periodic payout GL recovery (bead legend-pfk3q; design
// docs/briefs/881-payout-gl-877-so-fix.md).
//
// A payout settlement can wait for something that is not an event: the bank
// charges mapping coming back, a frozen source account being reactivated, or
// finance recording a missing source. Nothing replays the GL consumer for those,
// so this sweep (one tenant per call, tenant-wide worker context) walks the
// retryable payout batches and runs `recoverPayoutGlOfBatch` for each in its
// own transaction:
// - idempotent: the recovery takes the batch advisory lock, journals under the
//   posting's own keys and flips each posting once, so overlapping ticks or two
//   workers replay and add nothing;
// - bounded and fair (legend-la22h): at most 200 retryable batches per tick per
//   tenant, chosen by batch id after a per-tenant cursor that wraps around, so
//   a batch that stays blocked in front never starves the ones behind it, and
//   every batch gets a turn within ceil(batches / limit) ticks (batches that
//   only a human clears are not listed and never use up the limit; the cursor
//   is in memory, a restart only starts again from the first batch);
// - fail closed per batch: a configuration that still blocks the batch is
//   skipped by the recovery itself, any other error rolls back that batch only
//   and the next tick tries again. It never blocks the other batches or the
//   relay. Logs carry no tenant data or amount.

import {
  assertTrustedScopedContext,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { db } from "../db";
import { withTenant } from "../db/tenant.ts";
import {
  listRecoveryBatchIds,
  recoverPayoutGlOfBatch,
} from "../services/payroll-payout-gl.service.ts";

/** Batches one tick handles per tenant; the rest wait for the next tick. */
export const PAYOUT_GL_RECOVERY_BATCHES_PER_TICK = 200;

/** Last batch id each tenant's sweep handled (in memory; see the header). */
const recoveryCursors = new Map<string, string>();

/** Test helper: forget every tenant's sweep cursor. */
export function __resetRecoveryCursorsForTest(): void {
  recoveryCursors.clear();
}

export type PayoutGlRecoveryResult = {
  /** Batches the sweep looked at. */
  readonly batches: number;
  /** Settlements turned into `settle`. */
  readonly resolved: number;
  /** Bank fees journaled. */
  readonly feesReposted: number;
  /** Batches whose recovery threw (rolled back, retried next tick). */
  readonly failed: number;
};

export async function runPayoutGlRecoverySweep(
  context: ScopedTenantContext,
  now: Date = new Date(),
  options: { batchLimit?: number } = {},
): Promise<PayoutGlRecoveryResult> {
  assertTrustedScopedContext(context);
  if (context.outletScope.kind !== "tenant")
    throw new Error("Payout GL recovery requires tenant-wide scope");
  const tenantId = context.tenant.tenantId;
  const batchLimit = options.batchLimit ?? PAYOUT_GL_RECOVERY_BATCHES_PER_TICK;
  // Batches with at least one retryable posting, after the tenant's cursor;
  // when the tail is short the list wraps to the first batches.
  const cursor = recoveryCursors.get(tenantId) ?? null;
  const batchIds = await withTenant(db, context, async (tx) => {
    const ids = await listRecoveryBatchIds(tx, tenantId, {
      after: cursor,
      limit: batchLimit,
    });
    if (ids.length < batchLimit && cursor !== null) {
      const wrapped = await listRecoveryBatchIds(tx, tenantId, {
        after: null,
        limit: batchLimit - ids.length,
      });
      for (const id of wrapped) if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  });
  // The next tick starts after the last batch handled (or from the start).
  const last = batchIds.at(-1);
  if (last === undefined) recoveryCursors.delete(tenantId);
  else recoveryCursors.set(tenantId, last);
  let resolved = 0;
  let feesReposted = 0;
  let failed = 0;
  for (const batchId of batchIds) {
    try {
      const outcome = await withTenant(db, context, (tx) =>
        recoverPayoutGlOfBatch(tx, tenantId, batchId, now),
      );
      resolved += outcome.resolved;
      feesReposted += outcome.feesReposted;
    } catch {
      failed += 1;
      console.error("Payout GL recovery failed for a batch");
    }
  }
  return { batches: batchIds.length, resolved, feesReposted, failed };
}
