// The idempotency key of the collect in progress, per outlet and charge, kept
// in localStorage so a refresh or a second tab repeats the same request
// instead of starting another (legend-t93l8). Pure over an injected Storage:
// Node tests load it directly. It holds a random key and no money data that
// the server trusts.

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type ChargeKeyScope = { outletId: string; chargeId: string };

type Entry = {
  signature: string;
  key: string;
  /** The server was read after the attempt and nothing was recorded. */
  checked: boolean;
};

const PREFIX = "legend-pos-charge-collect:";
const KEY_PATTERN = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

const keyOf = ({ outletId, chargeId }: ChargeKeyScope) =>
  `${PREFIX}${outletId}:${chargeId}`;

function read(storage: StorageLike, scope: ChargeKeyScope): Entry | null {
  const raw = storage.getItem(keyOf(scope));
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<Entry> | null;
    if (
      typeof value?.signature !== "string" ||
      typeof value.key !== "string" ||
      !KEY_PATTERN.test(value.key)
    )
      return null;
    return {
      signature: value.signature,
      key: value.key,
      checked: value.checked === true,
    };
  } catch {
    return null;
  }
}

function write(storage: StorageLike, scope: ChargeKeyScope, entry: Entry) {
  storage.setItem(keyOf(scope), JSON.stringify(entry));
}

/**
 * The key to send. The same request keeps its key until the answer is known; a
 * different request is refused (`conflict`) while the last one is unresolved.
 */
export function beginAttempt(
  storage: StorageLike,
  scope: ChargeKeyScope,
  signature: string,
  makeKey: () => string,
): { key: string; conflict: boolean } {
  const current = read(storage, scope);
  if (current && current.signature !== signature && !current.checked)
    return { key: current.key, conflict: true };
  const key = current?.signature === signature ? current.key : makeKey();
  write(storage, scope, { signature, key, checked: false });
  return { key, conflict: false };
}

/** The server was read: nothing recorded. The key stays for a plain retry. */
export function markChecked(storage: StorageLike, scope: ChargeKeyScope): void {
  const current = read(storage, scope);
  if (current) write(storage, scope, { ...current, checked: true });
  else storage.removeItem(keyOf(scope));
}

/** The answer is known (recorded or refused): the next request is new. */
export function endAttempt(storage: StorageLike, scope: ChargeKeyScope): void {
  storage.removeItem(keyOf(scope));
}

/** An attempt was sent and its answer is not known yet. */
export function hasUnresolved(
  storage: StorageLike,
  scope: ChargeKeyScope,
): boolean {
  const current = read(storage, scope);
  return current !== null && !current.checked;
}
