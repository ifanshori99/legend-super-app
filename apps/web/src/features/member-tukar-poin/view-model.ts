// Pure numbers behind the points picker (legend-0ne0z). No React, no clock, no
// text catalog: the component maps `error` to a message. The server stays the
// authority; this only previews what the member typed against the quote.
import { formatNumber, formatRupiah } from "@starter/shared/i18n";
import type { MemberPointsQuote } from "@starter/shared/crm";

/** 185000 -> "Rp185.000". */
export function formatIdr(amount: number): string {
  return formatRupiah(amount);
}

/** 1240 -> "1.240 poin". */
export function formatPoints(points: number): string {
  return `${formatNumber(points)} poin`;
}

export type RedeemPreviewError =
  | "empty"
  | "not_integer"
  | "below_min"
  | "over_balance"
  | "over_bill"
  | "not_eligible";

export type RedeemPreview = {
  points: number | null;
  valueIdr: number;
  remainingAfterIdr: number;
  balanceAfter: number;
  error: RedeemPreviewError | null;
};

/**
 * Most points the picker accepts. Never trusts `maxPoints` alone: a bloated or
 * stale quote is also bounded by the balance and by what the remaining bill can
 * absorb. A non-positive point value caps at 0 (the rule that limits payout).
 */
export function capPoints(
  quote: Pick<
    MemberPointsQuote,
    "balancePoints" | "pointValueIdr" | "maxPoints" | "remainingIdr"
  >,
): number {
  if (quote.pointValueIdr <= 0) return 0;
  const byBill = Math.floor(
    Math.max(0, quote.remainingIdr) / quote.pointValueIdr,
  );
  return Math.max(0, Math.min(quote.maxPoints, quote.balancePoints, byBill));
}

/**
 * `over_balance`: more than the member owns. `over_bill`: within the balance
 * but worth more than the remaining bill. On any error `points` is null and
 * the amounts show the untouched bill and balance.
 */
export function previewRedeem(
  quote: Pick<
    MemberPointsQuote,
    | "balancePoints"
    | "pointValueIdr"
    | "minPoints"
    | "maxPoints"
    | "remainingIdr"
    | "refusal"
  >,
  rawInput: string,
): RedeemPreview {
  const fail = (error: RedeemPreviewError): RedeemPreview => ({
    points: null,
    valueIdr: 0,
    remainingAfterIdr: quote.remainingIdr,
    balanceAfter: quote.balancePoints,
    error,
  });
  if (quote.refusal !== null) return fail("not_eligible");
  const input = rawInput.trim();
  if (input === "") return fail("empty");
  if (!/^\d+$/.test(input)) return fail("not_integer");
  const points = Number(input);
  if (!Number.isSafeInteger(points)) return fail("over_balance");
  if (points < quote.minPoints) return fail("below_min");
  if (points > quote.balancePoints) return fail("over_balance");
  if (points > capPoints(quote)) return fail("over_bill");
  const valueIdr = points * quote.pointValueIdr;
  return {
    points,
    valueIdr,
    remainingAfterIdr: Math.max(0, quote.remainingIdr - valueIdr),
    balanceAfter: quote.balancePoints - points,
    error: null,
  };
}
