// legend-dysef G5: parked carts are recoverable raw snapshots. They must not
// become payable orders, reserve kitchen stock, spend DP, or take a call number.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { originHeader } from "./helpers.ts";
import { owner, staffOfIsolatedTenant } from "./floor-test-helpers.ts";
import {
  cashierFixture,
  type CashierFixture,
} from "./pos-cashier-test-helpers.ts";

let fixture: CashierFixture;
let other: CashierFixture;
let otherOutletId: string;

beforeAll(async () => {
  fixture = await cashierFixture("parked-carts");
  other = await cashierFixture("parked-other");
  otherOutletId = randomUUID();
  await owner.query(
    `INSERT INTO outlets
       (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet Parkir Lain',
            address, timezone, opening_hours, status
     FROM outlets WHERE id = $3`,
    [
      otherOutletId,
      `PARK-${randomUUID().slice(0, 6)}`.toUpperCase(),
      fixture.tenant.outletId,
    ],
  );
});
afterAll(async () => {
  await owner.end();
});

const base = () => `/api/outlets/${fixture.tenant.outletId}/pos/parked-orders`;
const body = (overrides: Record<string, unknown> = {}) => ({
  channel: "pos",
  serviceType: "takeaway",
  items: [fixture.line({ note: "Tanpa sambal", course: "main", hold: true })],
  idempotencyKey: randomUUID(),
  ...overrides,
});

async function sideEffects() {
  const { rows } = await owner.query<Record<string, number>>(
    `SELECT
       (SELECT count(*)::int FROM orders WHERE tenant_id = $1) AS orders,
       (SELECT count(*)::int FROM pos_order_tenders WHERE tenant_id = $1) AS tenders,
       (SELECT count(*)::int FROM pickup_calls WHERE tenant_id = $1) AS calls,
       (SELECT count(*)::int FROM stock_ledger WHERE tenant_id = $1) AS stock,
       (SELECT coalesce(sum(deposit_applied_idr), 0)::int FROM orders WHERE tenant_id = $1) AS deposit`,
    [fixture.tenant.tenantId],
  );
  return rows[0];
}

describe("legend-dysef parked POS carts", () => {
  it("G5 parks sold-out and incomplete modifier selections without order, stock, DP or call effects", async () => {
    const guest = await fixture.newGuest();
    const before = await sideEffects();
    const input = body({
      channel: "captain",
      serviceType: "dine_in",
      tableSessionId: guest.sessionId,
      items: [
        fixture.line({
          menuItemId: fixture.ids.coffee,
          modifierIds: [],
          note: "Pilih ukuran nanti",
          course: "drink",
          hold: false,
        }),
        fixture.line({
          menuItemId: fixture.ids.soldOut,
          quantity: 2,
          hold: true,
        }),
      ],
    });
    const parked = await fixture.post(base(), input);
    expect(parked.status, JSON.stringify(parked.body)).toBe(201);
    expect(parked.body.data).toMatchObject({
      channel: "captain",
      serviceType: "dine_in",
      tableSessionId: guest.sessionId,
      items: input.items,
    });
    expect(typeof parked.body.data.id).toBe("string");
    expect(typeof parked.body.data.label).toBe("string");
    expect(Number.isNaN(Date.parse(parked.body.data.parkedAt))).toBe(false);
    expect(parked.body.data).not.toHaveProperty("totalIdr");
    expect(parked.body.data).not.toHaveProperty("orderId");
    expect(await sideEffects()).toEqual(before);
    const listed = await fixture.get(base());
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: parked.body.data.id,
          items: input.items,
        }),
      ]),
    );
  });

  it("G5 replays the original park intent once and preserves its raw values", async () => {
    const input = body({ externalRef: "PARK-REFERENSI" });
    const first = await fixture.post(base(), input);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const replay = await fixture.post(base(), input);
    expect([200, 201]).toContain(replay.status);
    expect(replay.body.data).toEqual(first.body.data);
    const list = await fixture.get(base());
    expect(list.status).toBe(200);
    expect(
      list.body.data.filter(
        (row: { id: string }) => row.id === first.body.data.id,
      ),
    ).toHaveLength(1);
  });

  it("G5 rejects a changed snapshot under the same create key without overwriting the original", async () => {
    const input = body();
    const created = await fixture.post(base(), input);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const before = await sideEffects();
    const changed = await fixture.post(base(), {
      ...input,
      items: [
        fixture.line({ quantity: 2, note: "Pesanan berubah", hold: false }),
      ],
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(409);
    const original = await fixture.get(`${base()}/${created.body.data.id}`);
    expect(original.status, JSON.stringify(original.body)).toBe(200);
    expect(original.body.data).toEqual(created.body.data);
    const list = await fixture.get(base());
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(
      list.body.data.filter(
        (row: { id: string }) => row.id === created.body.data.id,
      ),
    ).toHaveLength(1);
    expect(await sideEffects()).toEqual(before);
  });

  it("G5 hides direct snapshot reads from another cashier, outlet or tenant", async () => {
    const created = await fixture.post(base(), body());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.data.id as string;
    const own = await fixture.get(`${base()}/${id}`);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.data).toEqual(created.body.data);
    const peer = await staffOfIsolatedTenant(fixture.app, fixture.tenant);
    const hiddenReads = [
      await peer.client.get(`${base()}/${id}`).set(fixture.headers),
      await fixture.get(
        `/api/outlets/${otherOutletId}/pos/parked-orders/${id}`,
      ),
      await other.get(
        `/api/outlets/${other.tenant.outletId}/pos/parked-orders/${id}`,
      ),
    ];
    for (const hidden of hiddenReads) {
      expect(hidden.status, JSON.stringify(hidden.body)).toBe(404);
      expect(hidden.body).not.toHaveProperty("data");
      expect(JSON.stringify(hidden.body)).not.toContain(id);
    }
  });

  it("G5 replays a consumed create intent without reactivating its resumed snapshot", async () => {
    const cashier = await staffOfIsolatedTenant(fixture.app, fixture.tenant);
    const post = (path: string, input: Record<string, unknown>) =>
      cashier.client
        .post(path)
        .set(fixture.headers)
        .set(originHeader)
        .send(input);
    const get = (path: string) => cashier.client.get(path).set(fixture.headers);
    const input = body();
    const before = await sideEffects();
    const created = await post(base(), input);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const path = `${base()}/${created.body.data.id}`;
    const resumed = await post(`${path}/resume`, {
      idempotencyKey: randomUUID(),
    });
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    expect(resumed.body.data).toEqual(created.body.data);
    const replay = await post(base(), input);
    expect([200, 201], JSON.stringify(replay.body)).toContain(replay.status);
    expect(replay.body.data).toEqual(created.body.data);
    const listed = await get(base());
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.data).toEqual([]);
    expect((await get(path)).status).toBe(404);
    const again = await post(`${path}/resume`, {
      idempotencyKey: randomUUID(),
    });
    expect(again.status, JSON.stringify(again.body)).toBe(404);
    expect(await sideEffects()).toEqual(before);
  });

  it("G5 lists and resumes only the cashier's own outlet snapshots", async () => {
    const created = await fixture.post(base(), body());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const peer = await staffOfIsolatedTenant(fixture.app, fixture.tenant);
    const peerList = await peer.client.get(base()).set(fixture.headers);
    expect(peerList.status, JSON.stringify(peerList.body)).toBe(200);
    expect(
      peerList.body.data.some(
        (row: { id: string }) => row.id === created.body.data.id,
      ),
    ).toBe(false);
    const peerResume = await peer.client
      .post(`${base()}/${created.body.data.id}/resume`)
      .set(fixture.headers)
      .set(originHeader)
      .send({ idempotencyKey: randomUUID() });
    expect(peerResume.status).toBe(404);
    const wrongOutlet = `/api/outlets/${otherOutletId}/pos/parked-orders`;
    const outletList = await fixture.get(wrongOutlet);
    expect(outletList.status).toBe(200);
    expect(
      outletList.body.data.some(
        (row: { id: string }) => row.id === created.body.data.id,
      ),
    ).toBe(false);
    const outletResume = await fixture.post(
      `${wrongOutlet}/${created.body.data.id}/resume`,
      { idempotencyKey: randomUUID() },
    );
    expect(outletResume.status).toBe(404);
    const foreignResume = await other.post(
      `${base()}/${created.body.data.id}/resume`,
      { idempotencyKey: randomUUID() },
    );
    expect([403, 404]).toContain(foreignResume.status);
    const own = await fixture.get(base());
    expect(
      own.body.data.some(
        (row: { id: string }) => row.id === created.body.data.id,
      ),
    ).toBe(true);
  });

  it("G5 consumes a resume atomically once and returns a snapshot without creating an order", async () => {
    const created = await fixture.post(base(), body());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const before = await sideEffects();
    const path = `${base()}/${created.body.data.id}/resume`;
    const responses = await Promise.all([
      fixture.post(path, { idempotencyKey: randomUUID() }),
      fixture.post(path, { idempotencyKey: randomUUID() }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 404,
    ]);
    const resumed = responses.find((response) => response.status === 200)!;
    expect(resumed.body.data).toEqual(created.body.data);
    expect(await sideEffects()).toEqual(before);
    const listed = await fixture.get(base());
    expect(
      listed.body.data.some(
        (row: { id: string }) => row.id === created.body.data.id,
      ),
    ).toBe(false);
    const again = await fixture.post(path, { idempotencyKey: randomUUID() });
    expect(again.status).toBe(404);
  });

  it("G5 resumed raw carts revalidate availability and required modifiers at order creation", async () => {
    for (const line of [
      fixture.line({ menuItemId: fixture.ids.soldOut }),
      fixture.line({ menuItemId: fixture.ids.coffee, modifierIds: [] }),
    ]) {
      const parked = await fixture.post(base(), body({ items: [line] }));
      expect(parked.status, JSON.stringify(parked.body)).toBe(201);
      const resumed = await fixture.post(
        `${base()}/${parked.body.data.id}/resume`,
        { idempotencyKey: randomUUID() },
      );
      expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
      const before = await sideEffects();
      const order = await fixture.create({ items: resumed.body.data.items });
      expect(await sideEffects()).toEqual(before);
      expect([409, 422], JSON.stringify(order.body)).toContain(order.status);
    }
  });

  it("G5 uses the current server price after a resumed cart is submitted", async () => {
    const parked = await fixture.post(base(), body());
    expect(parked.status, JSON.stringify(parked.body)).toBe(201);
    const resumed = await fixture.post(
      `${base()}/${parked.body.data.id}/resume`,
      { idempotencyKey: randomUUID() },
    );
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    await owner.query(
      `UPDATE price_list_items SET price_idr = 37000
       WHERE tenant_id = $1 AND item_id = $2`,
      [fixture.tenant.tenantId, fixture.ids.meal],
    );
    const order = await fixture.create({ items: resumed.body.data.items });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    expect(order.body.data.subtotalIdr).toBe(37_000);
    expect(order.body.data.items[0].note).toBe("Tanpa sambal");
  });

  it.each(["price", "total", "owner", "outlet"])(
    "G5 rejects client-supplied %s fields instead of storing an authoritative value",
    async (label) => {
      const fields: Record<string, Record<string, unknown>> = {
        price: { items: [{ ...fixture.line(), unitPriceIdr: 1 }] },
        total: { totalIdr: 1 },
        owner: { userId: randomUUID() },
        outlet: { outletId: fixture.tenant.outletId },
      };
      const overrides = fields[label]!;
      const rejected = await fixture.post(base(), body(overrides));
      expect(rejected.status, JSON.stringify(rejected.body)).toBe(422);
    },
  );
});
