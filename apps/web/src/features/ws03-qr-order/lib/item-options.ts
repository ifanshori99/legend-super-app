// Choosing an item: variant, modifiers with min/max, quantity, note (PRD §3
// F10 "Menu & Keranjang", ORD-01, ORD-05). The preview is for display only;
// the server prices the cart line (ORD-03).
import type { QrMenuItem, QrMenuModifierGroup } from "@starter/shared/qr-order";

export const MAX_QUANTITY = 99;
export const MAX_NOTE_LENGTH = 200;

export type Selection = {
  variantId: string | null;
  modifierIds: readonly string[];
  quantity: number;
  note: string;
};

export type SelectionIssue =
  | { code: "item_sold_out" }
  | { code: "variant_required" }
  | { code: "quantity_invalid" }
  | { code: "note_too_long" }
  | { code: "modifier_sold_out"; groupId: string; modifierId: string }
  | { code: "modifier_min"; groupId: string; min: number }
  | { code: "modifier_max"; groupId: string; max: number };

export function emptySelection(): Selection {
  return { variantId: null, modifierIds: [], quantity: 1, note: "" };
}

export function selectedInGroup(
  group: QrMenuModifierGroup,
  selection: Selection,
): string[] {
  const ids = new Set(group.modifiers.map((modifier) => modifier.id));
  return selection.modifierIds.filter((id) => ids.has(id));
}

/** Empty list means the selection can be added to the cart. */
export function validateSelection(
  item: QrMenuItem,
  selection: Selection,
): SelectionIssue[] {
  const issues: SelectionIssue[] = [];
  if (item.status === "sold_out") issues.push({ code: "item_sold_out" });
  if (
    item.variants.length > 0 &&
    !item.variants.some((variant) => variant.id === selection.variantId)
  )
    issues.push({ code: "variant_required" });
  if (
    !Number.isInteger(selection.quantity) ||
    selection.quantity < 1 ||
    selection.quantity > MAX_QUANTITY
  )
    issues.push({ code: "quantity_invalid" });
  if (selection.note.length > MAX_NOTE_LENGTH)
    issues.push({ code: "note_too_long" });
  for (const group of item.modifierGroups) {
    const chosen = selectedInGroup(group, selection);
    for (const id of chosen) {
      const modifier = group.modifiers.find((entry) => entry.id === id);
      if (modifier?.soldOut)
        issues.push({
          code: "modifier_sold_out",
          groupId: group.id,
          modifierId: id,
        });
    }
    if (chosen.length < group.minSelect)
      issues.push({
        code: "modifier_min",
        groupId: group.id,
        min: group.minSelect,
      });
    if (chosen.length > group.maxSelect)
      issues.push({
        code: "modifier_max",
        groupId: group.id,
        max: group.maxSelect,
      });
  }
  return issues;
}

/**
 * Toggles a modifier. A single-choice group (max 1) swaps the choice; a
 * multi-choice group ignores a tap past its maximum, so the screen never holds
 * an over-full selection.
 */
export function toggleModifier(
  item: QrMenuItem,
  selection: Selection,
  groupId: string,
  modifierId: string,
): Selection {
  const group = item.modifierGroups.find((entry) => entry.id === groupId);
  if (!group) return selection;
  const chosen = selectedInGroup(group, selection);
  const others = selection.modifierIds.filter((id) => !chosen.includes(id));
  if (chosen.includes(modifierId))
    return {
      ...selection,
      modifierIds: [...others, ...chosen.filter((id) => id !== modifierId)],
    };
  if (group.maxSelect === 1)
    return { ...selection, modifierIds: [...others, modifierId] };
  if (chosen.length >= group.maxSelect) return selection;
  return { ...selection, modifierIds: [...others, ...chosen, modifierId] };
}

/** Unit price shown on the button; excludes tax and service charge. */
export function previewUnitPrice(
  item: QrMenuItem,
  selection: Selection,
): number {
  const variant = item.variants.find(
    (entry) => entry.id === selection.variantId,
  );
  const base = variant?.priceIdr ?? item.priceIdr;
  const extras = item.modifierGroups
    .flatMap((group) => group.modifiers)
    .filter((modifier) => selection.modifierIds.includes(modifier.id))
    .reduce((sum, modifier) => sum + modifier.priceIdr, 0);
  return base + extras;
}

export function previewLineTotal(
  item: QrMenuItem,
  selection: Selection,
): number {
  return previewUnitPrice(item, selection) * selection.quantity;
}

export function groupRule(group: QrMenuModifierGroup): {
  required: boolean;
  min: number;
  max: number;
} {
  return {
    required: group.minSelect > 0,
    min: group.minSelect,
    max: group.maxSelect,
  };
}

/** Lowest price a guest sees on a card: "mulai dari" when variants differ. */
export function hasPriceRange(item: QrMenuItem): boolean {
  return (
    item.variants.length > 1 &&
    new Set(item.variants.map((variant) => variant.priceIdr)).size > 1
  );
}
