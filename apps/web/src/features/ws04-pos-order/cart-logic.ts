// Pure cart rules for the kasir and captain drafts (no React, unit tested).
// Money stays whole rupiah: a line is (base price + modifier deltas) x quantity.
// Holding a line never changes the total: a held line is still owed, it is only
// sent to the kitchen later.
//
// Plain TypeScript: Node tests load it directly.
import type {
  CartLine,
  MenuItem,
  MenuVariant,
  OrderLine,
  SelectedModifier,
} from "./types.ts";

export const MAX_LINE_QUANTITY = 99;

export interface AddLineOptions {
  /** Required when the item has variants; ignored (null) otherwise. */
  variant?: MenuVariant | null;
  modifiers: SelectedModifier[];
  note: string;
  quantity: number;
}

function clampQuantity(quantity: number): number {
  if (!(quantity >= 1)) return 1;
  return Math.min(MAX_LINE_QUANTITY, Math.floor(quantity));
}

/**
 * Same item, same modifiers (in any order), same note and the same hold state
 * make one line: a held line never absorbs a fresh one (or the reverse), or
 * the item that should go to the kitchen now would stay held.
 */
function lineSignature(
  menuItemId: string,
  variantId: string | null,
  modifiers: readonly SelectedModifier[],
  note: string,
  hold: boolean,
): string {
  const picked = modifiers
    .map((modifier) => `${modifier.groupId}:${modifier.optionId}`)
    .sort()
    .join("|");
  return `${menuItemId}@${variantId ?? ""}#${picked}#${note.trim()}#${hold ? "held" : "now"}`;
}

function newLineId(): string {
  return `line-${globalThis.crypto.randomUUID()}`;
}

/** True when the cashier must choose a variant or a modifier before adding. */
export function needsChoice(
  item: Pick<MenuItem, "variants" | "modifierGroups">,
): boolean {
  return item.variants.length > 0 || item.modifierGroups.length > 0;
}

/**
 * An item with variants needs one of its own variants; an item without
 * variants takes none. The server refuses a missing variant too.
 */
export function validateVariant(
  item: Pick<MenuItem, "variants">,
  variantId: string | null,
): boolean {
  if (item.variants.length === 0) return variantId === null;
  return item.variants.some((variant) => variant.id === variantId);
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

/** Whole-rupiah total of a draft or sent line: unit price x quantity. */
export function lineTotalIdr(line: CartLine | OrderLine): number {
  return Math.round(lineUnitPriceIdr(line) * line.quantity);
}

/** Adds an item; merges into the existing line when item, modifiers and note match. */
export function addLine(
  lines: readonly CartLine[],
  item: MenuItem,
  opts: AddLineOptions,
): CartLine[] {
  const variant = item.variants.length > 0 ? (opts.variant ?? null) : null;
  // A variant item without a valid variant is not added: the dialog asks for it.
  if (!validateVariant(item, variant?.id ?? null)) return [...lines];
  const quantity = clampQuantity(opts.quantity);
  const note = opts.note.trim();
  const signature = lineSignature(
    item.id,
    variant?.id ?? null,
    opts.modifiers,
    note,
    false,
  );
  const existing = lines.find(
    (line) =>
      lineSignature(
        line.menuItemId,
        line.variantId,
        line.modifiers,
        line.note,
        line.hold,
      ) === signature,
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
      variantId: variant?.id ?? null,
      variantName: variant?.name ?? null,
      name: item.name,
      unitPriceIdr: variant?.priceIdr ?? item.priceIdr,
      quantity,
      modifiers: opts.modifiers.map((modifier) => ({ ...modifier })),
      note,
      course: item.course,
      hold: false,
    },
  ];
}

/**
 * A quantity of 0 or less removes the line; more than 99 is capped at 99. NaN
 * or a fraction is not a quantity: the line stays as it is.
 */
export function setQuantity(
  lines: readonly CartLine[],
  lineId: string,
  quantity: number,
): CartLine[] {
  if (!Number.isFinite(quantity) || !Number.isInteger(quantity))
    return [...lines];
  if (quantity <= 0) return removeLine(lines, lineId);
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
 * group needs at least one), more than its maximum, or the same option twice.
 * All of them are listed in
 * `missingGroupIds`; the screen shows "Pilih <grup> sebelum menambahkan.".
 */
export function validateModifiers(
  item: Pick<MenuItem, "modifierGroups">,
  modifiers: readonly SelectedModifier[],
): { ok: true } | { ok: false; missingGroupIds: string[] } {
  const missingGroupIds: string[] = [];
  for (const group of item.modifierGroups) {
    const inGroup = modifiers.filter(
      (modifier) => modifier.groupId === group.id,
    );
    const picked = inGroup.length;
    const duplicated =
      new Set(inGroup.map((modifier) => modifier.optionId)).size !== picked;
    const needed = Math.max(group.min, group.required ? 1 : 0);
    if (duplicated || picked < needed || picked > group.max)
      missingGroupIds.push(group.id);
  }
  return missingGroupIds.length === 0
    ? { ok: true }
    : { ok: false, missingGroupIds };
}
