// Brief 1268 W1: the cashier order on the real contract. The body carries ids
// and quantities only (no price), a dine-in order goes onto the table session,
// a variant item needs its variant, and a lost reply to create or submit gives
// one order, also after a refresh (same storage, new page).
import assert from "node:assert/strict";
import { createPosOrder } from "@starter/shared/pos";
import { ApiError } from "@/lib/api/errors";
import { addLine } from "@/features/ws04-pos-order/cart-logic";
import {
  placeOrder,
  parkCart,
  resumeParkedInto,
  readPendingOrder,
  closeOrderIntent,
  pendingResumeIds,
  ACTOR_MISSING,
  needsCashierClose,
  PARK_INTENT_PENDING,
  readPendingPark,
  closeParkIntent,
  closeResumeIntent,
  ORDER_INTENT_PENDING,
  type FlowDeps,
  replayAll,
} from "@/features/ws04-pos-order/order-flow";
import {
  hasForeignIntent,
  peekIntent,
} from "@/features/ws04-pos-order/intent-store";
import {
  clearActingStaffToken,
  readActingStaffUserId,
  writeActingStaffToken,
} from "@/lib/api/acting-staff";
import { cashierDraftKey } from "@/features/ws04-pos-order/draft-store";
import {
  createBodyOf,
  draftFromPark,
  mapParked,
  sameOrder,
} from "@/features/ws04-pos-order/order-wire";
import type {
  CartLine,
  Catalog,
  MenuItem,
  OrderMeta,
  SubmitOrderInput,
} from "@/features/ws04-pos-order/types";

const uuid = () => globalThis.crypto.randomUUID();
const course = { id: "", label: "", order: 0 };

const SMALL = { id: uuid(), name: "Kecil", priceIdr: 20000 };
const LARGE = { id: uuid(), name: "Besar", priceIdr: 30000 };
const OPTION = { id: uuid(), name: "Extra keju", priceDeltaIdr: 5000 };

function item(extra: Partial<MenuItem> = {}): MenuItem {
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
    ...extra,
  };
}

const withVariants = item({
  variants: [SMALL, LARGE],
  modifierGroups: [
    {
      id: uuid(),
      name: "Tambahan",
      required: false,
      min: 0,
      max: 1,
      options: [OPTION],
    },
  ],
});

function cartLines(): CartLine[] {
  const lines = addLine([], withVariants, {
    variant: LARGE,
    modifiers: [
      {
        groupId: withVariants.modifierGroups[0]!.id,
        optionId: OPTION.id,
        name: OPTION.name,
        priceDeltaIdr: OPTION.priceDeltaIdr,
      },
    ],
    note: " tanpa gula ",
    quantity: 2,
  });
  return addLine(lines, item(), { modifiers: [], note: "", quantity: 1 });
}

const SESSION = uuid();
const LINES = cartLines();

function input(over: Partial<SubmitOrderInput> = {}): SubmitOrderInput {
  return {
    channel: "dine_in",
    tableSessionId: SESSION,
    ojol: null,
    lines: LINES,
    ...over,
  };
}

class MemoryStorage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  /** A copied tab: the same entries in its own storage. */
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

/** A server that records by idempotency key and can lose a reply. */
function fakeServer() {
  const orders = new Map<string, { id: string; status: string }>();
  const byCreateKey = new Map<string, string>();
  const submits = new Map<string, string>();
  const state = {
    orders,
    createCalls: [] as string[],
    submitCalls: [] as string[],
    parked: new Map<string, string>(),
    resumed: new Map<string, string>(),
    loseCreateReply: 0,
    loseSubmitReply: 0,
    failCreate: null as ApiError | null,
    lastCreateBody: null as unknown,
  };
  const deps = (
    storage: MemoryStorage,
    scope = { outletId: "o1", actorId: "u1", subject: "kasir" },
  ): FlowDeps<{ id: string; status: string }, { id: string }> => {
    let n = 0;
    return {
      storage,
      makeKey: () =>
        `00000000-0000-4000-8000-${String(++n + Math.floor(Math.random() * 1e6)).padStart(12, "0")}`,
      scope,
      create: async (body) => {
        state.createCalls.push(body.idempotencyKey);
        state.lastCreateBody = body;
        if (state.failCreate) throw state.failCreate;
        let id = byCreateKey.get(body.idempotencyKey);
        if (!id) {
          id = `order-${orders.size + 1}`;
          byCreateKey.set(body.idempotencyKey, id);
          orders.set(id, { id, status: "draft" });
        }
        if (state.loseCreateReply-- > 0) throw NETWORK();
        return { id };
      },
      submit: async (orderId, body) => {
        state.submitCalls.push(body.idempotencyKey);
        const order = orders.get(orderId)!;
        if (!submits.has(body.idempotencyKey)) {
          submits.set(body.idempotencyKey, orderId);
          order.status = "awaiting_payment";
        }
        if (state.loseSubmitReply-- > 0) throw NETWORK();
        return { ...order };
      },
      park: async (body) => {
        const id =
          state.parked.get(body.idempotencyKey) ??
          `parked-${state.parked.size + 1}`;
        state.parked.set(body.idempotencyKey, id);
        return { id };
      },
      resume: async (parkedId, body) => {
        state.resumed.set(body.idempotencyKey, parkedId);
        return { id: parkedId };
      },
    };
  };
  return { state, deps };
}

test("the create body carries ids and quantities, never a price", () => {
  const body = createBodyOf(input());
  const text = JSON.stringify(body);
  assert.doesNotMatch(text, /price|total|amount|subtotal/i);
  const parsed = createPosOrder.body.safeParse({
    ...body,
    idempotencyKey: "create-key-0001",
  });
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  const first = body.items[0]!;
  assert.equal(first.variantId, LARGE.id);
  assert.deepEqual(first.modifierIds, [OPTION.id]);
  assert.equal(first.note, "tanpa gula");
  assert.equal(first.course, null);
});

test("dine-in goes onto the table session, not the label", () => {
  const body = createBodyOf(input());
  assert.equal(body.tableSessionId, SESSION);
  assert.equal(body.serviceType, "dine_in");
  assert.equal("tableLabel" in body, false);
  const takeaway = createBodyOf(
    input({ channel: "takeaway", tableSessionId: null }),
  );
  assert.equal(takeaway.tableSessionId, null);
  assert.equal(takeaway.serviceType, "takeaway");
  const ojol = createBodyOf(
    input({
      channel: "ojol_manual",
      tableSessionId: null,
      ojol: { platform: "gofood", externalRef: " GF-1 " },
    }),
  );
  assert.equal(ojol.channel, "gofood");
  assert.equal(ojol.externalRef, "GF-1");
});

test("a variant item is not added without its variant", () => {
  assert.deepEqual(
    addLine([], withVariants, { modifiers: [], note: "", quantity: 1 }),
    [],
  );
  assert.deepEqual(
    addLine([], withVariants, {
      variant: { id: uuid(), name: "Asing", priceIdr: 1 },
      modifiers: [],
      note: "",
      quantity: 1,
    }),
    [],
  );
  const lines = addLine([], withVariants, {
    variant: SMALL,
    modifiers: [],
    note: "",
    quantity: 1,
  });
  assert.equal(lines[0]?.unitPriceIdr, SMALL.priceIdr);
  assert.equal(lines[0]?.variantId, SMALL.id);
});

test("a lost create reply gives one order on retry", async () => {
  const { state, deps } = fakeServer();
  const storage = new MemoryStorage();
  state.loseCreateReply = 1;
  await assert.rejects(placeOrder(deps(storage), input()));
  const placed = await placeOrder(deps(storage), input());
  assert.equal(state.orders.size, 1);
  assert.equal(placed.status, "awaiting_payment");
  assert.equal(new Set(state.createCalls).size, 1, "same create key");
  assert.equal(
    peekIntent(storage, {
      outletId: "o1",
      actorId: "u1",
      kind: "create",
      subject: "kasir",
    }),
    null,
  );
});

test("a lost submit reply gives one order and one submit key", async () => {
  const { state, deps } = fakeServer();
  const storage = new MemoryStorage();
  state.loseSubmitReply = 1;
  await assert.rejects(placeOrder(deps(storage), input()));
  assert.equal(state.createCalls.length, 1);
  await placeOrder(deps(storage), input());
  assert.equal(state.createCalls.length, 1, "create is not repeated");
  assert.equal(state.orders.size, 1);
  assert.equal(new Set(state.submitCalls).size, 1, "same submit key");
});

test("a refresh keeps the key: new page, same storage, one order", async () => {
  const { state, deps } = fakeServer();
  const storage = new MemoryStorage();
  state.loseCreateReply = 1;
  await assert.rejects(placeOrder(deps(storage), input()));
  // "Refresh": a new deps object whose key maker would give other keys.
  await placeOrder(deps(storage), input());
  assert.equal(state.orders.size, 1);
  assert.equal(new Set(state.createCalls).size, 1);
});

test("another cart while a send is unresolved is refused, not sent", async () => {
  const { state, deps } = fakeServer();
  const storage = new MemoryStorage();
  state.loseCreateReply = 1;
  await assert.rejects(placeOrder(deps(storage), input()));
  const other = input({
    lines: addLine(LINES, item(), { modifiers: [], note: "", quantity: 1 }),
  });
  await assert.rejects(
    placeOrder(deps(storage), other),
    (error: unknown) =>
      error instanceof ApiError && error.code === ORDER_INTENT_PENDING,
  );
  assert.equal(state.createCalls.length, 1, "nothing was sent");
});

test("a sold-out 409 forgets the key and the cart is untouched", async () => {
  const { state, deps } = fakeServer();
  const storage = new MemoryStorage();
  const before = JSON.stringify(LINES);
  state.failCreate = new ApiError(409, "ITEM_SOLD_OUT", "Kopi susu habis.");
  await assert.rejects(placeOrder(deps(storage), input()));
  assert.equal(JSON.stringify(LINES), before);
  state.failCreate = null;
  await placeOrder(deps(storage), input());
  assert.equal(
    new Set(state.createCalls).size,
    2,
    "a fresh key after a refusal",
  );
  assert.equal(state.orders.size, 1);
});

test("a 5xx keeps the key", async () => {
  const { state, deps } = fakeServer();
  const storage = new MemoryStorage();
  state.failCreate = new ApiError(503, "UNAVAILABLE", "down");
  await assert.rejects(placeOrder(deps(storage), input()));
  state.failCreate = null;
  await placeOrder(deps(storage), input());
  assert.equal(new Set(state.createCalls).size, 1);
});

test("park is keyed and does not need the catalog", async () => {
  const { state, deps } = fakeServer();
  const storage = new MemoryStorage();
  const parked = await parkCart(deps(storage), input());
  assert.equal(state.parked.size, 1);
  const draft = draftFromPark(
    {
      id: parked.id,
      label: "Meja",
      parkedAt: "2026-11-26T00:00:00.000Z",
    } as never,
    input(),
  );
  assert.equal(draft.lines, LINES, "the cart that was parked, no catalog read");
});

test("a parked cart comes back from the catalog; gone items are counted", () => {
  const catalog: Catalog = {
    categories: [],
    items: [withVariants],
    updatedAt: "2026-11-26T00:00:00.000Z",
    source: "live",
  };
  const gone = uuid();
  const { draft, missing } = mapParked(
    {
      id: "p1" as never,
      label: "Meja",
      channel: "pos",
      serviceType: "dine_in",
      tableSessionId: null,
      externalRef: null,
      parkedAt: "2026-11-26T00:00:00.000Z",
      items: [
        {
          menuItemId: withVariants.id,
          variantId: LARGE.id,
          modifierIds: [OPTION.id],
          quantity: 2,
        },
        { menuItemId: gone, variantId: null, modifierIds: [], quantity: 1 },
      ],
    } as never,
    catalog,
    uuid,
  );
  assert.equal(missing, 1);
  assert.equal(draft.lines.length, 1);
  assert.equal(draft.lines[0]?.variantId, LARGE.id);
  assert.equal(draft.subtotalIdr, (LARGE.priceIdr + OPTION.priceDeltaIdr) * 2);
});

// ---- Review of W1 (docs/qa/1268-w1-review.md) ------------------------------

const META: OrderMeta = {
  channel: "dine_in",
  tableLabel: "A01",
  tableSessionId: SESSION,
  ojolPlatform: null,
  ojolRef: "",
};
const SCOPE = { outletId: "o1", actorId: "u1", subject: "kasir" };

class FlakyStorage extends MemoryStorage {
  failRemove = 0;
  removeItem(key: string) {
    if (this.failRemove-- > 0) throw new Error("tab closed");
    super.removeItem(key);
  }
}

test("resume: a catalog failure sends nothing; the lines are saved before the key is forgotten", async () => {
  const { state, deps } = fakeServer();
  const storage = new MemoryStorage();
  const d = deps(storage);
  let sent = 0;
  const realResume = d.resume;
  d.resume = async (id, body) => {
    sent += 1;
    const parked = await realResume(id, body);
    if (sent === 1) throw NETWORK();
    return parked;
  };
  await assert.rejects(
    resumeParkedInto(
      d,
      "p1",
      async () => Promise.reject(new Error("catalog")),
      () => {},
    ),
  );
  assert.equal(sent, 0, "the server was not asked while the catalog failed");
  assert.deepEqual(pendingResumeIds(storage, SCOPE), []);

  // The reply is lost: the intent stays, the open screen replays it.
  await assert.rejects(
    resumeParkedInto(
      d,
      "p1",
      async () => "cat",
      () => {},
    ),
  );
  assert.deepEqual(pendingResumeIds(storage, SCOPE), ["p1"]);
  const applied: string[] = [];
  await resumeParkedInto(
    d,
    "p1",
    async () => "cat",
    (parked) => {
      applied.push(parked.id);
      assert.deepEqual(
        pendingResumeIds(storage, SCOPE),
        ["p1"],
        "key still kept while applying",
      );
    },
  );
  assert.deepEqual(applied, ["p1"]);
  assert.deepEqual(pendingResumeIds(storage, SCOPE), []);
  assert.equal(new Set(state.resumed.keys()).size, 1, "one key for both tries");
});

test("resume: a crash after the lines were saved does not add them twice", async () => {
  const { deps } = fakeServer();
  const storage = new FlakyStorage();
  const d = deps(storage);
  const applied: string[] = [];
  storage.failRemove = 1;
  await assert.rejects(
    resumeParkedInto(
      d,
      "p1",
      async () => "cat",
      (p) => applied.push(p.id),
    ),
  );
  assert.equal(applied.length, 1);
  const again = await resumeParkedInto(
    d,
    "p1",
    async () => "cat",
    (p) => applied.push(p.id),
  );
  assert.equal(again, null);
  assert.equal(applied.length, 1, "applied once");
  assert.deepEqual(pendingResumeIds(storage, SCOPE), []);
});

test("an unclear send keeps its lines and meta; the re-send uses the same key", async () => {
  const { state, deps } = fakeServer();
  const storage = new MemoryStorage();
  state.loseCreateReply = 1;
  await assert.rejects(placeOrder(deps(storage), input(), META));
  const pending = readPendingOrder(storage, SCOPE);
  assert.deepEqual(pending?.meta, META);
  assert.equal(pending?.lines.length, LINES.length);
  // The cashier emptied the cart meanwhile; the restored one is sent as it was.
  const restored = input({
    lines: pending!.lines,
    tableSessionId: pending!.meta.tableSessionId,
  });
  await placeOrder(deps(storage), restored, pending!.meta);
  assert.equal(state.orders.size, 1);
  assert.equal(new Set(state.createCalls).size, 1);
  assert.equal(readPendingOrder(storage, SCOPE), null);
});

test("a reused key is never closed on its own; the cashier closes it", async () => {
  const { state, deps } = fakeServer();
  const storage = new MemoryStorage();
  state.failCreate = new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "reused");
  await assert.rejects(placeOrder(deps(storage), input(), META));
  assert.notEqual(readPendingOrder(storage, SCOPE), null);
  closeOrderIntent(storage, SCOPE);
  assert.equal(readPendingOrder(storage, SCOPE), null);
});

test("final refusals close the key, 401/403/408/429 keep it", async () => {
  for (const [status, closed] of [
    [422, true],
    [404, true],
    [409, true],
    [401, false],
    [403, false],
    [408, false],
    [429, false],
    [500, false],
  ] as const) {
    const { state, deps } = fakeServer();
    const storage = new MemoryStorage();
    state.failCreate = new ApiError(status, "X", "x");
    await assert.rejects(placeOrder(deps(storage), input(), META));
    assert.equal(
      readPendingOrder(storage, SCOPE) === null,
      closed,
      `status ${status}`,
    );
  }
});

test("a saved option that left the catalog is counted missing, not dropped", () => {
  const catalog: Catalog = {
    categories: [],
    items: [withVariants],
    updatedAt: "2026-11-26T00:00:00.000Z",
    source: "live",
  };
  const { draft, missing } = mapParked(
    {
      id: "p1" as never,
      label: "Meja",
      channel: "pos",
      serviceType: "dine_in",
      tableSessionId: null,
      externalRef: null,
      parkedAt: "2026-11-26T00:00:00.000Z",
      items: [
        {
          menuItemId: withVariants.id,
          variantId: LARGE.id,
          modifierIds: [OPTION.id, uuid()],
          quantity: 1,
        },
      ],
    } as never,
    catalog,
    uuid,
  );
  assert.equal(missing, 1);
  assert.equal(draft.lines.length, 0);
});

test("nothing is sent without an outlet or a cashier", async () => {
  for (const scope of [
    { outletId: "o1", actorId: "", subject: "kasir" },
    { outletId: "", actorId: "u1", subject: "kasir" },
  ]) {
    const { state, deps } = fakeServer();
    const storage = new MemoryStorage();
    const code = (error: unknown) =>
      error instanceof ApiError && error.code === ACTOR_MISSING;
    await assert.rejects(placeOrder(deps(storage, scope), input(), META), code);
    await assert.rejects(parkCart(deps(storage, scope), input()), code);
    await assert.rejects(
      resumeParkedInto(
        deps(storage, scope),
        "p1",
        async () => 1,
        () => {},
      ),
      code,
    );
    assert.equal(state.createCalls.length, 0);
    assert.equal(state.parked.size, 0);
    assert.equal(storage.length, 0);
  }
});

test("a copied tab repeats the same key: one order whoever sends first", async () => {
  const { state, deps } = fakeServer();
  const tabA = new MemoryStorage();
  state.loseCreateReply = 1;
  await assert.rejects(placeOrder(deps(tabA), input(), META));
  const tabB = tabA.clone();
  await placeOrder(deps(tabB), input(), META);
  await placeOrder(deps(tabA), input(), META);
  assert.equal(state.orders.size, 1);
  assert.equal(new Set(state.createCalls).size, 1);
});

test("another cashier or outlet never reuses or sees the key", async () => {
  const { state, deps } = fakeServer();
  const storage = new MemoryStorage();
  state.loseCreateReply = 1;
  await assert.rejects(placeOrder(deps(storage), input(), META));
  const other = { outletId: "o1", actorId: "u2", subject: "kasir" };
  const elsewhere = { outletId: "o2", actorId: "u1", subject: "kasir" };
  assert.equal(readPendingOrder(storage, other), null);
  assert.equal(readPendingOrder(storage, elsewhere), null);
  await placeOrder(deps(storage, elsewhere), input(), META);
  assert.equal(
    new Set(state.createCalls).size,
    2,
    "another outlet, another key",
  );
  // The first cashier's unresolved send is untouched.
  assert.notEqual(readPendingOrder(storage, SCOPE), null);
});

// ---- Re-review of W1 --------------------------------------------------------

test("two resumes at once apply the parked cart once", async () => {
  const { deps } = fakeServer();
  const storage = new MemoryStorage();
  const applied: string[] = [];
  const run = () =>
    resumeParkedInto(
      deps(storage),
      "p1",
      async () => "cat",
      (p) => applied.push(p.id),
    );
  await Promise.all([run(), run()]);
  assert.deepEqual(applied, ["p1"]);
  assert.deepEqual(pendingResumeIds(storage, SCOPE), []);
});

test("restoring is a no-op question only when the cart is the same order", () => {
  const same = sameOrder(LINES, META, { lines: LINES, meta: META });
  assert.equal(same, true);
  assert.equal(
    sameOrder(
      addLine(LINES, item(), { modifiers: [], note: "", quantity: 1 }),
      META,
      {
        lines: LINES,
        meta: META,
      },
    ),
    false,
  );
  assert.equal(
    sameOrder(
      LINES,
      { ...META, tableSessionId: uuid() },
      { lines: LINES, meta: META },
    ),
    false,
  );
  assert.equal(sameOrder([], META, { lines: LINES, meta: META }), false);
});

test("the cart key carries outlet and cashier", () => {
  assert.notEqual(cashierDraftKey("o1", "u1"), cashierDraftKey("o1", "u2"));
  assert.notEqual(cashierDraftKey("o1", "u1"), cashierDraftKey("o2", "u1"));
});

test("another cashier's unclear send is shown, never blocking, never resent", async () => {
  const { state, deps } = fakeServer();
  const storage = new MemoryStorage();
  state.loseCreateReply = 1;
  await assert.rejects(placeOrder(deps(storage), input(), META));
  const keyOfA = state.createCalls[0]!;
  const other = { outletId: "o1", actorId: "u2", subject: "kasir" };
  assert.equal(hasForeignIntent(storage, other), true, "the screen can tell");
  assert.equal(
    hasForeignIntent(storage, SCOPE),
    false,
    "own intent is not foreign",
  );
  // B sends B's cart, and may also park; A's request is not touched.
  await placeOrder(deps(storage, other), input(), META);
  await parkCart(deps(storage, other), input());
  assert.equal(
    state.orders.size,
    2,
    "A's recorded order and B's own, no third",
  );
  assert.equal(
    state.createCalls.filter((key) => key === keyOfA).length,
    1,
    "A's key is not resent by B",
  );
  assert.notEqual(readPendingOrder(storage, SCOPE), null, "A's intent stays");
  assert.equal(
    peekIntent(storage, {
      outletId: "o1",
      actorId: "u1",
      kind: "create",
      subject: "kasir",
    })?.key,
    keyOfA,
  );
});

test("a lost park keeps its cart and meta; resend repeats key and bytes", async () => {
  const { state, deps } = fakeServer();
  const storage = new MemoryStorage();
  const d = deps(storage);
  const realPark = d.park;
  let lose = 1;
  d.park = async (body) => {
    const parked = await realPark(body);
    if (lose-- > 0) throw NETWORK();
    return parked;
  };
  await assert.rejects(parkCart(d, input(), META));
  const pending = readPendingPark(storage, SCOPE);
  assert.deepEqual(pending?.meta, META);
  assert.equal(pending?.lines.length, LINES.length);
  // Another cart meanwhile: refused with the park message, nothing sent.
  await assert.rejects(
    parkCart(d, input({ lines: [] }), META),
    (error: unknown) =>
      error instanceof ApiError && error.code === PARK_INTENT_PENDING,
  );
  await parkCart(d, input({ lines: pending!.lines }), pending!.meta);
  assert.equal(state.parked.size, 1, "one parked cart, one key");
  assert.equal(readPendingPark(storage, SCOPE), null);
});

test("a park or resume the server refused for the key can be closed by the cashier", async () => {
  const { deps } = fakeServer();
  const storage = new MemoryStorage();
  const d = deps(storage);
  d.park = async () => {
    throw new ApiError(403, "FORBIDDEN", "no");
  };
  await assert.rejects(parkCart(d, input(), META));
  assert.notEqual(readPendingPark(storage, SCOPE), null, "403 keeps the key");
  closeParkIntent(storage, SCOPE);
  assert.equal(readPendingPark(storage, SCOPE), null);

  d.resume = async () => {
    throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "x");
  };
  await assert.rejects(
    resumeParkedInto(
      d,
      "p9",
      async () => 1,
      () => {},
    ),
  );
  assert.deepEqual(pendingResumeIds(storage, SCOPE), ["p9"]);
  closeResumeIntent(storage, SCOPE, "p9");
  assert.deepEqual(pendingResumeIds(storage, SCOPE), []);
});

test("the actor is the staff the tab's token was issued to", () => {
  const data = new Map<string, string>();
  const store = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
  vi.stubGlobal("window", { localStorage: store, sessionStorage: store });
  try {
    clearActingStaffToken();
    assert.equal(readActingStaffUserId(), null);
    writeActingStaffToken({
      token: "t",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      staffUserId: "staff-1",
    });
    assert.equal(readActingStaffUserId(), "staff-1");
    writeActingStaffToken({
      token: "t",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      staffUserId: "staff-1",
    });
    assert.equal(
      readActingStaffUserId(),
      null,
      "an expired token names no actor",
    );
  } finally {
    clearActingStaffToken();
    vi.unstubAllGlobals();
  }
});
test("a refused key and a 403 are closed only by the cashier", () => {
  assert.equal(
    needsCashierClose(new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "x")),
    true,
  );
  assert.equal(needsCashierClose(new ApiError(403, "FORBIDDEN", "x")), true);
  assert.equal(needsCashierClose(new ApiError(500, "X", "x")), false);
  assert.equal(needsCashierClose(new ApiError(422, "X", "x")), false);
  assert.equal(needsCashierClose(new Error("x")), false);
});

test("a replay keeps every refusal: each parked cart has its own close action", async () => {
  const outcome = await replayAll(["a", "b", "c", "d"], async (id) => {
    if (id === "a") throw new ApiError(403, "FORBIDDEN", "x");
    if (id === "b") return "ok";
    if (id === "c") throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "x");
    throw new ApiError(500, "X", "x");
  });
  assert.deepEqual(outcome.results, ["ok"]);
  assert.deepEqual(
    outcome.failures.filter((f) => needsCashierClose(f.error)).map((f) => f.id),
    ["a", "c"],
  );
});
