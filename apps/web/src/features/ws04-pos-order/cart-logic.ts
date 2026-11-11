// Pure cart rules for the kasir and captain drafts (no React, unit tested).
// Money stays whole rupiah: a line is (base price + modifier deltas) x quantity.
// Holding a line never changes the total: a held line is still owed, it is only
// sent to the kitchen later.
//
// Plain TypeScript: Node tests load it directly.
import type { CartLine, MenuItem, SelectedModifier } from "./types.ts";

export const MAX_LINE_QUANTITY = 99;

export interface AddLineOptions {
  modifiers: SelectedModifier[];
  note: string;
  quantity: number;
}

function clampQuantity(quantity: number): number {
  if (!(quantity >= 1)) return 1;
  return Math.min(MAX_LINE_QUANTITY, Math.floor(quantity));
}

/** Same item, same modifiers (in any order) and same note make one line. */
function lineSignature(
  menuItemId: string,
  modifiers: readonly SelectedModifier[],
  note: string,
): string {
  const picked = modifiers
    .map((modifier) => `${modifier.groupId}:${modifier.optionId}`)
    .sort()
    .join("|");
  return `${menuItemId}#${picked}#${note.trim()}`;
}

function newLineId(): string {
  return `line-${globalThis.crypto.randomUUID()}`;
}

/** Base price plus the price delta of every chosen option; whole rupiah. */
export function lineUnitPriceIdr(
  line: Pick<CartLine, "unitPriceIdr" | "modifiers">,
): number {
  const deltas = line.modifiers.reduce(
    (sum, modifier) => sum + modifier.priceDeltaIdr,
    0,
  );
  return Math.round(line.unitPriceIdr + deltas);
}

export function lineTotalIdr(
  line: Pick<CartLine, "unitPriceIdr" | "modifiers" | "quantity">,
): number {
  return lineUnitPriceIdr(line) * line.quantity;
}

/** Adds an item; merges into the existing line when item, modifiers and note match. */
export function addLine(
  lines: readonly CartLine[],
  item: MenuItem,
  opts: AddLineOptions,
): CartLine[] {
  const quantity = clampQuantity(opts.quantity);
  const note = opts.note.trim();
  const signature = lineSignature(item.id, opts.modifiers, note);
  const existing = lines.find(
    (line) =>
      lineSignature(line.menuItemId, line.modifiers, line.note) === signature,
  );
  if (existing)
    return lines.map((line) =>
      line.lineId === existing.lineId
        ? {
            ...line,
            quantity: Math.min(MAX_LINE_QUANTITY, line.quantity + quantity),
          }
        : line,
    );
  return [
    ...lines,
    {
      lineId: newLineId(),
      menuItemId: item.id,
      name: item.name,
      unitPriceIdr: item.priceIdr,
      quantity,
      modifiers: opts.modifiers.map((modifier) => ({ ...modifier })),
      note,
      course: item.course,
      hold: false,
    },
  ];
}

/** A quantity of 0 or less removes the line; more than 99 is capped at 99. */
export function setQuantity(
  lines: readonly CartLine[],
  lineId: string,
  quantity: number,
): CartLine[] {
  if (!(quantity > 0)) return removeLine(lines, lineId);
  const next = clampQuantity(quantity);
  return lines.map((line) =>
    line.lineId === lineId ? { ...line, quantity: next } : line,
  );
}

export function removeLine(
  lines: readonly CartLine[],
  lineId: string,
): CartLine[] {
  return lines.filter((line) => line.lineId !== lineId);
}

export function toggleHold(
  lines: readonly CartLine[],
  lineId: string,
): CartLine[] {
  return lines.map((line) =>
    line.lineId === lineId ? { ...line, hold: !line.hold } : line,
  );
}

/**
 * `itemCount` and `heldCount` count items (quantities), not lines, so the
 * "N item" label and the "N ditahan" label agree.
 */
export function cartTotals(lines: readonly CartLine[]): {
  itemCount: number;
  subtotalIdr: number;
  heldCount: number;
} {
  let itemCount = 0;
  let subtotalIdr = 0;
  let heldCount = 0;
  for (const line of lines) {
    itemCount += line.quantity;
    subtotalIdr += lineTotalIdr(line);
    if (line.hold) heldCount += line.quantity;
  }
  return { itemCount, subtotalIdr, heldCount };
}

/**
 * A group is wrong when fewer options are picked than it needs (a required
 * group needs at least one) or more than its maximum. Both are listed in
 * `missingGroupIds`; the screen shows "Pilih <grup> sebelum menambahkan.".
 */
export function validateModifiers(
  item: Pick<MenuItem, "modifierGroups">,
  modifiers: readonly SelectedModifier[],
): { ok: true } | { ok: false; missingGroupIds: string[] } {
  const missingGroupIds: string[] = [];
  for (const group of item.modifierGroups) {
    const picked = modifiers.filter(
      (modifier) => modifier.groupId === group.id,
    ).length;
    const needed = Math.max(group.min, group.required ? 1 : 0);
    if (picked < needed || picked > group.max) missingGroupIds.push(group.id);
  }
  return missingGroupIds.length === 0
    ? { ok: true }
    : { ok: false, missingGroupIds };
}
