import { describe, it } from "vitest";

/**
 * A–Z business-flow scenarios (WS-13, brief 91) for features that are not yet
 * merged into milestone/m1. The scenario is written now from docs/PRD.md and
 * skipped with the branch that will deliver it, so the merge train only has
 * to flip `describeUntilMerged` to `describe` once that branch lands.
 *
 * Search for "PENDING-BRANCH" to list every skipped scenario.
 */
export function describeUntilMerged(
  branch: string,
  title: string,
  body: () => void,
): void {
  describe.skip(`[PENDING-BRANCH ${branch}] ${title}`, body);
}

/**
 * Scenarios for PRD behaviour that no branch implements yet. Skipped with the
 * open bd card that owns the backend work ("PENDING-CARD"), so `pnpm check`
 * on milestone/m1 stays green while the gap stays visible and countable.
 */
export function describeUntilBuilt(
  card: string,
  title: string,
  body: () => void,
): void {
  describe.skip(`[PENDING-CARD ${card}] ${title}`, body);
}

export function itUntilBuilt(
  card: string,
  title: string,
  body: () => unknown,
): void {
  it.skip(`[PENDING-CARD ${card}] ${title}`, body);
}

export function itUntilMerged(
  branch: string,
  title: string,
  body: () => unknown,
): void {
  it.skip(`[PENDING-BRANCH ${branch}] ${title}`, body);
}
