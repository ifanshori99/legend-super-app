// Referral qualification step of the loyalty earn consumer (legend-111j stub,
// docs/design/ws08-member-loyalty.md §M6 step 8). The tier and referral card
// (legend-3zd1) fills only this file.

import type { EarnStepContext } from "./loyalty-earn-step-context.ts";

/** Runs after the mission step; may lock the referrer's profile. */
export async function afterVisit(context: EarnStepContext): Promise<void> {
  void context;
}
