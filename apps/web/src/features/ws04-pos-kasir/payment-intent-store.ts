// The payment request in progress, per outlet and bill, kept in localStorage
// BEFORE it is sent (1268 W2): a refresh, a lost answer or a second tab repeats
// the same key and the same body instead of charging again. While a payment
// request has no known answer every method of that bill stays locked. Pure over
// an injected Storage: Node tests load it directly. A PIN is never stored, and
// the server trusts nothing in here.
import { ApiError } from "../../lib/api/errors.ts";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Only `payment` locks the bill; the others keep their key for a retry. */
export type IntentSlot = "payment" | "complete" | "receipt";

export type IntentScope = {
  outletId: string;
  orderId: string;
  slot: IntentSlot;
};

export type IntentKind =
  "cash" | "qris" | "edc_standalone" | "points" | "complete" | "receipt";

export type PaymentIntent = {
  key: string;
  kind: IntentKind;
  /** What the cashier asked for: the same ask replays, another one is refused. */
  signature: string;
  /** The exact body to send again, key included. */
  body: Record<string, unknown>;
  /** The cashier who sent it: the server only replays for the same one. */
  actorId: string;
  startedAt: string;
};

export type IntentState =
  | { status: "none" }
  | { status: "pending"; intent: PaymentIntent }
  /** Something is stored that cannot be read: treated as unresolved. */
  | { status: "corrupt" };

/** An earlier payment request of this bill has no known answer. */
export const PAYMENT_UNRESOLVED = "PAYMENT_UNRESOLVED";
/** The browser cannot keep the request, so it must not be sent. */
export const INTENT_STORAGE_UNAVAILABLE = "INTENT_STORAGE_UNAVAILABLE";

/** The supervisor approval of a hand-keyed EDC payment is spent or too old. */
export const EDC_APPROVAL_REQUIRED = "EDC_STANDALONE_APPROVAL_REQUIRED";

const PREFIX = "legend-pos-payment-intent:";
const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;
const KINDS: readonly string[] = [
  "cash",
  "qris",
  "edc_standalone",
  "points",
  "complete",
  "receipt",
];

export const intentStorageKey = ({ outletId, orderId, slot }: IntentScope) =>
  `${PREFIX}${outletId}:${orderId}:${slot}`;

/** Parse one stored value (null: nothing stored). */
export function parseIntent(raw: string | null): IntentState {
  if (raw === null) return { status: "none" };
  try {
    const value = JSON.parse(raw) as Partial<PaymentIntent> | null;
    if (
      typeof value?.key !== "string" ||
      !KEY_PATTERN.test(value.key) ||
      typeof value.kind !== "string" ||
      !KINDS.includes(value.kind) ||
      typeof value.signature !== "string" ||
      typeof value.actorId !== "string" ||
      typeof value.startedAt !== "string" ||
      typeof value.body !== "object" ||
      value.body === null ||
      value.body.idempotencyKey !== value.key
    )
      return { status: "corrupt" };
    return { status: "pending", intent: value as PaymentIntent };
  } catch {
    return { status: "corrupt" };
  }
}

/** The request without a known answer. Storage that cannot be read is locked. */
export function readIntent(
  storage: StorageLike,
  scope: IntentScope,
): IntentState {
  try {
    return parseIntent(storage.getItem(intentStorageKey(scope)));
  } catch {
    return { status: "corrupt" };
  }
}

const unresolved = (message: string) =>
  new ApiError(409, PAYMENT_UNRESOLVED, message);

/**
 * The request to send, stored first. The same ask by the same cashier gets the
 * stored request back (`replay`); anything else is refused while one is stored.
 */
export function beginIntent(
  storage: StorageLike,
  scope: IntentScope,
  ask: {
    kind: IntentKind;
    signature: string;
    actorId: string;
    makeKey: () => string;
    makeBody: (key: string) => Record<string, unknown>;
    now: () => Date;
  },
): { intent: PaymentIntent; replay: boolean } {
  const state = readIntent(storage, scope);
  // Completing the order and issuing the receipt collect no money and the
  // server guards them by state, so another ask there simply starts over.
  const replaces =
    scope.slot !== "payment" &&
    (state.status === "corrupt" ||
      (state.status === "pending" &&
        (state.intent.actorId !== ask.actorId ||
          state.intent.signature !== ask.signature)));
  if (state.status === "corrupt" && !replaces)
    throw unresolved(
      "Permintaan sebelumnya untuk tagihan ini tidak bisa dibaca. Hubungi supervisor sebelum menerima pembayaran lain.",
    );
  if (state.status === "pending" && !replaces) {
    const { intent } = state;
    if (intent.actorId !== ask.actorId)
      throw unresolved(
        "Permintaan sebelumnya dikirim kasir lain dan hasilnya belum diketahui. Kasir itu perlu mengirim ulang.",
      );
    if (intent.kind !== ask.kind || intent.signature !== ask.signature)
      throw unresolved(
        "Hasil permintaan sebelumnya belum diketahui. Kirim ulang permintaan yang sama dulu.",
      );
    return { intent, replay: true };
  }
  const key = ask.makeKey();
  const intent: PaymentIntent = {
    key,
    kind: ask.kind,
    signature: ask.signature,
    body: ask.makeBody(key),
    actorId: ask.actorId,
    startedAt: ask.now().toISOString(),
  };
  const text = JSON.stringify(intent);
  let kept: string | null = null;
  try {
    storage.setItem(intentStorageKey(scope), text);
    kept = storage.getItem(intentStorageKey(scope));
  } catch {
    kept = null;
  }
  // Not kept (blocked or full storage, or another tab wrote over it): do not send.
  if (kept !== text)
    throw new ApiError(
      0,
      INTENT_STORAGE_UNAVAILABLE,
      "Peramban tidak bisa menyimpan permintaan pembayaran. Pembayaran belum dikirim.",
    );
  return { intent, replay: false };
}

/** The answer is known: the next request is new. Another key is left alone. */
export function endIntent(
  storage: StorageLike,
  scope: IntentScope,
  key: string,
): void {
  const state = readIntent(storage, scope);
  if (state.status !== "pending" || state.intent.key !== key) return;
  storage.removeItem(intentStorageKey(scope));
}

/**
 * Settled by a supervisor: the stored request goes, or `next` takes its place in
 * one write so the lock never opens between them. Only what was resolved: a
 * value that changed meanwhile is another request and stays.
 */
export function settleStored(
  storage: StorageLike,
  scope: IntentScope,
  resolvedRaw: string,
  next?: PaymentIntent,
): boolean {
  const id = intentStorageKey(scope);
  if (storage.getItem(id) !== resolvedRaw) return false;
  if (next) storage.setItem(id, JSON.stringify(next));
  else storage.removeItem(id);
  return true;
}

/** The server proves the bill paid: whatever was stored no longer matters. */
export function clearPaidIntent(
  storage: StorageLike,
  scope: Pick<IntentScope, "outletId" | "orderId">,
): void {
  storage.removeItem(intentStorageKey({ ...scope, slot: "payment" }));
}

const refused = new WeakSet<object>();

/** The error ended a stored request: nothing was recorded under its key. */
export const markRefused = (error: object): void => void refused.add(error);
export const wasRefused = (error: unknown): boolean =>
  typeof error === "object" && error !== null && refused.has(error);

/**
 * True when the error proves the server recorded nothing for this key. The
 * first send is refused by any client error that answers the request itself; a
 * repeat only by an answer about the bill (409, 412, 422, a refused EDC
 * approval): another 401, 403, 404 or 429 of the repeat says nothing about the
 * first send, and a reused key means the server DID record one.
 */
export function isDefinitiveRefusal(error: unknown, replay: boolean): boolean {
  if (!(error instanceof ApiError)) return false;
  if (
    error.code === "IDEMPOTENCY_KEY_REUSED" ||
    error.code === "IDEMPOTENCY_KEY_RESERVED" ||
    error.code === PAYMENT_UNRESOLVED
  )
    return false;
  // The API throws this one only inside the keyed transaction: after the stored
  // key was looked up (posIdempotent) and under the order lock, so nothing is
  // recorded under this key and the approval, spent or too old, cannot serve a
  // late arrival of the same body either (pos-edc-standalone.test.ts).
  if (replay && error.code === EDC_APPROVAL_REQUIRED) return true;
  if (replay) return [409, 412, 422].includes(error.status);
  return (
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 425
  );
}
