// QRIS release reconciliation (legend-adiov). Runs from the worker relay tick
// per tenant, on cloud and edge. Every open row of the queue that is due is
// asked at the provider once (`reconcileReleasedQris`); a row stays open until
// the provider answers paid / expired / failed, however long that takes. It
// does not use the payment poller's selector or the 24 h intent timeout. A
// failing row never stops the others.

import {
  assertTrustedScopedContext,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { logger } from "../lib/logger";
import {
  dueReleaseReconciliations,
  reconcileReleasedQris,
} from "../services/pos-qris-release-recon.ts";

/** Minimum time between two runs for one tenant. */
export const POS_QRIS_RELEASE_RECON_INTERVAL_MS = 30_000;
const BATCH_LIMIT = 100;

const lastRunByTenant = new Map<string, number>();

export type PosQrisReleaseReconResult = { checked: number; resolved: number };

export async function runPosQrisReleaseReconJob(
  context: ScopedTenantContext,
  now: Date = new Date(),
  options: { force?: boolean } = {},
): Promise<PosQrisReleaseReconResult | null> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const last = lastRunByTenant.get(tenantId);
  if (
    !options.force &&
    last !== undefined &&
    now.getTime() - last < POS_QRIS_RELEASE_RECON_INTERVAL_MS
  )
    return null;
  lastRunByTenant.set(tenantId, now.getTime());
  const due = await dueReleaseReconciliations(context, now, {
    force: options.force,
    limit: BATCH_LIMIT,
  });
  const result: PosQrisReleaseReconResult = { checked: 0, resolved: 0 };
  for (const id of due) {
    try {
      const status = await reconcileReleasedQris(context, id, now);
      result.checked += 1;
      if (status === "resolved") result.resolved += 1;
    } catch (error) {
      logger.warn(
        {
          job: "pos_qris_release_recon",
          errorName: error instanceof Error ? error.name : "unknown",
        },
        "QRIS release reconciliation failed",
      );
    }
  }
  return result;
}
