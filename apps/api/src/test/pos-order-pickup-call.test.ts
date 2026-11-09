// legend-ggpoe: a POS takeaway or delivery order gets a pickup call number (and
// letter code A-001..A-999, B-001...) inside the order's own transaction.
// Dine-in orders and orders from a training device get none.
//
// Assumptions where the contract is silent:
//  - Each numbering test uses a fresh outlet (copy of the tenant outlet with
//    its own price lists), so its call sequence starts at A-001.
//  - The code is read back through `allocatePickupCall`, which is idempotent
//    per order and returns the call the order already holds.
//  - A delivery sale is priced from the takeaway price list (the menu price
//    channels have no `delivery`).
//  - Fixture setup is copied from pos-order-training.test.ts.
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  outletIdSchema,
  tenantIdSchema,
  businessDateOf,
  ulidToUuid,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  createPosOrder as createPosOrderContract,
  type PosReceipt,
} from "@starter/shared/pos";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { formatPickupCode } from "@starter/shared/kitchen";
import { signDeviceToken } from "../lib/device-token.ts";
import { withTenant } from "../db/tenant.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  enrollDevice,
  setDeviceTrainingMode,
} from "../services/device.service.ts";
import { createDeviceOutletResolver } from "../services/device-outlet-resolver.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import {
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { createPosOrder } from "../services/pos-order.service.ts";
import { allocatePickupCall } from "../services/pickup.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  priceList: randomUUID(),
  cashierRole: randomUUID(),
};
const actor = randomUUID();
let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let cashier: { client: ReturnType<typeof agent>; userId: string };

const tenantContext = (): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
const outletContext = (): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(tenant.outletId)] },
  );

async function asOwnerTenant<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.tenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function memoryReceiptPort(): PosReceiptPort {
  const byOrder = new Map<string, PosReceipt>();
  let next = 0;
  return {
    async issueForSale(_tx, context, input) {
      const existing = byOrder.get(input.orderId);
      if (existing) return existing;
      next += 1;
      const receipt = {
        id: randomUUID(),
        tenantId: context.tenant.tenantId,
        outletId: input.outletId,
        orderId: input.orderId,
        deviceId: input.deviceId ?? randomUUID(),
        number: `TRN-${String(next).padStart(6, "0")}`,
        sequenceNumber: next,
        status: "issued",
        issuedAt: input.at.toISOString(),
        voidedAt: null,
        voidReason: null,
        voidedBy: null,
        reprintCount: 0,
      } as unknown as PosReceipt;
      byOrder.set(input.orderId, receipt);
      return receipt;
    },
    async findForOrder(_tx, _context, orderId) {
      return byOrder.get(orderId) ?? null;
    },
    async voidForOrder() {
      return null;
    },
  };
}

async function newDevice(trainingMode: boolean): Promise<string> {
  const { device } = await enrollDevice(outletContext(), actor, {
    outletId: tenant.outletId,
    type: "pos",
    label: `Kasir ${randomUUID().slice(0, 6)}`,
    stationId: null,
    idempotencyKey: randomUUID(),
  });
  if (trainingMode)
    await setDeviceTrainingMode(outletContext(), actor, {
      deviceId: device.id,
      trainingMode: true,
    });
  return device.id;
}

type ServiceType = "dine_in" | "takeaway" | "delivery";

/** Creates a POS order through the service, as a cashier on `deviceId`. */
async function createOrder(
  deviceId: string | null,
  serviceType: ServiceType = "takeaway",
  outletId: string = tenant.outletId,
): Promise<string> {
  const input = createPosOrderContract.body.parse({
    idempotencyKey: randomUUID(),
    channel: "pos",
    serviceType,
    items: [{ menuItemId: ids.kopi, quantity: 2, modifierIds: [] }],
  });
  const order = await createPosOrder(
    tenantContext(),
    {
      userId: userIdSchema.parse(cashier.userId),
      deviceId,
      expectedVersion: null,
    },
    outletIdSchema.parse(outletId),
    input,
  );
  return order.id;
}

/** The device token header a registered terminal sends (pos-shift). */
const deviceToken = (deviceId: string) =>
  signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: tenant.tenantId,
    brandId: null,
    deviceId,
  });

const posHttp = (
  path: string,
  body: Record<string, unknown>,
  deviceId?: string,
) => {
  const request = cashier.client
    .post(
      `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/orders${path}`,
    )
    .set(headers)
    .set(originHeader);
  if (deviceId) request.set(DEVICE_TOKEN_HEADER, deviceToken(deviceId));
  return request.send({ idempotencyKey: randomUUID(), ...body });
};

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  setAuditWriter(coreAuditWriter);
  setPosReceiptPort(memoryReceiptPort());
  // Production resolver: a cash drawer opens only on a device row (pos-shift).
  setDeviceOutletResolver(createDeviceOutletResolver());
  tenant = await createIsolatedTenant(`trn-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'POS Kasir Uji', false, NULL, $3, false, '["tenant"]')`,
    [
      ids.cashierRole,
      tenant.tenantId,
      JSON.stringify([
        "order.view",
        "pos.sale.create",
        "pos.payment.accept",
        "pos.discount.apply",
        "pos.void.request",
        "pos.refund.request",
        "shift.cash.operate",
      ]),
    ],
  );
  const client = agent(app);
  await signUp(client, "Kasir Latihan");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, ids.cashierRole],
  );
  cashier = { client, userId };
  await asOwnerTenant(async (c) => {
    await c.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Latihan Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await c.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [ids.kopi, tenant.tenantId, tenant.brandId, ids.category, randomUUID()],
    );
    await c.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
      [ids.priceList, tenant.tenantId, tenant.outletId],
    );
    await c.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, 25000)`,
      [randomUUID(), tenant.tenantId, ids.priceList, ids.kopi],
    );
    await c.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, userId],
    );
    await c.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-TRN', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, userId],
    );
  });
});

afterAll(async () => {
  setPosReceiptPort(null);
  setDeviceOutletResolver(null);
  setAuditWriter(null);
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

const CLOCK = { timeZone: "Asia/Jakarta", cutoff: "04:00" };

/** A new outlet of the tenant with its own price lists: a fresh call sequence. */
async function newOutlet(): Promise<string> {
  const id = randomUUID();
  await asOwnerTenant(async (client) => {
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet Panggil', 'Jl. Uji 3', timezone, opening_hours, 'active'
       FROM outlets WHERE tenant_id = $3 AND id = $4`,
      [
        id,
        `PC-${randomUUID().slice(0, 8)}`.toUpperCase(),
        tenant.tenantId,
        tenant.outletId,
      ],
    );
    for (const channel of ["takeaway", "dine_in"]) {
      const priceList = randomUUID();
      await client.query(
        `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
         VALUES ($1, $2, $3, $4, '2026-01-01')`,
        [priceList, tenant.tenantId, id, channel],
      );
      await client.query(
        `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
         VALUES ($1, $2, $3, $4, 25000)`,
        [randomUUID(), tenant.tenantId, priceList, ids.kopi],
      );
    }
  });
  return id;
}

/** Seeds pickup calls 1..count for today at `outletId` (with plain orders). */
async function seedCallsUpTo(outletId: string, count: number) {
  const businessDate = businessDateOf(new Date(), CLOCK);
  await asOwnerTenant((client) =>
    client.query(
      `WITH seeded AS (
         INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
           subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
           status, business_date, placed_at)
         SELECT gen_random_uuid(), $1, $2, 'SEED-' || $5 || '-' || n, 'gofood', 'delivery', 'pay_first',
           10000, 0, 0, 0, 0, 10000, 'sent', $3::date, now()
         FROM generate_series(1, $4::int) AS n
         RETURNING id, number
       )
       INSERT INTO pickup_calls
         (id, tenant_id, outlet_id, order_id, channel, number, business_date, status)
       SELECT gen_random_uuid(), $1, $2, id, 'gofood',
         substring(number from '[0-9]+$')::int, $3::date, 'assigned'
       FROM seeded`,
      [
        tenant.tenantId,
        outletId,
        businessDate,
        count,
        randomUUID().slice(0, 6),
      ],
    ),
  );
}

interface CallRow {
  number: number;
  channel: string;
  status: string;
}

async function callOf(orderId: string): Promise<CallRow | null> {
  const { rows } = await asOwnerTenant((client) =>
    client.query<CallRow>(
      `SELECT number::int AS number, channel, status FROM pickup_calls
       WHERE tenant_id = $1 AND order_id = $2::uuid`,
      [tenant.tenantId, ulidToUuid(orderId)],
    ),
  );
  expect(rows.length).toBeLessThanOrEqual(1);
  return rows[0] ?? null;
}

/** The order's call as the service returns it (idempotent repeat). */
const heldCall = (orderId: string) =>
  withTenant(db, tenantContext(), (tx) =>
    allocatePickupCall(tx, tenantContext(), orderId),
  );

describe("legend-ggpoe POS orders get a pickup call", () => {
  it("a takeaway order gets a call with code A-001 on channel takeaway", async () => {
    const outlet = await newOutlet();
    const orderId = await createOrder(null, "takeaway", outlet);
    expect(await callOf(orderId)).toMatchObject({
      number: 1,
      channel: "takeaway",
      status: "assigned",
    });
    expect((await heldCall(orderId)).code).toBe("A-001");
  });

  it("a delivery order gets the next code on channel delivery", async () => {
    const outlet = await newOutlet();
    const first = await createOrder(null, "takeaway", outlet);
    const second = await createOrder(null, "delivery", outlet);
    expect(await callOf(second)).toMatchObject({
      number: 2,
      channel: "delivery",
    });
    expect((await heldCall(first)).code).toBe("A-001");
    expect((await heldCall(second)).code).toBe("A-002");
  });

  it("a dine-in order gets no call and does not use up a number", async () => {
    const outlet = await newOutlet();
    const dineIn = await createOrder(null, "dine_in", outlet);
    expect(await callOf(dineIn)).toBeNull();
    const takeaway = await createOrder(null, "takeaway", outlet);
    expect((await heldCall(takeaway)).code).toBe("A-001");
  });

  it("an order from a training device gets no call and does not use up a number", async () => {
    const outlet = await newOutlet();
    const training = await createOrder(await newDevice(true), "takeaway");
    expect(await callOf(training)).toBeNull();
    // A normal device in the same outlet still gets one.
    const normal = await createOrder(await newDevice(false), "takeaway");
    expect(await callOf(normal)).not.toBeNull();
    // And the fresh outlet is untouched by either.
    const clean = await createOrder(null, "takeaway", outlet);
    expect((await heldCall(clean)).code).toBe("A-001");
  });

  it("two takeaway orders created at the same time get distinct numbers", async () => {
    const outlet = await newOutlet();
    const [a, b] = await Promise.all([
      createOrder(null, "takeaway", outlet),
      createOrder(null, "takeaway", outlet),
    ]);
    const numbers = [(await callOf(a))?.number, (await callOf(b))?.number];
    expect(numbers.sort()).toEqual([1, 2]);
  });

  it("many orders at the same time get distinct numbers and distinct codes", async () => {
    const outlet = await newOutlet();
    const orderIds = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        createOrder(null, i % 2 === 0 ? "takeaway" : "delivery", outlet),
      ),
    );
    const numbers = (await Promise.all(orderIds.map(callOf))).map(
      (c) => c?.number as number,
    );
    expect([...numbers].sort((x, y) => x - y)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    const codes = numbers.map((n) => formatPickupCode(n));
    expect(new Set(codes).size).toBe(8);
  });

  it("order number 999 is A-999 and number 1000 is B-001; the order is never refused", async () => {
    const outlet = await newOutlet();
    await seedCallsUpTo(outlet, 998);
    const n999 = await createOrder(null, "takeaway", outlet);
    const n1000 = await createOrder(null, "delivery", outlet);
    const n1001 = await createOrder(null, "takeaway", outlet);
    expect((await callOf(n999))?.number).toBe(999);
    expect((await heldCall(n999)).code).toBe("A-999");
    expect((await callOf(n1000))?.number).toBe(1000);
    expect((await heldCall(n1000)).code).toBe("B-001");
    expect((await heldCall(n1001)).code).toBe("B-002");
  });

  it("over HTTP a takeaway sale is created (201) and holds a call", async () => {
    const created = await posHttp("", {
      channel: "pos",
      serviceType: "takeaway",
      items: [{ menuItemId: ids.kopi, quantity: 1, modifierIds: [] }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const call = await callOf(created.body.data.id as string);
    expect(call).toMatchObject({ channel: "takeaway", status: "assigned" });
    expect(call?.number).toBeGreaterThanOrEqual(1);
  });
});
