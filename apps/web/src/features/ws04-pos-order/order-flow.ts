// The cashier's keyed sends (brief 1268 W1): create + submit an order, park a
// cart, resume a parked cart. Pure over injected transport and storage, so Node
// tests drive it with fakes. The intent (key, exact request fingerprint, the
// created order id) is written to storage BEFORE a request goes out and is
// forgotten only on a 2xx or a definitive refusal of that key; a lost reply
// therefore repeats the same key and gives one order, also after a refresh.
import { ApiError } from "@/lib/api/errors";
import {
  beginIntent,
  endIntent,
  isDefinitiveRefusal,
  peekIntent,
  recordIntentData,
  type IntentScope,
} from "./intent-store.ts";
import { createBodyOf, parkBodyOf, submitBodyOf } from "./order-wire.ts";
import type { SubmitOrderInput } from "./types.ts";

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

function pendingError(): ApiError {
  return new ApiError(
    409,
    ORDER_INTENT_PENDING,
    "Pengiriman sebelumnya belum jelas hasilnya. Kembalikan isi keranjang seperti semula lalu coba lagi.",
  );
}

const scopeOf = (
  scope: FlowScope,
  kind: IntentScope["kind"],
  subject = scope.subject,
): IntentScope => ({
  outletId: scope.outletId,
  actorId: scope.actorId,
  kind,
  subject,
});

/** One keyed request: begin (persist) -> send -> end on 2xx or refusal. */
async function keyedSend<T>(
  deps: { storage: Storage3; makeKey: () => string },
  scope: IntentScope,
  signature: string,
  send: (key: string) => Promise<T>,
): Promise<T> {
  const begun = beginIntent(deps.storage, scope, signature, deps.makeKey);
  if (begun.conflict) throw pendingError();
  try {
    const result = await send(begun.key);
    endIntent(deps.storage, scope, begun.key);
    return result;
  } catch (error) {
    if (
      error instanceof ApiError &&
      isDefinitiveRefusal(error.status) &&
      error.code !== "IDEMPOTENCY_KEY_REUSED"
    )
      endIntent(deps.storage, scope, begun.key);
    throw error;
  }
}

/**
 * Create the order (`key:create`), then submit it (`key:submit`, draft). The
 * created order id is kept with the submit intent, so a lost submit reply
 * repeats the submit on the same order and never creates a second one.
 */
export async function placeOrder<Order, Parked>(
  deps: FlowDeps<Order, Parked>,
  input: SubmitOrderInput,
): Promise<Order> {
  const body = createBodyOf(input);
  const signature = JSON.stringify(body);
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
        );
        recordIntentData(deps.storage, submitScope, next.key, order.id);
        return { order, submitKey: next.key };
      },
    );
    orderId = created.order.id;
    submitKey = created.submitKey;
  }

  try {
    const submitted = await deps.submit(orderId, submitBodyOf(submitKey));
    endIntent(deps.storage, submitScope, submitKey);
    return submitted;
  } catch (error) {
    if (
      error instanceof ApiError &&
      isDefinitiveRefusal(error.status) &&
      error.code !== "IDEMPOTENCY_KEY_REUSED"
    )
      endIntent(deps.storage, submitScope, submitKey);
    throw error;
  }
}

export function parkCart<Order, Parked>(
  deps: FlowDeps<Order, Parked>,
  input: SubmitOrderInput,
): Promise<Parked> {
  const body = parkBodyOf(input);
  return keyedSend(
    deps,
    scopeOf(deps.scope, "park"),
    JSON.stringify(body),
    (key) => deps.park({ ...body, idempotencyKey: key }),
  );
}

export function resumeParked<Order, Parked>(
  deps: FlowDeps<Order, Parked>,
  parkedId: string,
): Promise<Parked> {
  return keyedSend(
    deps,
    scopeOf(deps.scope, "resume", parkedId),
    "resume",
    (key) => deps.resume(parkedId, { idempotencyKey: key }),
  );
}
