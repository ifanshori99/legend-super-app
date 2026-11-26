// The witness approval of a supervisor's forced count (O4, legend-wasr7.8).
// The server keeps the override but offers no read of "the approval of this
// count", so the supervisor's device keeps what the close must name: the count,
// the override, the approver. A refresh must not lose it; a stale answer marks
// it so the screen asks for a recount. Pure over an injected Storage.
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type StoredForceCloseApproval = {
  countId: string;
  overrideId: string;
  approverUserId: string;
  approverName: string;
  stale: boolean;
};

const keyOf = (outletId: string, shiftId: string) =>
  `pos-kasir:force-close:${outletId}:${shiftId}`;

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

const memory = new Map<string, string>();

export function readForceCloseApproval(
  outletId: string,
  shiftId: string,
  storage: StorageLike | null = browserStorage(),
): StoredForceCloseApproval | null {
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
    const value = JSON.parse(raw) as Partial<StoredForceCloseApproval>;
    if (
      typeof value.countId === "string" &&
      typeof value.overrideId === "string" &&
      typeof value.approverUserId === "string" &&
      typeof value.approverName === "string" &&
      typeof value.stale === "boolean"
    )
      return value as StoredForceCloseApproval;
  } catch {
    // A broken entry is the same as none: the witness approves again.
  }
  return null;
}

export function writeForceCloseApproval(
  outletId: string,
  shiftId: string,
  approval: StoredForceCloseApproval,
  storage: StorageLike | null = browserStorage(),
): void {
  const key = keyOf(outletId, shiftId);
  const raw = JSON.stringify(approval);
  memory.set(key, raw);
  try {
    storage?.setItem(key, raw);
  } catch {
    // Memory still holds it for this page.
  }
}

export function clearForceCloseApproval(
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
