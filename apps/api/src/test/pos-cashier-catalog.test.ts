// legend-dysef G1: the cashier catalog is a scoped, server-priced read model.
// Its identifiers must be valid order inputs, including variant/modifier IDs.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { businessDateOf } from "@starter/shared/core";
import * as posContracts from "@starter/shared/pos";
import { createApp } from "../app.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import type { StorageRuntime } from "../services/core-storage-runtime.ts";
import { agent } from "./helpers.ts";
import { owner, staffOfIsolatedTenant } from "./floor-test-helpers.ts";
import {
  asCashierTenant,
  cashierFixture,
  type CashierFixture,
} from "./pos-cashier-test-helpers.ts";

let fixture: CashierFixture;
const ids = {
  variantItem: randomUUID(),
  small: randomUUID(),
  large: randomUUID(),
  noPrice: randomUUID(),
  inactive: randomUUID(),
  deleted: randomUUID(),
  otherBrand: randomUUID(),
  otherCategory: randomUUID(),
  otherItem: randomUUID(),
};

beforeAll(async () => {
  fixture = await cashierFixture("cashier-catalog");
  await asCashierTenant(fixture.tenant.tenantId, async (client) => {
    for (const [id, name, active] of [
      [ids.variantItem, "Teh Pilihan", true],
      [ids.noPrice, "Belum Diberi Harga", true],
      [ids.inactive, "Menu Nonaktif", false],
      [ids.deleted, "Menu Dihapus", true],
    ])
      await client.query(
        `INSERT INTO menu_items
       (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          id,
          fixture.tenant.tenantId,
          fixture.tenant.brandId,
          fixture.ids.category,
          name,
          active,
          randomUUID(),
        ],
      );
    await client.query(
      "UPDATE menu_items SET deleted_at = now() WHERE id = $1",
      [ids.deleted],
    );
    for (const [id, name] of [
      [ids.small, "Kecil"],
      [ids.large, "Besar"],
    ])
      await client.query(
        `INSERT INTO item_variants (id, tenant_id, menu_item_id, name) VALUES ($1, $2, $3, $4)`,
        [id, fixture.tenant.tenantId, ids.variantItem, name],
      );
    await client.query(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand Tidak Terkait')`,
      [
        ids.otherBrand,
        fixture.tenant.tenantId,
        `catalog-brand-${randomUUID().slice(0, 6)}`,
      ],
    );
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name) VALUES ($1, $2, $3, 'Kategori Brand Lain')`,
      [ids.otherCategory, fixture.tenant.tenantId, ids.otherBrand],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Menu Brand Lain', true, $5)`,
      [
        ids.otherItem,
        fixture.tenant.tenantId,
        ids.otherBrand,
        ids.otherCategory,
        randomUUID(),
      ],
    );
    const { rows: lists } = await client.query<{ id: string; channel: string }>(
      "SELECT id, channel FROM price_lists WHERE tenant_id = $1 AND outlet_id = $2",
      [fixture.tenant.tenantId, fixture.tenant.outletId],
    );
    for (const list of lists) {
      for (const [itemId, variantId, priceIdr] of [
        [ids.variantItem, ids.small, 20_000],
        [ids.variantItem, ids.large, 35_000],
        [ids.inactive, null, 10_000],
        [ids.deleted, null, 10_000],
        [ids.otherItem, null, 10_000],
      ])
        await client.query(
          `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, variant_id, price_idr)
         VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            randomUUID(),
            fixture.tenant.tenantId,
            list.id,
            itemId,
            variantId,
            priceIdr,
          ],
        );
      if (list.channel === "dine_in")
        await client.query(
          "UPDATE price_list_items SET price_idr = 32000 WHERE price_list_id = $1 AND item_id = $2",
          [list.id, fixture.ids.meal],
        );
    }
    const ojolList = randomUUID();
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'gofood', '2026-01-01')`,
      [ojolList, fixture.tenant.tenantId, fixture.tenant.outletId],
    );
    await client.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, 45000)`,
      [randomUUID(), fixture.tenant.tenantId, ojolList, fixture.ids.meal],
    );
  });
});
afterAll(async () => {
  await owner.end();
});

const base = () => `/api/outlets/${fixture.tenant.outletId}/pos/catalog`;
type CatalogItem = {
  id: string;
  basePriceIdr: number;
  plainPriceIdr: number | null;
  variants: { id: string; name: string; priceIdr: number }[];
};

async function catalog(query = "?channel=pos&serviceType=takeaway") {
  const response = await fixture.get(`${base()}${query}`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as {
    categories: { id: string; name: string; sortOrder: number }[];
    items: CatalogItem[];
    updatedAt: string;
    source: string;
  };
}

describe("legend-dysef cashier catalog", () => {
  it("G1 exposes priced categories, course, stock and required modifier groups with selectable server IDs", async () => {
    const result = await catalog();
    expect(result.categories).toEqual(
      expect.arrayContaining([
        { id: fixture.ids.category, name: "Katalog Kasir", sortOrder: 0 },
      ]),
    );
    expect(
      result.items.find((item) => item.id === fixture.ids.coffee),
    ).toMatchObject({
      id: fixture.ids.coffee,
      categoryId: fixture.ids.category,
      name: "Kopi Pilihan",
      basePriceIdr: 25_000,
      plainPriceIdr: 25_000,
      variants: [],
      imageUrl: null,
      course: "drink",
      code: null,
      soldOut: false,
      modifierGroups: [
        {
          id: fixture.ids.group,
          name: "Ukuran",
          required: true,
          min: 1,
          max: 1,
          options: [
            { id: fixture.ids.modifier, label: "Besar", priceDeltaIdr: 5_000 },
          ],
        },
      ],
    });
    expect(
      result.items.find((item) => item.id === fixture.ids.soldOut),
    ).toMatchObject({
      basePriceIdr: 15_000,
      course: "dessert",
      soldOut: true,
    });
    expect(result.source).toBe("live");
    expect(Number.isNaN(Date.parse(result.updatedAt))).toBe(false);
  });

  it("G1 returns variant prices and accepts the chosen catalog identifier at order creation", async () => {
    const result = await catalog();
    const variantItem = result.items.find(
      (item) => item.id === ids.variantItem,
    )!;
    expect(variantItem).toMatchObject({
      basePriceIdr: 20_000,
      plainPriceIdr: null,
      variants: expect.arrayContaining([
        { id: ids.small, name: "Kecil", priceIdr: 20_000 },
        { id: ids.large, name: "Besar", priceIdr: 35_000 },
      ]),
    });
    const selected = variantItem.variants.find(
      (variant) => variant.id === ids.large,
    )!;
    const created = await fixture.create({
      items: [
        fixture.line({ menuItemId: variantItem.id, variantId: selected.id }),
      ],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.subtotalIdr).toBe(selected.priceIdr);
    const countOrders = async () => {
      const { rows } = await owner.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM orders WHERE tenant_id = $1",
        [fixture.tenant.tenantId],
      );
      return rows[0]?.count;
    };
    const before = await countOrders();
    const unselected = await fixture.create({
      items: [fixture.line({ menuItemId: variantItem.id })],
    });
    expect(unselected.status, JSON.stringify(unselected.body)).toBe(400);
    expect(unselected.body.error).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Pilih varian untuk menu ini.",
    });
    expect(await countOrders()).toBe(before);
  });

  it("G1 uses channel and service type prices, with POS dine-in as the default", async () => {
    const dineIn = await catalog("");
    const takeaway = await catalog();
    const ojol = await catalog("?channel=gofood&serviceType=delivery");
    expect(
      dineIn.items.find((item) => item.id === fixture.ids.meal)?.basePriceIdr,
    ).toBe(32_000);
    expect(
      takeaway.items.find((item) => item.id === fixture.ids.meal)?.basePriceIdr,
    ).toBe(30_000);
    expect(
      ojol.items.find((item) => item.id === fixture.ids.meal)?.basePriceIdr,
    ).toBe(45_000);
    expect(ojol.items.some((item) => item.id === fixture.ids.coffee)).toBe(
      false,
    );
  });

  it("G1 omits unpriced, inactive, deleted and other-brand items without hiding sold-out choices", async () => {
    const result = await catalog();
    const itemIds = result.items.map((item) => item.id);
    for (const excluded of [
      ids.noPrice,
      ids.inactive,
      ids.deleted,
      ids.otherItem,
    ])
      expect(itemIds).not.toContain(excluded);
    expect(result.categories.map((category) => category.id)).not.toContain(
      ids.otherCategory,
    );
    expect(itemIds).toContain(fixture.ids.soldOut);
  });

  it("G1 keeps scheduled and exhausted daily-stock choices visible while a passed 86 sells again", async () => {
    const availability = await cashierFixture("catalog-availability");
    const now = new Date();
    const jakartaDay = new Date(
      now.getTime() + 7 * 60 * 60 * 1_000,
    ).getUTCDay();
    const businessDate = businessDateOf(now, {
      timeZone: "Asia/Jakarta",
      cutoff: "04:00",
    });
    await asCashierTenant(availability.tenant.tenantId, async (client) => {
      await client.query(
        `INSERT INTO item_availability
         (id, tenant_id, outlet_id, menu_item_id, schedule, daily_limit, status)
         VALUES ($1, $2, $3, $4, $5, NULL, 'available'),
                ($6, $2, $3, $7, '[]', 1, 'available')`,
        [
          randomUUID(),
          availability.tenant.tenantId,
          availability.tenant.outletId,
          availability.ids.coffee,
          JSON.stringify([
            {
              daysOfWeek: [(jakartaDay + 1) % 7],
              start: "00:00",
              end: "00:00",
            },
          ]),
          randomUUID(),
          availability.ids.meal,
        ],
      );
      await client.query(
        `INSERT INTO menu_item_daily_usage
         (id, tenant_id, outlet_id, menu_item_id, business_date, quantity)
         VALUES ($1, $2, $3, $4, $5, 1)`,
        [
          randomUUID(),
          availability.tenant.tenantId,
          availability.tenant.outletId,
          availability.ids.meal,
          businessDate,
        ],
      );
      await client.query(
        `UPDATE item_availability SET sold_out_until = '2000-01-01T00:00:00Z'
         WHERE tenant_id = $1 AND menu_item_id = $2`,
        [availability.tenant.tenantId, availability.ids.soldOut],
      );
    });
    const response = await availability.get(
      `/api/outlets/${availability.tenant.outletId}/pos/catalog?channel=pos&serviceType=takeaway`,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const items = response.body.data.items as {
      id: string;
      soldOut: boolean;
    }[];
    expect(
      items.find((item) => item.id === availability.ids.coffee),
    ).toMatchObject({ soldOut: true });
    expect(
      items.find((item) => item.id === availability.ids.meal),
    ).toMatchObject({ soldOut: true });
    expect(
      items.find((item) => item.id === availability.ids.soldOut),
    ).toMatchObject({ soldOut: false });
  });

  it("G1 resolves configured photo URLs independently for each app's storage runtime", async () => {
    const photos = await cashierFixture("catalog-photos");
    const mediaId = randomUUID();
    await asCashierTenant(photos.tenant.tenantId, async (client) => {
      await client.query(
        `INSERT INTO core_storage_objects
         (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes)
         VALUES ($1, $2, $3, 'menu_photo', $4, 'image/webp', 1)`,
        [
          photos.tenant.tenantId,
          photos.tenant.outletId,
          mediaId,
          `menu/${mediaId}/photo.webp`,
        ],
      );
      await client.query("UPDATE menu_items SET media_id = $1 WHERE id = $2", [
        mediaId,
        photos.ids.coffee,
      ]);
    });
    const runtime = (host: string): StorageRuntime => {
      const storage = new FakeObjectStorage();
      const originalUrl = storage.publicUrl.bind(storage);
      storage.publicUrl = async (...args) =>
        (await originalUrl(...args)).replace("https://storage.invalid", host);
      return {
        storage,
        scanner: new NoopMalwareScanner(),
        fileSigner: async (_context, objectId) => `${host}/signed/${objectId}`,
        hrisDocumentSigner: async () => null,
      };
    };
    const appA = createApp({
      storageRuntime: runtime("https://catalog-a.invalid"),
    });
    const clientA = await staffOfIsolatedTenant(appA, photos.tenant);
    const appB = createApp({
      storageRuntime: runtime("https://catalog-b.invalid"),
    });
    const clientB = await staffOfIsolatedTenant(appB, photos.tenant);
    const withoutStorage = createApp({ storageRuntime: null });
    const clientWithout = await staffOfIsolatedTenant(
      withoutStorage,
      photos.tenant,
    );
    const readPhoto = async (staff: typeof clientA) => {
      const response = await staff.client
        .get(`/api/outlets/${photos.tenant.outletId}/pos/catalog`)
        .set(photos.headers);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return (
        response.body.data.items as { id: string; imageUrl: string | null }[]
      ).find((item) => item.id === photos.ids.coffee)?.imageUrl;
    };
    const urlA = await readPhoto(clientA);
    expect(urlA).toMatch(/^https:\/\/catalog-a\.invalid\/public\//);
    expect(urlA).toContain(mediaId);
    expect(await readPhoto(clientB)).toMatch(
      /^https:\/\/catalog-b\.invalid\/public\//,
    );
    expect(await readPhoto(clientWithout)).toBeNull();
    expect(await readPhoto(clientA)).toBe(urlA);
  });

  it("G1 publishes a shared strict endpoint contract that parses the live read model", async () => {
    const endpoint = (posContracts as unknown as Record<string, unknown>)
      .getPosCatalog as
      | {
          method: string;
          path: string;
          response: { safeParse: (input: unknown) => { success: boolean } };
        }
      | undefined;
    expect(endpoint).toBeDefined();
    expect(endpoint?.method).toBe("GET");
    expect(endpoint?.path).toBe("/api/outlets/:outletId/pos/catalog");
    const response = await fixture.get(
      `${base()}?channel=pos&serviceType=takeaway`,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(endpoint?.response.safeParse(response.body).success).toBe(true);
    const invalid = await fixture.get(
      `${base()}?channel=pos&serviceType=unknown`,
    );
    expect(invalid.status).toBe(422);
  });

  it("G1 requires an authenticated scoped outlet and never returns another tenant's catalog", async () => {
    const anonymous = await agent(fixture.app).get(base()).set(fixture.headers);
    expect([401, 403, 404]).toContain(anonymous.status);
    const foreign = await cashierFixture("catalog-foreign");
    const refused = await fixture.get(
      `/api/outlets/${foreign.tenant.outletId}/pos/catalog`,
    );
    expect([403, 404]).toContain(refused.status);
    const own = await foreign.get(
      `/api/outlets/${foreign.tenant.outletId}/pos/catalog`,
    );
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(
      own.body.data.items.some(
        (item: CatalogItem) => item.id === fixture.ids.coffee,
      ),
    ).toBe(false);
  });
});
