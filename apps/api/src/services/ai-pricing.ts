// AI provider pricing (WS-12 part G, bead legend-zfi4; PRD §40 AIG-02).
// Cost is kept in micro-USD (millionths of a dollar) because that is what the
// provider bills; the budget unit of `ai_settings` is whole rupiah, converted
// with one fixed rate. Prices are per million tokens: 1 USD / MTok equals
// exactly 1 micro-USD per token, so cost = tokens * price with no float math.

/** Fixed budget conversion rate (IDR per USD). Documented assumption: PRD v1.7 sets none. */
export const USD_IDR_RATE = 16_500;

type Price = {
  /** Hundredths of a US dollar per million input tokens (400 = $4.00). */
  readonly inputPer100: number;
  readonly outputPer100: number;
};

const OPUS: Price = { inputPer100: 400, outputPer100: 2000 };
const SONNET: Price = { inputPer100: 200, outputPer100: 1000 };
const HAIKU: Price = { inputPer100: 10, outputPer100: 50 };

/** Unknown model = opus price (never undercount spend). */
export function priceFor(model: string): Price {
  const name = model.toLowerCase();
  if (name.includes("sonnet-5-5")) return SONNET;
  if (name.includes("haiku-5-5")) return HAIKU;
  return OPUS;
}

/** Provider cost in micro-USD, rounded up to a whole micro-dollar. */
export function costMicroUsd(
  model: string,
  usage: { inputTokens: number; outputTokens: number },
): number {
  const price = priceFor(model);
  const hundredths =
    BigInt(Math.max(0, Math.trunc(usage.inputTokens))) *
      BigInt(price.inputPer100) +
    BigInt(Math.max(0, Math.trunc(usage.outputTokens))) *
      BigInt(price.outputPer100);
  return Number((hundredths + 99n) / 100n);
}

/** Whole rupiah for a micro-USD amount, rounded up. */
export function microUsdToIdr(micro: number): number {
  return Number((BigInt(micro) * BigInt(USD_IDR_RATE) + 999_999n) / 1_000_000n);
}
