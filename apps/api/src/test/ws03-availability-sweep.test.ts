// WS-03 S5 (legend-2nb9): an outlet created after menu items exist gets an
// item_availability row for every live item of its brand, so its 86 screen
// lists them on day one. Real PostgreSQL with RLS (disposable server from
// `pnpm test`).

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendFixtures } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { CreateOutletInput } from "@starter/shared/platform";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { restoreExpiredSoldOut } from "../services/menu-availability";
import { createOutlet } from "../services/org.service";

const { tenant, brand, outlets } = cafeLegendFixtures;
const tenantId = tenant.id;
const brandId = brand.id;

const ownerPool = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const ids = {
  category: randomUUID(),
  liveItem: randomUUID(),
  inactiveItem: randomUUID(),
  deletedItem: randomUUID(),
  expiredA: randomUUID(),
  expiredB: randomUUID(),
  stillSoldOut: randomUUID(),
};

const HOURS = { opens: "08:00", closes: "22:00" };

async function asOwnerTenant<T>(
  run: (query: Pool["query"]) => Promise<T>,
): Promise<T> {
  const client = await ownerPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client.query.bind(client) as Pool["query"]);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await asOwnerTenant(async (query) => {
    await query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Sapuan Uji', 0)`,
      [ids.category, tenantId, brandId],
    );
    for (const [id, name, active, deleted] of [
      [ids.liveItem, "Kopi Sapuan", true, false],
      [ids.inactiveItem, "Teh Nonaktif", false, false],
      [ids.deletedItem, "Roti Terhapus", true, true],
      [ids.expiredA, "Kopi 86 Lewat A", true, false],
      [ids.expiredB, "Kopi 86 Lewat B", true, false],
      [ids.stillSoldOut, "Kopi 86 Masih", true, false],
    ] as const) {
      await query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id, deleted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, ${deleted ? "now()" : "NULL"})`,
        [id, tenantId, brandId, ids.category, name, active, randomUUID()],
      );
    }
    // Availability rows seeded by hand: two lapsed 86s on two outlets and one
    // 86 whose deadline is still ahead.
    for (const [itemId, outletId, until] of [
      [ids.expiredA, outlets[0].id, "2000-01-01T00:00:00.000Z"],
      [ids.expiredB, outlets[1].id, "2000-01-01T00:00:00.000Z"],
      [ids.stillSoldOut, outlets[0].id, "2999-01-01T00:00:00.000Z"],
    ] as const) {
      await query(
        `INSERT INTO item_availability
           (id, tenant_id, outlet_id, menu_item_id, schedule, sold_out_until, status)
         VALUES ($1, $2, $3, $4, '[]', $5, 'sold_out')`,
        [randomUUID(), tenantId, outletId, itemId, until],
      );
    }
  });
});

afterAll(async () => {
  await ownerPool.end();
});

describe("createOutlet availability seed (legend-2nb9)", () => {
  it("seeds a row per existing brand item, none for deleted ones", async () => {
    const legalEntityId = await asOwnerTenant(async (query) => {
      const res = await query(
        "SELECT legal_entity_id FROM outlets WHERE id = $1",
        [outlets[0].id],
      );
      return String(res.rows[0].legal_entity_id);
    });
    const context = establishScopedTenantContext(
      establishTenantContext({ tenantId, brandId: null, source: "session" }),
      { kind: "tenant" },
    );
    const outlet = await createOutlet(context, {
      brandId,
      legalEntityId,
      code: `SAPU-${randomUUID().slice(0, 6)}`.toUpperCase(),
      name: "Outlet Sapuan",
      address: "Jl. Uji No. 2, Kota Bandung",
      regionId: null,
      geofence: null,
      timeZone: "Asia/Jakarta",
      businessDayCutoff: undefined,
      openingHours: {
        mon: HOURS,
        tue: HOURS,
        wed: HOURS,
        thu: HOURS,
        fri: HOURS,
        sat: HOURS,
        sun: HOURS,
      },
    } as unknown as CreateOutletInput);

    const rows = await asOwnerTenant(async (query) => {
      const res = await query(
        `SELECT menu_item_id, status, daily_limit, sold_out_until
           FROM item_availability WHERE outlet_id = $1`,
        [outlet.id],
      );
      return res.rows;
    });
    const seeded = rows.map((row) => String(row.menu_item_id));
    expect(seeded).toContain(ids.liveItem);
    expect(seeded).toContain(ids.inactiveItem);
    expect(seeded).not.toContain(ids.deletedItem);
    for (const row of rows) {
      expect(row.status).toBe("available");
      expect(row.daily_limit).toBeNull();
      expect(row.sold_out_until).toBeNull();
    }
    const itemCount = await asOwnerTenant(async (query) => {
      const res = await query(
        `SELECT count(*)::int AS n FROM menu_items
          WHERE brand_id = $1 AND deleted_at IS NULL`,
        [brandId],
      );
      return Number(res.rows[0].n);
    });
    expect(rows).toHaveLength(itemCount);
  });
});

describe("worker 86 sweep (legend-1am2)", () => {
  it("restores lapsed 86s tenant-wide with the system actor, once", async () => {
    const context = establishScopedTenantContext(
      establishTenantContext({ tenantId, brandId: null, source: "job" }),
      { kind: "tenant" },
    );
    const restoredCount = await withTenant(db, context, (tx) =>
      restoreExpiredSoldOut(tx, context, {
        actorUserId: null,
        now: new Date(),
      }),
    );
    expect(restoredCount).toBeGreaterThanOrEqual(2);

    const state = await asOwnerTenant(async (query) => {
      const res = await query(
        `SELECT menu_item_id, status, sold_out_until FROM item_availability
          WHERE menu_item_id = ANY($1::uuid[]) AND outlet_id = ANY($2::uuid[])`,
        [
          [ids.expiredA, ids.expiredB, ids.stillSoldOut],
          [outlets[0].id, outlets[1].id],
        ],
      );
      const events = await query(
        `SELECT event->'actor' AS actor, event->'payload'->>'itemId' AS item_id,
                event->>'outletId' AS outlet_id
           FROM domain_event_outbox
          WHERE tenant_id = $1 AND event->>'name' = 'item.restored'
            AND event->'payload'->>'itemId' = ANY($2::text[])`,
        [tenantId, [ids.expiredA, ids.expiredB]],
      );
      return { rows: res.rows, events: events.rows };
    });
    const byItem = new Map(
      state.rows.map((row) => [String(row.menu_item_id), row]),
    );
    expect(byItem.get(ids.expiredA)).toMatchObject({
      status: "available",
      sold_out_until: null,
    });
    expect(byItem.get(ids.expiredB)).toMatchObject({
      status: "available",
      sold_out_until: null,
    });
    expect(byItem.get(ids.stillSoldOut)?.status).toBe("sold_out");
    // One item.restored per restored row, all with the system actor, each
    // addressed to the row's own outlet.
    expect(state.events).toHaveLength(2);
    for (const event of state.events)
      expect(event.actor).toEqual({ type: "system" });
    expect(new Map(state.events.map((e) => [e.item_id, e.outlet_id]))).toEqual(
      new Map([
        [ids.expiredA, outlets[0].id],
        [ids.expiredB, outlets[1].id],
      ]),
    );

    // A second sweep restores nothing more of these rows.
    const second = await withTenant(db, context, (tx) =>
      restoreExpiredSoldOut(tx, context, {
        actorUserId: null,
        now: new Date(),
      }),
    );
    expect(second).toBe(0);
  });
});
