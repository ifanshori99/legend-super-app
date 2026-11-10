// Seeds the rows the Lighthouse run (scripts/ci/lighthouse.mjs) needs on the
// disposable test database and prints one JSON line: { "token": "<table QR>" }.
//
// Not a test (no `.test.ts` suffix, so vitest ignores it). It mirrors the
// fixture of guest-menu-api.test.ts: a menu with photos, a price list, a tax
// rule and one pay-first table whose signed QR token resolves for Cafe Legend.
// It must run with the same BETTER_AUTH_SECRET / DATA_ENCRYPTION_KEY as the API
// it will talk to, because the QR signing key is derived from them.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { cafeLegendFixtures } from "@starter/shared/core";
import { qrTokenHash, signTableQrToken } from "../services/qr-token";

const ownerUrl = process.env.STARTER_TEST_DATABASE_URL;
if (!ownerUrl || !process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
  throw new Error(
    "Lighthouse seeding only runs on a disposable test database.",
  );

const { tenant, brand, outlets } = cafeLegendFixtures;
const tenantId = tenant.id;
const outletId = outlets[0].id;
const ids = {
  category: randomUUID(),
  priceList: randomUUID(),
  zone: randomUUID(),
  table: randomUUID(),
  taxRule: randomUUID(),
};
const items = [
  ["Kopi Susu Legend", 24000],
  ["Es Teh Lemon", 16000],
  ["Nasi Goreng Legend", 38000],
] as const;

const token = signTableQrToken({ tenantId, outletId, tableId: ids.table });
const pool = new Pool({ connectionString: ownerUrl, max: 1 });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query(
    "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
    [tenantId],
  );
  await client.query(
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
     VALUES ($1, $2, $3, 'Menu Lighthouse', 0)`,
    [ids.category, tenantId, brand.id],
  );
  await client.query(
    `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
     VALUES ($1, $2, $3, 'dine_in', '2026-01-01')`,
    [ids.priceList, tenantId, outletId],
  );
  for (const [name, price] of items) {
    const itemId = randomUUID();
    // Active items need a photo to reach a guest (owner Q23, legend-qf0i).
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, $5, true, $6)`,
      [itemId, tenantId, brand.id, ids.category, name, randomUUID()],
    );
    await client.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), tenantId, ids.priceList, itemId, price],
    );
  }
  await client.query(
    `INSERT INTO tax_rules (id, tenant_id, outlet_id, code, name, tax_type, rate_bp,
       channels, applies_to, price_includes_tax, include_service_in_base, is_active,
       version, effective_from, status, published_at, published_by)
     VALUES ($1, $2, $3, 'LH-PBJT', 'PBJT Lighthouse', 'pbjt', 1000,
       '[]', $4, false, false, true, 1, '2026-01-01', 'published', now(), 'lighthouse')`,
    [
      ids.taxRule,
      tenantId,
      outletId,
      JSON.stringify({
        itemClasses: ["food_beverage"],
        categoryIds: [],
        itemIds: [],
      }),
    ],
  );
  await client.query(
    `INSERT INTO floor_zones (id, tenant_id, outlet_id, name, payment_mode,
       service_charge_bp, minimum_spend_idr, hours, status, sort_order)
     VALUES ($1, $2, $3, 'Zona Lighthouse', 'pay_first', 500, 0, $4, 'active', 0)`,
    [
      ids.zone,
      tenantId,
      outletId,
      JSON.stringify([
        { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" },
      ]),
    ],
  );
  await client.query(
    `INSERT INTO tables (id, tenant_id, outlet_id, zone_id, code, capacity, type,
       layout, status, qr_token_hash, qr_token_sealed)
     VALUES ($1, $2, $3, $4, 'LH1', 4, 'regular', $5, 'available', $6, 'sealed')`,
    [
      ids.table,
      tenantId,
      outletId,
      ids.zone,
      JSON.stringify({
        x: 10,
        y: 10,
        width: 60,
        height: 60,
        rotation: 0,
        shape: "rect",
      }),
      qrTokenHash(token),
    ],
  );
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
console.log(JSON.stringify({ token }));
