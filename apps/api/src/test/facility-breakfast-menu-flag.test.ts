// Breakfast menu flag (bead legend-lgyfh; follow-up TODO(oa0qk) of the
// breakfast-from-ticket feature). Written from the brief (scratchpad brief-987.md
// section legend-lgyfh), the shared contract (`@starter/shared/facility`
// breakfast schemas, `@starter/shared/menu` admin DTOs) and the existing
// breakfast fixtures, never from the implementation.
//
// Decision under test (CTO fallback rule, brief 987b B1): the breakfast menu
// uses the flag `isBreakfast` (column `menu_items.is_breakfast`, default false)
// only once an outlet has opted in.
//   - LEGACY state: no active, non-deleted item in the outlet's menu scope
//     (same tenant / brand / outlet visibility as the breakfast menu) is flagged.
//     Old behaviour: every item the flow showed before the flag is listed and
//     orderable; nothing is rejected for being unflagged.
//   - FLAGGED state: >= 1 such item is flagged. Only flagged items are listed;
//     unflagged ids are rejected (409). The same rule drives the order path.
//   LGYFH-01 flagged + active item shows in the member breakfast menu and orders
//   LGYFH-02 flagged state: unflagged (or inactive) item is absent from the menu
//            and an order line with it is rejected, whole order refused
//   LGYFH-03 legacy state (zero flagged): everything shows, unflagged orderable;
//            flagged state: only flagged, unflagged 409; flipping the first flag
//            switches state, unflagging the last returns to legacy; flags of
//            another tenant/brand and inactive/deleted flagged items do not count
//   LGYFH-04 other tenant / other brand item ids are rejected
//   LGYFH-05 admin menu API: create/update/read `isBreakfast`, strict boolean,
//            and the flag drives the member menu; other tenants cannot flip it
//
// Assumptions (ambiguous in the brief):
// - The order path rejects a non-breakfast item with "the same error class as
//   an unavailable item". The exact status/code is not in the contract, so the
//   tests accept 404, 409 or 422 (never 201, never 5xx) and assert that nothing
//   was created for the ticket instead of pinning one code. The service answers
//   409 CONFLICT, the same as an unavailable item (resolveLine "sold_out").
// - The admin DTO field is named `isBreakfast` (boolean) in create input,
//   update input and the admin item response, next to `isActive`.
// - Admin items are created as inactive drafts (Q23 photo rule), so the "flag
//   drives the member menu" cases flip the flag on already active seeded items
//   with PATCH instead of creating a published item.
// - The shared fixture `facility-breakfast-helpers.ts` seeds its two items
//   (nasi, kopi) WITH the flag, so a fresh world is in the flagged state. To get
//   the legacy state a test builds its own world and resets both flags to false.
// - "Legacy menu" is asserted with `toContain` for the active priced items of the
//   outlet (the exact legacy list is not pinned) and `not.toContain` for
//   inactive/deleted items, which the old flow never showed either (assumption).
// - Rejection in the flagged state is pinned to 409 (brief: "409, as now").

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import { staffOfIsolatedTenant, type Staff } from "./floor-test-helpers.ts";
import {
  asOwnerTenant,
  breakfastBody,
  createBreakfastWorld,
  dropBreakfastWorld,
  endPools,
  installGateway,
  memberApi,
  newMember,
  owner,
  removeGateway,
  seedTicket,
  type BreakfastWorld,
} from "./facility-breakfast-helpers.ts";

let app: Express;
let world: BreakfastWorld; // main tenant
let other: BreakfastWorld; // a second, isolated tenant
const extraWorlds: BreakfastWorld[] = []; // per-test worlds, dropped in afterAll
let admin: Staff; // menu admin of `world`
let otherAdmin: Staff; // menu admin of `other`

/** Rejection of an order line the breakfast menu does not offer. */
const REJECTED = [404, 409, 422];

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  installGateway();
  world = await createBreakfastWorld(app);
  other = await createBreakfastWorld(app);
  admin = await menuAdminOf(world);
  otherAdmin = await menuAdminOf(other);
});

afterAll(async () => {
  removeGateway();
  for (const w of [world, other, ...extraWorlds]) await dropBreakfastWorld(w);
  await endPools();
});

/** A staff account of the world's tenant that may manage menu items. */
async function menuAdminOf(w: BreakfastWorld): Promise<Staff> {
  // The role is widened before the account is created so no grant is stale.
  await owner.query(
    `UPDATE roles SET permissions = permissions || '["menu.item.view","menu.item.manage"]'::jsonb WHERE id = $1`,
    [w.tenant.roleId],
  );
  return staffOfIsolatedTenant(app, w.tenant);
}

/** A new world in the legacy state: none of its items is flagged. */
async function createLegacyWorld(): Promise<BreakfastWorld> {
  const w = await createBreakfastWorld(app);
  extraWorlds.push(w);
  await asOwnerTenant(w.tenant.tenantId, (client) =>
    client.query(
      `UPDATE menu_items SET is_breakfast = false WHERE id = ANY($1::uuid[])`,
      [[w.ids.nasi, w.ids.kopi]],
    ),
  );
  for (const id of [w.ids.nasi, w.ids.kopi])
    expect(await flagOf(w, id)).toBe(false);
  return w;
}

async function setFlag(w: BreakfastWorld, itemId: string, value: boolean) {
  await asOwnerTenant(w.tenant.tenantId, (client) =>
    client.query(
      `UPDATE menu_items SET is_breakfast = $3 WHERE tenant_id = $1 AND id = $2`,
      [w.tenant.tenantId, itemId, value],
    ),
  );
}

async function orderOne(w: BreakfastWorld, itemId: string) {
  const { ticketId, api } = await newTicket(w);
  return api.create(
    ticketId,
    breakfastBody(w, { lines: [{ menuItemId: itemId, quantity: 1 }] }),
  );
}

async function menuIdsOf(w: BreakfastWorld): Promise<string[]> {
  const { ticketId, api } = await newTicket(w);
  return (await menuItems(api, ticketId)).map((item) => item.id);
}

type SeedOptions = {
  name: string;
  price?: number;
  active?: boolean;
  /** undefined: the column is not written, so the database default applies. */
  breakfast?: boolean;
  brandId?: string;
};

/** Inserts a menu item (with a price) in the world's tenant; returns its id. */
async function seedItem(
  w: BreakfastWorld,
  options: SeedOptions,
): Promise<string> {
  const id = randomUUID();
  const price = options.price ?? 20_000;
  await asOwnerTenant(w.tenant.tenantId, async (client) => {
    const brandId = options.brandId ?? w.tenant.brandId;
    let categoryId: string;
    if (options.brandId === undefined) {
      const { rows } = await client.query<{ category_id: string }>(
        `SELECT category_id FROM menu_items WHERE id = $1`,
        [w.ids.nasi],
      );
      categoryId = rows[0]!.category_id;
    } else {
      categoryId = randomUUID();
      await client.query(
        `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
         VALUES ($1, $2, $3, 'Kategori Merek Lain', 0)`,
        [categoryId, w.tenant.tenantId, brandId],
      );
    }
    const columns = [
      "id",
      "tenant_id",
      "brand_id",
      "category_id",
      "name",
      "is_active",
      "media_id",
      "station_id",
      "station_type",
    ];
    const values: unknown[] = [
      id,
      w.tenant.tenantId,
      brandId,
      categoryId,
      options.name,
      options.active ?? true,
      randomUUID(),
      w.ids.station,
      "hot_kitchen",
    ];
    if (options.breakfast !== undefined) {
      columns.push("is_breakfast");
      values.push(options.breakfast);
    }
    await client.query(
      `INSERT INTO menu_items (${columns.join(", ")})
       VALUES (${values.map((_, index) => `$${index + 1}`).join(", ")})`,
      values,
    );
    const { rows: lists } = await client.query<{ id: string }>(
      `SELECT id FROM price_lists WHERE tenant_id = $1 AND outlet_id = $2 LIMIT 1`,
      [w.tenant.tenantId, w.tenant.outletId],
    );
    await client.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), w.tenant.tenantId, lists[0]!.id, id, price],
    );
  });
  return id;
}

async function flagOf(w: BreakfastWorld, itemId: string): Promise<boolean> {
  return asOwnerTenant(w.tenant.tenantId, async (client) => {
    const { rows } = await client.query<{ is_breakfast: boolean }>(
      `SELECT is_breakfast FROM menu_items WHERE tenant_id = $1 AND id = $2`,
      [w.tenant.tenantId, itemId],
    );
    return rows[0]!.is_breakfast;
  });
}

async function newTicket(w: BreakfastWorld) {
  const member = await newMember(w);
  const ticketId = await seedTicket(w, member);
  return { member, ticketId, api: memberApi(w, member) };
}

type MenuItemView = { id: string; name: string; priceIdr: number };

async function menuItems(
  api: ReturnType<typeof memberApi>,
  ticketId: string,
): Promise<MenuItemView[]> {
  const response = await api.menu(ticketId);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data.items as MenuItemView[];
}

const adminCall = (w: BreakfastWorld, staff: Staff) => ({
  get: (path: string) => staff.client.get(path).set(w.headers),
  post: (path: string, body: Record<string, unknown>) =>
    staff.client.post(path).set(w.headers).set(originHeader).send(body),
  patch: (path: string, body: Record<string, unknown>) =>
    staff.client.patch(path).set(w.headers).set(originHeader).send(body),
});

describe("legend-lgyfh breakfast menu flag: member menu and order", () => {
  it("LGYFH-01 a flagged active item shows in the breakfast menu with its price and can be ordered", async () => {
    const id = await seedItem(world, {
      name: "Bubur Ayam Sarapan",
      price: 22_000,
      breakfast: true,
    });
    const { ticketId, api } = await newTicket(world);

    const items = await menuItems(api, ticketId);
    expect(items.find((item) => item.id === id)).toEqual({
      id,
      name: "Bubur Ayam Sarapan",
      priceIdr: 22_000,
    });

    const created = await api.create(
      ticketId,
      breakfastBody(world, { lines: [{ menuItemId: id, quantity: 2 }] }),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.lines).toEqual([
      expect.objectContaining({ menuItemId: id, quantity: 2 }),
    ]);
  });

  it("LGYFH-02 an unflagged item is absent from the menu and an order line with it is rejected", async () => {
    const flagged = await seedItem(world, {
      name: "Roti Bakar",
      breakfast: true,
    });
    const unflagged = await seedItem(world, {
      name: "Steak Malam",
      breakfast: false,
    });
    const { ticketId, api } = await newTicket(world);

    const items = await menuItems(api, ticketId);
    expect(items.map((item) => item.id)).toContain(flagged);
    expect(items.map((item) => item.id)).not.toContain(unflagged);
    expect(items.map((item) => item.name)).not.toContain("Steak Malam");

    const rejected = await api.create(
      ticketId,
      breakfastBody(world, { lines: [{ menuItemId: unflagged, quantity: 1 }] }),
    );
    expect(REJECTED, JSON.stringify(rejected.body)).toContain(rejected.status);
    expect(rejected.body.error.code).toEqual(expect.any(String));
  });

  it("LGYFH-02 one unflagged line refuses the whole order; nothing is created and a valid order still works", async () => {
    const flagged = await seedItem(world, {
      name: "Telur Dadar",
      breakfast: true,
    });
    const unflagged = await seedItem(world, {
      name: "Iga Bakar",
      breakfast: false,
    });
    const { ticketId, api } = await newTicket(world);

    const mixed = await api.create(
      ticketId,
      breakfastBody(world, {
        lines: [
          { menuItemId: flagged, quantity: 1 },
          { menuItemId: unflagged, quantity: 1 },
        ],
      }),
    );
    expect(REJECTED, JSON.stringify(mixed.body)).toContain(mixed.status);

    // No half order was created: the ticket shows no order and takes a new one.
    const menu = await api.menu(ticketId);
    expect(menu.body.data.order).toBeNull();
    const ok = await api.create(
      ticketId,
      breakfastBody(world, { lines: [{ menuItemId: flagged, quantity: 1 }] }),
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it("LGYFH-02 a flagged but inactive item stays out of the menu and cannot be ordered", async () => {
    const hidden = await seedItem(world, {
      name: "Menu Dimatikan",
      breakfast: true,
      active: false,
    });
    const { ticketId, api } = await newTicket(world);

    expect(
      (await menuItems(api, ticketId)).map((item) => item.id),
    ).not.toContain(hidden);
    const rejected = await api.create(
      ticketId,
      breakfastBody(world, { lines: [{ menuItemId: hidden, quantity: 1 }] }),
    );
    expect(REJECTED, JSON.stringify(rejected.body)).toContain(rejected.status);
  });

  it("LGYFH-03 default is false: an item created without the flag stores false", async () => {
    const id = await seedItem(world, { name: "Menu Lama" }); // column not written
    expect(await flagOf(world, id)).toBe(false);
  });

  it("LGYFH-03 legacy state (zero flagged): every active item shows and an unflagged item can be ordered", async () => {
    const legacy = await createLegacyWorld();
    const extra = await seedItem(legacy, { name: "Menu Lama", price: 18_000 });
    const inactive = await seedItem(legacy, {
      name: "Menu Mati",
      active: false,
    });
    expect(await flagOf(legacy, extra)).toBe(false);

    const { ticketId, api } = await newTicket(legacy);
    const items = await menuItems(api, ticketId);
    const ids = items.map((item) => item.id);
    expect(ids).toEqual(
      expect.arrayContaining([legacy.ids.nasi, legacy.ids.kopi, extra]),
    );
    expect(items.find((item) => item.id === extra)).toEqual({
      id: extra,
      name: "Menu Lama",
      priceIdr: 18_000,
    });
    expect(ids).not.toContain(inactive);

    // Old behaviour: the unflagged item is not rejected.
    const created = await api.create(
      ticketId,
      breakfastBody(legacy, { lines: [{ menuItemId: extra, quantity: 1 }] }),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    // An inactive item stays unorderable, as before the flag existed.
    const rejected = await orderOne(legacy, inactive);
    expect(REJECTED, JSON.stringify(rejected.body)).toContain(rejected.status);
  });

  it("LGYFH-03 flagged state (>= 1 flagged): only flagged items show and an unflagged id is rejected with 409", async () => {
    const flagged = await seedItem(world, {
      name: "Hanya Ini",
      breakfast: true,
    });
    const unflagged = await seedItem(world, { name: "Bukan Sarapan" });
    expect(await menuIdsOf(world)).toEqual(
      expect.arrayContaining([world.ids.nasi, world.ids.kopi, flagged]),
    );
    expect(await menuIdsOf(world)).not.toContain(unflagged);

    const rejected = await orderOne(world, unflagged);
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(409);
  });

  it("LGYFH-03 flagging the first item switches the outlet to the flagged state; unflagging the last returns to legacy", async () => {
    const legacy = await createLegacyWorld();
    const first = await seedItem(legacy, { name: "Item Pertama" });
    const second = await seedItem(legacy, { name: "Item Kedua" });

    // Legacy: all show, unflagged orderable.
    expect(await menuIdsOf(legacy)).toEqual(
      expect.arrayContaining([legacy.ids.nasi, first, second]),
    );

    // Flag the first item: only it shows, every other id is rejected (409).
    await setFlag(legacy, first, true);
    expect(await menuIdsOf(legacy)).toEqual([first]);
    expect((await orderOne(legacy, second)).status).toBe(409);
    expect((await orderOne(legacy, legacy.ids.nasi)).status).toBe(409);
    expect((await orderOne(legacy, first)).status).toBe(201);

    // A second flag widens the menu but stays in the flagged state.
    await setFlag(legacy, second, true);
    expect((await menuIdsOf(legacy)).sort()).toEqual([first, second].sort());
    expect((await orderOne(legacy, legacy.ids.kopi)).status).toBe(409);

    // Unflag one: still flagged state. Unflag the last: back to legacy.
    await setFlag(legacy, second, false);
    expect(await menuIdsOf(legacy)).toEqual([first]);
    await setFlag(legacy, first, false);
    expect(await menuIdsOf(legacy)).toEqual(
      expect.arrayContaining([legacy.ids.nasi, legacy.ids.kopi, first, second]),
    );
    expect((await orderOne(legacy, second)).status).toBe(201);
  });

  it("LGYFH-03 a flag in another tenant or another brand does not switch this outlet to the flagged state", async () => {
    const legacy = await createLegacyWorld();
    const mine = await seedItem(legacy, { name: "Item Saya" });
    await seedItem(other, { name: "Tenant Lain Ditandai", breakfast: true });
    const brandId = randomUUID();
    await asOwnerTenant(legacy.tenant.tenantId, (client) =>
      client.query(
        `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Merek Lain')`,
        [brandId, legacy.tenant.tenantId, `merek-${brandId.slice(0, 8)}`],
      ),
    );
    await seedItem(legacy, {
      name: "Merek Lain Ditandai",
      breakfast: true,
      brandId,
    });

    expect(await menuIdsOf(legacy)).toEqual(
      expect.arrayContaining([legacy.ids.nasi, legacy.ids.kopi, mine]),
    );
    expect((await orderOne(legacy, mine)).status).toBe(201);
  });

  it("LGYFH-03 a flagged item that is inactive or deleted does not count as flagged", async () => {
    const legacy = await createLegacyWorld();
    const mine = await seedItem(legacy, { name: "Item Aktif" });
    await seedItem(legacy, {
      name: "Ditandai Tapi Mati",
      breakfast: true,
      active: false,
    });
    const deleted = await seedItem(legacy, {
      name: "Ditandai Tapi Dihapus",
      breakfast: true,
    });
    await asOwnerTenant(legacy.tenant.tenantId, (client) =>
      client.query(
        `UPDATE menu_items SET deleted_at = now() WHERE tenant_id = $1 AND id = $2`,
        [legacy.tenant.tenantId, deleted],
      ),
    );

    const ids = await menuIdsOf(legacy);
    expect(ids).toEqual(
      expect.arrayContaining([legacy.ids.nasi, legacy.ids.kopi, mine]),
    );
    expect(ids).not.toContain(deleted);
    expect((await orderOne(legacy, mine)).status).toBe(201);
  });

  it("LGYFH-04 an item id of another tenant is rejected even when that item is flagged", async () => {
    const foreign = await seedItem(other, {
      name: "Menu Tenant Lain",
      breakfast: true,
    });
    const { ticketId, api } = await newTicket(world);

    expect(
      (await menuItems(api, ticketId)).map((item) => item.id),
    ).not.toContain(foreign);
    const rejected = await api.create(
      ticketId,
      breakfastBody(world, { lines: [{ menuItemId: foreign, quantity: 1 }] }),
    );
    expect(REJECTED, JSON.stringify(rejected.body)).toContain(rejected.status);
  });

  it("LGYFH-04 a flagged item of another brand of the same tenant is rejected and not listed", async () => {
    const brandId = randomUUID();
    await asOwnerTenant(world.tenant.tenantId, (client) =>
      client.query(
        `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Merek Lain')`,
        [brandId, world.tenant.tenantId, `merek-${brandId.slice(0, 8)}`],
      ),
    );
    const foreign = await seedItem(world, {
      name: "Menu Merek Lain",
      breakfast: true,
      brandId,
    });
    const { ticketId, api } = await newTicket(world);

    expect(
      (await menuItems(api, ticketId)).map((item) => item.id),
    ).not.toContain(foreign);
    const rejected = await api.create(
      ticketId,
      breakfastBody(world, { lines: [{ menuItemId: foreign, quantity: 1 }] }),
    );
    expect(REJECTED, JSON.stringify(rejected.body)).toContain(rejected.status);
  });
});

describe("legend-lgyfh breakfast menu flag: admin menu API", () => {
  it("LGYFH-05 create defaults isBreakfast to false and stores true when sent", async () => {
    const api = adminCall(world, admin);
    const { rows } = await asOwnerTenant(world.tenant.tenantId, (client) =>
      client.query<{ category_id: string }>(
        `SELECT category_id FROM menu_items WHERE id = $1`,
        [world.ids.nasi],
      ),
    );
    const categoryId = rows[0]!.category_id;

    const plain = await api.post("/api/menu/items", {
      brandId: world.tenant.brandId,
      categoryId,
      name: "Item Tanpa Tanda",
    });
    expect(plain.status, JSON.stringify(plain.body)).toBe(201);
    expect(plain.body.data.isBreakfast).toBe(false);

    const flagged = await api.post("/api/menu/items", {
      brandId: world.tenant.brandId,
      categoryId,
      name: "Item Sarapan Baru",
      isBreakfast: true,
    });
    expect(flagged.status, JSON.stringify(flagged.body)).toBe(201);
    expect(flagged.body.data.isBreakfast).toBe(true);

    const read = await api.get(`/api/menu/items/${flagged.body.data.id}`);
    expect(read.status).toBe(200);
    expect(read.body.data.isBreakfast).toBe(true);
    expect(await flagOf(world, flagged.body.data.id)).toBe(true);
  });

  it("LGYFH-05 flipping the flag with PATCH adds the item to, then removes it from, the member menu", async () => {
    const id = await seedItem(world, { name: "Pancake Uji", price: 35_000 });
    const api = adminCall(world, admin);
    const { ticketId, api: member } = await newTicket(world);
    expect(
      (await menuItems(member, ticketId)).map((item) => item.id),
    ).not.toContain(id);

    const on = await api.patch(`/api/menu/items/${id}`, { isBreakfast: true });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body.data.isBreakfast).toBe(true);
    expect(
      (await menuItems(member, ticketId)).find((item) => item.id === id),
    ).toEqual({ id, name: "Pancake Uji", priceIdr: 35_000 });

    const off = await api.patch(`/api/menu/items/${id}`, {
      isBreakfast: false,
    });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body.data.isBreakfast).toBe(false);
    expect(
      (await menuItems(member, ticketId)).map((item) => item.id),
    ).not.toContain(id);
    const rejected = await member.create(
      ticketId,
      breakfastBody(world, { lines: [{ menuItemId: id, quantity: 1 }] }),
    );
    expect(REJECTED, JSON.stringify(rejected.body)).toContain(rejected.status);
  });

  it("LGYFH-05 isBreakfast must be a boolean (422) and an unrelated edit keeps the flag", async () => {
    const id = await seedItem(world, { name: "Waffle Uji", breakfast: true });
    const api = adminCall(world, admin);

    const invalid = await api.patch(`/api/menu/items/${id}`, {
      isBreakfast: "ya",
    });
    expect(invalid.status).toBe(422);

    const renamed = await api.patch(`/api/menu/items/${id}`, {
      description: "Dengan madu",
    });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body.data.isBreakfast).toBe(true);
    expect(await flagOf(world, id)).toBe(true);
  });

  it("LGYFH-05 another tenant's admin cannot change the flag of this tenant's item", async () => {
    const id = await seedItem(world, {
      name: "Milik Tenant Utama",
      breakfast: false,
    });
    const attempt = await adminCall(other, otherAdmin).patch(
      `/api/menu/items/${id}`,
      { isBreakfast: true },
    );
    expect([403, 404], JSON.stringify(attempt.body)).toContain(attempt.status);
    expect(await flagOf(world, id)).toBe(false);
  });

  it("LGYFH-05 a staff account without menu permission cannot change the flag", async () => {
    const id = await seedItem(world, { name: "Tanpa Izin", breakfast: false });
    // A signed-in account with no role in the tenant (the shared floor role was
    // widened for the admins above, so `world.staff` is not usable here).
    const client = agent(app);
    await signUp(client, "Tanpa Peran");
    const attempt = await client
      .patch(`/api/menu/items/${id}`)
      .set(world.headers)
      .set(originHeader)
      .send({ isBreakfast: true });
    expect(attempt.status).toBe(403);
    expect(await flagOf(world, id)).toBe(false);
  });
});
