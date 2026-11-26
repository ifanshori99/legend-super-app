import type { ScopedTenantContext } from "@starter/shared/core";

export async function runEdcReconciliationOverdueJob(
  _context: ScopedTenantContext,
  _now: Date = new Date(),
  _options: { force?: boolean } = {},
): Promise<null> {
  return null;
}
