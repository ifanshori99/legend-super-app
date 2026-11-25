// The captain's keyed sends (brief 1268 W4): seat a walk-in, send an order for
// a table session, fire held items. Pure over injected transport and storage,
// like order-flow.ts, and built on its intent rules: the key and the exact
// request are written to storage BEFORE a request goes out and are forgotten
// only on a 2xx or a final refusal of that key, so a lost reply repeats the
// same bytes, also after a refresh.
import type { PosOrderStatus } from "@starter/shared/pos";
import { ApiError } from "@/lib/api/errors";
import {
  beginIntent,
  endIntent,
  listIntentSubjects,
  peekIntent,
  recordIntentData,
  type IntentScope,
} from "./intent-store.ts";
import {
  assertScope,
  forgetOnFinalRefusal,
  keyedSend,
  parseOrderSnapshot,
  pendingOrderText,
  placeOrder,
  scopeOf,
  type FlowDeps,
  type SubmitBody,
} from "./order-flow.ts";
import {
  NO_TABLE_SESSION,
  captainDraftKey,
  captainInput,
} from "./captain-wire.ts";
import { submitBodyOf } from "./order-wire.ts";
import type { CartLine, OrderMeta, OrderSnapshot } from "./types.ts";

export { NO_TABLE_SESSION };
export const SESSION_CLOSED = "SESSION_CLOSED";
export const OPEN_INTENT_PENDING = "OPEN_INTENT_PENDING";
export const FIRE_INTENT_PENDING = "FIRE_INTENT_PENDING";

type Storage3 = Parameters<typeof beginIntent>[0];

/** Outlet and captain: a key needs both. */
export type Who = { outletId: string; actorId: string };

const scopeFor = (
  who: Who,
  kind: IntentScope["kind"],
  subject: string,
): IntentScope => scopeOf({ ...who, subject: "" }, kind, subject);

const checkWho = (storage: Storage3, who: Who) =>
  assertScope({ storage, scope: { ...who, subject: "" } });

// ---- Order for a table session -------------------------------------------------

/**
 * Create then submit the captain's order for a table session (`captain`
 * channel). Without a session there is no order. Every send is its own order.
 */
export function placeCaptainOrder<Order, Parked>(
  deps: FlowDeps<Order, Parked>,
  tableSessionId: string,
  lines: CartLine[],
  meta?: OrderMeta,
): Promise<Order> {
  if (tableSessionId === "")
    return Promise.reject(
      new ApiError(
        409,
        NO_TABLE_SESSION,
        "Meja ini belum punya sesi. Dudukkan tamu dulu.",
      ),
    );
  return placeOrder(deps, captainInput(tableSessionId, lines), meta);
}

/**
 * Captain orders whose answer is not known, for this outlet and captain,
 * whether or not the table still has a session (a closed session must not hide
 * an order that may have gone through). Each one has its stored snapshot, so
 * it is sent again from that alone.
 */
export function pendingCaptainOrders(
  storage: Storage3,
  who: Who,
): { draftKey: string; snapshot: OrderSnapshot }[] {
  if (who.outletId === "" || who.actorId === "") return [];
  const subjects = new Set([
    ...listIntentSubjects(storage, { ...who, kind: "create" }),
    ...listIntentSubjects(storage, { ...who, kind: "submit" }),
  ]);
  return [...subjects].flatMap((draftKey) => {
    if (!draftKey.startsWith("captain:")) return [];
    const snapshot = parseOrderSnapshot(
      pendingOrderText(storage, { ...who, subject: draftKey }),
    );
    return snapshot ? [{ draftKey, snapshot }] : [];
  });
}

export interface ContinueDeps<Order> {
  storage: Storage3;
  makeKey: () => string;
  scope: Who;
  submit: (orderId: string, body: SubmitBody) => Promise<Order>;
  /** Sends the unclear captain order of a cart again (same keys, snapshot). */
  resend?: (draftKey: string) => Promise<Order>;
}

/** The cart whose unclear submit belongs to this order (null: none stored). */
export function submitIntentOf(
  storage: Storage3,
  who: Who,
  orderId: string,
): string | null {
  if (who.outletId === "" || who.actorId === "") return null;
  for (const draftKey of listIntentSubjects(storage, {
    ...who,
    kind: "submit",
  }))
    if (
      peekIntent(storage, scopeFor(who, "submit", draftKey))?.data === orderId
    )
      return draftKey;
  return null;
}

/**
 * Submit an order that was created but never submitted (its submit reply was
 * lost, or the page was left). An unclear send of the same table session is
 * resent first. The stored submit key is used when there is one, else the draft gets its own key kept until answered: never a second
 * create, so never a second order.
 */
export async function continueDraft<Order>(
  deps: ContinueDeps<Order>,
  orderId: string,
  tableSessionId: string | null,
): Promise<Order> {
  checkWho(deps.storage, deps.scope);
  // A create or submit of this table session is still unclear: the draft is
  // very likely its order. Go on with that send (same keys), so its stored
  // intent is answered and cleared; a second key would leave it to be resent
  // later over an order that is already sent.
  if (deps.resend && tableSessionId !== null) {
    const cart = captainDraftKey(
      deps.scope.outletId,
      deps.scope.actorId,
      tableSessionId,
    );
    if (
      peekIntent(deps.storage, scopeFor(deps.scope, "create", cart)) ||
      peekIntent(deps.storage, scopeFor(deps.scope, "submit", cart))
    )
      return deps.resend(cart);
  }
  const draftKey = submitIntentOf(deps.storage, deps.scope, orderId);
  if (draftKey !== null) {
    const scope = scopeFor(deps.scope, "submit", draftKey);
    const stored = peekIntent(deps.storage, scope);
    if (stored) {
      try {
        const result = await deps.submit(orderId, submitBodyOf(stored.key));
        endIntent(deps.storage, scope, stored.key);
        return result;
      } catch (error) {
        forgetOnFinalRefusal(deps.storage, scope, stored.key, error);
        throw error;
      }
    }
  }
  return keyedSend(
    deps,
    scopeFor(deps.scope, "submit", `draft:${orderId}`),
    JSON.stringify({ orderId }),
    (key) => deps.submit(orderId, submitBodyOf(key)),
  );
}

// ---- Walk-in seat -----------------------------------------------------------------

export interface OpenDeps<Session extends { status: string }> {
  storage: Storage3;
  makeKey: () => string;
  scope: Who;
  open: (body: { pax: number; idempotencyKey: string }) => Promise<Session>;
}

function openPendingError(): ApiError {
  return new ApiError(
    409,
    OPEN_INTENT_PENDING,
    "Dudukkan sebelumnya belum jelas hasilnya. Kirim ulang dengan jumlah tamu yang sama, atau periksa meja dulu.",
  );
}

/**
 * Seat a walk-in party. A replay can answer the session of an earlier party
 * that has closed with 200: that is not a seat, so it is refused and the key
 * is let go (the next try is a new request).
 */
export async function openTableSession<Session extends { status: string }>(
  deps: OpenDeps<Session>,
  tableId: string,
  pax: number,
): Promise<Session> {
  checkWho(deps.storage, deps.scope);
  return keyedSend(
    deps,
    scopeFor(deps.scope, "open", tableId),
    JSON.stringify({ tableId, pax }),
    (key) => deps.open({ pax, idempotencyKey: key }),
    null,
    (session) => {
      if (session.status === "closed" || session.status === "voided")
        throw new ApiError(
          409,
          SESSION_CLOSED,
          "Sesi meja ini sudah ditutup. Dudukkan tamu lagi.",
        );
    },
    openPendingError,
  );
}

/** The guest count of a seat whose answer is not known (null: none). */
export function readPendingOpenPax(
  storage: Storage3,
  who: Who,
  tableId: string,
): number | null {
  if (who.outletId === "" || who.actorId === "") return null;
  const entry = peekIntent(storage, scopeFor(who, "open", tableId));
  if (!entry) return null;
  try {
    const pax = (JSON.parse(entry.signature) as { pax?: unknown }).pax;
    return typeof pax === "number" ? pax : null;
  } catch {
    return null;
  }
}

/** Seats whose answer is not known, per table (no open session needed). */
export function pendingOpenSeats(
  storage: Storage3,
  who: Who,
): { tableId: string; pax: number }[] {
  if (who.outletId === "" || who.actorId === "") return [];
  return listIntentSubjects(storage, { ...who, kind: "open" }).flatMap(
    (tableId) => {
      const pax = readPendingOpenPax(storage, who, tableId);
      return pax === null ? [] : [{ tableId, pax }];
    },
  );
}

/** The captain checked the table: an unclear or refused seat is closed. */
export function closeOpenIntent(
  storage: Storage3,
  who: Who,
  tableId: string,
): void {
  endIntent(storage, scopeFor(who, "open", tableId));
}

// ---- Fire held items -------------------------------------------------------------

export type FireBody = {
  itemIds: string[];
  expectedStatus: PosOrderStatus;
  idempotencyKey: string;
};

export interface FireDeps<Order> {
  storage: Storage3;
  makeKey: () => string;
  scope: Who;
  fire: (orderId: string, body: FireBody) => Promise<Order>;
}

/**
 * Fire held items by their server item ids. The key and the status the order
 * had are stored before sending and replayed as they were (the status is part
 * of what the server fingerprints), so a lost reply repeats the same bytes
 * even when the order has moved on since. One unclear fire per order: other
 * items wait until it is answered or closed.
 */
export async function fireItems<Order>(
  deps: FireDeps<Order>,
  orderId: string,
  itemIds: readonly string[],
  status: PosOrderStatus,
): Promise<Order> {
  checkWho(deps.storage, deps.scope);
  const ids = [...new Set(itemIds)].sort();
  if (ids.length === 0)
    throw new ApiError(422, "NO_ITEMS", "Pilih item yang akan dikirim.");
  const scope = scopeFor(deps.scope, "fire", orderId);
  const begun = beginIntent(
    deps.storage,
    scope,
    JSON.stringify(ids),
    deps.makeKey,
  );
  if (begun.conflict)
    throw new ApiError(
      409,
      FIRE_INTENT_PENDING,
      "Pengiriman sebelumnya belum jelas hasilnya. Kirim ulang item yang sama, atau periksa pesanan dulu.",
    );
  if (begun.data === null)
    recordIntentData(deps.storage, scope, begun.key, status);
  const expectedStatus = (begun.data ?? status) as PosOrderStatus;
  try {
    const result = await deps.fire(orderId, {
      itemIds: ids,
      expectedStatus,
      idempotencyKey: begun.key,
    });
    endIntent(deps.storage, scope, begun.key);
    return result;
  } catch (error) {
    forgetOnFinalRefusal(deps.storage, scope, begun.key, error);
    throw error;
  }
}

/** The items of a fire whose answer is not known (null: none). */
export function pendingFireItems(
  storage: Storage3,
  who: Who,
  orderId: string,
): string[] | null {
  if (who.outletId === "" || who.actorId === "") return null;
  const entry = peekIntent(storage, scopeFor(who, "fire", orderId));
  if (!entry) return null;
  try {
    const ids: unknown = JSON.parse(entry.signature);
    return Array.isArray(ids) ? (ids as string[]) : null;
  } catch {
    return null;
  }
}

/** Orders that have a fire without an answer. */
export function pendingFireOrderIds(storage: Storage3, who: Who): string[] {
  if (who.outletId === "" || who.actorId === "") return [];
  return listIntentSubjects(storage, { ...who, kind: "fire" });
}

/** The captain checked the order: an unclear or refused fire is closed. */
export function closeFireIntent(
  storage: Storage3,
  who: Who,
  orderId: string,
): void {
  endIntent(storage, scopeFor(who, "fire", orderId));
}

/**
 * A fire of table items first repeats every unclear fire whose items are all
 * wanted (same key, same body, no new read of the order: the order may have
 * moved on, and a changed read would change the bytes). What is left is sent
 * as a new fire.
 */
export function planFireReplay(
  pending: readonly { orderId: string; itemIds: string[] }[],
  wanted: ReadonlySet<string>,
): { replay: { orderId: string; itemIds: string[] }[]; rest: string[] } {
  const replay = pending.filter(
    (entry) =>
      entry.itemIds.length > 0 && entry.itemIds.every((id) => wanted.has(id)),
  );
  const done = new Set(replay.flatMap((entry) => entry.itemIds));
  return {
    replay: replay.map((entry) => ({ ...entry })),
    rest: [...wanted].filter((id) => !done.has(id)),
  };
}
