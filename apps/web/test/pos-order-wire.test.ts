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
  resumeParked,
  ORDER_INTENT_PENDING,
  type FlowDeps,
} from "@/features/ws04-pos-order/order-flow";
import { peekIntent } from "@/features/ws04-pos-order/intent-store";
import { createBodyOf, mapParked } from "@/features/ws04-pos-order/order-wire";
import type {
  CartLine,
  Catalog,
  MenuItem,
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

test("park and resume are keyed and repeat their key", async () => {
  const { state, deps } = fakeServer();
  const storage = new MemoryStorage();
  const parkedA = await parkCart(deps(storage), input());
  const parkedB = await parkCart(deps(storage), input());
  assert.notEqual(parkedA.id, "");
  assert.equal(parkedB.id.startsWith("parked-"), true);
  assert.equal(state.parked.size, 2, "a finished park forgets its key");
  await resumeParked(deps(storage), "parked-1");
  assert.equal(state.resumed.size, 1);
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
