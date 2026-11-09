// Plausibility check for a gateway-reported payment time. A provider clock
// that is wrong (or a hostile payload) must not back-date or future-date a
// settlement: the time feeds the late-payment and reconciliation decisions.

import { logger } from "../lib/logger";

const SKEW_MS = 5 * 60 * 1000;

/** DOIT's paid time if plausible (createdAt - 5 min .. now + 5 min), else `now`. Logs a warning on fallback. */
export function plausiblePaidAt(
  candidate: string | null | undefined,
  createdAt: Date | null,
  now: Date,
): string {
  if (candidate !== null && candidate !== undefined) {
    const at = new Date(candidate).getTime();
    const lower =
      createdAt === null ? -Infinity : createdAt.getTime() - SKEW_MS;
    const upper = now.getTime() + SKEW_MS;
    if (!Number.isNaN(at) && at >= lower && at <= upper)
      return new Date(at).toISOString();
    logger.warn(
      { paidAtImplausible: true },
      "Gateway paid time outside the plausible window; using the poll time",
    );
  }
  return now.toISOString();
}
