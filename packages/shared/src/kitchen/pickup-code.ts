// Pickup call code (legend-ggpoe). The stored call number is a per-outlet,
// per-day sequence 1, 2, 3...; the code shown to the customer is derived from
// it: A-001..A-999, B-001.., Z-999, then AA-001, AB-001 and so on. Orders are
// never refused because the numbers ran out (founder decision Q51).

/** Numbers in one letter block (A-001..A-999). */
export const PICKUP_CODE_BLOCK = 999;

/** Shape of a call code: 1-4 letters, a dash, three digits. */
export const PICKUP_CODE_PATTERN = /^[A-Z]{1,4}-\d{3}$/;

/** 1 -> A, 26 -> Z, 27 -> AA, 28 -> AB (bijective base 26). */
function blockLetters(block: number): string {
  let rest = block;
  let letters = "";
  while (rest > 0) {
    const digit = (rest - 1) % 26;
    letters = String.fromCharCode(65 + digit) + letters;
    rest = (rest - 1 - digit) / 26;
  }
  return letters;
}

/** Sequence number (>= 1) to the code shown on the wall and receipt. */
export function formatPickupCode(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1)
    throw new RangeError("Pickup number must be a positive integer");
  const block = Math.ceil(sequence / PICKUP_CODE_BLOCK);
  const position = ((sequence - 1) % PICKUP_CODE_BLOCK) + 1;
  return `${blockLetters(block)}-${String(position).padStart(3, "0")}`;
}
