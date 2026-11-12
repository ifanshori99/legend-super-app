// Pure rules of the extra shift screens (legend-pspy, legend-7mlf). The screens
// and the mock engine call these; nothing here touches React or the network.
import {
  SHIFT_CASHIER_COUNT_LIMIT,
  type ForceCloseStage,
} from "./shift-extra-types.ts";

const isWhole = (value: number) => Number.isSafeInteger(value);

/** A cash out or drop is held when it is larger than the expected drawer cash. */
export function isHeldCashOut(amountIdr: number, expectedIdr: number): boolean {
  return amountIdr > expectedIdr;
}

/** Sum of the held cash outs, whole rupiah. */
export function heldTotalIdr(items: readonly { amountIdr: number }[]): number {
  return items.reduce((sum, item) => sum + item.amountIdr, 0);
}

/**
 * Book variance = physical variance + held cash out (-20.000 + 200.000 =
 * +180.000). Held cash out was paid from the drawer but is not in the system
 * figure yet, so the supervisor sees both numbers.
 */
export function bookVarianceIdr(
  physicalVarianceIdr: number,
  heldIdr: number,
): number {
  if (!isWhole(physicalVarianceIdr) || !isWhole(heldIdr) || heldIdr < 0)
    throw new RangeError("Selisih dan kas keluar harus rupiah utuh.");
  return physicalVarianceIdr + heldIdr;
}

/** The cashier has no recount left after `SHIFT_CASHIER_COUNT_LIMIT` counts. */
export function countLimitReached(cashierCounts: number): boolean {
  return cashierCounts >= SHIFT_CASHIER_COUNT_LIMIT;
}

/** Where a force close stands, from what is stored. Stale restarts at count. */
export function forceCloseStage(input: {
  hasCount: boolean;
  stale: boolean;
  witnessed: boolean;
  closed: boolean;
}): ForceCloseStage {
  if (input.closed) return "closed";
  if (!input.hasCount || input.stale) return "count";
  return input.witnessed ? "ready" : "witness";
}
