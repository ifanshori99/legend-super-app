// WS-03 guest menu: tax note from the WS-05 resolver (legend-lf8g), the
// "available later today" state (legend-nx3f) and the inclusive-price flag of
// the menu pricing block (legend-49pw).
//
// Runs the real Express app and PostgreSQL on a throwaway tenant, so rules left
// by other suites on the seeded tenant cannot make the resolver ambiguous.

import { randomUUID } from "node:crypto";
import { Pool, type Client } from "pg";
import { businessDateOf } from "@starter/shared/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { nextWindowStartToday } from "../services/guest-menu.service";
import { wallClockAt } from "../services/menu-availability";
import { qrTokenHash, signTableQrToken } from "../services/qr-token";
import { agent } from "./helpers";
import {
  createIsolatedTenant,
  dropIsolatedTenant,
  type IsolatedTenant,
} from "./floor-test-helpers";

const app = createApp();
const pool = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const ids = {
  category: randomUUID(),
  laterItem: randomUUID(),
  otherDayItem: randomUUID(),
  spentItem: randomUUID(),
  categoryRule: randomUUID(),
  itemRule: randomUUID(),
  zeroZone: randomUUID(),
  zeroTable: randomUUID(),
  serviceRule: randomUUID(),
  priceList: randomUUID(),
  zone: randomUUID(),
  table: randomUUID(),
  wideRule: randomUUID(),
  outletRule: randomUUID(),
  duplicateRule: randomUUID(),
};
const mediaId = randomUUID();
const FOOD = JSON.stringify({
  itemClasses: ["food_beverage"],
  categoryIds: [],
  itemIds: [],
});

let tenant: IsolatedTenant;
let qrToken = "";
let timeZone = "Asia/Jakarta";
let cutoff = "00:00";

async function asTenant<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
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

const insertRule = (
  db: Client,
  input: {
    id: string;
    outletId: string | null;
    code: string;
    name: string;
    rateBp: number;
    inclusive?: boolean;
  },
) =>
  db.query(
    `INSERT INTO tax_rules (id, tenant_id, outlet_id, code, name, tax_type, rate_bp,
       channels, applies_to, price_includes_tax, include_service_in_base, is_active,
       version, effective_from, status, published_at, published_by)
     VALUES ($1, $2, $3, $4, $5, 'pbjt', $6, '[]', $7, $8, false, true, 1,
       '2026-01-01', 'published', now(), 'test')`,
    [
      input.id,
      tenant.tenantId,
      input.outletId,
      input.code,
      input.name,
      input.rateBp,
      FOOD,
      input.inclusive ?? false,
    ],
  );

const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** Local minute of the outlet now; the later-today case needs room before midnight. */
const clockNow = () => wallClockAt(new Date(), timeZone)!;

beforeAll(async () => {
  tenant = await createIsolatedTenant(`ws03-menu-${randomUUID().slice(0, 6)}`);
  const outlet = await pool.query<{
    timezone: string;
    business_day_cutoff: string;
  }>("SELECT timezone, business_day_cutoff FROM outlets WHERE id = $1", [
    tenant.outletId,
  ]);
  timeZone = outlet.rows[0].timezone;
  cutoff = outlet.rows[0].business_day_cutoff;
  qrToken = signTableQrToken({
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
    tableId: ids.table,
  });
  const clock = clockNow();
  const laterStart = Math.min(clock.minutes + 10, 23 * 60 + 59);
  await asTenant(async (db) => {
    await db.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Sarapan Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    for (const [id, name] of [
      [ids.laterItem, "Bubur Nanti"],
      [ids.otherDayItem, "Bubur Lain Hari"],
      [ids.spentItem, "Bubur Habis Jatah"],
    ]) {
      await db.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
         VALUES ($1, $2, $3, $4, $5, true, $6)`,
        [id, tenant.tenantId, tenant.brandId, ids.category, name, mediaId],
      );
    }
    // Opens 10 minutes from now, later today.
    await db.query(
      `INSERT INTO item_availability (id, tenant_id, outlet_id, menu_item_id, status, schedule)
       VALUES ($1, $2, $3, $4, 'available', $5)`,
      [
        randomUUID(),
        tenant.tenantId,
        tenant.outletId,
        ids.laterItem,
        JSON.stringify([
          {
            daysOfWeek: [clock.weekday],
            start: hhmm(laterStart),
            end: "23:59",
          },
        ]),
      ],
    );
    // Only sells on a day that is not today: no window later today.
    await db.query(
      `INSERT INTO item_availability (id, tenant_id, outlet_id, menu_item_id, status, schedule)
       VALUES ($1, $2, $3, $4, 'available', $5)`,
      [
        randomUUID(),
        tenant.tenantId,
        tenant.outletId,
        ids.otherDayItem,
        JSON.stringify([
          {
            daysOfWeek: [(clock.weekday + 3) % 7],
            start: "00:00",
            end: "23:59",
          },
        ]),
      ],
    );
    // A window later today, but today's daily stock (1) is already spent.
    await db.query(
      `INSERT INTO item_availability (id, tenant_id, outlet_id, menu_item_id, status, schedule, daily_limit)
       VALUES ($1, $2, $3, $4, 'available', $5, 1)`,
      [
        randomUUID(),
        tenant.tenantId,
        tenant.outletId,
        ids.spentItem,
        JSON.stringify([
          {
            daysOfWeek: [clock.weekday],
            start: hhmm(laterStart),
            end: "23:59",
          },
        ]),
      ],
    );
    await db.query(
      `INSERT INTO menu_item_daily_usage (id, tenant_id, outlet_id, menu_item_id, business_date, quantity)
       VALUES ($1, $2, $3, $4, $5, 1)`,
      [
        randomUUID(),
        tenant.tenantId,
        tenant.outletId,
        ids.spentItem,
        businessDateOf(new Date(), { timeZone, cutoff }),
      ],
    );
    await db.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'dine_in', '2026-01-01')`,
      [ids.priceList, tenant.tenantId, tenant.outletId],
    );
    for (const itemId of [ids.laterItem, ids.otherDayItem, ids.spentItem])
      await db.query(
        `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
         VALUES ($1, $2, $3, $4, 20000)`,
        [randomUUID(), tenant.tenantId, ids.priceList, itemId],
      );
    await db.query(
      `INSERT INTO floor_zones (id, tenant_id, outlet_id, name, payment_mode,
         service_charge_bp, minimum_spend_idr, hours, status, sort_order)
       VALUES ($1, $2, $3, 'Zona Uji', 'pay_first', 500, 0, $4, 'active', 0)`,
      [
        ids.zone,
        tenant.tenantId,
        tenant.outletId,
        JSON.stringify([
          { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" },
        ]),
      ],
    );
    await db.query(
      `INSERT INTO tables (id, tenant_id, outlet_id, zone_id, code, capacity, type,
         layout, status, qr_token_hash, qr_token_sealed)
       VALUES ($1, $2, $3, $4, 'W3', 4, 'regular', $5, 'available', $6, 'sealed')`,
      [
        ids.table,
        tenant.tenantId,
        tenant.outletId,
        ids.zone,
        JSON.stringify({
          x: 10,
          y: 10,
          width: 60,
          height: 60,
          rotation: 0,
          shape: "rect",
        }),
        qrTokenHash(qrToken),
      ],
    );
    // A tenant-wide rule and an outlet rule with a DIFFERENT code: the engine
    // picks the outlet one; the old note listed both.
    await insertRule(db, {
      id: ids.wideRule,
      outletId: null,
      code: "PB1-WIDE",
      name: "PB1 Tenant",
      rateBp: 1100,
    });
    await insertRule(db, {
      id: ids.outletRule,
      outletId: tenant.outletId,
      code: "PB1-OUTLET",
      name: "PB1 Outlet",
      rateBp: 1000,
    });
  });
});

afterAll(async () => {
  await asTenant(async (db) => {
    for (const sql of [
      "DELETE FROM service_charge_rules WHERE tenant_id = $1",
      "DELETE FROM tables WHERE tenant_id = $1",
      "DELETE FROM floor_zones WHERE tenant_id = $1",
      "DELETE FROM tax_rules WHERE tenant_id = $1",
      "DELETE FROM price_list_items WHERE tenant_id = $1",
      "DELETE FROM price_lists WHERE tenant_id = $1",
      "DELETE FROM menu_item_daily_usage WHERE tenant_id = $1",
      "DELETE FROM item_availability WHERE tenant_id = $1",
      "DELETE FROM menu_items WHERE tenant_id = $1",
      "DELETE FROM menu_categories WHERE tenant_id = $1",
    ])
      await db.query(sql, [tenant.tenantId]);
  });
  await dropIsolatedTenant(tenant);
  await pool.end();
});

const readMenu = async () => {
  const response = await agent(app)
    .get(`/api/qr/menu/${qrToken}`)
    .set("Host", tenant.hostname);
  expect(response.status).toBe(200);
  return response.body.data;
};

describe("nextWindowStartToday (legend-nx3f)", () => {
  const at = new Date("2026-11-02T03:10:00.000Z"); // Mon 10:10 Asia/Jakarta
  const zone = "Asia/Jakarta";
  const window = (start: string, end: string, daysOfWeek = [1]) => ({
    daysOfWeek,
    start,
    end,
  });

  it("returns the earliest window start later today", () => {
    const next = nextWindowStartToday(
      [window("17:00", "21:00"), window("12:00", "14:00")],
      at,
      zone,
    );
    expect(next?.toISOString()).toBe("2026-11-02T05:00:00.000Z"); // 12:00 local
  });

  it("ignores windows already started, full-day windows and other days", () => {
    expect(
      nextWindowStartToday(
        [
          window("06:00", "09:00"),
          window("00:00", "00:00"),
          window("17:00", "21:00", [2]),
        ],
        at,
        zone,
      ),
    ).toBeNull();
  });

  it("counts an overnight window that starts later today", () => {
    expect(
      nextWindowStartToday([window("22:00", "02:00")], at, zone)?.toISOString(),
    ).toBe("2026-11-02T15:00:00.000Z"); // 22:00 local
  });
});

describe("guest menu tax and availability (WS-03 S4)", () => {
  it("legend-lf8g: the tax note is the one rule the resolver picks, not every rule", async () => {
    const menu = await readMenu();
    expect(menu.pricing.taxes).toEqual([{ name: "PB1 Outlet", rateBp: 1000 }]);
    expect(menu.pricing.pricesIncludeTaxAndService).toBe(false);
  });

  it("legend-49pw: an inclusive F&B rule turns the menu price flag on", async () => {
    await asTenant((db) =>
      db.query(
        "UPDATE tax_rules SET price_includes_tax = true WHERE tenant_id = $1 AND id = $2",
        [tenant.tenantId, ids.outletRule],
      ),
    );
    const menu = await readMenu();
    expect(menu.pricing.pricesIncludeTaxAndService).toBe(true);
    expect(menu.pricing.taxPriceMode).toBe("inclusive");
    expect(menu.pricing.taxes).toEqual([{ name: "PB1 Outlet", rateBp: 1000 }]);
  });

  it("legend-lf8g: a category-only rule is the note, and its inclusive flag drives the price flag", async () => {
    const categoryRule = (inclusive: boolean) =>
      asTenant((db) =>
        db.query(
          `INSERT INTO tax_rules (id, tenant_id, outlet_id, code, name, tax_type, rate_bp,
             channels, applies_to, price_includes_tax, include_service_in_base, is_active,
             version, effective_from, status, published_at, published_by)
           VALUES ($1, $2, NULL, 'PB1-CAT', 'PB1 Kategori', 'pbjt', 1200, '[]', $3, $4, false,
             true, 1, '2026-01-01', 'published', now(), 'test')`,
          [
            ids.categoryRule,
            tenant.tenantId,
            JSON.stringify({
              itemClasses: [],
              categoryIds: [ids.category],
              itemIds: [],
            }),
            inclusive,
          ],
        ),
      );
    await categoryRule(false);
    // The earlier test left the outlet rule inclusive; the category rule is more
    // specific for every item, so the outlet rule is no longer part of the note.
    let menu = await readMenu();
    expect(menu.pricing.taxes).toEqual([
      { name: "PB1 Kategori", rateBp: 1200 },
    ]);
    expect(menu.pricing.pricesIncludeTaxAndService).toBe(false);
    await asTenant((db) =>
      db.query(
        "UPDATE tax_rules SET price_includes_tax = true WHERE tenant_id = $1 AND id = $2",
        [tenant.tenantId, ids.categoryRule],
      ),
    );
    menu = await readMenu();
    expect(menu.pricing.pricesIncludeTaxAndService).toBe(true);
    await asTenant((db) =>
      db.query("DELETE FROM tax_rules WHERE tenant_id = $1 AND id = $2", [
        tenant.tenantId,
        ids.categoryRule,
      ]),
    );
  });

  it("legend-lf8g: an ambiguous pair fails closed with no tax note", async () => {
    await asTenant((db) =>
      insertRule(db, {
        id: ids.duplicateRule,
        outletId: tenant.outletId,
        code: "PB1-DUP",
        name: "PB1 Kembar",
        rateBp: 900,
      }),
    );
    const menu = await readMenu();
    expect(menu.pricing.taxes).toEqual([]);
    expect(menu.pricing.pricesIncludeTaxAndService).toBe(false);
  });

  it("legend-nx3f: outside its schedule with a window later today answers unavailable_until", async () => {
    const clock = clockNow();
    // The window starts 10 minutes ahead; too close to midnight to assert.
    if (clock.minutes > 23 * 60 + 40) return;
    const menu = await readMenu();
    const item = menu.items.find(
      (entry: { id: string }) => entry.id === ids.laterItem,
    );
    expect(item.status).toBe("unavailable_until");
    const from = wallClockAt(new Date(item.availableFrom), timeZone)!;
    expect(from.minutes).toBe(Math.min(clock.minutes + 10, 23 * 60 + 59));
    expect(from.weekday).toBe(clock.weekday);
  });

  it("legend-nx3f: a window only on another day stays sold_out without availableFrom", async () => {
    const menu = await readMenu();
    const item = menu.items.find(
      (entry: { id: string }) => entry.id === ids.otherDayItem,
    );
    expect(item.status).toBe("sold_out");
    expect(item.availableFrom).toBeUndefined();
  });
});

describe("unavailable_until needs stock left today (legend-nx3f)", () => {
  it("a window later today does not promise an item whose daily stock is spent", async () => {
    const menu = await readMenu();
    const item = menu.items.find(
      (entry: { id: string }) => entry.id === ids.spentItem,
    );
    expect(item.status).toBe("sold_out");
    expect(item.availableFrom).toBeUndefined();
  });
});

describe("tax price mode and service charge of the menu (WS-03 S4 review)", () => {
  it("legend-49pw: mixed rules give a neutral mode and never claim inclusive", async () => {
    await asTenant(async (db) => {
      await db.query("DELETE FROM tax_rules WHERE tenant_id = $1 AND id = $2", [
        tenant.tenantId,
        ids.duplicateRule,
      ]);
      // Class rule exclusive again; one item gets its own inclusive rule.
      await db.query(
        "UPDATE tax_rules SET price_includes_tax = false WHERE tenant_id = $1 AND id = $2",
        [tenant.tenantId, ids.outletRule],
      );
      await db.query(
        `INSERT INTO tax_rules (id, tenant_id, outlet_id, code, name, tax_type, rate_bp,
           channels, applies_to, price_includes_tax, include_service_in_base, is_active,
           version, effective_from, status, published_at, published_by)
         VALUES ($1, $2, NULL, 'PB1-ITEM', 'PB1 Item', 'pbjt', 800, '[]', $3, true, false,
           true, 1, '2026-01-01', 'published', now(), 'test')`,
        [
          ids.itemRule,
          tenant.tenantId,
          JSON.stringify({
            itemClasses: [],
            categoryIds: [],
            itemIds: [ids.laterItem],
          }),
        ],
      );
    });
    const menu = await readMenu();
    expect(menu.pricing.taxPriceMode).toBe("mixed");
    expect(menu.pricing.pricesIncludeTaxAndService).toBe(false);
    expect(menu.pricing.taxes).toHaveLength(2);
    // Back to a single exclusive rule.
    await asTenant((db) =>
      db.query("DELETE FROM tax_rules WHERE tenant_id = $1 AND id = $2", [
        tenant.tenantId,
        ids.itemRule,
      ]),
    );
    const exclusive = await readMenu();
    expect(exclusive.pricing.taxPriceMode).toBe("exclusive");
    expect(exclusive.pricing.pricesIncludeTaxAndService).toBe(false);
  });

  it("the menu service charge follows the quote: a zone with none falls back to the outlet rule", async () => {
    const zeroToken = signTableQrToken({
      tenantId: tenant.tenantId,
      outletId: tenant.outletId,
      tableId: ids.zeroTable,
    });
    await asTenant(async (db) => {
      await db.query(
        `INSERT INTO floor_zones (id, tenant_id, outlet_id, name, payment_mode,
           service_charge_bp, minimum_spend_idr, hours, status, sort_order)
         VALUES ($1, $2, $3, 'Zona Tanpa Service', 'pay_first', 0, 0, $4, 'active', 1)`,
        [
          ids.zeroZone,
          tenant.tenantId,
          tenant.outletId,
          JSON.stringify([
            { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" },
          ]),
        ],
      );
      await db.query(
        `INSERT INTO tables (id, tenant_id, outlet_id, zone_id, code, capacity, type,
           layout, status, qr_token_hash, qr_token_sealed)
         VALUES ($1, $2, $3, $4, 'W0', 2, 'regular', $5, 'available', $6, 'sealed')`,
        [
          ids.zeroTable,
          tenant.tenantId,
          tenant.outletId,
          ids.zeroZone,
          JSON.stringify({
            x: 80,
            y: 10,
            width: 60,
            height: 60,
            rotation: 0,
            shape: "rect",
          }),
          qrTokenHash(zeroToken),
        ],
      );
    });
    const read = async () =>
      (
        await agent(app)
          .get(`/api/qr/menu/${zeroToken}`)
          .set("Host", tenant.hostname)
          .expect(200)
      ).body.data;
    // No outlet rule yet: nothing is charged, as in the quote.
    expect((await read()).pricing.serviceChargeBp).toBe(0);
    await asTenant((db) =>
      db.query(
        `INSERT INTO service_charge_rules
           (id, tenant_id, outlet_id, code, name, rate_bp, zone_id, order_types, item_classes,
            is_active, version, effective_from, status, published_at, published_by)
         VALUES ($1, $2, $3, 'SC-OUT', 'Service outlet', 500, NULL, '[]', '["food_beverage"]',
           true, 1, '2026-01-01', 'published', now(), 'test')`,
        [ids.serviceRule, tenant.tenantId, tenant.outletId],
      ),
    );
    const menu = await read();
    expect(menu.pricing.serviceChargeBp).toBe(500);
    expect(menu.zone.serviceChargeBp).toBe(500);
    // A zone with its own charge keeps it over the outlet rule.
    const own = await readMenu();
    expect(own.pricing.serviceChargeBp).toBe(500);
  });
});
