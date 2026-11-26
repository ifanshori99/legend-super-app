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
 * Booked difference at close, mirroring `pos-shift.service.ts` (legend-y9bf):
 * `(closed.varianceIdr ?? 0) + heldCorrectionIdr`. Held cash outs and drops
 * are NOT added: they expire at close and are never booked. Only the held
 * refund and void cash (`heldCorrectionIdr`) is.
 */
export function bookVarianceIdr(
  physicalVarianceIdr: number,
  heldCorrectionIdr: number,
): number {
  if (
    !isWhole(physicalVarianceIdr) ||
    !isWhole(heldCorrectionIdr) ||
    heldCorrectionIdr < 0
  )
    throw new RangeError("Selisih dan koreksi tertahan harus rupiah utuh.");
  return physicalVarianceIdr + heldCorrectionIdr;
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

/** User IDs compare without letter case (the server may answer either). */
export const sameUser = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase();

/** The options minus the named people: a witness is a third person. */
export function thirdPersons<T extends { userId: string }>(
  options: readonly T[],
  exclude: readonly string[],
): T[] {
  return options.filter(
    (option) => !exclude.some((userId) => sameUser(userId, option.userId)),
  );
}

/**
 * Review K P3: the review read failed in a way a supervisor resolves by force
 * closing: the review is not wired yet, or the cashier never sent a count.
 */
const FORCE_CLOSE_ENTRY_CODES: readonly string[] = [
  "CONTRACT_PENDING",
  "COUNT_NOT_SUBMITTED",
];
export function offersForceClose(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && FORCE_CLOSE_ENTRY_CODES.includes(code);
}
