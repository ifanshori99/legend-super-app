// Pure money rules of the POS correction screens (discount, void, refund;
// bead legend-2fo, POS-02/POS-04). Every figure is whole rupiah, computed here
// and never in JSX. The API stays the authority (it re-checks each limit and
// answers 422 when a figure is too high); these functions only show the
// cashier the same numbers first and keep a request from being sent that the
// API would refuse. No imports: Node tests load this file directly.

const MAX_IDR = 999_999_999;
const BP_DENOMINATOR = 10_000;

function assertWholeIdr(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0)
    throw new RangeError(`${name} must be a whole, non-negative rupiah amount`);
}

/**
 * The example shown before a discount is applied: the discount is held between
 * 0 and the subtotal, tax follows the discounted subtotal, the total is the
 * discounted subtotal plus tax. 200000 with 20000 at 1000 bps gives
 * 20000 / 18000 / 198000.
 */
export function discountPreview(i: {
  subtotalIdr: number;
  discountIdr: number;
  taxRateBps: number;
}): { discountIdr: number; taxIdr: number; totalIdr: number } {
  assertWholeIdr("subtotalIdr", i.subtotalIdr);
  assertWholeIdr("taxRateBps", i.taxRateBps);
  if (!Number.isFinite(i.discountIdr))
    throw new RangeError("discountIdr must be a number");
  const discountIdr = Math.floor(
    Math.min(Math.max(i.discountIdr, 0), i.subtotalIdr),
  );
  const base = i.subtotalIdr - discountIdr;
  const taxIdr = Math.round((base * i.taxRateBps) / BP_DENOMINATOR);
  return { discountIdr, taxIdr, totalIdr: base + taxIdr };
}

/** What the server takes off for a manual percent discount (it rounds down). */
export function percentDiscountIdr(i: {
  subtotalIdr: number;
  percentBp: number;
}): number {
  assertWholeIdr("subtotalIdr", i.subtotalIdr);
  assertWholeIdr("percentBp", i.percentBp);
  return Math.floor(
    (i.subtotalIdr * Math.min(i.percentBp, BP_DENOMINATOR)) / BP_DENOMINATOR,
  );
}

/**
 * "10" or "7,5" to basis points (1000, 750). At most two decimals, above 0 and
 * at most 100 percent; anything else is null so the field shows an error.
 */
export function parsePercentBp(text: string): number | null {
  const match = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const bp = whole * 100 + fraction;
  return bp >= 1 && bp <= BP_DENOMINATOR ? bp : null;
}

/** The outlet's rule: a manual discount above the share of the subtotal needs a supervisor. */
export function discountNeedsApproval(i: {
  subtotalIdr: number;
  discountIdr: number;
  thresholdBp: number;
}): boolean {
  assertWholeIdr("subtotalIdr", i.subtotalIdr);
  assertWholeIdr("discountIdr", i.discountIdr);
  assertWholeIdr("thresholdBp", i.thresholdBp);
  return i.discountIdr * BP_DENOMINATOR > i.subtotalIdr * i.thresholdBp;
}

/** Tax share of a base, in basis points, to carry the order's own rate into the preview. */
export function taxRateBpsOf(i: { taxIdr: number; baseIdr: number }): number {
  assertWholeIdr("taxIdr", i.taxIdr);
  assertWholeIdr("baseIdr", i.baseIdr);
  if (i.baseIdr === 0) return 0;
  return Math.round((i.taxIdr * BP_DENOMINATOR) / i.baseIdr);
}

/** Subtotal once a line is voided; never below zero. */
export function subtotalAfterVoidIdr(i: {
  subtotalIdr: number;
  itemIdr: number;
}): number {
  assertWholeIdr("subtotalIdr", i.subtotalIdr);
  assertWholeIdr("itemIdr", i.itemIdr);
  return Math.max(0, i.subtotalIdr - i.itemIdr);
}

/** Still refundable: what was paid minus what was already returned, never negative. */
export function refundableIdr(i: {
  paidIdr: number;
  refundedIdr: number;
}): number {
  assertWholeIdr("paidIdr", i.paidIdr);
  assertWholeIdr("refundedIdr", i.refundedIdr);
  return Math.max(0, i.paidIdr - i.refundedIdr);
}

export type RefundAmountIssue = "empty" | "over";

/** Why a refund amount cannot be sent, or null when it can. */
export function refundAmountIssue(i: {
  amountIdr: number | null;
  availableIdr: number;
}): RefundAmountIssue | null {
  if (
    i.amountIdr === null ||
    !Number.isInteger(i.amountIdr) ||
    i.amountIdr <= 0
  )
    return "empty";
  return i.amountIdr > i.availableIdr ? "over" : null;
}

/** Digits only ("Rp50.000" or "50000") to whole rupiah; null when empty or too large. */
export function parseRupiahDigits(text: string): number | null {
  const digits = text.replace(/\D/g, "");
  if (digits === "") return null;
  const value = Number(digits);
  return value <= MAX_IDR ? value : null;
}
