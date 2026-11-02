// Pure helpers for the payment back office. No React and no `@/` alias, so
// tests can import this file with plain Node ESM.
import type { PermissionCode } from "@starter/shared/access";

/** Permissions that may open /kelola/pembayaran (any one is enough). */
export const PAYMENT_ADMIN_PERMISSIONS: readonly PermissionCode[] = [
  "payment.transaction.view",
  "payment.reconcile",
  "payment.edc.manage",
];

/**
 * Route loaders skip the SSR prefetch when the URL asks for a mock scenario
 * (?mock=empty|slow|error|offline): the scenario lives in the browser, so a
 * server-prefetched page would otherwise never show the state.
 */
export function isMockScenarioRequest(searchStr: string): boolean {
  const scenario = new URLSearchParams(searchStr).get("mock");
  return scenario !== null && scenario !== "normal";
}
