// Brief 1268 W5: the open orders list and the fire from the order detail. The
// list asks only for open statuses, shows the server's money as is, and a
// parked cart has no price. Fire sends only held, live lines, keyed, and a
// lost reply repeats the same bytes.
import assert from "node:assert/strict";
import type { PosOrderSummary, PosParkedOrder } from "@starter/shared/pos";
import { fireItems } from "@/features/ws04-pos-order/captain-flow";
import {
  canFire,
  heldItemIds,
} from "@/features/ws04-pos-order-detail/fire";
import {
  OPEN_ORDER_STATUSES,
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
  assert.deepEqual([...OPEN_ORDER_STATUSES], ["draft", "awaiting_payment", "sent"]);
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
  assert.equal(oldLinkRemainingIdr(192_900, { remainingIdr: 0 }), 0);
  assert.equal(oldLinkRemainingIdr(192_900, { remainingIdr: 192_900 }), null);
  assert.equal(oldLinkRemainingIdr(192_900, undefined), null);
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
