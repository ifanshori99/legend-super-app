// Periodic payout GL recovery (bead legend-pfk3q; design
// docs/briefs/881-payout-gl-877-so-fix.md).
//
// A payout settlement can wait for something that is not an event: the bank
// charges mapping coming back, a frozen source account being reactivated, or
// finance recording a missing source. Nothing replays the GL consumer for those,
// so this sweep (one tenant per call, tenant-wide worker context) walks the
// payout recovery list and runs `recoverPayoutGlOfBatch` for each batch in its
// own transaction:
// - idempotent: the recovery takes the batch advisory lock, journals under the
//   posting's own keys and flips each posting once, so overlapping ticks or two
//   workers replay and add nothing;
// - bounded: at most 200 retryable batches per tick per tenant, oldest first
//   (batches that only a human clears are not listed for the sweep);
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
  listPayoutRecovery,
  recoverPayoutGlOfBatch,
} from "../services/payroll-payout-gl.service.ts";

/** Batches one tick handles per tenant; the rest wait for the next tick. */
export const PAYOUT_GL_RECOVERY_BATCHES_PER_TICK = 200;

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
  // Only retryable rows, filtered before the cap: batches that wait for a
  // human (accounting_was_off, source_account_unknown) never use up the tick
  // and are never locked. The list is oldest posting first.
  const rows = await withTenant(db, context, (tx) =>
    listPayoutRecovery(tx, tenantId, {
      retryableOnly: true,
      maxBatches: batchLimit,
    }),
  );
  const batchIds = [...new Set(rows.map((row) => row.batchId))].slice(
    0,
    batchLimit,
  );
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
