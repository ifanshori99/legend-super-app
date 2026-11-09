// legend-k7x4p: create and reprice must agree on who pays the zone service
// charge. Reprice charges it only for dine_in; create charges it whenever a
// table session is attached, so a non-dine_in order carrying a session would
// be priced with the zone charge at create and without it at the first
// reprice. Create therefore refuses a table session on any non-dine_in order
// (pos-order.service.ts "Sesi meja hanya untuk pesanan makan di tempat.").
//
// Real Express app, Better Auth, RBAC and PostgreSQL in a fresh isolated
// tenant (same setup as pos-order-version.test.ts and ws03-open-bill.test.ts).

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agent, originHeader, signUp } from "./helpers.ts";
import { createApp } from "../app.ts";
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

const SESSION_ONLY_DINE_IN = "Sesi meja hanya untuk pesanan makan di tempat.";
const KOPI_IDR = 25_000;
const SERVICE_CHARGE_BP = 500;
const ALL_DAY = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
];

const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  priceList: randomUUID(),
  cashierRole: randomUUID(),
};

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let staff: Staff;
let cashier: ReturnType<typeof agent>;
let sessionId: string;

function ordersBase() {
  return `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/orders`;
}

function createOrder(body: Record<string, unknown>) {
  return cashier
    .post(ordersBase())
    .set(headers)
    .set(originHeader)
    .send({
      idempotencyKey: randomUUID(),
      items: [{ menuItemId: ids.kopi, quantity: 2, modifierIds: [] }],
      ...body,
    });
}

async function orderCount(): Promise<number> {
  const { rows } = await owner.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM orders WHERE tenant_id = $1`,
    [tenant.tenantId],
  );
  return Number(rows[0]?.count);
}

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`possess-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  staff = await staffOfIsolatedTenant(app, tenant);

  cashier = agent(app);
  await signUp(cashier, "POS Kasir Sesi");
  const session = await cashier.get("/api/auth/get-session");
  const cashierId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'POS Kasir Sesi', false, NULL, $3, false, '["tenant"]')`,
    [
      ids.cashierRole,
      tenant.tenantId,
      JSON.stringify(["order.view", "pos.sale.create"]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, cashierId, ids.cashierRole],
  );

  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.tenantId],
    );
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'POS Sesi Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [ids.kopi, tenant.tenantId, tenant.brandId, ids.category, randomUUID()],
    );
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'dine_in', '2026-01-01')`,
      [ids.priceList, tenant.tenantId, tenant.outletId],
    );
    await client.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), tenant.tenantId, ids.priceList, ids.kopi, KOPI_IDR],
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
       VALUES ($1, $2, NULL, 'PBJT-SES', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, staff.userId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  // A pay-first zone with a 5% service charge: the scanned session is open.
  const zone = await createZone(
    staff.client,
    { serviceChargeBp: SERVICE_CHARGE_BP, hours: ALL_DAY },
    headers,
  );
  const table = await createTable(staff.client, { zoneId: zone.id }, headers);
  const qr = await issueQr(staff.client, table.id, headers);
  const scanned = await scan(app, {
    token: qr.token,
    hostname: tenant.hostname,
  });
  expect(scanned.status, JSON.stringify(scanned.body)).toBe(201);
  expect(scanned.body.data.session.status).toBe("open");
  sessionId = scanned.body.data.session.id as string;
});

afterAll(async () => {
  // The isolated tenant stays in the disposable test database (append-only
  // audit rows); give it a valid creator so the tenant list still parses it.
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("POS order create: table session needs dine_in (legend-k7x4p)", () => {
  it.each([
    { channel: "pos", serviceType: "takeaway" },
    { channel: "pos", serviceType: "delivery" },
    { channel: "kiosk", serviceType: "takeaway" },
    { channel: "captain", serviceType: "takeaway" },
    { channel: "gofood", serviceType: "delivery", externalRef: "GF-K7X4P-1" },
    { channel: "grabfood", serviceType: "takeaway", externalRef: "GR-K7X4P-1" },
    {
      channel: "shopeefood",
      serviceType: "delivery",
      externalRef: "SH-K7X4P-1",
    },
  ])(
    "refuses a table session on $channel / $serviceType and creates no order",
    async (variant) => {
      const before = await orderCount();
      const refused = await createOrder({
        ...variant,
        tableSessionId: sessionId,
      });
      expect(refused.status, JSON.stringify(refused.body)).toBe(400);
      expect(refused.body.error?.code ?? refused.body.code).toBe(
        "VALIDATION_ERROR",
      );
      expect(JSON.stringify(refused.body)).toContain(SESSION_ONLY_DINE_IN);
      expect(refused.body.data?.id).toBeUndefined();
      expect(await orderCount()).toBe(before);
    },
  );

  it("accepts the same session for dine_in and charges the zone service charge", async () => {
    const before = await orderCount();
    const created = await createOrder({
      channel: "pos",
      serviceType: "dine_in",
      tableSessionId: sessionId,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({
      serviceType: "dine_in",
      tableSessionId: sessionId,
      subtotalIdr: 2 * KOPI_IDR,
      serviceChargeIdr: (2 * KOPI_IDR * SERVICE_CHARGE_BP) / 10_000,
    });
    expect(await orderCount()).toBe(before + 1);
  });
});
