// Mission progress step of the loyalty earn consumer (legend-111j stub,
// docs/design/ws08-member-loyalty.md §M6 step 8). The missions card
// (legend-m4p5) fills only this file.

import type { EarnStepContext } from "./loyalty-earn-step-context.ts";

/** Runs after the visit row of a paid order is written. */
export async function afterVisit(context: EarnStepContext): Promise<void> {
  void context;
}
