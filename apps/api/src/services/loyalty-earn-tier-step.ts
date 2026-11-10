// Tier multiplier step of the loyalty earn consumer (legend-111j stub,
// docs/design/ws08-member-loyalty.md §M6 step 8). The tier card (legend-3zd1)
// fills only this file.

import type { EarnStepContext } from "./loyalty-earn-step-context.ts";

/** Basis points of the earn multiplier: 10 000 = 1x until tiers ship. */
export async function tierMultiplierBp(
  context: EarnStepContext,
): Promise<number> {
  void context;
  return 10_000;
}
