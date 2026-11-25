// The idempotency key of a send in progress (create order, submit order, park,
// resume), per outlet, cashier and cart, kept in sessionStorage next to the
// draft cart so a refresh repeats the same request instead of starting another
// (brief 1268, money invariants). Pure over an injected Storage: Node tests
// load it directly. It holds random keys, the order id the create returned and
// a fingerprint of the cart; nothing the server trusts.
//
// The key stays until the answer is known: 2xx, or a definitive refusal of that
// key (400/404/409/410/422). A timeout, 5xx, 401, 403 or 429 keep it. While a
// key is unresolved, a different request in the same scope is refused
// (`conflict`): the first one may have been recorded.

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type IntentKind = "create" | "submit" | "park" | "resume";

export type IntentScope = {
  outletId: string;
  /** The cashier at the till; another cashier never shares a key. */
  actorId: string;
  kind: IntentKind;
  /** The cart key for create/submit/park, the parked order id for resume. */
  subject: string;
};

type Entry = {
  /** Fingerprint of the exact request the key belongs to. */
  signature: string;
  key: string;
  /** What the first step produced (the order id between create and submit). */
  data: string | null;
};

const PREFIX = "legend-pos-order-intent:";
const KEY_PATTERN = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

const slot = ({ outletId, actorId, kind, subject }: IntentScope) =>
  `${PREFIX}${kind}:${outletId}:${actorId}:${subject}`;

function read(storage: StorageLike, scope: IntentScope): Entry | null {
  const raw = storage.getItem(slot(scope));
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
      data: typeof value.data === "string" ? value.data : null,
    };
  } catch {
    return null;
  }
}

/**
 * The key to send, written to storage before the request goes out. The same
 * request keeps its key (and `data`); a different request while one is
 * unresolved is a `conflict` and must not be sent.
 */
export function beginIntent(
  storage: StorageLike,
  scope: IntentScope,
  signature: string,
  makeKey: () => string,
): { key: string; data: string | null; conflict: boolean } {
  const current = read(storage, scope);
  if (current && current.signature !== signature)
    return { key: current.key, data: current.data, conflict: true };
  if (current) return { key: current.key, data: current.data, conflict: false };
  const key = makeKey();
  storage.setItem(
    slot(scope),
    JSON.stringify({ signature, key, data: null } satisfies Entry),
  );
  return { key, data: null, conflict: false };
}

/** Remember what the first step returned (the created order's id). */
export function recordIntentData(
  storage: StorageLike,
  scope: IntentScope,
  key: string,
  data: string,
): void {
  const current = read(storage, scope);
  if (current?.key === key)
    storage.setItem(slot(scope), JSON.stringify({ ...current, data }));
}

/** The answer is known (recorded or refused): the next request is new. */
export function endIntent(
  storage: StorageLike,
  scope: IntentScope,
  key?: string,
): void {
  if (key !== undefined && read(storage, scope)?.key !== key) return;
  storage.removeItem(slot(scope));
}

/** The stored request of a scope, without creating one. */
export function peekIntent(
  storage: StorageLike,
  scope: IntentScope,
): { signature: string; key: string; data: string | null } | null {
  return read(storage, scope);
}

/** A request was sent and its answer is not known yet. */
export function hasUnresolvedIntent(
  storage: StorageLike,
  scope: IntentScope,
): boolean {
  return read(storage, scope) !== null;
}

/** HTTP statuses that mean the server recorded nothing for the key. */
const DEFINITIVE_REFUSALS = new Set([400, 404, 409, 410, 413, 422]);

/**
 * True when the key can be forgotten after this failure. A network error has
 * no status; timeout, 5xx, 401, 403 and 429 are all unknown outcomes.
 */
export function isDefinitiveRefusal(status: number | null): boolean {
  return status !== null && DEFINITIVE_REFUSALS.has(status);
}
