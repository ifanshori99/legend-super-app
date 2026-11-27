// Guest service fee for Duitku e-wallet, VA and card (1272 K1; design
// docs/design/duitku-fee-passthrough.md §1-§2, §5). Pure functions, no I/O.
//
// The gateway's MDR is a percentage of the CHARGED amount plus a flat part, so
// the fee is a gross-up: g is the smallest whole rupiah with fee(B + g) <= g,
// which leaves the outlet at least the bill B after the MDR and never charges
// the guest a rupiah more than that. QRIS never carries a fee (§5): its rate
// is never read. A method that should carry a fee and has no usable rate
// answers null (hidden), never a silent 0.

import { duitkuGuestFeesSchema } from "@starter/shared/platform";
import { duitkuMethodCategory } from "./payment-duitku-wire";

export type GuestFeeRate = { readonly bps: number; readonly flatIdr: number };

/** Methods a guest fee may apply to; QRIS is not one of them (§5). */
export const GUEST_FEE_METHODS = ["va", "ewallet", "card"] as const;
export type GuestFeeMethod = (typeof GUEST_FEE_METHODS)[number];

const BPS = 10_000n;

function assertRate(rate: GuestFeeRate): void {
  if (
    !Number.isSafeInteger(rate.bps) ||
    !Number.isSafeInteger(rate.flatIdr) ||
    rate.bps < 0 ||
    rate.bps >= 10_000 ||
    rate.flatIdr < 0
  )
    throw new RangeError("Guest fee rate out of range");
}

function feeBig(amount: bigint, rate: GuestFeeRate): bigint {
  // ceil(amount * bps / 10000) + flat, whole rupiah.
  return (
    (amount * BigInt(rate.bps) + BPS - 1n) / BPS + BigInt(rate.flatIdr)
  );
}

/** The gateway's fee on an amount: `ceil(x * bps / 10000) + flatIdr`. */
export function gatewayFeeOf(amountIdr: number, rate: GuestFeeRate): number {
  assertRate(rate);
  if (!Number.isSafeInteger(amountIdr) || amountIdr < 0)
    throw new RangeError("Amount out of range");
  return Number(feeBig(BigInt(amountIdr), rate));
}

/**
 * Smallest g >= 0 with `fee(B + g) <= g` (BigInt). `g - fee(B + g)` never
 * decreases as g grows (the fee rises by at most 1 per rupiah while bps <
 * 10000), and every g below the real root `(B*bps + flat*10000) / (10000 -
 * bps)` fails, so the scan starts at that root's ceiling and moves at most a
 * couple of steps.
 */
export function grossUpGuestFee(baseIdr: number, rate: GuestFeeRate): number {
  assertRate(rate);
  if (!Number.isSafeInteger(baseIdr) || baseIdr <= 0)
    throw new RangeError("Bill amount out of range");
  const base = BigInt(baseIdr);
  const numerator = base * BigInt(rate.bps) + BigInt(rate.flatIdr) * BPS;
  const denominator = BPS - BigInt(rate.bps);
  let g = (numerator + denominator - 1n) / denominator;
  for (let step = 0; feeBig(base + g, rate) > g; step += 1) {
    if (step >= 8) throw new RangeError("Guest fee gross-up did not settle");
    g += 1n;
  }
  const result = Number(g);
  if (!Number.isSafeInteger(baseIdr + result))
    throw new RangeError("Charged amount out of range");
  return result;
}

function capNumber(value: unknown, max: number): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= max
    ? value
    : null;
}

/**
 * Usable guest fee rates of one Duitku integration config, by channel code.
 * A rate is kept only when it parses, its code is a known VA, e-wallet or card
 * code (QRIS rates are never read), and it is within the method's C4a cap
 * (`maxFeeBps_<method>`, `maxFeeFlatIdr_<method>`, the settlement fee cap). No
 * cap for the method means no rate.
 */
export function guestFeeRatesOf(
  config: Record<string, unknown>,
): ReadonlyMap<string, GuestFeeRate> {
  const rates = new Map<string, GuestFeeRate>();
  const raw = config.guestFees;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return rates;
  for (const [code, value] of Object.entries(raw)) {
    const parsed = duitkuGuestFeesSchema.safeParse({ [code]: value });
    const rate = parsed.success ? parsed.data[code] : undefined;
    if (!rate) continue;
    const method = duitkuMethodCategory(code);
    if (method !== "va" && method !== "ewallet" && method !== "card") continue;
    const bpsRaw = config[`maxFeeBps_${method}`];
    const flatRaw = config[`maxFeeFlatIdr_${method}`];
    if (bpsRaw === undefined && flatRaw === undefined) continue;
    const capBps = bpsRaw === undefined ? 0 : capNumber(bpsRaw, 10_000);
    const capFlat =
      flatRaw === undefined ? 0 : capNumber(flatRaw, 1_000_000_000);
    if (capBps === null || capFlat === null) continue;
    if (rate.bps > capBps || rate.flatIdr > capFlat) continue;
    rates.set(code, { bps: rate.bps, flatIdr: rate.flatIdr });
  }
  return rates;
}

/** Is the guest fee on for this method (`DUITKU_GUEST_FEE_METHODS`)? */
export function guestFeeMethodOn(
  method: string,
  feeMethods: readonly string[],
): method is GuestFeeMethod {
  return (
    (GUEST_FEE_METHODS as readonly string[]).includes(method) &&
    feeMethods.includes(method)
  );
}

/**
 * The guest fee of paying `baseIdr` with this method and Duitku channel code:
 * 0 when the method carries no fee (QRIS, or not in `feeMethods`); null when it
 * should and the channel has no usable rate of that method (hide it, refuse
 * the intent); else the gross-up.
 */
export function guestFeeFor(input: {
  readonly method: string;
  readonly channelCode: string | null;
  readonly baseIdr: number;
  readonly rates: ReadonlyMap<string, GuestFeeRate>;
  readonly feeMethods: readonly string[];
}): number | null {
  if (!guestFeeMethodOn(input.method, input.feeMethods)) return 0;
  if (input.channelCode === null) return null;
  if (duitkuMethodCategory(input.channelCode) !== input.method) return null;
  const rate = input.rates.get(input.channelCode);
  if (!rate) return null;
  return grossUpGuestFee(input.baseIdr, rate);
}

/**
 * §1: the provider's quote q for the charged amount is accepted when it is at
 * most our fee g and short of it by at most one rupiah (rounding). Anything
 * else means the rate changed: no intent.
 */
export function feeQuoteAccepted(quoteIdr: number, guestFeeIdr: number): boolean {
  return quoteIdr <= guestFeeIdr && guestFeeIdr - quoteIdr <= 1;
}
