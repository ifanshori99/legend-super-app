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
  closeOpenIntent,
  readPendingOpenPax,
  pendingCaptainOrders,
  pendingOpenSeats,
  planFireReplay,
  continueDraft,
  SESSION_CLOSED,
  OPEN_INTENT_PENDING,
  FIRE_INTENT_PENDING,
} from "@/features/ws04-pos-order/captain-flow";
import {
  assertOrderable,
  assertSeated,
  isUnsentDraft,
  CAPTAIN_PAY_FIRST,
  canResolveCall,
  captainDraftKey,
  captainInput,
  captainMeta,
  mapServiceRequest,
  mapTableOrders,
  NO_TABLE_SESSION,
  readAllPages,
  removeSentLines,
} from "@/features/ws04-pos-order/captain-wire";
import {
  needsCashierClose,
  ORDER_INTENT_PENDING,
  type FlowDeps,
} from "@/features/ws04-pos-order/order-flow";
import { createBodyOf, mapFloor } from "@/features/ws04-pos-order/order-wire";
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
  const sessions = new Map<
    string,
    { id: string; status: string; pax: number }
  >();
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
  assert.equal(
    server.state.bodies[0]!.idempotencyKey,
    server.state.bodies[1]!.idempotencyKey,
  );
  assert.ok(
    openStaffSessionInputSchema.safeParse(server.state.bodies[0]).success,
  );
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
    fire: async (_orderId: string, body: (typeof state.bodies)[number]) => {
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
  const view = mapTableOrders(table(), [
    detail("o-1", "i-1"),
    detail("o-2", "i-2"),
  ]);
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
  assert.equal(
    mapServiceRequest(request({ status: "resolved" }))!.status,
    "resolved",
  );
});

// ---- Reservation hold --------------------------------------------------------

test("the floor board hold marker reaches the table, without a name", () => {
  const row = (reservationHold?: unknown) => ({
    table: { id: "t1", code: "A1", zoneId: "z1", capacity: 4 },
    session: null,
    openServiceRequestCount: 0,
    outstandingIdr: 0,
    ...(reservationHold === undefined ? {} : { reservationHold }),
  });
  const board = (...rows: unknown[]) =>
    ({
      outletId: "o1",
      zones: [{ id: "z1", name: "Indoor" }],
      tables: rows,
      generatedAt: "2026-11-26T05:00:00.000Z",
    }) as never;
  const marker = {
    startsAt: "2026-11-26T06:00:00.000Z",
    endsAt: "2026-11-26T07:30:00.000Z",
    pax: 4,
  };
  assert.deepEqual(mapFloor(board(row(marker)))[0]!.hold, marker);
  // None means none; a server that did not say stays unknown (soft warning).
  assert.equal(mapFloor(board(row(null)))[0]!.hold, null);
  assert.equal(mapFloor(board(row()))[0]!.hold, undefined);
});

// ---- Unclear sends independent of the table ------------------------------------

test("an unclear captain order is listed with no open session, resent from its snapshot and closed", async () => {
  const server = orderServer();
  const storage = new MemoryStorage();
  const draftKey = captainDraftKey(WHO.outletId, WHO.actorId, SESSION);
  server.state.loseCreate = 1;
  await assert.rejects(
    placeCaptainOrder(
      server.deps(storage, draftKey),
      SESSION,
      LINES,
      captainMeta({ label: "A1", sessionId: SESSION }),
    ),
  );
  // Another cashier's cart and a cashier cart are not the captain's.
  const other = new MemoryStorage();
  const found = pendingCaptainOrders(storage, WHO);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.draftKey, draftKey);
  assert.equal(found[0]!.snapshot.meta.tableSessionId, SESSION);
  assert.equal(found[0]!.snapshot.meta.tableLabel, "A1");
  assert.deepEqual(pendingCaptainOrders(other, WHO), []);
  assert.deepEqual(
    pendingCaptainOrders(storage, { ...WHO, actorId: "u2" }),
    [],
  );
  // The same bytes go again from the snapshot alone: one order.
  const reloaded = storage.clone();
  const again = pendingCaptainOrders(reloaded, WHO)[0]!;
  await placeCaptainOrder(
    server.deps(reloaded, again.draftKey),
    again.snapshot.meta.tableSessionId!,
    again.snapshot.lines,
    again.snapshot.meta,
  );
  assert.equal(server.state.orders.size, 1);
  assert.deepEqual(pendingCaptainOrders(reloaded, WHO), []);
});

test("an unclear seat is listed per table, with its guest count", async () => {
  const storage = new MemoryStorage();
  const server = seatServer();
  server.state.lose = 1;
  await assert.rejects(openTableSession(server.deps(storage), "t9", 3));
  assert.deepEqual(pendingOpenSeats(storage, WHO), [{ tableId: "t9", pax: 3 }]);
  closeOpenIntent(storage, WHO, "t9");
  assert.deepEqual(pendingOpenSeats(storage, WHO), []);
});

test("a table fire replays an unclear fire of the same items as it was, without a new pre-check", () => {
  const pending = [
    { orderId: "o-1", itemIds: [ITEM_A] },
    { orderId: "o-2", itemIds: [ITEM_B, "other"] },
  ];
  const plan = planFireReplay(pending, new Set([ITEM_A, ITEM_B]));
  // o-1 is fully wanted: replayed. o-2 holds an item that was not asked for:
  // not touched here, and its items stay out of the new send.
  assert.deepEqual(plan.replay, [{ orderId: "o-1", itemIds: [ITEM_A] }]);
  assert.deepEqual(plan.rest, [ITEM_B]);
  assert.deepEqual(planFireReplay([], new Set([ITEM_A])), {
    replay: [],
    rest: [ITEM_A],
  });
});

test("a list is read to its last page, and a cursor that repeats stops the read", async () => {
  const seen: (string | undefined)[] = [];
  const pages: Record<string, { data: number[]; next: string | null }> = {
    first: { data: [1, 2], next: "b" },
    b: { data: [3], next: "c" },
    c: { data: [4], next: null },
  };
  const all = await readAllPages(async (cursor) => {
    seen.push(cursor);
    const page = pages[cursor ?? "first"]!;
    return { data: page.data, meta: { limit: 2, nextCursor: page.next } };
  });
  assert.deepEqual(all, [1, 2, 3, 4]);
  assert.deepEqual(seen, [undefined, "b", "c"]);
  await assert.rejects(
    readAllPages(async () => ({
      data: [1],
      meta: { limit: 1, nextCursor: "same" },
    })),
    (error: unknown) => error instanceof ApiError,
  );
});

// ---- Pay first: the cashier's table -----------------------------------------------

test("a pay-first table is held back before anything is sent", () => {
  const row = (paymentMode: string) => ({
    table: { id: "t1", code: "A1", zoneId: "z1", capacity: 4 },
    session: { id: SESSION, status: "open", pax: 2, paymentMode },
    openServiceRequestCount: 0,
    outstandingIdr: 0,
  });
  const board = (mode: string) =>
    ({
      outletId: "o1",
      zones: [{ id: "z1", name: "Indoor" }],
      tables: [row(mode)],
      generatedAt: "2026-11-26T05:00:00.000Z",
    }) as never;
  const payFirst = mapFloor(board("pay_first"))[0]!;
  const openBill = mapFloor(board("open_bill"))[0]!;
  assert.equal(payFirst.paymentMode, "pay_first");
  assert.equal(assertOrderable(openBill), SESSION);
  assert.throws(
    () => assertOrderable(payFirst),
    (error: unknown) =>
      error instanceof ApiError &&
      error.status === 409 &&
      error.code === CAPTAIN_PAY_FIRST &&
      error.message === "Meja ini bayar di muka. Arahkan tamu ke kasir.",
  );
  // No session is still its own refusal.
  assert.throws(
    () => assertOrderable(table({ sessionId: null })),
    (error: unknown) =>
      error instanceof ApiError && error.code === NO_TABLE_SESSION,
  );
});

// ---- An order that was created but not submitted --------------------------------

test("a draft whose submit was lost goes on with the same key, and no second order is created", async () => {
  const server = orderServer();
  const storage = new MemoryStorage();
  const draftKey = captainDraftKey(WHO.outletId, WHO.actorId, SESSION);
  server.state.loseSubmit = 1;
  await assert.rejects(
    placeCaptainOrder(
      server.deps(storage, draftKey),
      SESSION,
      LINES,
      captainMeta({ label: "A1", sessionId: SESSION }),
    ),
  );
  const submits: string[] = [];
  const reloaded = storage.clone();
  const continued = await continueDraft(
    {
      storage: reloaded,
      makeKey,
      scope: WHO,
      submit: async (orderId, body) => {
        submits.push(body.idempotencyKey);
        return server.deps(reloaded, draftKey).submit(orderId, body);
      },
    },
    "order-1",
    SESSION,
  );
  assert.equal(continued.status, "awaiting_payment");
  assert.equal(server.state.orders.size, 1);
  // The key of the unclear submit, not a new one; nothing is left to resend.
  assert.equal(submits.length, 1);
  assert.deepEqual(pendingCaptainOrders(reloaded, WHO), []);
});

test("a draft with no stored intent is submitted on its own key, repeated as it was", async () => {
  const storage = new MemoryStorage();
  const keys: string[] = [];
  let lose = 1;
  const deps = (store: MemoryStorage) => ({
    storage: store,
    makeKey,
    scope: WHO,
    submit: async (orderId: string, body: { idempotencyKey: string }) => {
      keys.push(body.idempotencyKey);
      if (lose-- > 0) throw NETWORK();
      return { id: orderId, status: "awaiting_payment" };
    },
  });
  await assert.rejects(continueDraft(deps(storage), "order-9", SESSION));
  await continueDraft(deps(storage.clone()), "order-9", SESSION);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
});

test("the cashier continues a draft with no table session on its own key, once", async () => {
  const storage = new MemoryStorage();
  const keys: string[] = [];
  let lose = 1;
  const deps = (store: MemoryStorage) => ({
    storage: store,
    makeKey,
    scope: WHO,
    submit: async (orderId: string, body: { idempotencyKey: string }) => {
      keys.push(body.idempotencyKey);
      if (lose-- > 0) throw NETWORK();
      return { id: orderId, status: "awaiting_payment" };
    },
  });
  await assert.rejects(continueDraft(deps(storage), "order-4", null));
  const sent = await continueDraft(deps(storage.clone()), "order-4", null);
  assert.equal(sent.status, "awaiting_payment");
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
});

test("create lost, then Continue, then Resend: one order, nothing left to resend", async () => {
  const server = orderServer();
  const storage = new MemoryStorage();
  const draftKey = captainDraftKey(WHO.outletId, WHO.actorId, SESSION);
  const meta = captainMeta({ label: "A1", sessionId: SESSION });
  server.state.loseCreate = 1;
  await assert.rejects(
    placeCaptainOrder(server.deps(storage, draftKey), SESSION, LINES, meta),
  );
  // The order exists on the server as a draft; the create intent is stored.
  assert.equal(server.state.orders.size, 1);
  assert.equal(pendingCaptainOrders(storage, WHO).length, 1);
  const submitBodies: string[] = [];
  await continueDraft(
    {
      storage,
      makeKey,
      scope: WHO,
      submit: async (orderId, body) => {
        submitBodies.push(body.idempotencyKey);
        return server.deps(storage, draftKey).submit(orderId, body);
      },
      // The same create key and the stored snapshot: the replay, not a new key.
      resend: async (key) => {
        const found = pendingCaptainOrders(storage, WHO).find(
          (entry) => entry.draftKey === key,
        )!;
        return placeCaptainOrder(
          server.deps(storage, key),
          found.snapshot.meta.tableSessionId!,
          found.snapshot.lines,
          found.snapshot.meta,
        );
      },
    },
    "order-1",
    SESSION,
  );
  assert.equal(server.state.orders.size, 1);
  assert.equal(server.state.orders.get("order-1")!.status, "awaiting_payment");
  // Nothing is left to resend, so a resend cannot create or submit again.
  assert.deepEqual(pendingCaptainOrders(storage, WHO), []);
  assert.equal(submitBodies.length, 0);
});

test("a captain draft is listed on the table; another channel's draft is not", () => {
  const order = (id: string, status: string, channel: string) =>
    ({
      id,
      status,
      channel,
      serviceType: "dine_in",
      number: id,
      callNumber: null,
      subtotalIdr: 0,
      createdAt: `2026-11-26T05:0${id}:00.000Z`,
      items: [],
    }) as never;
  const view = mapTableOrders(table(), [
    order("1", "draft", "captain"),
    order("2", "draft", "pos"),
    order("3", "awaiting_payment", "pos"),
  ]);
  assert.deepEqual(
    view.orders.map((entry) => entry.orderId),
    ["1", "3"],
  );
  assert.equal(isUnsentDraft(view.orders[0]!), true);
  assert.equal(isUnsentDraft(view.orders[1]!), false);
});
