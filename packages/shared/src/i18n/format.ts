// Locale formatting for UI numbers. One fixed locale (id-ID) and no time zone
// dependence, so the server render and the browser render always match.
// No runtime imports: tests load this file with Node type stripping.

export const DEFAULT_LOCALE = "id-ID";

const rupiah = new Intl.NumberFormat(DEFAULT_LOCALE, {
  style: "currency",
  currency: "IDR",
  currencyDisplay: "symbol",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const integer = new Intl.NumberFormat(DEFAULT_LOCALE, {
  maximumFractionDigits: 0,
});

// Intl puts a no-break space between "Rp" and the digits; the product style
// is "Rp38.000", so drop it.
function compact(text: string): string {
  return text.replace("Rp\u00a0", "Rp");
}

function assertFinite(value: number | bigint): void {
  if (typeof value === "number" && !Number.isFinite(value))
    throw new RangeError(`Cannot format a non-finite amount: ${value}`);
}

/**
 * Formats an amount in whole rupiah: 25000 → "Rp25.000" (no space between
 * the symbol and the digits, so the symbol never wraps away from them).
 * Amounts with sen are rounded half away from zero for display only; the
 * stored value is never changed here.
 */
export function formatRupiah(amount: number | bigint): string {
  assertFinite(amount);
  // Normalize "-0" so a zero balance never renders as "-Rp 0".
  if (amount === 0 || amount === 0n) return compact(rupiah.format(0));
  return compact(rupiah.format(amount)).replace("-", "−");
}

/** Whole numbers with Indonesian grouping: 1234 → "1.234". */
export function formatNumber(
  value: number | bigint,
  options: { fractionDigits?: number } = {},
): string {
  assertFinite(value);
  if (options.fractionDigits === undefined) return integer.format(value);
  return new Intl.NumberFormat(DEFAULT_LOCALE, {
    minimumFractionDigits: options.fractionDigits,
    maximumFractionDigits: options.fractionDigits,
  }).format(value);
}
