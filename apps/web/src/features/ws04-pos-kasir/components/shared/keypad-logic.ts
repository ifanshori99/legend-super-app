// Pure helpers for the amount keypad and the denomination counter: whole
// rupiah only, never a float.

/** Largest amount the keypad accepts (Rp 999.999.999). */
export const KEYPAD_MAX_IDR = 999_999_999;

export type KeypadKey =
  "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "000" | "back";

/** Applies one key press to a whole-rupiah amount, capped at `max`. */
export function pressKeypadKey(
  value: number,
  key: KeypadKey,
  max: number = KEYPAD_MAX_IDR,
): number {
  if (key === "back") return Math.floor(value / 10);
  const next = key === "000" ? value * 1000 : value * 10 + Number(key);
  return next > max ? value : next;
}

/** Digits typed or pasted into a field, as a whole number capped at `max`. */
export function parseDigits(
  text: string,
  max: number = KEYPAD_MAX_IDR,
): number {
  const digits = text.replace(/\D/g, "").slice(0, 12);
  if (digits === "") return 0;
  return Math.min(Number(digits), max);
}

/** Sum of count × denomination. */
export function denominationTotal(
  quantities: ReadonlyArray<{ denominationIdr: number; quantity: number }>,
): number {
  return quantities.reduce(
    (sum, row) => sum + row.denominationIdr * row.quantity,
    0,
  );
}
