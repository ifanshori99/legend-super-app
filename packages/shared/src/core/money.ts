// Money conventions (PRD v1.7 §6; decision recorded in docs/plan/contracts.md):
// - Posted, paid, billed or reported amounts are whole rupiah: Postgres BIGINT,
//   field suffix `Idr` on the wire (`total_idr` in the DB). In TypeScript and
//   JSON they are a branded safe integer (Idr): every realistic rupiah amount
//   (|x| < 9 * 10^15) fits, so JSON never needs bigint strings.
// - Per-unit cost and quantity (stock_ledger.unit_cost_idr, quantity,
//   recipes.theoretical_cost_idr, yields, AI per-call cost estimates) are
//   NUMERIC(14,4): a decimal string (Decimal4) on the wire, exact scaled bigint
//   arithmetic here, never a float.
// - Rounding is always explicit (RoundingMode). Which mode and increment a
//   tenant uses (PRD F11 "aturan pembulatan") is configuration, not code.
// Arithmetic runs in bigint so intermediate products never lose precision.

import { z } from "zod";

export const idrSchema = z
  .number()
  .int()
  .refine(Number.isSafeInteger, "Rupiah amount exceeds the safe integer range")
  .brand<"Idr">();

/** Whole rupiah. BIGINT in Postgres, safe integer in JSON. */
export type Idr = z.infer<typeof idrSchema>;

/** Validates a whole-rupiah amount. Throws RangeError on fractions or overflow. */
export function idr(amount: number): Idr {
  if (!Number.isSafeInteger(amount))
    throw new RangeError(`Not a whole safe-integer rupiah amount: ${amount}`);
  // Normalize -0 so a zero balance never prints or compares as negative.
  return (amount === 0 ? 0 : amount) as Idr;
}

/**
 * Exact bigint -> Idr (no float, no rounding). Throws RangeError beyond the
 * safe-integer range instead of silently losing digits.
 */
export function idrFromBigInt(value: bigint): Idr {
  if (
    value > BigInt(Number.MAX_SAFE_INTEGER) ||
    value < BigInt(Number.MIN_SAFE_INTEGER)
  )
    throw new RangeError(`Rupiah amount overflow: ${value}`);
  return idr(Number(value));
}

function integer(value: number, label: string): bigint {
  if (!Number.isSafeInteger(value))
    throw new RangeError(`${label} must be a safe integer: ${value}`);
  return BigInt(value);
}

export const ROUNDING_MODES = [
  "half_up",
  "half_even",
  "down",
  "floor",
  "ceil",
] as const;
export const roundingModeSchema = z.enum(ROUNDING_MODES);
/**
 * half_up: half away from zero (2.5 -> 3, -2.5 -> -3).
 * half_even: banker's rounding (2.5 -> 2, 3.5 -> 4).
 * down: toward zero. floor: toward -infinity. ceil: toward +infinity.
 */
export type RoundingMode = (typeof ROUNDING_MODES)[number];

/** numerator / denominator rounded to an integer with the given mode. */
export function divideRounded(
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode,
): bigint {
  if (denominator === 0n) throw new RangeError("Division by zero");
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return quotient;
  const sign = numerator < 0n ? -1n : 1n;
  const twice = 2n * (remainder < 0n ? -remainder : remainder);
  switch (mode) {
    case "down":
      return quotient;
    case "floor":
      return sign < 0n ? quotient - 1n : quotient;
    case "ceil":
      return sign > 0n ? quotient + 1n : quotient;
    case "half_up":
      return twice >= denominator ? quotient + sign : quotient;
    case "half_even":
      if (twice > denominator) return quotient + sign;
      if (twice < denominator) return quotient;
      return quotient % 2n === 0n ? quotient : quotient + sign;
  }
}

export function addIdr(a: Idr, b: Idr): Idr {
  return idrFromBigInt(BigInt(a) + BigInt(b));
}

export function subtractIdr(a: Idr, b: Idr): Idr {
  return idrFromBigInt(BigInt(a) - BigInt(b));
}

export function negateIdr(a: Idr): Idr {
  return idr(-a);
}

export function sumIdr(amounts: readonly Idr[]): Idr {
  let total = 0n;
  for (const amount of amounts) total += BigInt(amount);
  return idrFromBigInt(total);
}

/** amount x whole-number factor (e.g. unit price x quantity). */
export function multiplyIdr(amount: Idr, factor: number): Idr {
  return idrFromBigInt(BigInt(amount) * integer(factor, "Factor"));
}

/** amount x numerator / denominator, rounded. E.g. 12% x 11/12 DPP. */
export function applyRatio(
  amount: Idr,
  numerator: number,
  denominator: number,
  mode: RoundingMode,
): Idr {
  return idrFromBigInt(
    divideRounded(
      BigInt(amount) * integer(numerator, "Numerator"),
      integer(denominator, "Denominator"),
      mode,
    ),
  );
}

/** Basis points: 10,000 bp = 100%. Shares, tax and service-charge rates. */
export const basisPointsSchema = z.number().int().min(0).max(10_000);
export type BasisPoints = z.infer<typeof basisPointsSchema>;

/**
 * Founder decision W9 (2026-11-11): a manual discount above 50% of the subtotal
 * always needs approval, so the approval threshold can never exceed 5000 bp.
 * Stored values above it (older rows) are clamped on read, never migrated.
 */
export const POS_DISCOUNT_APPROVAL_MAX_BP = 5000;

/** Clamp a stored threshold to the founder maximum (read side only). */
export function capDiscountThresholdBp(value: number): number {
  return Math.min(value, POS_DISCOUNT_APPROVAL_MAX_BP);
}

/** Write-side rule shared by the policy, the config bundle and the importer. */
export const posDiscountThresholdBpSchema = z
  .number()
  .int()
  .min(1, "The discount threshold must be above zero")
  .max(
    POS_DISCOUNT_APPROVAL_MAX_BP,
    `The discount threshold is at most ${POS_DISCOUNT_APPROVAL_MAX_BP} bp (50%)`,
  );

/** amount x bp / 10,000, rounded. PBJT 10% = 1,000 bp. */
export function applyBasisPoints(
  amount: Idr,
  bp: number,
  mode: RoundingMode,
): Idr {
  if (!Number.isSafeInteger(bp) || bp < 0)
    throw new RangeError(`Invalid basis points: ${bp}`);
  return applyRatio(amount, bp, 10_000, mode);
}

/**
 * Rounds a bill to a cash increment (e.g. Rp100). `adjustment` is the
 * rounding line (orders.rounding_idr): amount = original + adjustment.
 */
export function roundToIncrement(
  amount: Idr,
  increment: number,
  mode: RoundingMode,
): { amount: Idr; adjustment: Idr } {
  if (!Number.isSafeInteger(increment) || increment <= 0)
    throw new RangeError(
      `Rounding increment must be a positive integer: ${increment}`,
    );
  const step = BigInt(increment);
  const rounded = idrFromBigInt(
    divideRounded(BigInt(amount), step, mode) * step,
  );
  return { amount: rounded, adjustment: subtractIdr(rounded, amount) };
}

/**
 * Splits `total` in proportion to non-negative integer `weights` so the parts
 * sum to exactly `total` (ORD-06). Largest remainder method; ties go to the
 * earlier index, so the result is deterministic. Zero weights get zero.
 * Negative totals (refunds) split the absolute value and negate it.
 */
export function allocateIdr(total: Idr, weights: readonly number[]): Idr[] {
  if (weights.length === 0)
    throw new RangeError("Allocation needs at least one weight");
  const big = weights.map((weight) => {
    if (!Number.isSafeInteger(weight) || weight < 0)
      throw new RangeError(
        `Allocation weights must be non-negative integers: ${weight}`,
      );
    return BigInt(weight);
  });
  const weightSum = big.reduce((sum, weight) => sum + weight, 0n);
  if (weightSum === 0n) throw new RangeError("Allocation weights sum to zero");
  const negative = total < 0;
  const absolute = BigInt(negative ? -total : total);
  const parts = big.map((weight) => (absolute * weight) / weightSum);
  const remainders = big.map((weight, index) => ({
    index,
    rest: (absolute * weight) % weightSum,
  }));
  let leftover = absolute - parts.reduce((sum, part) => sum + part, 0n);
  remainders.sort((a, b) =>
    a.rest === b.rest ? a.index - b.index : a.rest > b.rest ? -1 : 1,
  );
  for (const { index } of remainders) {
    if (leftover === 0n) break;
    parts[index] += 1n;
    leftover -= 1n;
  }
  return parts.map((part) => idrFromBigInt(negative ? -part : part));
}

/** Equal split (split bill per person), earlier parts take the extra rupiah. */
export function splitIdrEvenly(total: Idr, parts: number): Idr[] {
  if (!Number.isSafeInteger(parts) || parts <= 0)
    throw new RangeError(`Invalid number of parts: ${parts}`);
  return allocateIdr(
    total,
    Array.from({ length: parts }, () => 1),
  );
}

// ---- NUMERIC(14,4): quantities and per-unit costs -------------------------

const SCALE = 10_000n;
const DECIMAL4_LIMIT = 10n ** 14n; // 14 significant digits, 4 after the point
const DECIMAL4_PATTERN = /^-?\d{1,10}(\.\d{1,4})?$/;

/** NUMERIC(14,4) as a decimal string, e.g. "0.0180" or "245000". */
export const decimal4Schema = z
  .string()
  .regex(
    DECIMAL4_PATTERN,
    "Expected a decimal with at most 10 integer and 4 fraction digits",
  )
  .brand<"Decimal4">();
export type Decimal4 = z.infer<typeof decimal4Schema>;

/** Validates a NUMERIC(14,4) string. */
export function decimal4(value: string): Decimal4 {
  return decimal4Schema.parse(value);
}

/** Decimal4 -> bigint scaled by 10^4 ("1.5" -> 15000n). */
export function parseDecimal4(value: string): bigint {
  if (!DECIMAL4_PATTERN.test(value))
    throw new RangeError(`Not a NUMERIC(14,4) value: ${value}`);
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const scaled = BigInt(whole) * SCALE + BigInt(fraction.padEnd(4, "0"));
  return negative ? -scaled : scaled;
}

/** bigint scaled by 10^4 -> canonical Decimal4 with 4 fraction digits. */
export function formatDecimal4(scaled: bigint): Decimal4 {
  const absolute = scaled < 0n ? -scaled : scaled;
  if (absolute >= DECIMAL4_LIMIT)
    throw new RangeError(`NUMERIC(14,4) overflow: ${scaled}`);
  const whole = absolute / SCALE;
  const fraction = (absolute % SCALE).toString().padStart(4, "0");
  return `${scaled < 0n ? "-" : ""}${whole}.${fraction}` as Decimal4;
}

/** quantity x unit cost -> whole rupiah (e.g. recipe line cost, stock value). */
export function extendCostIdr(
  quantity: Decimal4,
  unitCostIdr: Decimal4,
  mode: RoundingMode,
): Idr {
  return idrFromBigInt(
    divideRounded(
      parseDecimal4(quantity) * parseDecimal4(unitCostIdr),
      SCALE * SCALE,
      mode,
    ),
  );
}

/** a x b at NUMERIC(14,4) precision (e.g. UOM conversion x quantity). */
export function multiplyDecimal4(
  a: Decimal4,
  b: Decimal4,
  mode: RoundingMode,
): Decimal4 {
  return formatDecimal4(
    divideRounded(parseDecimal4(a) * parseDecimal4(b), SCALE, mode),
  );
}

/** Rupiah total / quantity -> per-unit cost at NUMERIC(14,4) precision. */
export function unitCostOf(
  totalIdr: Idr,
  quantity: Decimal4,
  mode: RoundingMode,
): Decimal4 {
  const scaledQuantity = parseDecimal4(quantity);
  if (scaledQuantity === 0n) throw new RangeError("Quantity must not be zero");
  return formatDecimal4(
    divideRounded(BigInt(totalIdr) * SCALE * SCALE, scaledQuantity, mode),
  );
}
