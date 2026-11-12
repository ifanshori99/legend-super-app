// legend-dysef G2: a next-call preview reserves nothing. The saved order's
// server-assigned call number remains authoritative, including across retries.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { businessDateOf, createUlid, ulidToUuid } from "@starter/shared/core";
import { createPosOrder, getPosOrder } from "@starter/shared/pos";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { signDeviceToken } from "../lib/device-token.ts";
import { registerTestDevice } from "./device-seed.ts";
import { owner } from "./floor-test-helpers.ts";
import {
  asCashierTenant,
  cashierFixture,
  type CashierFixture,
} from "./pos-cashier-test-helpers.ts";

let fixture: CashierFixture;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  fixture = await cashierFixture("next-call");
});

afterAll(async () => {
  await owner.end();
});

const ordersPath = (outletId: string) => `/api/outlets/${outletId}/pos/orders`;
const preview = (outletId: string) =>
  fixture.get(`/api/outlets/${outletId}/pos/next-call-number`);
const create = (outletId: string, body: Record<string, unknown> = {}) =>
  fixture.post(ordersPath(outletId), {
    channel: "pos",
    serviceType: "takeaway",
    items: [fixture.line()],
    idempotencyKey: randomUUID(),
    ...body,
  });

async function newOutlet(): Promise<string> {
  const outletId = randomUUID();
  await asCashierTenant(fixture.tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO outlets
         (id, tenant_id, brand_id, legal_entity_id, code, name, address,
          timezone, business_day_cutoff, opening_hours, status)
       SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Panggilan Uji',
              address, timezone, business_day_cutoff, opening_hours, 'active'
       FROM outlets WHERE tenant_id = $3 AND id = $4`,
      [
        outletId,
        `NEXT-${randomUUID().slice(0, 8)}`.toUpperCase(),
        fixture.tenant.tenantId,
        fixture.tenant.outletId,
      ],
    );
    for (const channel of ["takeaway", "dine_in"]) {
      const priceListId = randomUUID();
      await client.query(
        `INSERT INTO price_lists
           (id, tenant_id, outlet_id, channel, effective_from)
         VALUES ($1, $2, $3, $4, '2026-01-01')`,
        [priceListId, fixture.tenant.tenantId, outletId, channel],
      );
      await client.query(
        `INSERT INTO price_list_items
           (id, tenant_id, price_list_id, item_id, price_idr)
         VALUES ($1, $2, $3, $4, 30000)`,
        [randomUUID(), fixture.tenant.tenantId, priceListId, fixture.ids.meal],
      );
    }
  });
  return outletId;
}

async function todayAt(outletId: string): Promise<string> {
  const { rows } = await asCashierTenant(fixture.tenant.tenantId, (client) =>
    client.query<{ timezone: string; cutoff: string }>(
      `SELECT timezone, business_day_cutoff AS cutoff FROM outlets
       WHERE tenant_id = $1 AND id = $2`,
      [fixture.tenant.tenantId, outletId],
    ),
  );
  const outlet = rows[0]!;
  return businessDateOf(new Date(), {
    timeZone: outlet.timezone,
    cutoff: outlet.cutoff,
  });
}

async function writeCounts(outletId: string) {
  const { rows } = await asCashierTenant(fixture.tenant.tenantId, (client) =>
    client.query<{ orders: number; calls: number }>(
      `SELECT
         (SELECT count(*)::int FROM orders
          WHERE tenant_id = $1 AND outlet_id = $2) AS orders,
         (SELECT count(*)::int FROM pickup_calls
          WHERE tenant_id = $1 AND outlet_id = $2) AS calls`,
      [fixture.tenant.tenantId, outletId],
    ),
  );
  return rows[0]!;
}

async function seedCollectedCall(
  outletId: string,
  number: number,
  businessDate: string,
) {
  const orderId = createUlid();
  await asCashierTenant(fixture.tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO orders
         (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
          subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr,
          total_idr, status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'gofood', 'delivery', 'pay_first',
               30000, 0, 0, 0, 0, 30000, 'sent', $5, now())`,
      [
        ulidToUuid(orderId),
        fixture.tenant.tenantId,
        outletId,
        `NEXT-${orderId.slice(-20)}`,
        businessDate,
      ],
    );
    await client.query(
      `INSERT INTO pickup_calls
         (id, tenant_id, outlet_id, order_id, channel, number, business_date,
          status, called_at, picked_up_at)
       VALUES ($1, $2, $3, $4, 'gofood', $5, $6, 'picked_up', now(), now())`,
      [
        randomUUID(),
        fixture.tenant.tenantId,
        outletId,
        ulidToUuid(orderId),
        number,
        businessDate,
      ],
    );
  });
}

describe("legend-dysef G2 next takeaway call number", () => {
  it("G2-01 repeated previews reserve no order or call before a real create", async () => {
    const outletId = await newOutlet();
    const before = await writeCounts(outletId);
    for (let read = 0; read < 2; read++) {
      const response = await preview(outletId);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.data).toMatchObject({
        number: 1,
        code: "A-001",
        businessDate: await todayAt(outletId),
      });
    }
    expect(await writeCounts(outletId)).toEqual(before);
    const created = await create(outletId);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.callNumber).toBe("A-001");
    expect(await writeCounts(outletId)).toEqual({ orders: 1, calls: 1 });
    const next = await preview(outletId);
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expect(next.body.data).toMatchObject({ number: 2, code: "A-002" });
  });

  it("G2-02 create, detail and idempotent retries expose the same assigned call", async () => {
    const outletId = await newOutlet();
    const body = { idempotencyKey: randomUUID() };
    const created = await create(outletId, body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(createPosOrder.response.parse(created.body).data).toMatchObject({
      callNumber: "A-001",
    });
    const orderId = created.body.data.id as string;
    const detail = await fixture.get(`${ordersPath(outletId)}/${orderId}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(getPosOrder.response.parse(detail.body).data).toMatchObject({
      id: orderId,
      callNumber: "A-001",
    });
    const replay = await create(outletId, body);
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(replay.body.data).toMatchObject({
      id: orderId,
      callNumber: "A-001",
    });
    expect(await writeCounts(outletId)).toEqual({ orders: 1, calls: 1 });
  });

  it("G2-03 a versioned legacy replay missing callNumber reads the existing call without reallocating", async () => {
    const outletId = await newOutlet();
    const body = { idempotencyKey: randomUUID() };
    const created = await create(outletId, body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const orderId = created.body.data.id as string;
    await asCashierTenant(fixture.tenant.tenantId, (client) =>
      client.query(
        `UPDATE pos_order_idempotency SET response = response - 'callNumber'
         WHERE tenant_id = $1 AND outlet_id = $2 AND key = $3`,
        [fixture.tenant.tenantId, outletId, body.idempotencyKey],
      ),
    );
    const replay = await create(outletId, body);
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(replay.body.data).toMatchObject({
      id: orderId,
      callNumber: "A-001",
    });
    expect(replay.headers.etag).toBe(`"${replay.body.data.version}"`);
    expect(await writeCounts(outletId)).toEqual({ orders: 1, calls: 1 });
  });

  it("G2-04 preview keeps collected numbers, rolls A-999 to B-001 and scopes the sequence by outlet/day", async () => {
    const outletId = await newOutlet();
    const otherOutlet = await newOutlet();
    const today = await todayAt(outletId);
    const yesterday = new Date(`${today}T12:00:00Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    await seedCollectedCall(outletId, 999, today);
    await seedCollectedCall(
      outletId,
      26_000,
      yesterday.toISOString().slice(0, 10),
    );
    const response = await preview(outletId);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toMatchObject({
      number: 1000,
      code: "B-001",
      businessDate: today,
    });
    const created = await create(outletId);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.callNumber).toBe("B-001");
    const untouched = await preview(otherOutlet);
    expect(untouched.status, JSON.stringify(untouched.body)).toBe(200);
    expect(untouched.body.data).toMatchObject({ number: 1, code: "A-001" });
    expect(await writeCounts(otherOutlet)).toEqual({ orders: 0, calls: 0 });
  });

  it("G2-05 dine-in orders expose no call and leave the takeaway sequence untouched", async () => {
    const outletId = await newOutlet();
    const dineIn = await create(outletId, { serviceType: "dine_in" });
    expect(dineIn.status, JSON.stringify(dineIn.body)).toBe(201);
    expect(dineIn.body.data.callNumber).toBeNull();
    const response = await preview(outletId);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toMatchObject({ number: 1, code: "A-001" });
    expect(await writeCounts(outletId)).toEqual({ orders: 1, calls: 0 });
  });

  it("G2-06 training orders expose no call and cannot consume a real customer's number", async () => {
    const outletId = await newOutlet();
    const deviceId = randomUUID();
    await registerTestDevice(owner, {
      tenantId: fixture.tenant.tenantId,
      outletId,
      deviceId,
    });
    await asCashierTenant(fixture.tenant.tenantId, (client) =>
      client.query(
        "UPDATE devices SET training_mode = true WHERE tenant_id = $1 AND id = $2",
        [fixture.tenant.tenantId, deviceId],
      ),
    );
    const training = await create(outletId).set(
      DEVICE_TOKEN_HEADER,
      signDeviceToken({
        version: 1,
        issuedAt: Math.floor(Date.now() / 1000),
        tenantId: fixture.tenant.tenantId,
        brandId: null,
        deviceId,
      }),
    );
    expect(training.status, JSON.stringify(training.body)).toBe(201);
    expect(training.body.data.callNumber).toBeNull();
    const response = await preview(outletId);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toMatchObject({ number: 1, code: "A-001" });
    expect(await writeCounts(outletId)).toEqual({ orders: 1, calls: 0 });
    const real = await create(outletId);
    expect(real.status, JSON.stringify(real.body)).toBe(201);
    expect(real.body.data.callNumber).toBe("A-001");
  });
});
