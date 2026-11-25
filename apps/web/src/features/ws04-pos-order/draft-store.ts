// Draft carts, one per key: "kasir" for the cashier, `captain:${tableId}` for a
// table. An external store (useSyncExternalStore) backed by sessionStorage, so
// a reload keeps the cart and every screen of one key sees the same lines.
// Storage can be blocked (private mode, quota): then the cart lives in memory.
import { useMemo, useSyncExternalStore } from "react";
import {
  MAX_LINE_QUANTITY,
  addLine,
  removeLine,
  setQuantity,
  toggleHold,
  type AddLineOptions,
} from "./cart-logic.ts";
import type { CartLine, MenuItem } from "./types.ts";

/** The cashier's cart: per outlet and cashier, so a shared till never mixes them. */
export function cashierDraftKey(outletId: string, actorId: string): string {
  return `kasir:${outletId}:${actorId}`;
}

const STORAGE_PREFIX = "legend-pos-order-draft:";
const EMPTY: CartLine[] = [];

const carts = new Map<string, CartLine[]>();
const listeners = new Map<string, Set<() => void>>();

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string";
}

function isCartLine(value: unknown): value is CartLine {
  if (!isRecord(value)) return false;
  const course = value.course;
  return (
    isText(value.lineId) &&
    isText(value.menuItemId) &&
    (value.variantId === null || isText(value.variantId)) &&
    (value.variantName === null || isText(value.variantName)) &&
    isText(value.name) &&
    typeof value.unitPriceIdr === "number" &&
    Number.isFinite(value.unitPriceIdr) &&
    typeof value.quantity === "number" &&
    Number.isInteger(value.quantity) &&
    value.quantity >= 1 &&
    value.quantity <= MAX_LINE_QUANTITY &&
    Array.isArray(value.modifiers) &&
    value.modifiers.every(
      (modifier) =>
        isRecord(modifier) &&
        isText(modifier.groupId) &&
        isText(modifier.optionId) &&
        isText(modifier.name) &&
        typeof modifier.priceDeltaIdr === "number" &&
        Number.isFinite(modifier.priceDeltaIdr),
    ) &&
    isText(value.note) &&
    isRecord(course) &&
    isText(course.id) &&
    isText(course.label) &&
    typeof course.order === "number" &&
    typeof value.hold === "boolean"
  );
}

function load(key: string): CartLine[] {
  const store = storage();
  if (!store) return EMPTY;
  try {
    const raw = store.getItem(STORAGE_PREFIX + key);
    if (!raw) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every(isCartLine))
      return parsed.length === 0 ? EMPTY : parsed;
    // Not a list of cart lines (stale or tampered): drop it, start empty.
    store.removeItem(STORAGE_PREFIX + key);
    return EMPTY;
  } catch {
    // A stale or tampered snapshot must never break the screen: start empty.
    return EMPTY;
  }
}

/** The current lines of a draft (the same array until the next change). */
export function readDraft(key: string): CartLine[] {
  const cached = carts.get(key);
  if (cached) return cached;
  const lines = load(key);
  carts.set(key, lines);
  return lines;
}

export function writeDraft(key: string, lines: CartLine[]): void {
  const next = lines.length === 0 ? EMPTY : lines;
  carts.set(key, next);
  const store = storage();
  if (store) {
    try {
      if (next.length === 0) store.removeItem(STORAGE_PREFIX + key);
      else store.setItem(STORAGE_PREFIX + key, JSON.stringify(next));
    } catch {
      // Quota or private mode: the cart keeps working in memory.
    }
  }
  listeners.get(key)?.forEach((notify) => notify());
}

function subscribe(key: string, notify: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(notify);
  return () => {
    set.delete(notify);
  };
}

/** Test helper: forget the in-memory carts so the next read hits storage. */
export function resetDraftStore(): void {
  carts.clear();
}

export function useDraftCart(key: string) {
  const lines = useSyncExternalStore(
    (notify) => subscribe(key, notify),
    () => readDraft(key),
    () => EMPTY,
  );
  const actions = useMemo(
    () => ({
      add: (item: MenuItem, opts: AddLineOptions) =>
        writeDraft(key, addLine(readDraft(key), item, opts)),
      setQuantity: (lineId: string, quantity: number) =>
        writeDraft(key, setQuantity(readDraft(key), lineId, quantity)),
      remove: (lineId: string) =>
        writeDraft(key, removeLine(readDraft(key), lineId)),
      toggleHold: (lineId: string) =>
        writeDraft(key, toggleHold(readDraft(key), lineId)),
      clear: () => writeDraft(key, EMPTY),
      replace: (next: CartLine[]) => writeDraft(key, next),
    }),
    [key],
  );
  return { lines, ...actions };
}
