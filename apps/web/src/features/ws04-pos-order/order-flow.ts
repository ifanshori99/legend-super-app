// The cashier's keyed sends (brief 1268 W1): create + submit an order, park a
// cart, resume a parked cart. Pure over injected transport and storage, so Node
// tests drive it with fakes. The intent (key, exact request fingerprint, the
// created order id, a snapshot of the cart and meta) is written to storage
// BEFORE a request goes out and is forgotten only on a 2xx or a final refusal
// of that key; a lost reply therefore repeats the same key and gives one order,
// also after a refresh or in a copied tab. The key is scoped to outlet +
// cashier + cart: without an outlet or cashier nothing is sent.
import { ApiError } from "@/lib/api/errors";
import {
  beginIntent,
  endIntent,
  isFinalRefusal,
  KEY_REUSED_CODE,
  listIntentSubjects,
  peekIntent,
  recordIntentData,
  type IntentScope,
} from "./intent-store.ts";
import { createBodyOf, parkBodyOf, submitBodyOf } from "./order-wire.ts";
import type { OrderMeta, OrderSnapshot, SubmitOrderInput } from "./types.ts";

type Storage3 = Parameters<typeof beginIntent>[0];

export type FlowScope = { outletId: string; actorId: string; subject: string };

export type CreateBody = ReturnType<typeof createBodyOf> & {
  idempotencyKey: string;
};
export type ParkBody = ReturnType<typeof parkBodyOf> & {
  idempotencyKey: string;
};
export type SubmitBody = ReturnType<typeof submitBodyOf>;

export interface FlowDeps<Order, Parked> {
  storage: Storage3;
  makeKey: () => string;
  scope: FlowScope;
  create: (body: CreateBody) => Promise<{ id: string }>;
  submit: (orderId: string, body: SubmitBody) => Promise<Order>;
  park: (body: ParkBody) => Promise<Parked>;
  resume: (
    parkedId: string,
    body: { idempotencyKey: string },
  ) => Promise<Parked>;
}

export const ORDER_INTENT_PENDING = "ORDER_INTENT_PENDING";
export const ACTOR_MISSING = "ACTOR_MISSING";
export const PARK_INTENT_PENDING = "PARK_INTENT_PENDING";
const APPLIED = "applied";

function parkPendingError(): ApiError {
  return new ApiError(
    409,
    PARK_INTENT_PENDING,
    "Penahanan sebelumnya belum jelas hasilnya. Kirim ulang atau tutup dulu.",
  );
}

function pendingError(): ApiError {
  return new ApiError(
    409,
    ORDER_INTENT_PENDING,
    "Ada pesanan yang belum jelas terkirim. Kembalikan pesanan itu lalu kirim ulang.",
  );
}

/**
 * No outlet or no cashier: nothing may be sent (a key needs both). Another
 * cashier's unclear send does not block this one: carts are per cashier, and
 * the screen only tells (`hasForeignIntent`); that intent is left as it is.
 */
export function assertScope(deps: { storage: Storage3; scope: FlowScope }): void {
  const { scope } = deps;
  if (scope.outletId === "" || scope.actorId === "")
    throw new ApiError(
      401,
      ACTOR_MISSING,
      "Kasir belum dikenali. Masuk dengan PIN lagi.",
    );
}

/**
 * The key is refused for another body, or the server said 403: nothing says
 * whether the first request landed, so only the cashier closes it, after
 * checking the open orders.
 */
export function needsCashierClose(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === KEY_REUSED_CODE || error.status === 403)
  );
}

/**
 * Runs every unanswered resume and keeps each one's own outcome: a refusal on
 * one parked cart must not hide the refusal on another, so each gets its own
 * close action.
 */
export async function replayAll<T>(
  ids: readonly string[],
  run: (id: string) => Promise<T>,
): Promise<{
  results: T[];
  failures: { id: string; error: unknown }[];
}> {
  const settled = await Promise.allSettled(ids.map((id) => run(id)));
  const results: T[] = [];
  const failures: { id: string; error: unknown }[] = [];
  settled.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") results.push(outcome.value);
    else failures.push({ id: ids[index], error: outcome.reason });
  });
  return { results, failures };
}

export const scopeOf = (
  scope: FlowScope,
  kind: IntentScope["kind"],
  subject = scope.subject,
): IntentScope => ({
  outletId: scope.outletId,
  actorId: scope.actorId,
  kind,
  subject,
});

export function forgetOnFinalRefusal(
  storage: Storage3,
  scope: IntentScope,
  key: string,
  error: unknown,
): void {
  if (error instanceof ApiError && isFinalRefusal(error.status, error.code))
    endIntent(storage, scope, key);
}

/**
 * One keyed request: begin (persist) -> send -> `after` -> end on 2xx. `after`
 * runs before the key is forgotten, so what the answer carries (a consumed
 * parked cart) is saved while a retry is still possible.
 */
export async function keyedSend<T>(
  deps: { storage: Storage3; makeKey: () => string },
  scope: IntentScope,
  signature: string,
  send: (key: string) => Promise<T>,
  snapshot: string | null = null,
  after?: (result: T, key: string) => void,
  conflict: () => ApiError = pendingError,
): Promise<T> {
  const begun = beginIntent(
    deps.storage,
    scope,
    signature,
    deps.makeKey,
    snapshot,
  );
  if (begun.conflict) throw conflict();
  try {
    const result = await send(begun.key);
    after?.(result, begun.key);
    endIntent(deps.storage, scope, begun.key);
    return result;
  } catch (error) {
    forgetOnFinalRefusal(deps.storage, scope, begun.key, error);
    throw error;
  }
}

const snapshotOf = (input: SubmitOrderInput, meta?: OrderMeta) =>
  meta
    ? JSON.stringify({ lines: input.lines, meta } satisfies OrderSnapshot)
    : null;

/**
 * Create the order (`key:create`), then submit it (`key:submit`, draft). The
 * created order id is kept with the submit intent, so a lost submit reply
 * repeats the submit on the same order and never creates a second one.
 */
export async function placeOrder<Order, Parked>(
  deps: FlowDeps<Order, Parked>,
  input: SubmitOrderInput,
  meta?: OrderMeta,
): Promise<Order> {
  assertScope(deps);
  const body = createBodyOf(input);
  const signature = JSON.stringify(body);
  const snapshot = snapshotOf(input, meta);
  const submitScope = scopeOf(deps.scope, "submit");
  const createScope = scopeOf(deps.scope, "create");

  let orderId: string;
  let submitKey: string;
  const waiting = peekIntent(deps.storage, submitScope);
  if (waiting) {
    // The order exists: only its submit is unresolved.
    if (waiting.signature !== signature || waiting.data === null)
      throw pendingError();
    orderId = waiting.data;
    submitKey = waiting.key;
  } else {
    const created = await keyedSend(
      deps,
      createScope,
      signature,
      async (key) => {
        const order = await deps.create({ ...body, idempotencyKey: key });
        // Persist the submit intent before the create key is forgotten.
        const next = beginIntent(
          deps.storage,
          submitScope,
          signature,
          deps.makeKey,
          snapshot,
        );
        recordIntentData(deps.storage, submitScope, next.key, order.id);
        return { order, submitKey: next.key };
      },
      snapshot,
    );
    orderId = created.order.id;
    submitKey = created.submitKey;
  }

  try {
    const submitted = await deps.submit(orderId, submitBodyOf(submitKey));
    endIntent(deps.storage, submitScope, submitKey);
    return submitted;
  } catch (error) {
    forgetOnFinalRefusal(deps.storage, submitScope, submitKey, error);
    throw error;
  }
}

/**
 * The order whose answer is not known yet (create or submit), as it was sent:
 * lines and meta. The cashier brings it back and sends it again; the same key
 * is used, never a new one.
 */
export function readPendingOrder(
  storage: Storage3,
  scope: FlowScope,
): OrderSnapshot | null {
  return parseOrderSnapshot(pendingOrderText(storage, scope));
}

/** The stored snapshot text (stable between reads, for a store subscription). */
export function pendingOrderText(
  storage: Storage3,
  scope: FlowScope,
): string | null {
  if (scope.outletId === "" || scope.actorId === "") return null;
  const entry =
    peekIntent(storage, scopeOf(scope, "submit")) ??
    peekIntent(storage, scopeOf(scope, "create"));
  return entry?.snapshot ?? null;
}

export function parseOrderSnapshot(text: string | null): OrderSnapshot | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Partial<OrderSnapshot>;
    return Array.isArray(parsed.lines) && parsed.meta
      ? (parsed as OrderSnapshot)
      : null;
  } catch {
    return null;
  }
}

/**
 * The cashier checked the open orders and says the unresolved send did not
 * land (or is not wanted): the intent is closed. Used after a refused key
 * (IDEMPOTENCY_KEY_REUSED), which is never closed on its own.
 */
export function closeOrderIntent(storage: Storage3, scope: FlowScope): void {
  endIntent(storage, scopeOf(scope, "create"));
  endIntent(storage, scopeOf(scope, "submit"));
}

export async function parkCart<Order, Parked>(
  deps: FlowDeps<Order, Parked>,
  input: SubmitOrderInput,
  meta?: OrderMeta,
): Promise<Parked> {
  assertScope(deps);
  const body = parkBodyOf(input);
  return keyedSend(
    deps,
    scopeOf(deps.scope, "park"),
    JSON.stringify(body),
    (key) => deps.park({ ...body, idempotencyKey: key }),
    snapshotOf(input, meta),
    undefined,
    parkPendingError,
  );
}

/** The park whose answer is not known yet, as it was sent (lines and meta). */
export function pendingParkText(
  storage: Storage3,
  scope: FlowScope,
): string | null {
  if (scope.outletId === "" || scope.actorId === "") return null;
  return peekIntent(storage, scopeOf(scope, "park"))?.snapshot ?? null;
}

export function readPendingPark(
  storage: Storage3,
  scope: FlowScope,
): OrderSnapshot | null {
  return parseOrderSnapshot(pendingParkText(storage, scope));
}

/** The cashier checked the parked list and closes an unclear park. */
export function closeParkIntent(storage: Storage3, scope: FlowScope): void {
  endIntent(storage, scopeOf(scope, "park"));
}

/** The cashier checked and closes an unclear resume of this parked cart. */
export function closeResumeIntent(
  storage: Storage3,
  scope: FlowScope,
  parkedId: string,
): void {
  endIntent(storage, scopeOf(scope, "resume", parkedId));
}

/** Parked carts whose resume was sent but not answered (replayed on open). */
export function pendingResumeIds(
  storage: Storage3,
  scope: FlowScope,
): string[] {
  if (scope.outletId === "" || scope.actorId === "") return [];
  return listIntentSubjects(storage, {
    outletId: scope.outletId,
    actorId: scope.actorId,
    kind: "resume",
  });
}

/**
 * Resume a parked cart. The catalog is loaded BEFORE the server consumes the
 * snapshot (a failure there sends nothing), and `apply` saves the lines into
 * the draft BEFORE the key is forgotten; the "applied" mark keeps a replay
 * after a crash from adding them twice. Returns null when it was already
 * applied.
 */
export function resumeParkedInto<Order, Parked, Catalog>(
  deps: FlowDeps<Order, Parked>,
  parkedId: string,
  loadCatalog: () => Promise<Catalog>,
  apply: (parked: Parked, catalog: Catalog) => void,
): Promise<Parked | null> {
  // Two calls for the same parked cart at once (the sheet and the replay on
  // open) share one run: the lines are applied once.
  const flight = `${deps.scope.outletId}:${deps.scope.actorId}:${parkedId}`;
  const running = resumesInFlight.get(flight);
  if (running) return running as Promise<Parked | null>;
  const run = resumeOnce(deps, parkedId, loadCatalog, apply).finally(() =>
    resumesInFlight.delete(flight),
  );
  resumesInFlight.set(flight, run);
  return run;
}

const resumesInFlight = new Map<string, Promise<unknown>>();

async function resumeOnce<Order, Parked, Catalog>(
  deps: FlowDeps<Order, Parked>,
  parkedId: string,
  loadCatalog: () => Promise<Catalog>,
  apply: (parked: Parked, catalog: Catalog) => void,
): Promise<Parked | null> {
  assertScope(deps);
  const scope = scopeOf(deps.scope, "resume", parkedId);
  if (peekIntent(deps.storage, scope)?.data === APPLIED) {
    endIntent(deps.storage, scope);
    return null;
  }
  const catalog = await loadCatalog();
  return keyedSend(
    deps,
    scope,
    "resume",
    (key) => deps.resume(parkedId, { idempotencyKey: key }),
    null,
    (parked, key) => {
      // Checked again right before applying: another run (or tab) may have
      // saved these lines while this one waited for its answer.
      if (peekIntent(deps.storage, scope)?.data === APPLIED) return;
      apply(parked, catalog);
      recordIntentData(deps.storage, scope, key, APPLIED);
    },
  );
}
