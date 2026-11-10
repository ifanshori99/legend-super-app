// Referral qualification step of the loyalty earn consumer (legend-111j stub,
// docs/design/ws08-member-loyalty.md §M6 step 8). The rules live in
// `referral.service.ts` (legend-3zd1); this file only adapts the step.

import type { EarnStepContext } from "./loyalty-earn-step-context.ts";
import { qualifyReferral } from "./referral.service.ts";

/** Runs after the mission step; may lock the referrer's profile. */
export async function afterVisit(context: EarnStepContext): Promise<void> {
  await qualifyReferral(context);
}
