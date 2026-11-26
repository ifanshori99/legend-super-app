// The cashier's latest blind count of a shift (1268 W3). The server never lets
// a cashier read a count back (the stored rows carry expected and variance), so
// the receipt of the submit is kept here: the close names this count id, and a
// refresh must not lose it. Only what the blind receipt already said: id,
// order number, counted total, whether a note is due. Never a system figure.
// Pure over an injected Storage: Node tests load it directly.
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type StoredCount = {
  countId: string;
  sequence: number;
  countedIdr: number;
  noteRequired: boolean;
  submittedAt: string;
};

const keyOf = (outletId: string, shiftId: string) =>
  `pos-kasir:shift-count:${outletId}:${shiftId}`;

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

const memory = new Map<string, string>();

export function readStoredCount(
  outletId: string,
  shiftId: string,
  storage: StorageLike | null = browserStorage(),
): StoredCount | null {
  const key = keyOf(outletId, shiftId);
  let raw: string | null = null;
  try {
    raw = storage?.getItem(key) ?? null;
  } catch {
    raw = null;
  }
  raw ??= memory.get(key) ?? null;
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredCount>;
    if (
      typeof value.countId === "string" &&
      typeof value.sequence === "number" &&
      typeof value.countedIdr === "number" &&
      typeof value.noteRequired === "boolean" &&
      typeof value.submittedAt === "string"
    )
      return value as StoredCount;
  } catch {
    // A broken entry is the same as none: the cashier counts again.
  }
  return null;
}

export function writeStoredCount(
  outletId: string,
  shiftId: string,
  count: StoredCount,
  storage: StorageLike | null = browserStorage(),
): void {
  const key = keyOf(outletId, shiftId);
  const raw = JSON.stringify(count);
  memory.set(key, raw);
  try {
    storage?.setItem(key, raw);
  } catch {
    // Memory still holds it for this page.
  }
}

export function clearStoredCount(
  outletId: string,
  shiftId: string,
  storage: StorageLike | null = browserStorage(),
): void {
  const key = keyOf(outletId, shiftId);
  memory.delete(key);
  try {
    storage?.removeItem(key);
  } catch {
    // Nothing else to clear.
  }
}
