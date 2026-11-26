// Brief 1268 W5: the open orders list and the fire from the order detail. The
// list asks only for open statuses, shows the server's money as is, and a
// parked cart has no price. Fire sends only held, live lines, keyed, and a
// lost reply repeats the same bytes.
import assert from "node:assert/strict";
import type { PosOrderSummary, PosParkedOrder } from "@starter/shared/pos";
import { listPosOrders } from "@starter/shared/pos";
import { createEndpointCaller } from "@/lib/api/endpoint-core";
import { fireItems } from "@/features/ws04-pos-order/captain-flow";
import type { AreaAccess } from "@/lib/areas/access";
import {
  canFire,
  heldItemIds,
  orderActionRights,
  primaryActionOf,
} from "@/features/ws04-pos-order-detail/fire";
import { openOrdersGate } from "@/features/ws04-pos-open-orders/guard";
import {
  OLD_LINK_FRESH_MS,
  OPEN_ORDER_STATUSES,
  listAgeMs,
  minutesAgo,
  oldLinkRemainingIdr,
  ordersWithHeldItems,
  toOpenOrderRows,
  toParkedRows,
} from "@/features/ws04-pos-open-orders/open-orders-logic";

const summary = (over: Partial<PosOrderSummary>): PosOrderSummary =>
  ({
    id: "01JBQ9E0000000000000000001",
    tenantId: "t",
    outletId: "o",
    number: "1042",
    channel: "pos",
    serviceType: "dine_in",
    tableSessionId: null,
    status: "sent",
    shiftId: null,
    totalIdr: 192_900,
    remainingIdr: 192_900,
    tableLabel: "Meja 7",
    itemCount: 4,
    heldItemCount: 2,
    createdAt: "2026-11-26T07:05:00.000Z",
    ...over,
  }) as PosOrderSummary;

class MemoryStorage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
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

test("the tab asks for open statuses only, never completed or voided", () => {
  assert.deepEqual(
    [...OPEN_ORDER_STATUSES],
    ["draft", "awaiting_payment", "sent"],
  );
});

test("rows keep the server's money and leave final orders out", () => {
  const rows = toOpenOrderRows([
    summary({}),
    summary({ id: "b", status: "completed", remainingIdr: 0 }),
    summary({ id: "c", remainingIdr: 50_000, heldItemCount: 0 }),
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.totalIdr, 192_900);
  assert.equal(rows[0]?.partlyPaid, false);
  assert.equal(rows[1]?.remainingIdr, 50_000);
  assert.equal(rows[1]?.partlyPaid, true);
  assert.equal(ordersWithHeldItems(rows), 1);
});

test("a parked cart row has no price field at all", () => {
  const parked = {
    id: "p1",
    label: "Meja 5",
    channel: "pos",
    serviceType: "dine_in",
    items: [
      { menuItemId: "m1", modifierIds: [], quantity: 2 },
      { menuItemId: "m2", modifierIds: [], quantity: 1 },
    ],
    parkedAt: "2026-11-26T07:24:00.000Z",
  } as unknown as PosParkedOrder;
  const [row] = toParkedRows([parked]);
  assert.equal(row?.itemCount, 2);
  assert.deepEqual(Object.keys(row ?? {}).sort(), [
    "id",
    "itemCount",
    "label",
    "parkedAt",
    "serviceType",
  ]);
});

test("time since opening reads in minutes, then hours", () => {
  const now = new Date("2026-11-26T07:32:00.000Z");
  assert.deepEqual(minutesAgo("2026-11-26T07:28:00.000Z", now), {
    unit: "minute",
    count: 4,
  });
  assert.deepEqual(minutesAgo("2026-11-26T06:20:00.000Z", now), {
    unit: "hour",
    count: 1,
  });
  assert.equal(minutesAgo("2026-11-26T07:40:00.000Z", now), null);
});

test("an old paid link lowers the list's remaining: the detail shows it", () => {
  assert.equal(oldLinkRemainingIdr(192_900, { remainingIdr: 0 }, 1_000), 0);
  assert.equal(
    oldLinkRemainingIdr(192_900, { remainingIdr: 192_900 }, 1_000),
    null,
  );
  assert.equal(oldLinkRemainingIdr(192_900, undefined, 1_000), null);
});

test("the paid-link warning needs a list read under 20 seconds ago", () => {
  assert.equal(oldLinkRemainingIdr(192_900, { remainingIdr: 0 }, 19_999), 0);
  assert.equal(
    oldLinkRemainingIdr(192_900, { remainingIdr: 0 }, OLD_LINK_FRESH_MS),
    null,
  );
  // No list read yet (age unknown) hides it too.
  assert.equal(oldLinkRemainingIdr(192_900, { remainingIdr: 0 }, -1), null);
});

const access = (permissions: string[]): AreaAccess =>
  ({
    authenticated: true,
    permissions,
    mfaRequired: false,
    mfaVerified: false,
  }) as unknown as AreaAccess;

test("a waiter is sent to the captain screen, not to an empty not-found", () => {
  assert.equal(
    openOrdersGate(access(["order.view", "order.create"])),
    "captain",
  );
  assert.equal(openOrdersGate(access(["pos.sale.create"])), "allowed");
  assert.equal(openOrdersGate(access(["pos.payment.accept"])), "allowed");
  assert.equal(openOrdersGate(access(["order.view"])), "hidden");
  assert.equal(
    openOrdersGate({ ...access([]), authenticated: false }),
    "hidden",
  );
});

test("fire and payment buttons follow the API's permissions", () => {
  assert.deepEqual(orderActionRights(access(["pos.payment.accept"])), {
    fire: false,
    pay: true,
    cashier: false,
  });
  assert.deepEqual(orderActionRights(access(["pos.void.request"])), {
    fire: false,
    pay: false,
    cashier: false,
  });
  assert.deepEqual(orderActionRights(access(["order.create"])), {
    fire: true,
    pay: false,
    cashier: false,
  });
  assert.deepEqual(orderActionRights(access(["pos.sale.create"])), {
    fire: true,
    pay: false,
    cashier: true,
  });
  const base = { unclear: false, fireable: false, status: "sent" as const };
  assert.equal(
    primaryActionOf({ ...base, rights: { pay: false, cashier: true } }),
    null,
  );
  assert.equal(
    primaryActionOf({ ...base, rights: { pay: true, cashier: false } }),
    "pay",
  );
  assert.equal(
    primaryActionOf({
      ...base,
      fireable: true,
      rights: { pay: true, cashier: true },
    }),
    "fire",
  );
});

test("a draft order offers the cashier, never payment", () => {
  const draft = { unclear: false, fireable: false, status: "draft" as const };
  assert.equal(
    primaryActionOf({ ...draft, rights: { pay: true, cashier: true } }),
    "cashier",
  );
  assert.equal(
    primaryActionOf({ ...draft, rights: { pay: true, cashier: false } }),
    null,
  );
});

test("fire takes only held, live lines of an order on the shift", () => {
  const items = [
    { id: "a", status: "active", fireStatus: "held" as const },
    { id: "b", status: "active", fireStatus: "fired" as const },
    { id: "c", status: "voided", fireStatus: "held" as const },
  ];
  assert.deepEqual(heldItemIds(items), ["a"]);
  assert.equal(canFire("sent", 1), true);
  assert.equal(canFire("awaiting_payment", 1), true);
  assert.equal(canFire("draft", 1), false);
  assert.equal(canFire("completed", 1), false);
  assert.equal(canFire("sent", 0), false);
});

test("a lost fire reply repeats the same key and body: one fire", async () => {
  const storage = new MemoryStorage();
  const bodies: string[] = [];
  let calls = 0;
  const deps = {
    storage,
    makeKey: () => globalThis.crypto.randomUUID(),
    scope: { outletId: "o", actorId: "u" },
    fire: async (_orderId: string, body: unknown) => {
      calls += 1;
      bodies.push(JSON.stringify(body));
      if (calls === 1) throw new TypeError("network");
      return { ok: true };
    },
  };
  await assert.rejects(fireItems(deps, "order-1", ["b", "a"], "sent"));
  // The order moved on (paid) before the retry: the stored status still wins.
  await fireItems(deps, "order-1", ["a", "b"], "awaiting_payment");
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
});

test("the status filter goes out as the comma list the API parses", async () => {
  let sent: unknown;
  const call = createEndpointCaller(
    async (_path, request) => {
      sent = request.query;
      return {
        data: [],
        meta: { limit: 100, nextCursor: null, totalCount: null },
      };
    },
    { validateResponse: () => false },
  );
  await call(listPosOrders, {
    params: { outletId: "0e0e0001-0000-4000-8000-000000000001" },
    query: { status: OPEN_ORDER_STATUSES.join(","), limit: 100 } as never,
  } as never);
  assert.deepEqual(sent, { status: "draft,awaiting_payment,sent", limit: 100 });
});

test("the list age never goes negative after a refetch lands past `now`", () => {
  assert.equal(listAgeMs(10_000, 4_000), 6_000);
  assert.equal(listAgeMs(10_000, 12_500), 0);
  assert.equal(listAgeMs(10_000, 0), -1);
  assert.equal(
    oldLinkRemainingIdr(
      192_900,
      { remainingIdr: 0 },
      listAgeMs(10_000, 12_500),
    ),
    0,
  );
});
