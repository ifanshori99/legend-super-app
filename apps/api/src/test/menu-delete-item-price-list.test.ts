// Deleting a menu item must also remove its prices (bead legend-d0ipm; design
// docs/briefs/24318-design.md "Kartu"; PRD v1.7 §3 F8 Master Menu & Harga).
// Written from the shared menu endpoints (packages/shared/src/menu/endpoints.ts)
// and the catalog-sync contract, not from the implementation.
//
// Rule under test: `DELETE /api/menu/items/:itemId` also soft-deletes every
// `price_list_items` row of that item (every price list, every variant) and
// moves the touched price lists forward (`updated_at`, hence a new `sync_txid`
// that the edge catalog sync sees). A price of a deleted item must never reach
// an edge, and a price list that did not hold the item must not change.
//
// Assumptions (the contract is silent):
//  - The delete answers 200 or 204.
//  - "Moves forward" is asserted on `price_lists.updated_at` and
//    `price_lists.sync_txid` (strictly greater); untouched lists keep both.
//  - A caller without `menu.item.manage` (a cashier) is refused with 403 and
//    nothing changes; an anonymous caller gets 401; an unknown item 404.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendFixtures } from "@starter/shared/core";
import { catalogSyncQuerySchema } from "@starter/shared/edge";
import { createApp } from "../app";
import { db } from "../db/index.ts";
import { listCatalogRecordsSince } from "../services/edge-catalog-sync.ts";
import { settleCloud } from "./helpers/catalog-cloud.ts";
import { agent, originHeader, signUp } from "./helpers";

const app = createApp();
const { tenant, brand, outlets } = cafeLegendFixtures;
const tenantId = tenant.id;
const brandId = brand.id;
const outletA = outlets[0].id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});

type Client = ReturnType<typeof agent>;
type Json = Record<string, unknown>;
const data = (response: { body: unknown }) =>
  (response.body as Json).data as Json;

const createdUsers: string[] = [];
const createdItems: string[] = [];
const createdLists: string[] = [];
const createdCategories: string[] = [];

async function menuClient(
  role: "owner" | "cashier",
  scope: { type: "tenant"; id: null } | { type: "outlet"; id: string },
): Promise<Client> {
  const client = agent(app);
  await signUp(client, "Menu Delete User");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     SELECT $1, $2, id, $3, $4, now() - interval '1 minute', $2 FROM roles
      WHERE tenant_id = $1 AND template_key = $5`,
    [tenantId, userId, scope.type, scope.id, role],
  );
  return client;
}

let admin: Client;
let cashier: Client;

/** A private category plus helpers that create items, variants and price lists. */
let categoryId = "";
const uniqueDate = () => {
  const month = String(1 + (randomBytes(1)[0]! % 12)).padStart(2, "0");
  const day = String(1 + (randomBytes(1)[0]! % 28)).padStart(2, "0");
  const year = 2040 + (randomBytes(1)[0]! % 50);
  return `${year}-${month}-${day}`;
};

async function createItem(name: string): Promise<string> {
  const response = await admin
    .post("/api/menu/items")
    .set(originHeader)
    .send({
      brandId,
      categoryId,
      name: `${name} ${randomBytes(3).toString("hex")}`,
    });
  expect(response.status).toBe(201);
  const itemId = data(response).id as string;
  createdItems.push(itemId);
  return itemId;
}
async function createVariant(itemId: string): Promise<string> {
  const response = await admin
    .post(`/api/menu/items/${itemId}/variants`)
    .set(originHeader)
    .send({ name: "Large" });
  expect(response.status).toBe(201);
  return data(response).id as string;
}
async function createPriceList(
  channel: "dine_in" | "takeaway" | "gofood",
): Promise<string> {
  const response = await admin
    .post("/api/menu/price-lists")
    .set(originHeader)
    .send({ outletId: outletA, channel, effectiveFrom: uniqueDate() });
  expect(response.status).toBe(201);
  const listId = data(response).id as string;
  createdLists.push(listId);
  return listId;
}
async function setPrices(
  listId: string,
  items: { itemId: string; variantId: string | null; priceIdr: number }[],
) {
  const response = await admin
    .put(`/api/menu/price-lists/${listId}/items`)
    .set(originHeader)
    .send({ items });
  expect(response.status).toBe(204);
}
const deleteItem = (client: Client, itemId: string) =>
  client.delete(`/api/menu/items/${itemId}`).set(originHeader);

const rowsOfItem = async (itemId: string) =>
  (
    await owner.query(
      `SELECT id, price_list_id, variant_id, price_idr, deleted_at
         FROM price_list_items WHERE item_id = $1 ORDER BY price_idr`,
      [itemId],
    )
  ).rows;
const listStamp = async (listId: string) => {
  const row = (
    await owner.query(
      "SELECT updated_at, sync_txid::text AS txid FROM price_lists WHERE id = $1",
      [listId],
    )
  ).rows[0];
  return {
    updatedAt: row.updated_at as Date,
    txid: BigInt(row.txid as string),
  };
};
const apiPrices = async (listId: string) =>
  (
    (await admin.get(`/api/menu/price-lists/${listId}/items?limit=100`))
      .body as { data: Json[] }
  ).data;

/** The price list record the edge of outlet A would receive now. */
async function exportedList(listId: string): Promise<Json | undefined> {
  await settleCloud(owner);
  let since: string | undefined;
  for (let n = 0; n < 500; n += 1) {
    const page = (await listCatalogRecordsSince(db, {
      tenantId: tenantId as never,
      outletId: outletA as never,
      query: catalogSyncQuerySchema.parse({
        stream: "price_lists",
        limit: 100,
        ...(since === undefined ? {} : { since }),
      }),
    })) as unknown as {
      records: Json[];
      nextCursor: string | null;
      hasMore: boolean;
    };
    const found = page.records.find((r) => r.id === listId);
    if (found) return found;
    if (!page.hasMore) return undefined;
    since = page.nextCursor as string;
  }
  return undefined;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  admin = await menuClient("owner", { type: "tenant", id: null });
  cashier = await menuClient("cashier", { type: "outlet", id: outletA });
  const category = await admin
    .post("/api/menu/categories")
    .set(originHeader)
    .send({ brandId, name: `Hapus item ${randomUUID().slice(0, 6)}` });
  expect(category.status).toBe(201);
  categoryId = data(category).id as string;
  createdCategories.push(categoryId);
}, 120_000);

afterAll(async () => {
  try {
    await owner.query(
      "DELETE FROM price_list_items WHERE price_list_id = ANY($1::uuid[]) OR item_id = ANY($2::uuid[])",
      [createdLists, createdItems],
    );
    await owner.query("DELETE FROM price_lists WHERE id = ANY($1::uuid[])", [
      createdLists,
    ]);
    await owner
      .query(
        "DELETE FROM item_availability WHERE menu_item_id = ANY($1::uuid[])",
        [createdItems],
      )
      .catch(() => undefined);
    await owner.query(
      "DELETE FROM item_variants WHERE menu_item_id = ANY($1::uuid[])",
      [createdItems],
    );
    await owner.query("DELETE FROM menu_items WHERE id = ANY($1::uuid[])", [
      createdItems,
    ]);
    await owner.query(
      "DELETE FROM menu_categories WHERE id = ANY($1::uuid[])",
      [createdCategories],
    );
    await owner.query(
      "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
      [createdUsers],
    );
  } catch {
    // Best effort: every row is private to this file.
  }
  await owner.end();
});

describe("d0ipm deleting a menu item removes its prices", () => {
  it("soft-deletes the item's price rows in every price list (variants included) and leaves other items' prices alone", async () => {
    const doomed = await createItem("Item hapus");
    const keeper = await createItem("Item tetap");
    const variant = await createVariant(doomed);
    const dineIn = await createPriceList("dine_in");
    const takeaway = await createPriceList("takeaway");
    await setPrices(dineIn, [
      { itemId: doomed, variantId: null, priceIdr: 27_000 },
      { itemId: doomed, variantId: variant, priceIdr: 31_500 },
      { itemId: keeper, variantId: null, priceIdr: 18_750 },
    ]);
    await setPrices(takeaway, [
      { itemId: doomed, variantId: null, priceIdr: 29_000 },
    ]);
    expect(await rowsOfItem(doomed)).toHaveLength(3);

    const response = await deleteItem(admin, doomed);
    expect([200, 204]).toContain(response.status);

    // The item itself is gone (soft delete).
    const item = (
      await owner.query("SELECT deleted_at FROM menu_items WHERE id = $1", [
        doomed,
      ])
    ).rows[0];
    expect(item.deleted_at).not.toBeNull();
    // Every price row of the item, in both lists, is soft-deleted.
    const doomedRows = await rowsOfItem(doomed);
    expect(doomedRows).toHaveLength(3);
    for (const row of doomedRows) expect(row.deleted_at).not.toBeNull();
    // The other item's price is untouched and exact.
    const keeperRows = await rowsOfItem(keeper);
    expect(keeperRows).toHaveLength(1);
    expect(keeperRows[0]!.deleted_at).toBeNull();
    expect(Number(keeperRows[0]!.price_idr)).toBe(18_750);

    // What a back-office user sees through the API.
    const dineInPrices = await apiPrices(dineIn);
    expect(dineInPrices.map((p) => p.itemId)).toEqual([keeper]);
    expect(dineInPrices[0]!.priceIdr).toBe(18_750);
    expect(await apiPrices(takeaway)).toEqual([]);
  });

  it("moves every touched price list forward (updated_at and sync_txid) and leaves untouched lists exactly as they were", async () => {
    const doomed = await createItem("Item hapus 2");
    const other = await createItem("Item lain");
    const touched = await createPriceList("dine_in");
    const untouched = await createPriceList("gofood");
    await setPrices(touched, [
      { itemId: doomed, variantId: null, priceIdr: 22_000 },
    ]);
    await setPrices(untouched, [
      { itemId: other, variantId: null, priceIdr: 24_000 },
    ]);
    await settleCloud(owner);
    const touchedBefore = await listStamp(touched);
    const untouchedBefore = await listStamp(untouched);

    expect([200, 204]).toContain((await deleteItem(admin, doomed)).status);

    const touchedAfter = await listStamp(touched);
    expect(touchedAfter.updatedAt.getTime()).toBeGreaterThan(
      touchedBefore.updatedAt.getTime(),
    );
    expect(touchedAfter.txid).toBeGreaterThan(touchedBefore.txid);
    const untouchedAfter = await listStamp(untouched);
    expect(untouchedAfter.updatedAt.getTime()).toBe(
      untouchedBefore.updatedAt.getTime(),
    );
    expect(untouchedAfter.txid).toBe(untouchedBefore.txid);
  });

  it("the next catalog export carries a newer version of the list without the deleted item's price (no tombstone price leaks to the edge)", async () => {
    const doomed = await createItem("Item hapus 3");
    const keeper = await createItem("Item tetap 3");
    const list = await createPriceList("dine_in");
    await setPrices(list, [
      { itemId: doomed, variantId: null, priceIdr: 33_333 },
      { itemId: keeper, variantId: null, priceIdr: 12_345 },
    ]);
    const before = await exportedList(list);
    expect(before).toBeDefined();
    const beforeItems = before!.items as Json[];
    expect(beforeItems.map((i) => i.priceIdr).sort()).toEqual([12_345, 33_333]);

    expect([200, 204]).toContain((await deleteItem(admin, doomed)).status);

    const after = await exportedList(list);
    expect(after).toBeDefined();
    expect(after!.deletedAt).toBeNull();
    // A strictly newer version, otherwise an edge would keep the old price.
    expect(BigInt(String(after!.syncTxid))).toBeGreaterThan(
      BigInt(String(before!.syncTxid)),
    );
    const afterItems = after!.items as Json[];
    expect(afterItems.map((i) => i.itemId)).toEqual([keeper]);
    expect(afterItems[0]!.priceIdr).toBe(12_345);
    expect(JSON.stringify(after)).not.toContain(doomed);
    expect(JSON.stringify(after)).not.toContain("33333");
  });

  it("an item that has no price changes no price list", async () => {
    const lonely = await createItem("Item tanpa harga");
    const keeper = await createItem("Item bertarif");
    const list = await createPriceList("takeaway");
    await setPrices(list, [
      { itemId: keeper, variantId: null, priceIdr: 15_000 },
    ]);
    await settleCloud(owner);
    const before = await listStamp(list);
    expect([200, 204]).toContain((await deleteItem(admin, lonely)).status);
    const after = await listStamp(list);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(after.txid).toBe(before.txid);
    expect((await rowsOfItem(keeper))[0]!.deleted_at).toBeNull();
  });
});

describe("d0ipm error states", () => {
  it("a cashier (no menu.item.manage) and an anonymous caller cannot delete: 403 / 401, the item and its prices stay", async () => {
    const item = await createItem("Item dilindungi");
    const list = await createPriceList("dine_in");
    await setPrices(list, [
      { itemId: item, variantId: null, priceIdr: 20_000 },
    ]);
    await settleCloud(owner);
    const before = await listStamp(list);

    expect((await deleteItem(cashier, item)).status).toBe(403);
    expect(
      (await agent(app).delete(`/api/menu/items/${item}`).set(originHeader))
        .status,
    ).toBe(401);

    const row = (
      await owner.query("SELECT deleted_at FROM menu_items WHERE id = $1", [
        item,
      ])
    ).rows[0];
    expect(row.deleted_at).toBeNull();
    const prices = await rowsOfItem(item);
    expect(prices).toHaveLength(1);
    expect(prices[0]!.deleted_at).toBeNull();
    expect(Number(prices[0]!.price_idr)).toBe(20_000);
    const after = await listStamp(list);
    expect(after.txid).toBe(before.txid);
  });

  it("an unknown item answers 404 and changes no price list", async () => {
    const keeper = await createItem("Item aman");
    const list = await createPriceList("gofood");
    await setPrices(list, [
      { itemId: keeper, variantId: null, priceIdr: 9_900 },
    ]);
    await settleCloud(owner);
    const before = await listStamp(list);
    expect((await deleteItem(admin, randomUUID())).status).toBe(404);
    const after = await listStamp(list);
    expect(after.txid).toBe(before.txid);
    expect((await rowsOfItem(keeper))[0]!.deleted_at).toBeNull();
  });

  it("a malformed item id is refused with a 4xx", async () => {
    const response = await deleteItem(admin, "bukan-uuid");
    expect([400, 404, 422]).toContain(response.status);
  });
});
