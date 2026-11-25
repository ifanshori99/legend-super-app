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
  /** The server was read after the attempt and the charge was still open. */
  checked: boolean;
  /** The server answered 409/422 for this key: it recorded nothing for it. */
  refused: boolean;
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
      refused: value.refused === true,
    };
  } catch {
    return null;
  }
}

function write(storage: StorageLike, scope: ChargeKeyScope, entry: Entry) {
  storage.setItem(keyOf(scope), JSON.stringify(entry));
}

const isQris = (signature: string) => signature.startsWith("qris:");

/**
 * The key to send. The same request keeps its key until the answer is known.
 * Without an answer for the key, no other request is allowed (`conflict`): the
 * first one may have been recorded. The ways out are the server's 409/422 for
 * that key plus a read of the charge as open, or a QRIS asked after the
 * server's code changed (the earlier QRIS request did reach the server).
 */
export function beginAttempt(
  storage: StorageLike,
  scope: ChargeKeyScope,
  signature: string,
  makeKey: () => string,
): { key: string; conflict: boolean } {
  const current = read(storage, scope);
  if (current && current.signature !== signature) {
    const freed =
      (current.refused && current.checked) ||
      (isQris(current.signature) && isQris(signature));
    if (!freed) return { key: current.key, conflict: true };
  }
  const key = current?.signature === signature ? current.key : makeKey();
  write(storage, scope, { signature, key, checked: false, refused: false });
  return { key, conflict: false };
}

/** The charge was read as open: the lock below stays until the key is refused. */
export function markChecked(storage: StorageLike, scope: ChargeKeyScope): void {
  const current = read(storage, scope);
  if (current) write(storage, scope, { ...current, checked: true });
  else storage.removeItem(keyOf(scope));
}

/** The server answered 409/422 for this key (a tab with another key is ignored). */
export function markRefused(
  storage: StorageLike,
  scope: ChargeKeyScope,
  key: string,
): void {
  const current = read(storage, scope);
  if (current?.key === key)
    write(storage, scope, { ...current, refused: true });
}

/** The answer is known (recorded or refused): the next request is new. */
export function endAttempt(
  storage: StorageLike,
  scope: ChargeKeyScope,
  key?: string,
): void {
  if (key !== undefined && read(storage, scope)?.key !== key) return;
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
