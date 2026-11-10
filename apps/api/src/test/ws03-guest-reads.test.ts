// WS-03 W4 (bead legend-cpq2): guest read model GET /suggestions.
//
// Real Express app and PostgreSQL with RLS, in a fresh isolated tenant. Rules
// under test: top items of the outlet's last 30 days by order lines, orderable
// now only (86 items never offered), nothing already in the session cart, at
// most 6, menu order when there is no history, outlet-scoped by the bearer
// session credential. Order issues, point claim and order ETA have no data
// source yet (follow-up cards) and are intentionally not served here. The
// existing GET payments/:paymentId is covered in qr-order-api.test.ts.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { getMenuSuggestions } from "@starter/shared/qr-order";
import { createApp } from "../app.ts";
import { agent, originHeader } from "./helpers.ts";
import {
  createIsolatedTenant,
  createTable,
  createZone,
  issueQr,
  owner,
  scan,
  seededHostname,
  staffOfIsolatedTenant,
  type IsolatedTenant,
  type Staff,
} from "./floor-test-helpers.ts";

let app: Express;
let tenant: IsolatedTenant;
let staff: Staff;
let headers: { Host: string };

const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  roti: randomUUID(),
  teh: randomUUID(),
  habis: randomUUID(),
  priceList: randomUUID(),
  taxRule: randomUUID(),
  taxSettings: randomUUID(),
};
/** Menu order: kopi, roti, teh, habis (86). */
const MENU = [
  [ids.kopi, "Kopi Susu", 25_000],
  [ids.roti, "Roti Bakar", 18_000],
  [ids.teh, "Teh Tarik", 12_000],
  [ids.habis, "Kue Habis", 15_000],
] as const;
const ALL_DAY = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
];

async function asOwnerTenant<T>(
  tenantId: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
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

type Guest = { token: string; sessionId: string };

async function seat(): Promise<Guest & { zoneId: string }> {
  const zone = await createZone(
    staff.client,
    { paymentMode: "pay_first", serviceChargeBp: 500, hours: ALL_DAY },
    headers,
  );
  const table = await createTable(staff.client, { zoneId: zone.id }, headers);
  const qr = await issueQr(staff.client, table.id, headers);
  const response = await scan(app, {
    token: qr.token,
    hostname: tenant.hostname,
  });
  expect(response.status).toBe(201);
  return {
    token: response.body.data.sessionToken,
    sessionId: response.body.data.session.id,
    zoneId: zone.id,
  };
}

function as(guest: Guest, host = tenant.hostname) {
  const client = agent(app);
  const auth = (test: ReturnType<typeof client.get>) =>
    test
      .set("Host", host)
      .set("Authorization", `Bearer ${guest.token}`)
      .set(originHeader);
  const base = `/api/table-sessions/${guest.sessionId}`;
  return {
    add: (menuItemId: string, expectedCartVersion: number) =>
      auth(client.post(`${base}/cart/lines`)).send({
        idempotencyKey: randomUUID(),
        modifierIds: [],
        menuItemId,
        quantity: 1,
        expectedCartVersion,
      }),
    checkout: (expectedCartVersion: number) =>
      auth(client.post(`${base}/orders`)).send({
        expectedCartVersion,
        idempotencyKey: randomUUID(),
      }),
    suggestions: (query = "") =>
      auth(client.get(`${base}/suggestions${query}`)),
  };
}

/** One order of one item: the outlet's history for that item. */
async function orderOnce(menuItemId: string): Promise<void> {
  const guest = await seat();
  const added = await as(guest).add(menuItemId, 0);
  expect(added.status).toBe(201);
  const placed = await as(guest).checkout(added.body.data.cart.version);
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
}

const idsOf = (body: { data: { menuItemId: string }[] }) =>
  body.data.map((row) => row.menuItemId);

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`gr-${randomUUID().slice(0, 6)}`);
  staff = await staffOfIsolatedTenant(app, tenant);
  headers = { Host: tenant.hostname };
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Guest Reads Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'dine_in', '2026-01-01')`,
      [ids.priceList, tenant.tenantId, tenant.outletId],
    );
    for (const [index, [id, name, price]] of MENU.entries()) {
      await client.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id, sort_order)
         VALUES ($1, $2, $3, $4, $5, true, $6, $7)`,
        [
          id,
          tenant.tenantId,
          tenant.brandId,
          ids.category,
          name,
          randomUUID(),
          index,
        ],
      );
      await client.query(
        `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), tenant.tenantId, ids.priceList, id, price],
      );
    }
    await client.query(
      `INSERT INTO item_availability (id, tenant_id, outlet_id, menu_item_id, schedule, daily_limit, status)
       VALUES ($1, $2, $3, $4, '[]', NULL, 'sold_out')`,
      [randomUUID(), tenant.tenantId, tenant.outletId, ids.habis],
    );
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [ids.taxSettings, tenant.tenantId, staff.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-GR', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [ids.taxRule, tenant.tenantId, staff.userId],
    );
  });
});

afterAll(async () => {
  // The isolated tenant stays in the disposable test database: its audit
  // rows are append-only. Give it a valid creator so the platform tenant list
  // still parses it.
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("guest suggestions (legend-cpq2)", () => {
  it("answers 401 without a credential and 404 for another session id", async () => {
    const guest = await seat();
    const anonymous = await agent(app)
      .get(`/api/table-sessions/${guest.sessionId}/suggestions`)
      .set("Host", tenant.hostname);
    expect(anonymous.status).toBe(401);
    const other = await as({ ...guest, sessionId: randomUUID() }).suggestions();
    expect(other.status).toBe(404);
  });

  it("falls back to menu order without history, never offering an 86 item", async () => {
    const guest = await seat();
    const res = await as(guest).suggestions();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(() => getMenuSuggestions.response.parse(res.body)).not.toThrow();
    expect(idsOf(res.body)).toEqual([ids.kopi, ids.roti, ids.teh]);
    expect(res.body.data.every((row: { kind: string }) => row.kind)).toBe(true);
    expect(res.body.data[0].basedOnMenuItemId).toBeNull();
  });

  it("ranks by the outlet's order lines and skips items already in the cart", async () => {
    // Teh sold twice, roti once: history order is teh, roti, then menu order.
    await orderOnce(ids.teh);
    await orderOnce(ids.teh);
    await orderOnce(ids.roti);

    const guest = await seat();
    const fresh = await as(guest).suggestions();
    expect(idsOf(fresh.body)).toEqual([ids.teh, ids.roti, ids.kopi]);

    const added = await as(guest).add(ids.teh, 0);
    expect(added.status).toBe(201);
    const withCart = await as(guest).suggestions();
    expect(idsOf(withCart.body)).toEqual([ids.roti, ids.kopi]);
    expect(
      withCart.body.data.every(
        (row: { basedOnMenuItemId: string }) =>
          row.basedOnMenuItemId === ids.teh,
      ),
    ).toBe(true);
  });

  it("excludes the item being viewed and anchors on it", async () => {
    const guest = await seat();
    const res = await as(guest).suggestions(`?menuItemId=${ids.roti}`);
    expect(res.status).toBe(200);
    expect(idsOf(res.body)).not.toContain(ids.roti);
    expect(
      res.body.data.every(
        (row: { basedOnMenuItemId: string }) =>
          row.basedOnMenuItemId === ids.roti,
      ),
    ).toBe(true);
  });

  it("returns no suggestions while the zone is outside its ordering hours", async () => {
    const guest = await seat();
    const open = await as(guest).suggestions();
    expect(idsOf(open.body).length).toBeGreaterThan(0);
    // A zone with no ordering window never opens (zoneOrderingOpen).
    await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        "UPDATE floor_zones SET hours = '[]'::jsonb WHERE tenant_id = $1 AND id = $2",
        [tenant.tenantId, guest.zoneId],
      ),
    );
    const closed = await as(guest).suggestions();
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.data).toEqual([]);
  });

  it("does not count a free swap replacement line as popularity (legend-8igcm)", async () => {
    // History so far: teh 2, roti 1; kopi 0. Three kopi lines that are free swap
    // replacements must not lift kopi above teh.
    for (let i = 0; i < 3; i += 1) await orderOnce(ids.kopi);
    const lines = await owner.query<{
      id: string;
      order_id: string;
    }>(
      `SELECT id, order_id FROM order_items WHERE tenant_id = $1 AND menu_item_id = $2`,
      [tenant.tenantId, ids.kopi],
    );
    expect(lines.rows.length).toBe(3);
    await owner.query(
      `INSERT INTO "user" (id, name, email) VALUES ($1, 'Pelapor', $2)`,
      [`gr-swap-${tenant.tenantId}`, `gr-swap-${tenant.tenantId}@example.test`],
    );
    for (const line of lines.rows) {
      await owner.query(
        "UPDATE order_items SET unit_price_idr = 0, line_total_idr = 0 WHERE id = $1",
        [line.id],
      );
      // The issue's own line stands in for the swapped-out original.
      await owner.query(
        `INSERT INTO order_issues (tenant_id, outlet_id, order_id, order_item_id, type, reason,
           reason_note, reported_by, resolution, replacement_item_id, replacement_order_item_id,
           cost_idr, status, idempotency_key, resolved_at)
         VALUES ($1, $2, $3, $4, 'unfulfillable', 'out_of_stock', 'Habis, ditukar', $5, 'swap',
           $6, $4, 0, 'resolved', $7, now())`,
        [
          tenant.tenantId,
          tenant.outletId,
          line.order_id,
          line.id,
          `gr-swap-${tenant.tenantId}`,
          ids.kopi,
          `swap-${randomUUID()}`,
        ],
      );
    }
    const res = await as(await seat()).suggestions();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(idsOf(res.body)).toEqual([ids.teh, ids.roti, ids.kopi]);
  });

  it("rejects a malformed menuItemId query", async () => {
    const guest = await seat();
    const res = await as(guest).suggestions("?menuItemId=not-a-uuid");
    expect(res.status).toBe(422);
  });

  it("does not resolve a credential of another tenant's host", async () => {
    const guest = await seat();
    const res = await as(guest, seededHostname).suggestions();
    expect(res.status).toBe(401);
  });
});
