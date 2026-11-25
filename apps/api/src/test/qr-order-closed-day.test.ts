// QR order refused after Tutup Hari (bead legend-2o1b; founder decision Q20).
//
// A QR order placed on a business day that is already closed is REFUSED with
// HTTP 409, code BUSINESS_DAY_ALREADY_CLOSED and a guest-friendly Indonesian
// message. The check shares the business-day advisory lock with the end-of-day
// close, so a close that commits while the order is waiting also refuses it.
//
// Every case builds its own isolated tenant (one outlet each), so closing a
// day here never affects another case or another test file.
//
// Assumptions (spec text silent): the place endpoint is the guest checkout
// `POST /api/table-sessions/:id/orders` (201 on success, as in
// qr-order-api.test.ts); the business date of "today" is learned from a probe
// order placed in beforeAll, never computed in the test.

import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createApp } from "../app.ts";
import { env } from "../config/env.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { qrOrderSettlementLookup } from "../services/qr-order.service.ts";
import { setTableSessionSettlementLookup } from "../services/table-session.service.ts";
import { agent, originHeader } from "./helpers.ts";
import {
  seedFacility,
  seedTicketProduct,
} from "./facility-entitlement-helpers.ts";
import { owner as memberOwner } from "./member-loyalty-helpers.ts";
import {
  createIsolatedTenant,
  createTable,
  createZone,
  issueQr,
  owner,
  scan,
  staffOfIsolatedTenant,
  type IsolatedTenant,
  type Staff,
} from "./floor-test-helpers.ts";

/** The guest message fixed by the founder decision (Q20). */
const GUEST_MESSAGE =
  "Outlet sudah tutup untuk hari ini. Pesanan belum bisa dibuat, silakan hubungi staf.";
const ALL_DAY = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
];
const KOPI_IDR = 25_000;
const DAILY_LIMIT = 5;

let app: Express;
let today = "";
const createdTenants: string[] = [];

class FakeGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  async health() {
    return { status: "available" as const };
  }
  async createIntent(input: GatewayIntentRequest) {
    return {
      providerRef: `QRO-${randomBytes(6).toString("hex")}`,
      instructions: {
        method: "qris" as const,
        qrPayload: "00020101021226FAKEQRORDER",
        issuer: null,
      },
      expiresAt: input.expiresAt,
    };
  }
  async getStatus(input: { providerRef: string }) {
    return {
      status: "pending" as const,
      providerRef: input.providerRef,
      amountIdr: null,
    };
  }
  async channels() {
    return [];
  }
}

/** Owner-side writes set the tenant local, because RLS is FORCED. */
async function setTenantLocal(client: Client, tenantId: string) {
  await client.query(
    "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
    [tenantId],
  );
}

async function asOwnerTenant<T>(
  tenantId: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await setTenantLocal(client as unknown as Client, tenantId);
    const result = await run(client as unknown as Client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type World = {
  tenant: IsolatedTenant;
  staff: Staff;
  menuItemId: string;
  qrToken: string;
};

/** A fresh tenant with one outlet, a priced stock-limited item and one table. */
async function newWorld(): Promise<World> {
  const tenant = await createIsolatedTenant(`qrc-${randomUUID().slice(0, 6)}`);
  createdTenants.push(tenant.tenantId);
  const staff = await staffOfIsolatedTenant(app, tenant);
  const headers = { Host: tenant.hostname };
  const categoryId = randomUUID();
  const menuItemId = randomUUID();
  const priceListId = randomUUID();
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'QR Tutup Hari', 0)`,
      [categoryId, tenant.tenantId, tenant.brandId],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [menuItemId, tenant.tenantId, tenant.brandId, categoryId, randomUUID()],
    );
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'dine_in', '2026-01-01')`,
      [priceListId, tenant.tenantId, tenant.outletId],
    );
    await client.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), tenant.tenantId, priceListId, menuItemId, KOPI_IDR],
    );
    await client.query(
      `INSERT INTO item_availability (id, tenant_id, outlet_id, menu_item_id, schedule, daily_limit, status)
       VALUES ($1, $2, $3, $4, '[]', $5, 'available')`,
      [randomUUID(), tenant.tenantId, tenant.outletId, menuItemId, DAILY_LIMIT],
    );
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, staff.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-QRC', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, staff.userId],
    );
  });
  const zone = await createZone(
    staff.client,
    { paymentMode: "pay_first", serviceChargeBp: 500, hours: ALL_DAY },
    headers,
  );
  const table = await createTable(staff.client, { zoneId: zone.id }, headers);
  const qr = await issueQr(staff.client, table.id, headers);
  return { tenant, staff, menuItemId, qrToken: qr.token };
}

type Guest = { token: string; sessionId: string; world: World };

async function seat(world: World): Promise<Guest> {
  const response = await scan(app, {
    token: world.qrToken,
    hostname: world.tenant.hostname,
  });
  expect(response.status).toBe(201);
  return {
    token: response.body.data.sessionToken,
    sessionId: response.body.data.session.id,
    world,
  };
}

function as(guest: Guest) {
  const client = agent(app);
  const base = `/api/table-sessions/${guest.sessionId}`;
  const auth = (test: ReturnType<typeof client.get>) =>
    test
      .set("Host", guest.world.tenant.hostname)
      .set("Authorization", `Bearer ${guest.token}`)
      .set(originHeader);
  return {
    view: () => auth(client.get(base)),
    add: (body: Record<string, unknown>) =>
      auth(client.post(`${base}/cart/lines`)).send({
        idempotencyKey: randomUUID(),
        modifierIds: [],
        ...body,
      }),
    checkout: (body: Record<string, unknown>) =>
      auth(client.post(`${base}/orders`)).send(body),
  };
}

/** A guest with a Kopi x2 cart; returns the cart version to place with. */
async function guestWithCart(world: World) {
  const guest = await seat(world);
  const added = await as(guest).add({
    menuItemId: world.menuItemId,
    quantity: 2,
    expectedCartVersion: 0,
  });
  expect(added.status).toBe(201);
  return { guest, version: added.body.data.cart.version as number };
}

async function orderCount(guest: Guest): Promise<number> {
  const { rows } = await owner.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM orders WHERE tenant_id = $1 AND table_session_id = $2",
    [guest.world.tenant.tenantId, guest.sessionId],
  );
  return Number(rows[0]?.count ?? 0);
}

async function usageOf(world: World): Promise<number> {
  const { rows } = await owner.query<{ quantity: string }>(
    `SELECT coalesce(sum(quantity), 0)::text AS quantity
     FROM menu_item_daily_usage WHERE tenant_id = $1 AND menu_item_id = $2`,
    [world.tenant.tenantId, world.menuItemId],
  );
  return Number(rows[0]?.quantity ?? 0);
}

function insertDayCloseOn(client: Client, world: World) {
  return client.query(
    `INSERT INTO pos_daily_closes
       (tenant_id, outlet_id, business_date, order_count, total_sales_idr,
        total_refunds_idr, total_voids_idr, total_variance_idr,
        inventory_deduction_applied, recap, closed_by, closed_at,
        idempotency_key, request_fingerprint)
     VALUES ($1, $2, $3, 0, 0, 0, 0, 0, false, '{}', $4, now(), $5, $6)`,
    [
      world.tenant.tenantId,
      world.tenant.outletId,
      today,
      world.staff.userId,
      randomUUID(),
      "0".repeat(64),
    ],
  );
}

/** Polls pg_locks until a backend waits, not granted, on the outlet's day lock. */
async function waitForDayLockWaiter(
  world: World,
  hasSettled: () => boolean,
): Promise<void> {
  const key = `pos-day:${world.tenant.tenantId}:${world.tenant.outletId}:${today}`;
  for (let attempt = 0; attempt < 400; attempt++) {
    const { rows } = await owner.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_locks
       WHERE locktype = 'advisory' AND NOT granted
         AND classid::bigint = ((hashtext($1)::bigint >> 32) & 4294967295)
         AND objid::bigint = (hashtext($1)::bigint & 4294967295)`,
      [key],
    );
    if (Number(rows[0]?.count ?? 0) >= 1) return;
    if (hasSettled())
      throw new Error(
        "Place request finished without waiting on the business-day lock",
      );
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("No request waited on the business-day advisory lock");
}

beforeAll(async () => {
  app = createApp();
  setPaymentGateway(new FakeGateway());
  setTableSessionSettlementLookup(qrOrderSettlementLookup);
  // Probe: learn the business date the order service stamps for "now".
  const { guest, version } = await guestWithCart(await newWorld());
  const probe = await as(guest).checkout({
    expectedCartVersion: version,
    idempotencyKey: randomUUID(),
  });
  expect(probe.status, JSON.stringify(probe.body)).toBe(201);
  const { rows } = await owner.query<{ today: string }>(
    "SELECT business_date::text AS today FROM orders WHERE tenant_id = $1 AND table_session_id = $2",
    [guest.world.tenant.tenantId, guest.sessionId],
  );
  today = rows[0]?.today ?? "";
  expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
}, 120_000);

afterAll(async () => {
  setPaymentGateway(null);
  setTableSessionSettlementLookup(null);
  // Isolated tenants stay in the disposable database (audit rows are
  // append-only); give each a valid creator so tenant lists still parse.
  for (const tenantId of createdTenants)
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      tenantId,
      randomUUID(),
    ]);
  await memberOwner.end();
  await owner.end();
});

describe("QR order after Tutup Hari (legend-2o1b)", () => {
  it("legend-2o1b control: an open business day still accepts the QR order", async () => {
    const { guest, version } = await guestWithCart(await newWorld());
    const usageBefore = await usageOf(guest.world);

    const placed = await as(guest).checkout({
      expectedCartVersion: version,
      idempotencyKey: randomUUID(),
    });
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    expect(await orderCount(guest)).toBe(1);
    expect(await usageOf(guest.world)).toBe(usageBefore + 2);
  });

  it("legend-2o1b a QR order on an already closed business day is refused with the guest message", async () => {
    const { guest, version } = await guestWithCart(await newWorld());
    const usageBefore = await usageOf(guest.world);
    await asOwnerTenant(guest.world.tenant.tenantId, (client) =>
      insertDayCloseOn(client, guest.world),
    );

    const refused = await as(guest).checkout({
      expectedCartVersion: version,
      idempotencyKey: randomUUID(),
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.code).toBe("BUSINESS_DAY_ALREADY_CLOSED");
    expect(refused.body.error.message).toBe(GUEST_MESSAGE);

    // Nothing was ordered or reserved, and the guest keeps the cart.
    expect(await orderCount(guest)).toBe(0);
    expect(await usageOf(guest.world)).toBe(usageBefore);
    const view = await as(guest).view();
    expect(view.status).toBe(200);
    expect(view.body.data.cart.lines).toHaveLength(1);
    expect(view.body.data.cart.lines[0].quantity).toBe(2);
    expect(view.body.data.cart.version).toBe(version);
  });

  it("legend-2o1b a day closed while the order waits on the day lock still refuses the order", async () => {
    const { guest, version } = await guestWithCart(await newWorld());
    const { world } = guest;
    const usageBefore = await usageOf(world);
    const lockKey = `pos-day:${world.tenant.tenantId}:${world.tenant.outletId}:${today}`;

    // The closer holds the exclusive day lock, as closePosDay does.
    const holder = await owner.connect();
    let settled = false;
    try {
      await holder.query("BEGIN");
      await setTenantLocal(holder as unknown as Client, world.tenant.tenantId);
      await holder.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        lockKey,
      ]);

      const placing = as(guest)
        .checkout({
          expectedCartVersion: version,
          idempotencyKey: randomUUID(),
        })
        .then((response) => {
          settled = true;
          return response;
        });

      await waitForDayLockWaiter(world, () => settled);
      // Still waiting: the order is neither accepted nor refused yet.
      expect(settled).toBe(false);

      await insertDayCloseOn(holder as unknown as Client, world);
      await holder.query("COMMIT");

      const refused = await placing;
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.error.code).toBe("BUSINESS_DAY_ALREADY_CLOSED");
      expect(refused.body.error.message).toBe(GUEST_MESSAGE);
    } catch (error) {
      await holder.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      holder.release();
    }

    expect(await orderCount(guest)).toBe(0);
    expect(await usageOf(world)).toBe(usageBefore);
  });
});

describe("1269 F0 a shower menu item is not sold over QR while the shower is off", () => {
  const flag = env as unknown as { FACILITY_SHOWER_ENABLED?: boolean };
  const was = flag.FACILITY_SHOWER_ENABLED;
  afterEach(() => {
    flag.FACILITY_SHOWER_ENABLED = was;
  });
  const linkTo = async (world: World, type: "shower" | "coworking") =>
    seedTicketProduct(world.tenant.tenantId, {
      facilityId: await seedFacility(
        { tenantId: world.tenant.tenantId, outletA: world.tenant.outletId },
        world.tenant.outletId,
        type,
      ),
      outletId: world.tenant.outletId,
      menuItemId: world.menuItemId,
    });

  it("a new cart line and a cart filled earlier are both refused: no order, no stock used", async () => {
    const world = await newWorld();
    await linkTo(world, "shower");
    // The cart was filled before the switch went off.
    const { guest, version } = await guestWithCart(world);
    flag.FACILITY_SHOWER_ENABLED = false;

    const added = await as(guest).add({
      menuItemId: world.menuItemId,
      quantity: 1,
      expectedCartVersion: version,
    });
    expect(added.status, JSON.stringify(added.body)).toBe(409);
    const placed = await as(guest).checkout({
      expectedCartVersion: version,
      idempotencyKey: randomUUID(),
    });
    expect(placed.status, JSON.stringify(placed.body)).toBeGreaterThanOrEqual(
      400,
    );
    expect(placed.status).toBeLessThan(500);
    expect(await orderCount(guest)).toBe(0);
    expect(await usageOf(world)).toBe(0);
  });

  it("a coworking item is still sold", async () => {
    const world = await newWorld();
    await linkTo(world, "coworking");
    flag.FACILITY_SHOWER_ENABLED = false;
    const { guest, version } = await guestWithCart(world);
    const placed = await as(guest).checkout({
      expectedCartVersion: version,
      idempotencyKey: randomUUID(),
    });
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    expect(await orderCount(guest)).toBe(1);
  });
});
