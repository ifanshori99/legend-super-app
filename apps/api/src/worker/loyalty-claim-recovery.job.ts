// A busy entity lock can park a guest claim without starting its remaining
// lifetime. Retry it on every cloud worker tick; the recovery service owns the
// locking, eligibility checks and idempotent state transition. A failed tick
// is retried naturally on the next tick, including after a worker restart.

import type { ScopedTenantContext } from "@starter/shared/core";
import { retryBusyLoyaltyClaims } from "../services/loyalty-claim-recovery.ts";

export async function runLoyaltyClaimRecoverySweep(
  context: ScopedTenantContext,
  now: Date,
): Promise<void> {
  await retryBusyLoyaltyClaims(context, now);
}
