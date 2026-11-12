// What a bill still asks the cashier to collect (legend-p7lx). Pure integer
// rupiah, no framework: Node tests load this file directly.
//
// The reservation DP is not a tender: the order carries it as
// `depositAppliedIdr` (never above the total), the captured tenders settle the
// rest. Forgetting the DP charged the customer twice, so every screen derives
// the balance here.

function assertIdr(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0)
    throw new RangeError(`${name} must be a non-negative integer rupiah`);
}

/** total - DP applied - captured payments, never below zero. */
export function remainingToPayIdr(i: {
  totalIdr: number;
  depositAppliedIdr: number;
  capturedIdr: number;
}): number {
  assertIdr("totalIdr", i.totalIdr);
  assertIdr("depositAppliedIdr", i.depositAppliedIdr);
  assertIdr("capturedIdr", i.capturedIdr);
  return Math.max(0, i.totalIdr - i.depositAppliedIdr - i.capturedIdr);
}

/** The DP alone covers the whole bill: nothing is left to collect. */
export function isSettledByDeposit(i: {
  totalIdr: number;
  depositAppliedIdr: number;
}): boolean {
  return i.totalIdr > 0 && i.depositAppliedIdr >= i.totalIdr;
}
