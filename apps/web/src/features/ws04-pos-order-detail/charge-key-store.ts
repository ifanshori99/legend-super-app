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
 * What the server's charge says about its gateway code right now: the code's
 * id and whether it ended unpaid (expired or failed).
 */
export type ChargeCodeFacts = { paymentId: string | null; codeEnded: boolean };

const NO_CODE: ChargeCodeFacts = { paymentId: null, codeEnded: false };

/**
 * A QRIS request named the code the server had when it was sent. A server
 * code with another id that ended unpaid answers it: that request (or a later
 * one) reached the server and no money can come from it (legend-f1mmf (c)).
 */
function qrisAnswered(signature: string, facts: ChargeCodeFacts): boolean {
  return (
    isQris(signature) &&
    facts.codeEnded &&
    facts.paymentId !== null &&
    signature !== `qris:${facts.paymentId}`
  );
}

/** The stored attempt no longer holds the other methods. */
function freed(entry: Entry, facts: ChargeCodeFacts): boolean {
  return (entry.refused && entry.checked) || qrisAnswered(entry.signature, facts);
}

/**
 * The attempt this browser sent without a known answer, while it still holds
 * the other methods: only its own method may be sent again (same key), or a
 * supervisor settles it (legend-f1mmf (a)). Null when every method is free.
 */
export function lockedAttempt(
  storage: StorageLike,
  scope: ChargeKeyScope,
  facts: ChargeCodeFacts = NO_CODE,
): { signature: string; key: string } | null {
  const current = read(storage, scope);
  if (!current || freed(current, facts)) return null;
  return { signature: current.signature, key: current.key };
}

/**
 * The key to send. The same request keeps its key until the answer is known.
 * Without an answer for the key, no other request is allowed (`conflict`): the
 * first one may have been recorded. The ways out are the server's 409/422 for
 * that key plus a read of the charge as open, a QRIS asked after the server's
 * code changed (the earlier QRIS request did reach the server), or that new
 * code ending unpaid (every method is free again). `firstSend`: no earlier send
 * used this key, so a refusal before the server worked on it ends it.
 */
export function beginAttempt(
  storage: StorageLike,
  scope: ChargeKeyScope,
  signature: string,
  makeKey: () => string,
  facts: ChargeCodeFacts = NO_CODE,
): { key: string; conflict: boolean; firstSend: boolean } {
  const current = read(storage, scope);
  if (current && current.signature !== signature) {
    const free =
      freed(current, facts) || (isQris(current.signature) && isQris(signature));
    if (!free) return { key: current.key, conflict: true, firstSend: false };
  }
  const replay = current?.signature === signature;
  const key = replay ? current.key : makeKey();
  write(storage, scope, { signature, key, checked: false, refused: false });
  return { key, conflict: false, firstSend: !replay };
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

// The start key of each card sale this browser started, by sale id: the
// supervisor's settle names the sale by the key it was started with. Kept
// until the charge leaves the screen's reach; holds no money data.
const SALE_PREFIX = "legend-pos-charge-edc-sale:";

const saleKeyOf = ({ outletId, chargeId }: ChargeKeyScope) =>
  `${SALE_PREFIX}${outletId}:${chargeId}`;

function readSales(
  storage: StorageLike,
  scope: ChargeKeyScope,
): Record<string, string> {
  const raw = storage.getItem(saleKeyOf(scope));
  if (raw === null) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (pair): pair is [string, string] =>
          typeof pair[1] === "string" && KEY_PATTERN.test(pair[1]),
      ),
    );
  } catch {
    return {};
  }
}

/** The card start with this key made this sale. */
export function rememberSaleKey(
  storage: StorageLike,
  scope: ChargeKeyScope,
  saleId: string,
  key: string,
): void {
  if (!KEY_PATTERN.test(key)) return;
  const sales = { ...readSales(storage, scope), [saleId]: key };
  storage.setItem(saleKeyOf(scope), JSON.stringify(sales));
}

/** The key the sale was started with by this browser, if it was. */
export function saleStartKey(
  storage: StorageLike,
  scope: ChargeKeyScope,
  saleId: string,
): string | null {
  return readSales(storage, scope)[saleId] ?? null;
}
