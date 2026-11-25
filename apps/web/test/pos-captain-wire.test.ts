// Brief 1268 W4: the captain on the real contract. No session means no order,
// a retry gives one order, a walk-in seat and a fire are keyed and replay the
// same bytes, a closed session from a replay is refused, a bill request needs
// acknowledgement, and the cart is per outlet + captain + table session.
import assert from "node:assert/strict";
import { createPosOrder, firePosOrderItems } from "@starter/shared/pos";
import { openStaffSessionInputSchema } from "@starter/shared/qr-order";
import { ApiError } from "@/lib/api/errors";
import { addLine } from "@/features/ws04-pos-order/cart-logic";
import {
  fireItems,
  openTableSession,
  placeCaptainOrder,
  pendingFireItems,
  closeFireIntent,
  readPendingOpenPax,
  SESSION_CLOSED,
  OPEN_INTENT_PENDING,
  FIRE_INTENT_PENDING,
} from "@/features/ws04-pos-order/captain-flow";
import {
  assertSeated,
  canResolveCall,
  captainDraftKey,
  captainInput,
  holdFor,
  mapServiceRequest,
  mapTableOrders,
  NO_TABLE_SESSION,
  removeSentLines,
} from "@/features/ws04-pos-order/captain-wire";
import {
  needsCashierClose,
  ORDER_INTENT_PENDING,
  type FlowDeps,
} from "@/features/ws04-pos-order/order-flow";
import { createBodyOf } from "@/features/ws04-pos-order/order-wire";
import type {
  CaptainTable,
  CartLine,
  MenuItem,
} from "@/features/ws04-pos-order/types";

const uuid = () => globalThis.crypto.randomUUID();
const course = { id: "", label: "", order: 0 };

function menuItem(): MenuItem {
  return {
    id: uuid(),
    name: "Kopi susu",
    categoryId: uuid(),
    categoryName: "Minuman",
    priceIdr: 20000,
    imageUrl: null,
    soldOut: false,
    code: null,
    course,
    variants: [],
    modifierGroups: [],
  };
}

const LINES: CartLine[] = addLine([], menuItem(), {
  modifiers: [],
  note: "",
  quantity: 2,
});
const SESSION = uuid();

class MemoryStorage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  clone() {
    const copy = new MemoryStorage();
    for (const [key, value] of this.map) copy.setItem(key, value);
    return copy;
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

const NETWORK = () => new ApiError(0, "NETWORK_ERROR", "offline");
let counter = 0;
const makeKey = () =>
  `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
const WHO = { outletId: "o1", actorId: "u1" };

/** Order server that records by idempotency key and can lose a reply. */
function orderServer() {
  const orders = new Map<string, { id: string; status: string }>();
  const byKey = new Map<string, string>();
  const state = {
    orders,
    createBodies: [] as { channel: string; tableSessionId: unknown }[],
    loseCreate: 0,
    loseSubmit: 0,
  };
  const deps = (
    storage: MemoryStorage,
    draftKey: string,
  ): FlowDeps<{ id: string; status: string }, { id: string }> => ({
    storage,
    makeKey,
    scope: { ...WHO, subject: draftKey },
    create: async (body) => {
      state.createBodies.push(body);
      let id = byKey.get(body.idempotencyKey);
      if (!id) {
        id = `order-${orders.size + 1}`;
        byKey.set(body.idempotencyKey, id);
        orders.set(id, { id, status: "draft" });
      }
      if (state.loseCreate-- > 0) throw NETWORK();
      return { id };
    },
    submit: async (orderId) => {
      const order = orders.get(orderId)!;
      order.status = "awaiting_payment";
      if (state.loseSubmit-- > 0) throw NETWORK();
      return { ...order };
    },
    park: async () => ({ id: "p" }),
    resume: async () => ({ id: "p" }),
  });
  return { state, deps };
}

const table = (over: Partial<CaptainTable> = {}): CaptainTable => ({
  id: "t1",
  label: "A01",
  zone: "Indoor",
  status: "occupied",
  guestCount: 2,
  seats: 4,
  qrSessionActive: true,
  sessionId: SESSION,
  hasOpenCall: false,
  ...over,
});

test("the captain order body is on the captain channel, ids only, on the session", () => {
  const body = createBodyOf(captainInput(SESSION, LINES));
  assert.equal(body.channel, "captain");
  assert.equal(body.serviceType, "dine_in");
  assert.equal(body.tableSessionId, SESSION);
  assert.doesNotMatch(JSON.stringify(body), /price|total|amount|subtotal/i);
  const parsed = createPosOrder.body.safeParse({
    ...body,
    idempotencyKey: "create-key-0001",
  });
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
});

test("no session means no order: nothing is sent", async () => {
  assert.throws(
    () => assertSeated(table({ status: "empty", sessionId: null })),
    (error: unknown) =>
      error instanceof ApiError && error.code === NO_TABLE_SESSION,
  );
  assert.equal(assertSeated(table()), SESSION);
  const server = orderServer();
  await assert.rejects(
    placeCaptainOrder(
      server.deps(new MemoryStorage(), "captain:none"),
      "",
      LINES,
    ),
    (error: unknown) =>
      error instanceof ApiError && error.code === NO_TABLE_SESSION,
  );
  assert.equal(server.state.createBodies.length, 0);
});

test("a lost reply to create or submit gives one captain order", async () => {
  const server = orderServer();
  const storage = new MemoryStorage();
  const key = captainDraftKey("o1", "u1", SESSION);
  server.state.loseCreate = 1;
  await assert.rejects(
    placeCaptainOrder(server.deps(storage, key), SESSION, LINES),
  );
  server.state.loseSubmit = 1;
  await assert.rejects(
    placeCaptainOrder(server.deps(storage, key), SESSION, LINES),
  );
  // A refresh: the same storage, a new page.
  const sent = await placeCaptainOrder(
    server.deps(storage.clone(), key),
    SESSION,
    LINES,
  );
  assert.equal(server.state.orders.size, 1);
  assert.equal(sent.status, "awaiting_payment");
  assert.ok(server.state.createBodies.every((b) => b.channel === "captain"));
});

test("a changed cart cannot be sent over an unclear send of this session", async () => {
  const server = orderServer();
  const storage = new MemoryStorage();
  const key = captainDraftKey("o1", "u1", SESSION);
  server.state.loseCreate = 1;
  await assert.rejects(
    placeCaptainOrder(server.deps(storage, key), SESSION, LINES),
  );
  const more = addLine(LINES, menuItem(), {
    modifiers: [],
    note: "",
    quantity: 1,
  });
  await assert.rejects(
    placeCaptainOrder(server.deps(storage, key), SESSION, more),
    (error: unknown) =>
      error instanceof ApiError && error.code === ORDER_INTENT_PENDING,
  );
  assert.equal(server.state.orders.size, 1);
});

test("the cart key is per outlet, captain and table session", async () => {
  const a = captainDraftKey("o1", "u1", SESSION);
  assert.notEqual(a, captainDraftKey("o2", "u1", SESSION));
  assert.notEqual(a, captainDraftKey("o1", "u2", SESSION));
  assert.notEqual(a, captainDraftKey("o1", "u1", uuid()));
  // An unclear send in one session does not stop another session's order.
  const server = orderServer();
  const storage = new MemoryStorage();
  server.state.loseCreate = 1;
  await assert.rejects(
    placeCaptainOrder(server.deps(storage, a), SESSION, LINES),
  );
  const other = uuid();
  await placeCaptainOrder(
    server.deps(storage, captainDraftKey("o1", "u1", other)),
    other,
    LINES,
  );
  assert.equal(server.state.orders.size, 2);
});

test("items added while a send was out stay in the cart", () => {
  const sent = LINES;
  const added = addLine(LINES, menuItem(), {
    modifiers: [],
    note: "",
    quantity: 1,
  });
  const left = removeSentLines(added, sent);
  assert.equal(left.length, 1);
  assert.ok(!sent.some((line) => line.lineId === left[0]!.lineId));
});

// ---- Walk-in seat ---------------------------------------------------------

function seatServer() {
  const sessions = new Map<string, { id: string; status: string; pax: number }>();
  const state = {
    sessions,
    bodies: [] as { pax: number; idempotencyKey: string }[],
    lose: 0,
    closedReplay: false,
    refuse: null as ApiError | null,
  };
  const deps = (storage: MemoryStorage) => ({
    storage,
    makeKey,
    scope: WHO,
    open: async (body: { pax: number; idempotencyKey: string }) => {
      state.bodies.push(body);
      if (state.refuse) throw state.refuse;
      let session = sessions.get(body.idempotencyKey);
      if (!session) {
        session = { id: uuid(), status: "active", pax: body.pax };
        sessions.set(body.idempotencyKey, session);
      }
      if (state.lose-- > 0) throw NETWORK();
      return state.closedReplay ? { ...session, status: "closed" } : session;
    },
  });
  return { state, deps };
}

test("seating: the body parses, two taps and a lost reply give one session", async () => {
  const server = seatServer();
  const storage = new MemoryStorage();
  server.state.lose = 1;
  await assert.rejects(openTableSession(server.deps(storage), "t1", 3));
  assert.equal(readPendingOpenPax(storage, WHO, "t1"), 3);
  const reloaded = storage.clone();
  const seated = await openTableSession(server.deps(reloaded), "t1", 3);
  assert.equal(server.state.sessions.size, 1);
  assert.equal(seated.status, "active");
  assert.equal(server.state.bodies[0]!.idempotencyKey, server.state.bodies[1]!.idempotencyKey);
  assert.ok(openStaffSessionInputSchema.safeParse(server.state.bodies[0]).success);
  assert.equal(readPendingOpenPax(reloaded, WHO, "t1"), null);
});

test("seating: other guests while the first answer is unknown is not sent", async () => {
  const server = seatServer();
  const storage = new MemoryStorage();
  server.state.lose = 1;
  await assert.rejects(openTableSession(server.deps(storage), "t1", 3));
  await assert.rejects(
    openTableSession(server.deps(storage), "t1", 5),
    (error: unknown) =>
      error instanceof ApiError && error.code === OPEN_INTENT_PENDING,
  );
  assert.equal(server.state.bodies.length, 1);
});

test("seating: a replay that answers a closed session is refused and the key is let go", async () => {
  const server = seatServer();
  const storage = new MemoryStorage();
  server.state.closedReplay = true;
  await assert.rejects(
    openTableSession(server.deps(storage), "t1", 2),
    (error: unknown) =>
      error instanceof ApiError && error.code === SESSION_CLOSED,
  );
  server.state.closedReplay = false;
  const next = await openTableSession(server.deps(storage), "t1", 2);
  assert.equal(next.status, "active");
  assert.notEqual(
    server.state.bodies[0]!.idempotencyKey,
    server.state.bodies[1]!.idempotencyKey,
  );
});

test("seating: no cashier or outlet sends nothing; a table in use is final", async () => {
  const server = seatServer();
  const storage = new MemoryStorage();
  await assert.rejects(
    openTableSession(
      { ...server.deps(storage), scope: { outletId: "o1", actorId: "" } },
      "t1",
      2,
    ),
  );
  assert.equal(server.state.bodies.length, 0);
  server.state.refuse = new ApiError(409, "CONFLICT", "Meja masih dipakai.");
  await assert.rejects(openTableSession(server.deps(storage), "t1", 2));
  assert.equal(readPendingOpenPax(storage, WHO, "t1"), null);
});

// ---- Fire by server item id -----------------------------------------------

function fireServer() {
  const state = {
    bodies: [] as {
      itemIds: string[];
      expectedStatus: string;
      idempotencyKey: string;
    }[],
    lose: 0,
    fail: null as ApiError | null,
    fired: new Set<string>(),
  };
  const deps = (storage: MemoryStorage) => ({
    storage,
    makeKey,
    scope: WHO,
    fire: async (
      _orderId: string,
      body: (typeof state.bodies)[number],
    ) => {
      state.bodies.push(body);
      if (state.fail) throw state.fail;
      state.fired.add(body.idempotencyKey);
      if (state.lose-- > 0) throw NETWORK();
      return { ok: true };
    },
  });
  return { state, deps };
}

const ITEM_A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ITEM_B = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

test("fire sends the server item ids and parses on the contract", async () => {
  const server = fireServer();
  await fireItems(
    server.deps(new MemoryStorage()),
    uuid(),
    [ITEM_B, ITEM_A, ITEM_A],
    "awaiting_payment",
  );
  const body = server.state.bodies[0]!;
  assert.deepEqual(body.itemIds, [ITEM_A, ITEM_B].sort());
  const parsed = firePosOrderItems.body.safeParse(body);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
});

test("fire repeated after a lost reply sends the same key and the same status", async () => {
  const server = fireServer();
  const storage = new MemoryStorage();
  const orderId = uuid();
  server.state.lose = 1;
  await assert.rejects(
    fireItems(server.deps(storage), orderId, [ITEM_A], "awaiting_payment"),
  );
  assert.deepEqual(pendingFireItems(storage, WHO, orderId), [ITEM_A]);
  // The order has moved on since: the stored status is still what is sent.
  const reloaded = storage.clone();
  await fireItems(server.deps(reloaded), orderId, [ITEM_A], "sent");
  const [first, second] = server.state.bodies;
  assert.equal(first!.idempotencyKey, second!.idempotencyKey);
  assert.equal(second!.expectedStatus, "awaiting_payment");
  assert.equal(pendingFireItems(reloaded, WHO, orderId), null);
});

test("fire of other items while one is unclear is not sent; a final refusal frees the key", async () => {
  const server = fireServer();
  const storage = new MemoryStorage();
  const orderId = uuid();
  server.state.lose = 1;
  await assert.rejects(
    fireItems(server.deps(storage), orderId, [ITEM_A], "sent"),
  );
  await assert.rejects(
    fireItems(server.deps(storage), orderId, [ITEM_B], "sent"),
    (error: unknown) =>
      error instanceof ApiError && error.code === FIRE_INTENT_PENDING,
  );
  assert.equal(server.state.bodies.length, 1);
  closeFireIntent(storage, WHO, orderId);
  server.state.fail = new ApiError(422, "ITEM_NOT_HELD", "no");
  await assert.rejects(
    fireItems(server.deps(storage), orderId, [ITEM_B], "sent"),
  );
  assert.equal(pendingFireItems(storage, WHO, orderId), null);
});

test("fire refused with 403 stays until the captain closes it", async () => {
  const server = fireServer();
  const storage = new MemoryStorage();
  const orderId = uuid();
  server.state.fail = new ApiError(403, "FORBIDDEN", "no");
  const error = await fireItems(
    server.deps(storage),
    orderId,
    [ITEM_A],
    "sent",
  ).catch((reason: unknown) => reason);
  assert.ok(needsCashierClose(error));
  assert.deepEqual(pendingFireItems(storage, WHO, orderId), [ITEM_A]);
  closeFireIntent(storage, WHO, orderId);
  assert.equal(pendingFireItems(storage, WHO, orderId), null);
});

test("fire without items is refused before anything is sent", async () => {
  const server = fireServer();
  await assert.rejects(
    fireItems(server.deps(new MemoryStorage()), uuid(), [], "sent"),
  );
  assert.equal(server.state.bodies.length, 0);
});

// ---- Table orders ----------------------------------------------------------

test("every send is its own order: orders are never merged, lines keep server ids", () => {
  const detail = (id: string, itemId: string) =>
    ({
      id,
      number: `POS-${id}`,
      createdAt: `2026-11-26T05:0${id.slice(-1)}:00.000Z`,
      channel: "captain",
      serviceType: "dine_in",
      callNumber: null,
      subtotalIdr: "20000",
      items: [
        {
          id: itemId,
          menuItemId: uuid(),
          name: "Kopi",
          unitPriceIdr: "20000",
          quantity: 1,
          modifiers: [],
          note: null,
          course: null,
          status: "active",
          fireStatus: "held",
        },
      ],
    }) as never;
  const view = mapTableOrders(table(), [detail("o-1", "i-1"), detail("o-2", "i-2")]);
  assert.equal(view.orders.length, 2);
  assert.equal(view.orders[0]!.lines[0]!.lineId, "i-1");
  assert.equal(view.orders[1]!.lines[0]!.lineId, "i-2");
  assert.equal(view.orders[0]!.lines[0]!.status, "held");
  assert.equal(view.orders[0]!.tableLabel, "A01");
  assert.deepEqual(mapTableOrders(table({ sessionId: null }), []).orders, []);
});

// ---- Calls ------------------------------------------------------------------

function request(over: Record<string, unknown> = {}) {
  return {
    id: uuid(),
    tableSessionId: SESSION,
    tableId: "t1",
    tableLabel: "A01",
    type: "request_bill",
    reason: null,
    message: null,
    status: "pending",
    createdAt: "2026-11-26T05:00:00.000Z",
    ...over,
  } as never;
}

test("a bill request needs acknowledgement before it can be resolved", () => {
  const pending = mapServiceRequest(request())!;
  assert.equal(pending.status, "new");
  assert.equal(canResolveCall(pending), false);
  const accepted = mapServiceRequest(request({ status: "acknowledged" }))!;
  assert.equal(canResolveCall(accepted), true);
  const waiter = mapServiceRequest(
    request({ type: "call_waiter", reason: "utensils" }),
  )!;
  assert.equal(canResolveCall(waiter), true);
  assert.equal(waiter.reason, "Minta alat makan");
  assert.equal(mapServiceRequest(request({ status: "cancelled" })), null);
  assert.equal(mapServiceRequest(request({ status: "resolved" }))!.status, "resolved");
});

// ---- Reservation hold --------------------------------------------------------

test("a reservation not yet seated that holds the table is a warning", () => {
  const now = Date.parse("2026-11-26T05:00:00.000Z");
  const hold = (over: Record<string, unknown> = {}) =>
    ({
      id: uuid(),
      guestName: "Budi",
      pax: 4,
      reservedFor: "2026-11-26T06:00:00.000Z",
      durationMinutes: 90,
      tableIds: ["t1"],
      status: "confirmed",
      tableSessionId: null,
      ...over,
    }) as never;
  assert.equal(holdFor([hold()], "t1", now)?.guestName, "Budi");
  assert.equal(holdFor([hold()], "t2", now), null);
  assert.equal(holdFor([hold({ status: "seated" })], "t1", now), null);
  assert.equal(holdFor([hold({ status: "cancelled" })], "t1", now), null);
  assert.equal(holdFor([hold({ tableSessionId: uuid() })], "t1", now), null);
  assert.equal(
    holdFor([hold({ reservedFor: "2026-11-26T01:00:00.000Z" })], "t1", now),
    null,
  );
});
