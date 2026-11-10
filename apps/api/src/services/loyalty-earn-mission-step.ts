// Mission progress step of the loyalty earn consumer (legend-111j stub,
// docs/design/ws08-member-loyalty.md §M6 step 8). The progress engine lives
// in `missions.service.ts` (legend-m4p5); this file only adapts the step.

import type { EarnStepContext } from "./loyalty-earn-step-context.ts";
import { advanceMissions } from "./missions.service.ts";

/** Runs after the visit row of a paid order is written. */
export async function afterVisit(context: EarnStepContext): Promise<void> {
  // Staff's own order: the visit counts, but no mission moves.
  if (context.record.outcomeReason === "blocked_self_serve") return;
  await advanceMissions(context);
}
