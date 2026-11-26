// EDC reconciliation overdue sweep (X1 legend-wasr7.10). Runs from the worker
// relay tick per tenant, self-throttled. A manual EDC slip still unmatched with
// the bank more than a day after it was keyed warns the shift that took it
// (services/edc-reconciliation-alert.ts; one alert per shift).

import {
  assertTrustedScopedContext,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  alertOverdueEdcReconciliation,
  type EdcOverdueAlertResult,
} from "../services/edc-reconciliation-alert.ts";

/** Minimum time between two runs for one tenant. */
export const EDC_RECONCILIATION_OVERDUE_INTERVAL_MS = 15 * 60 * 1000;

const lastRunByTenant = new Map<string, number>();

export async function runEdcReconciliationOverdueJob(
  context: ScopedTenantContext,
  now: Date = new Date(),
  options: { force?: boolean } = {},
): Promise<EdcOverdueAlertResult | null> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const last = lastRunByTenant.get(tenantId);
  if (
    !options.force &&
    last !== undefined &&
    now.getTime() - last < EDC_RECONCILIATION_OVERDUE_INTERVAL_MS
  )
    return null;
  lastRunByTenant.set(tenantId, now.getTime());
  return alertOverdueEdcReconciliation(context, now);
}
