// Approved cashier/captain contract fixtures (legend-dysef). Keep behavior
// assertions in the per-gap test files; this helper only seeds public inputs.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { expect } from "vitest";
import { createApp } from "../app.ts";
import { agent, originHeader } from "./helpers.ts";
import {
  createIsolatedTenant,
  createTable,
  createZone,
  issueQr,
  owner,
  scan,
  staffOfIsolatedTenant,
} from "./floor-test-helpers.ts";

export async function asCashierTenant<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
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

export async function cashierFixture(label: string) {
  const app = createApp();
  const tenant = await createIsolatedTenant(
    `${label}-${randomUUID().slice(0, 6)}`,
  );
  await owner.query("UPDATE roles SET permissions = $2 WHERE id = $1", [
    tenant.roleId,
    JSON.stringify([
      "floor.table.view",
      "floor.table.operate",
      "floor.table.manage",
      "service_request.zone.manage",
      "order.view",
      "order.create",
      "pos.sale.create",
      "pos.payment.accept",
      "menu.item.view",
      "menu.price.view",
    ]),
  ]);
  const staff = await staffOfIsolatedTenant(app, tenant);
  const headers = { Host: tenant.hostname };
  const ids = {
    category: randomUUID(),
    coffee: randomUUID(),
    meal: randomUUID(),
    soldOut: randomUUID(),
    group: randomUUID(),
    modifier: randomUUID(),
  };
  await asCashierTenant(tenant.tenantId, async (client) => {
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
       VALUES ($1, $2, NULL, 'PBJT-CASHIER', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, staff.userId],
    );
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Katalog Kasir', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    for (const [id, name, course] of [
      [ids.coffee, "Kopi Pilihan", "drink"],
      [ids.meal, "Nasi Goreng", "main"],
      [ids.soldOut, "Kue Habis", "dessert"],
    ])
      await client.query(
        `INSERT INTO menu_items
           (id, tenant_id, brand_id, category_id, name, course, is_active, media_id)
         VALUES ($1, $2, $3, $4, $5, $6, true, $7)`,
        [
          id,
          tenant.tenantId,
          tenant.brandId,
          ids.category,
          name,
          course,
          randomUUID(),
        ],
      );
    for (const channel of ["takeaway", "dine_in"]) {
      const priceListId = randomUUID();
      await client.query(
        `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
         VALUES ($1, $2, $3, $4, '2026-01-01')`,
        [priceListId, tenant.tenantId, tenant.outletId, channel],
      );
      for (const [itemId, amount] of [
        [ids.coffee, 25_000],
        [ids.meal, 30_000],
        [ids.soldOut, 15_000],
      ])
        await client.query(
          `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
           VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), tenant.tenantId, priceListId, itemId, amount],
        );
    }
    await client.query(
      `INSERT INTO modifier_groups (id, tenant_id, name, min_select, max_select)
       VALUES ($1, $2, 'Ukuran', 1, 1)`,
      [ids.group, tenant.tenantId],
    );
    await client.query(
      `INSERT INTO modifiers (id, tenant_id, group_id, name, price_idr)
       VALUES ($1, $2, $3, 'Besar', 5000)`,
      [ids.modifier, tenant.tenantId, ids.group],
    );
    await client.query(
      `INSERT INTO menu_item_modifier_groups (tenant_id, menu_item_id, group_id, sort_order)
       VALUES ($1, $2, $3, 0)`,
      [tenant.tenantId, ids.coffee, ids.group],
    );
    await client.query(
      `INSERT INTO item_availability (id, tenant_id, outlet_id, menu_item_id, schedule, status)
       VALUES ($1, $2, $3, $4, '[]', 'sold_out')`,
      [randomUUID(), tenant.tenantId, tenant.outletId, ids.soldOut],
    );
  });
  const base = `/api/outlets/${tenant.outletId}/pos/orders`;
  const post = (path: string, body: Record<string, unknown>) =>
    staff.client.post(path).set(headers).set(originHeader).send(body);
  const get = (path: string) => staff.client.get(path).set(headers);
  const line = (body: Record<string, unknown> = {}) => ({
    menuItemId: ids.meal,
    modifierIds: [],
    quantity: 1,
    ...body,
  });
  const create = (body: Record<string, unknown> = {}) =>
    post(base, {
      channel: "pos",
      serviceType: "takeaway",
      items: [line()],
      idempotencyKey: randomUUID(),
      ...body,
    });
  const newGuest = async (
    paymentMode: "pay_first" | "open_bill" = "pay_first",
  ) => {
    const zone = await createZone(
      staff.client,
      {
        paymentMode,
        serviceChargeBp: 0,
        hours: [
          { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
        ],
      },
      headers,
    );
    const table = await createTable(staff.client, { zoneId: zone.id }, headers);
    const qr = await issueQr(staff.client, table.id, headers);
    const opened = await scan(app, {
      token: qr.token,
      hostname: tenant.hostname,
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    return {
      zone,
      table,
      sessionId: opened.body.data.session.id as string,
      token: opened.body.data.sessionToken as string,
    };
  };
  const guestGet = (
    session: { sessionId: string; token: string },
    suffix: string,
  ) =>
    agent(app)
      .get(`/api/table-sessions/${session.sessionId}${suffix}`)
      .set(headers)
      .set("Authorization", `Bearer ${session.token}`);
  return {
    app,
    tenant,
    staff,
    headers,
    ids,
    base,
    post,
    get,
    line,
    create,
    newGuest,
    guestGet,
  };
}

export type CashierFixture = Awaited<ReturnType<typeof cashierFixture>>;
