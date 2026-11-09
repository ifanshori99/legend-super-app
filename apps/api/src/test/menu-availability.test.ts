// Ketersediaan and channel pricing (bead legend-h2a; PRD v1.7 §8 "Harga per
// Kanal" and "Ketersediaan", §3 F8). Acceptance: ORD-05 (a sold-out item cannot
// be added; an item that sells out at checkout leaves with a clear notice) and
// the bead's TEN-01/TEN-03 criteria for the new outlet-owned counter table.
//
// Real Express app, Better Auth and PostgreSQL with RLS (disposable server from
// `pnpm test`): the pure rule is unit tested, then the integration tests prove
// the effective-date price resolution, the race-safe daily limit, the 86
// deadline sweep + broadcast, and that a guest QR read reflects all three.

import { randomUUID } from "node:crypto";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendFixtures } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { outletIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import {
  evaluateAvailability,
  releaseMenuItemDailyLimit,
  reserveMenuItemDailyLimit,
  withinWindows,
} from "../services/menu-availability";
import {
  readChannelPriceGrid,
  resolveChannelPrices,
} from "../services/menu-pricing.service";
import { getQrMenu } from "../services/guest-menu.service";
import { qrTokenHash, signTableQrToken } from "../services/qr-token";
import { agent, originHeader } from "./helpers";
import { staffWithRole } from "./floor-test-helpers";

const app = createApp();
const { tenant, brand, outlets } = cafeLegendFixtures;
const tenantId = tenant.id;
const brandId = brand.id;
const outletA = outlets[0].id;
const outletB = outlets[1].id;

const ownerPool = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

/** Owner-side writes need the tenant local setting because RLS is FORCED. */
async function asOwnerTenant<T>(
  tenantOfRows: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await ownerPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantOfRows],
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

function scopedContext(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

function outletContext(outletId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );
}

/** Fixed instants so a schedule window is never a moving target. */
const AT_0900_JAKARTA = new Date("2026-03-10T02:00:00.000Z"); // Tue 09:00 WIB
const BUSINESS_DATE = "2026-03-10";

const ids = {
  category: randomUUID(),
  pricedItem: randomUUID(),
  scheduledItem: randomUUID(),
  offScheduleItem: randomUUID(),
  expired86Item: randomUUID(),
  limitedItem: randomUUID(),
  contestedItem: randomUUID(),
  priceListOld: randomUUID(),
  priceListNew: randomUUID(),
  priceListTakeaway: randomUUID(),
  zone: randomUUID(),
  table: randomUUID(),
};
const qrToken = signTableQrToken({
  tenantId,
  outletId: outletA,
  tableId: ids.table,
});

const createdItemIds = [
  ids.pricedItem,
  ids.scheduledItem,
  ids.offScheduleItem,
  ids.expired86Item,
  ids.limitedItem,
  ids.contestedItem,
];
const createdPriceListIds = [
  ids.priceListOld,
  ids.priceListNew,
  ids.priceListTakeaway,
];

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await asOwnerTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Ketersediaan Uji', 0)`,
      [ids.category, tenantId, brandId],
    );
    for (const [id, name, mediaId] of [
      [ids.pricedItem, "Kopi Harga Kanal", randomUUID()],
      [ids.scheduledItem, "Menu Sarapan", randomUUID()],
      [ids.offScheduleItem, "Menu Malam", randomUUID()],
      [ids.expired86Item, "Kopi 86 Selesai", randomUUID()],
      [ids.limitedItem, "Kue Terbatas", randomUUID()],
      [ids.contestedItem, "Kopi Rebutan", randomUUID()],
    ] as const) {
      await client.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
         VALUES ($1, $2, $3, $4, $5, true, $6)`,
        [id, tenantId, brandId, ids.category, name, mediaId],
      );
    }
    // Price versions: two dine-in effective dates, one takeaway list.
    for (const [id, channel, effectiveFrom] of [
      [ids.priceListOld, "dine_in", "2026-01-01"],
      [ids.priceListNew, "dine_in", "2026-02-01"],
      [ids.priceListTakeaway, "takeaway", "2026-01-01"],
    ] as const) {
      await client.query(
        `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, tenantId, outletA, channel, effectiveFrom],
      );
    }
    // Every QR-visible item needs a price in the list in force on 2026-03-10
    // (the read drops an item with no channel price).
    for (const [listId, itemId, price] of [
      [ids.priceListOld, ids.pricedItem, 20_000],
      [ids.priceListNew, ids.pricedItem, 25_000],
      [ids.priceListNew, ids.scheduledItem, 25_000],
      [ids.priceListNew, ids.offScheduleItem, 25_000],
      [ids.priceListNew, ids.expired86Item, 25_000],
      [ids.priceListNew, ids.limitedItem, 25_000],
      [ids.priceListTakeaway, ids.pricedItem, 22_000],
    ] as const) {
      await client.query(
        `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), tenantId, listId, itemId, price],
      );
    }
    // Availability rows: a breakfast window, a night window, an 86 whose
    // deadline already passed, and a daily limit already used up.
    await client.query(
      `INSERT INTO item_availability
         (id, tenant_id, outlet_id, menu_item_id, schedule, daily_limit, sold_out_until, status)
       VALUES
         ($1, $2, $3, $4, $5, NULL, NULL, 'available'),
         ($6, $2, $3, $7, $8, NULL, NULL, 'available'),
         ($9, $2, $3, $10, '[]', NULL, '2026-03-09T02:00:00.000Z', 'sold_out'),
         ($11, $2, $3, $12, '[]', 1, NULL, 'available'),
         ($13, $2, $3, $14, '[]', NULL, NULL, 'available')`,
      [
        randomUUID(),
        tenantId,
        outletA,
        ids.scheduledItem,
        JSON.stringify([{ daysOfWeek: [2], start: "08:00", end: "10:00" }]),
        randomUUID(),
        ids.offScheduleItem,
        JSON.stringify([{ daysOfWeek: [2], start: "18:00", end: "21:00" }]),
        randomUUID(),
        ids.expired86Item,
        randomUUID(),
        ids.limitedItem,
        randomUUID(),
        ids.pricedItem,
      ],
    );
    await client.query(
      `INSERT INTO menu_item_daily_usage
         (id, tenant_id, outlet_id, menu_item_id, business_date, quantity)
       VALUES ($1, $2, $3, $4, $5, 1)`,
      [randomUUID(), tenantId, outletA, ids.limitedItem, BUSINESS_DATE],
    );
    await client.query(
      `INSERT INTO floor_zones
         (id, tenant_id, outlet_id, name, payment_mode, service_charge_bp,
          minimum_spend_idr, hours, status, sort_order)
       VALUES ($1, $2, $3, 'Zona Uji h2a', 'pay_first', 0, 0, $4, 'active', 0)`,
      [
        ids.zone,
        tenantId,
        outletA,
        JSON.stringify([
          { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" },
        ]),
      ],
    );
    await client.query(
      `INSERT INTO tables
         (id, tenant_id, outlet_id, zone_id, code, capacity, type, layout, status,
          qr_token_hash, qr_token_sealed)
       VALUES ($1, $2, $3, $4, 'H2A', 4, 'regular', $5, 'available', $6, 'sealed')`,
      [
        ids.table,
        tenantId,
        outletA,
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
  });
});

afterAll(async () => {
  await asOwnerTenant(tenantId, async (client) => {
    await client.query(
      "DELETE FROM menu_item_daily_usage WHERE tenant_id = $1 AND menu_item_id = ANY($2)",
      [tenantId, createdItemIds],
    );
    await client.query(
      "DELETE FROM item_availability WHERE tenant_id = $1 AND menu_item_id = ANY($2)",
      [tenantId, createdItemIds],
    );
    await client.query(
      "DELETE FROM price_list_items WHERE tenant_id = $1 AND price_list_id = ANY($2)",
      [tenantId, createdPriceListIds],
    );
    await client.query(
      "DELETE FROM price_lists WHERE tenant_id = $1 AND id = ANY($2)",
      [tenantId, createdPriceListIds],
    );
    await client.query("DELETE FROM tables WHERE tenant_id = $1 AND id = $2", [
      tenantId,
      ids.table,
    ]);
    await client.query(
      "DELETE FROM floor_zones WHERE tenant_id = $1 AND id = $2",
      [tenantId, ids.zone],
    );
    await client.query(
      "DELETE FROM menu_items WHERE tenant_id = $1 AND id = ANY($2)",
      [tenantId, createdItemIds],
    );
    await client.query(
      "DELETE FROM menu_categories WHERE tenant_id = $1 AND id = $2",
      [tenantId, ids.category],
    );
  });
  await ownerPool.end();
});

const wind = (daysOfWeek: number[], start: string, end: string) => ({
  daysOfWeek,
  start,
  end,
});

describe("ORD-05 availability rule", () => {
  it("ORD-05 a schedule window follows the outlet time zone, including overnight", () => {
    // 02:00 UTC is 09:00 in Jakarta: inside a 08:00-10:00 Tuesday window.
    expect(
      withinWindows(
        [wind([2], "08:00", "10:00")],
        AT_0900_JAKARTA,
        "Asia/Jakarta",
        "open",
      ),
    ).toBe(true);
    // 02:00 UTC is still Monday 21:00 in New York: outside that window.
    expect(
      withinWindows(
        [wind([2], "08:00", "10:00")],
        new Date("2026-03-10T02:00:00.000Z"),
        "America/New_York",
        "open",
      ),
    ).toBe(false);
    // Friday 22:00-02:00 crosses midnight; Saturday 01:00 WIB (Friday 18:00
    // UTC) is still Friday's window.
    expect(
      withinWindows(
        [wind([5], "22:00", "02:00")],
        new Date("2026-03-13T18:00:00.000Z"),
        "Asia/Jakarta",
        "open",
      ),
    ).toBe(true);
    // An empty schedule is not a restriction for availability, but it never
    // opens a zone.
    expect(withinWindows([], AT_0900_JAKARTA, "Asia/Jakarta", "open")).toBe(
      true,
    );
    expect(withinWindows([], AT_0900_JAKARTA, "Asia/Jakarta", "closed")).toBe(
      false,
    );
  });

  it("ORD-05 86 wins over schedule, schedule over daily stock, and a passed deadline restores", () => {
    const base = {
      schedule: [] as ReturnType<typeof wind>[],
      dailyLimit: null,
      soldToday: 0,
      at: AT_0900_JAKARTA,
      timeZone: "Asia/Jakarta",
    };
    expect(
      evaluateAvailability({
        ...base,
        status: "sold_out",
        soldOutUntil: null,
      }),
    ).toMatchObject({ sellable: false, reason: "sold_out" });
    // A deadline in the future still blocks; a passed one does not.
    expect(
      evaluateAvailability({
        ...base,
        status: "sold_out",
        soldOutUntil: new Date("2026-03-10T03:00:00.000Z"),
      }),
    ).toMatchObject({ sellable: false, soldOut: true });
    expect(
      evaluateAvailability({
        ...base,
        status: "sold_out",
        soldOutUntil: new Date("2026-03-10T01:00:00.000Z"),
      }),
    ).toMatchObject({ sellable: true, reason: "available", soldOut: false });
    // Outside the window, even an unrestricted item does not sell.
    expect(
      evaluateAvailability({
        ...base,
        status: "available",
        soldOutUntil: null,
        schedule: [wind([2], "18:00", "21:00")],
      }),
    ).toMatchObject({ sellable: false, reason: "outside_schedule" });
    // Daily stock: two of three sold is one left; three sold is the limit.
    expect(
      evaluateAvailability({
        ...base,
        status: "available",
        soldOutUntil: null,
        dailyLimit: 3,
        soldToday: 2,
      }),
    ).toMatchObject({ sellable: true, remaining: 1 });
    expect(
      evaluateAvailability({
        ...base,
        status: "available",
        soldOutUntil: null,
        dailyLimit: 3,
        soldToday: 3,
      }),
    ).toMatchObject({ sellable: false, reason: "daily_limit", remaining: 0 });
    // No limit configured: remaining is unknown, not zero.
    expect(
      evaluateAvailability({
        ...base,
        status: "available",
        soldOutUntil: null,
      }),
    ).toMatchObject({ sellable: true, remaining: null });
  });
});

describe("legend-h2a daily limit", () => {
  it("ORD-05 concurrent orders cannot oversell the daily limit", async () => {
    const context = scopedContext();
    // The contested item starts with no availability row at all.
    const attempts = await Promise.all(
      Array.from({ length: 20 }, () =>
        withTenant(db, context, (tx) =>
          reserveMenuItemDailyLimit(tx, context, {
            outletId: outletA,
            menuItemId: ids.contestedItem,
            businessDate: BUSINESS_DATE,
            quantity: 1,
          }),
        ),
      ),
    );
    // No availability row: unlimited, but still counted.
    expect(attempts.every((attempt) => attempt.allowed)).toBe(true);

    // Give it a limit of 5 and race 20 one-unit orders at it.
    await asOwnerTenant(tenantId, async (client) => {
      await client.query(
        `INSERT INTO item_availability
           (id, tenant_id, outlet_id, menu_item_id, schedule, daily_limit, status)
         VALUES ($1, $2, $3, $4, '[]', 5, 'available')`,
        [randomUUID(), tenantId, outletA, ids.contestedItem],
      );
      await client.query(
        `DELETE FROM menu_item_daily_usage
         WHERE tenant_id = $1 AND menu_item_id = $2`,
        [tenantId, ids.contestedItem],
      );
    });
    const contested = await Promise.all(
      Array.from({ length: 20 }, () =>
        withTenant(db, context, (tx) =>
          reserveMenuItemDailyLimit(tx, context, {
            outletId: outletA,
            menuItemId: ids.contestedItem,
            businessDate: BUSINESS_DATE,
            quantity: 1,
          }),
        ),
      ),
    );
    expect(contested.filter((attempt) => attempt.allowed)).toHaveLength(5);
    expect(contested.filter((attempt) => !attempt.allowed)).toHaveLength(15);

    const usage = await asOwnerTenant(tenantId, (client) =>
      client.query<{ quantity: number }>(
        `SELECT quantity FROM menu_item_daily_usage
         WHERE tenant_id = $1 AND menu_item_id = $2 AND business_date = $3`,
        [tenantId, ids.contestedItem, BUSINESS_DATE],
      ),
    );
    expect(usage.rows[0]?.quantity).toBe(5);

    // A release gives a unit back; the very next reservation takes it.
    const released = await withTenant(db, context, (tx) =>
      releaseMenuItemDailyLimit(tx, context, {
        outletId: outletA,
        menuItemId: ids.contestedItem,
        businessDate: BUSINESS_DATE,
        quantity: 1,
      }),
    );
    expect(released).toBe(4);
    const reReserved = await withTenant(db, context, (tx) =>
      reserveMenuItemDailyLimit(tx, context, {
        outletId: outletA,
        menuItemId: ids.contestedItem,
        businessDate: BUSINESS_DATE,
        quantity: 1,
      }),
    );
    expect(reReserved).toMatchObject({ allowed: true, soldToday: 5 });
    // A quantity above the whole limit is refused before touching the counter.
    const oversized = await withTenant(db, context, (tx) =>
      reserveMenuItemDailyLimit(tx, context, {
        outletId: outletA,
        menuItemId: ids.contestedItem,
        businessDate: BUSINESS_DATE,
        quantity: 6,
      }),
    );
    expect(oversized.allowed).toBe(false);
  });

  it("ORD-05 counters are per outlet and per business date", async () => {
    const context = scopedContext();
    // The same item at the second outlet has its own limit and counter.
    await asOwnerTenant(tenantId, async (client) => {
      await client.query(
        `INSERT INTO item_availability
           (id, tenant_id, outlet_id, menu_item_id, schedule, daily_limit, status)
         VALUES ($1, $2, $3, $4, '[]', 2, 'available')`,
        [randomUUID(), tenantId, outletB, ids.contestedItem],
      );
    });
    const atOutletB = await Promise.all(
      Array.from({ length: 3 }, () =>
        withTenant(db, context, (tx) =>
          reserveMenuItemDailyLimit(tx, context, {
            outletId: outletB,
            menuItemId: ids.contestedItem,
            businessDate: BUSINESS_DATE,
            quantity: 1,
          }),
        ),
      ),
    );
    expect(atOutletB.filter((attempt) => attempt.allowed)).toHaveLength(2);
    // A different business date starts from zero.
    const nextDay = await withTenant(db, context, (tx) =>
      reserveMenuItemDailyLimit(tx, context, {
        outletId: outletA,
        menuItemId: ids.contestedItem,
        businessDate: "2026-03-11",
        quantity: 1,
      }),
    );
    expect(nextDay).toMatchObject({ allowed: true, soldToday: 1 });

    await asOwnerTenant(tenantId, async (client) => {
      await client.query(
        `DELETE FROM item_availability
         WHERE tenant_id = $1 AND outlet_id = $2 AND menu_item_id = $3`,
        [tenantId, outletB, ids.contestedItem],
      );
    });
  });

  it("ORD-05 an outlet-scoped context cannot reserve at another outlet", async () => {
    const context = outletContext(outletA);
    await expect(
      withTenant(db, context, (tx) =>
        reserveMenuItemDailyLimit(tx, context, {
          outletId: outletB,
          menuItemId: ids.contestedItem,
          businessDate: BUSINESS_DATE,
          quantity: 1,
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("legend-h2a channel price resolution", () => {
  it("ORD-05 resolves the latest price list effective on the business date, per channel", async () => {
    const context = scopedContext();
    const gridOn = (businessDate: string, channel: "dine_in" | "takeaway") =>
      withTenant(db, context, (tx) =>
        readChannelPriceGrid(tx, context, {
          outletId: outletA,
          channel,
          businessDate,
          itemIds: [ids.pricedItem],
        }),
      );

    const before = await gridOn("2026-01-15", "dine_in");
    expect(before.priceList?.id).toBe(ids.priceListOld);
    expect(before.entries).toContainEqual(
      expect.objectContaining({ itemId: ids.pricedItem, priceIdr: 20_000 }),
    );

    // A list that starts later is not in force yet...
    const later = await gridOn("2026-02-10", "dine_in");
    expect(later.priceList?.id).toBe(ids.priceListNew);
    expect(later.entries).toContainEqual(
      expect.objectContaining({ itemId: ids.pricedItem, priceIdr: 25_000 }),
    );
    // ...and one that starts after the asked date is ignored.
    const january = await gridOn("2026-01-31", "dine_in");
    expect(january.priceList?.id).toBe(ids.priceListOld);

    // Channels resolve independently: takeaway has its own list.
    const takeaway = await gridOn("2026-02-10", "takeaway");
    expect(takeaway.priceList?.id).toBe(ids.priceListTakeaway);
    expect(takeaway.entries).toContainEqual(
      expect.objectContaining({ itemId: ids.pricedItem, priceIdr: 22_000 }),
    );

    // The permission-gated entry resolves from the real clock (both lists are
    // effective today, so the newer one wins).
    const staff = await staffWithRole(app, {
      template: "outlet_manager",
      scopeType: "outlet",
      scopeId: outletA,
    });
    const resolved = await resolveChannelPrices(scopedContext(), staff.userId, {
      outletId: outletA,
      channel: "dine_in",
    });
    expect(resolved.priceList?.id).toBe(ids.priceListNew);
    expect(resolved.entries).toContainEqual(
      expect.objectContaining({ itemId: ids.pricedItem, priceIdr: 25_000 }),
    );
  });

  it("ORD-05 a role without menu.price.view cannot read the price grid", async () => {
    const cashier = await staffWithRole(app, {
      template: "cashier",
      scopeType: "outlet",
      scopeId: outletA,
    });
    await expect(
      resolveChannelPrices(
        scopedContext(),
        cashier.userId,
        { outletId: outletA, channel: "dine_in" },
        AT_0900_JAKARTA,
      ),
    ).rejects.toThrow(/PERMISSION|izin/i);
  });
});

describe("legend-h2a 86 deadline broadcast", () => {
  it("ORD-05 the availability board restores an expired 86 once and broadcasts item.restored", async () => {
    const manager = await staffWithRole(app, {
      template: "outlet_manager",
      scopeType: "outlet",
      scopeId: outletA,
    });
    const expired = await asOwnerTenant(tenantId, (client) =>
      client.query<{ id: string }>(
        `SELECT id FROM item_availability
         WHERE tenant_id = $1 AND menu_item_id = $2`,
        [tenantId, ids.expired86Item],
      ),
    );
    const availabilityId = expired.rows[0]?.id as string;
    const before = await asOwnerTenant(tenantId, (client) =>
      client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM domain_event_outbox
         WHERE tenant_id = $1 AND event->>'name' = 'item.restored'
           AND event->'payload'->>'availabilityId' = $2`,
        [tenantId, availabilityId],
      ),
    );
    expect(before.rows[0]?.count).toBe("0");

    const listed = await manager.client
      .get(`/api/menu/availability?limit=100&outletId=${outletA}`)
      .expect(200);
    const row = (
      listed.body.data as {
        id: string;
        status: string;
        soldOutUntil: unknown;
      }[]
    ).find((entry) => entry.id === availabilityId);
    expect(row).toMatchObject({ status: "available", soldOutUntil: null });

    const restored = await asOwnerTenant(tenantId, (client) =>
      client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM domain_event_outbox
         WHERE tenant_id = $1 AND event->>'name' = 'item.restored'
           AND event->'payload'->>'availabilityId' = $2`,
        [tenantId, availabilityId],
      ),
    );
    expect(restored.rows[0]?.count).toBe("1");

    // A second read restores nothing and emits no second event.
    await manager.client
      .get(`/api/menu/availability?limit=100&outletId=${outletA}`)
      .expect(200);
    const again = await asOwnerTenant(tenantId, (client) =>
      client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM domain_event_outbox
         WHERE tenant_id = $1 AND event->>'name' = 'item.restored'
           AND event->'payload'->>'availabilityId' = $2`,
        [tenantId, availabilityId],
      ),
    );
    expect(again.rows[0]?.count).toBe("1");

    // Concurrent board reads race the same expired 86: the sweep locks with
    // SKIP LOCKED, so exactly one transaction restores it and one event leaves.
    await asOwnerTenant(tenantId, (client) =>
      client.query(
        `UPDATE item_availability
         SET status = 'sold_out', sold_out_until = now() - interval '1 minute'
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, availabilityId],
      ),
    );
    await Promise.all(
      Array.from({ length: 6 }, () =>
        manager.client
          .get(`/api/menu/availability?limit=100&outletId=${outletA}`)
          .expect(200),
      ),
    );
    const raced = await asOwnerTenant(tenantId, (client) =>
      client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM domain_event_outbox
         WHERE tenant_id = $1 AND event->>'name' = 'item.restored'
           AND event->'payload'->>'availabilityId' = $2`,
        [tenantId, availabilityId],
      ),
    );
    expect(raced.rows[0]?.count).toBe("2");
  });
});

describe("legend-h2a guest QR availability", () => {
  it("ORD-05 the QR menu reports schedule, daily limit and a passed 86 to the guest", async () => {
    const menu = await getQrMenu(scopedContext(), qrToken, AT_0900_JAKARTA);
    const statusOf = (itemId: string) =>
      menu.items.find((item) => item.id === itemId)?.status;
    // 09:00 Tuesday: inside the breakfast window, outside the night window.
    expect(statusOf(ids.scheduledItem)).toBe("available");
    // legend-nx3f: outside its window but the 18:00 window opens later today.
    const offSchedule = menu.items.find(
      (item) => item.id === ids.offScheduleItem,
    );
    expect(offSchedule?.status).toBe("unavailable_until");
    expect(offSchedule?.availableFrom).toBe("2026-03-10T11:00:00.000Z"); // 18:00 WIB
    // The 86 deadline passed an hour ago: the item sells again.
    expect(statusOf(ids.expired86Item)).toBe("available");
    // Daily limit 1, one already sold today: nothing left.
    expect(statusOf(ids.limitedItem)).toBe("sold_out");
    // An unrestricted item with a price is available.
    expect(statusOf(ids.pricedItem)).toBe("available");
  });
});

describe("legend-h2a tenancy guards", () => {
  it("ORD-05 a rejected reservation never leaks an oversold row to a concurrent reader", async () => {
    // The counter row is the single source of truth the order service reads
    // before quoting a guest (ORD-05); after the race above it holds the limit.
    const usage = await asOwnerTenant(tenantId, (client) =>
      client.query<{ quantity: number }>(
        `SELECT quantity FROM menu_item_daily_usage
         WHERE tenant_id = $1 AND menu_item_id = $2 AND business_date = $3
           AND outlet_id = $4`,
        [tenantId, ids.contestedItem, BUSINESS_DATE, outletA],
      ),
    );
    expect(usage.rows.length).toBe(1);
    expect(usage.rows[0]?.quantity).toBe(5);
    // And an anonymous caller still cannot reach the admin availability board.
    expect((await agent(app).get("/api/menu/availability")).status).toBe(401);
    const injected = await agent(app)
      .post(
        "/api/menu/availability/00000000-0000-4000-8000-000000000000/status",
      )
      .set(originHeader)
      .send({ action: "sell_out", idempotencyKey: "x" });
    expect(injected.status).toBe(401);
  });
});
