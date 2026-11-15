// Guest/public menu reads hide active items without a photo (owner Q23,
// bead legend-qf0i; PRD v1.7 §10 QR Order, §8 "Konten Menu").
//
// Legend-pnsa refuses to publish an item without a photo, but rows created
// before the rule can still be active with `media_id` NULL. Those rows stay in
// the back office (which lists them with the "Foto wajib" badge) and must never
// reach a guest: the QR order menu and the public website menu skip them.
//
// Runs the real Express app and PostgreSQL (disposable server from `pnpm
// test`): the QR token is signed for an isolated tenant and the rows are seeded
// as the tenant owner, because the write API refuses exactly this state.

import { randomUUID } from "node:crypto";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { NoopMalwareScanner } from "../services/core-image";
import type { StorageRuntime } from "../services/core-storage-runtime";
import { qrTokenHash, signTableQrToken } from "../services/qr-token";
import { agent } from "./helpers";
import {
  createIsolatedTenant,
  dropIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers";

const app = createApp();
let isolatedTenant: IsolatedTenant;
let tenantId: string;
let brandId: string;
let outletId: string;
let hostname: string;

const pool = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const ids = {
  category: randomUUID(),
  visibleItem: randomUUID(),
  legacyItem: randomUUID(),
  priceList: randomUUID(),
  zone: randomUUID(),
  table: randomUUID(),
  taxRule: randomUUID(),
  availability: randomUUID(),
};
const mediaId = randomUUID();
let qrToken = "";

/** Owner-side writes need the tenant local setting because RLS is FORCED. */
async function asTenant<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
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

beforeAll(async () => {
  isolatedTenant = await createIsolatedTenant(
    `guest-menu-${randomUUID().slice(0, 8)}`,
  );
  ({ tenantId, brandId, outletId, hostname } = isolatedTenant);
  qrToken = signTableQrToken({
    tenantId,
    outletId,
    tableId: ids.table,
  });
  await asTenant(async (db) => {
    await db.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Kopi Uji', 0)`,
      [ids.category, tenantId, brandId],
    );
    // The sellable row: active and with a photo (owner Q23).
    await db.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Berfoto', true, $5)`,
      [ids.visibleItem, tenantId, brandId, ids.category, mediaId],
    );
    // The legacy row: active, no photo — created before the rule.
    await db.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Tanpa Foto', true, NULL)`,
      [ids.legacyItem, tenantId, brandId, ids.category],
    );
    await db.query(
      `INSERT INTO item_availability (id, tenant_id, outlet_id, menu_item_id, status)
       VALUES ($1, $2, $3, $4, 'sold_out')`,
      [ids.availability, tenantId, outletId, ids.visibleItem],
    );
    await db.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'dine_in', '2026-01-01')`,
      [ids.priceList, tenantId, outletId],
    );
    for (const [itemId, price] of [
      [ids.visibleItem, 24000],
      [ids.legacyItem, 18000],
    ]) {
      await db.query(
        `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), tenantId, ids.priceList, itemId, price],
      );
    }
    await db.query(
      `INSERT INTO tax_rules (id, tenant_id, outlet_id, code, name, tax_type, rate_bp,
         channels, applies_to, price_includes_tax, include_service_in_base, is_active,
         version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, $3, 'UJI-QF0I', 'PBJT Uji Q23', 'pbjt', 1000,
         '[]', $4, false, false, true, 1, '2026-01-01', 'published', now(), 'test')`,
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
    await db.query(
      `INSERT INTO floor_zones (id, tenant_id, outlet_id, name, payment_mode,
         service_charge_bp, minimum_spend_idr, hours, status, sort_order)
       VALUES ($1, $2, $3, 'Zona Uji QR', 'pay_first', 500, 0, $4, 'active', 0)`,
      [
        ids.zone,
        tenantId,
        outletId,
        JSON.stringify([
          { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" },
        ]),
      ],
    );
    await db.query(
      `INSERT INTO tables (id, tenant_id, outlet_id, zone_id, code, capacity, type,
         layout, status, qr_token_hash, qr_token_sealed)
       VALUES ($1, $2, $3, $4, 'Q23', 4, 'regular',
         $5, 'available', $6, 'sealed')`,
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
        qrTokenHash(qrToken),
      ],
    );
  });
});

afterAll(async () => {
  await asTenant(async (db) => {
    await db.query("DELETE FROM tables WHERE tenant_id = $1 AND id = $2", [
      tenantId,
      ids.table,
    ]);
    await db.query("DELETE FROM floor_zones WHERE tenant_id = $1 AND id = $2", [
      tenantId,
      ids.zone,
    ]);
    await db.query(
      "DELETE FROM price_list_items WHERE tenant_id = $1 AND price_list_id = $2",
      [tenantId, ids.priceList],
    );
    await db.query("DELETE FROM price_lists WHERE tenant_id = $1 AND id = $2", [
      tenantId,
      ids.priceList,
    ]);
    await db.query(
      "DELETE FROM item_availability WHERE tenant_id = $1 AND id = $2",
      [tenantId, ids.availability],
    );
    await db.query(
      "DELETE FROM menu_items WHERE tenant_id = $1 AND id = ANY($2)",
      [tenantId, [ids.visibleItem, ids.legacyItem]],
    );
    await db.query(
      "DELETE FROM menu_categories WHERE tenant_id = $1 AND id = $2",
      [tenantId, ids.category],
    );
    await db.query("DELETE FROM tax_rules WHERE tenant_id = $1 AND id = $2", [
      tenantId,
      ids.taxRule,
    ]);
  });
  await dropIsolatedTenant(isolatedTenant);
  await pool.end();
});

const itemNames = (body: {
  data: {
    items?: { name: string }[];
    sections?: { items: { name: string }[] }[];
  };
}) =>
  body.data.items?.map((item) => item.name) ??
  body.data.sections?.flatMap((section) =>
    section.items.map((item) => item.name),
  ) ??
  [];

describe("guest menu reads (Q23 legend-qf0i)", () => {
  it("Q23 legend-qf0i: the QR order menu hides an active item without a photo", async () => {
    const response = await agent(app)
      .get(`/api/qr/menu/${qrToken}`)
      .set("Host", hostname)
      .expect(200);
    const names = itemNames(response.body);
    expect(names).toContain("Kopi Berfoto");
    expect(names).not.toContain("Kopi Tanpa Foto");
    // The row really exists and is active: only the guest read hides it.
    const { rows } = await asTenant((db) =>
      db.query<{ is_active: boolean; media_id: string | null }>(
        "SELECT is_active, media_id FROM menu_items WHERE tenant_id = $1 AND id = $2",
        [tenantId, ids.legacyItem],
      ),
    );
    expect(rows[0]).toMatchObject({ is_active: true, media_id: null });
  });

  it("Q23 legend-qf0i: the QR menu keeps the channel price, zone and tax note of the visible row", async () => {
    const response = await agent(app)
      .get(`/api/qr/menu/${qrToken}`)
      .set("Host", hostname)
      .expect(200);
    const menu = response.body.data;
    expect(menu.table).toMatchObject({
      id: ids.table,
      code: "Q23",
      capacity: 4,
    });
    expect(menu.zone).toMatchObject({
      name: "Zona Uji QR",
      paymentMode: "pay_first",
      serviceChargeBp: 500,
    });
    expect(menu.pricing).toMatchObject({
      pricesIncludeTaxAndService: false,
      serviceChargeBp: 500,
    });
    expect(menu.pricing.taxes).toContainEqual({
      name: "PBJT Uji Q23",
      rateBp: 1000,
    });
    expect(menu.categories).toEqual([
      { id: ids.category, name: "Kopi Uji", sortOrder: 0 },
    ]);
    expect(menu.items).toHaveLength(1);
    expect(menu.items[0]).toMatchObject({
      id: ids.visibleItem,
      name: "Kopi Berfoto",
      priceIdr: 24000,
      status: "sold_out",
      photoUrl: null,
    });
    expect(menu.orderingOpen).toBe(true);
  });

  it("Q23 legend-qf0i: the public website menu hides the same legacy row", async () => {
    const response = await agent(app)
      .get("/api/public/site/menu")
      .set("Host", hostname)
      .expect(200);
    const items = response.body.data.sections.flatMap(
      (section: { items: { id: string; name: string }[] }) => section.items,
    );
    expect(items.map((item: { name: string }) => item.name)).toEqual([
      "Kopi Berfoto",
    ]);
    expect(items[0]).toMatchObject({
      id: ids.visibleItem,
      priceIdr: 24000,
      isAvailable: false,
      imageUrl: null,
    });
    expect(response.body.data.pricesExcludeTaxAndService).toBe(true);
  });

  it("TEN-02 legend-qf0i: a tampered QR signature is the same NOT_FOUND", async () => {
    const tampered = `${qrToken.slice(0, -2)}${qrToken.endsWith("AA") ? "BB" : "AA"}`;
    const response = await agent(app)
      .get(`/api/qr/menu/${tampered}`)
      .set("Host", hostname)
      .expect(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("TEN-02 legend-qf0i: an unknown host has no public website menu", async () => {
    await agent(app)
      .get("/api/public/site/menu")
      .set("Host", "unknown-brand.example")
      .expect(404);
  });

  it("Q23 legend-qf0i: a token signed for another tenant is not a guest menu", async () => {
    const isolated = await createIsolatedTenant("q23");
    try {
      await agent(app)
        .get(`/api/qr/menu/${qrToken}`)
        .set("Host", isolated.hostname)
        .expect(404);
    } finally {
      await dropIsolatedTenant(isolated);
    }
  });
});

// legend-tct6 / legend-8qri: with an object storage the guest menu carries the
// media-library photo URL and the brand's active theme with its logo URL.
describe("guest menu photo and theme (legend-tct6, legend-8qri)", () => {
  const storageApp = createApp({
    storageRuntime: {
      storage: new FakeObjectStorage(),
      scanner: new NoopMalwareScanner(),
      fileSigner: async (_context, objectId) =>
        `https://signed.invalid/${objectId}`,
      hrisDocumentSigner: async () => null,
    } satisfies StorageRuntime,
  });
  const logoId = randomUUID();
  let themeId = "";
  let seededTheme = false;
  let previousLogoId: string | null = null;

  beforeAll(async () => {
    await asTenant(async (db) => {
      await db.query(
        `INSERT INTO core_storage_objects
           (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes)
         VALUES ($1, $2, $3, 'menu_photo', $4, 'image/webp', 1000),
                ($1, NULL, $5, 'brand_logo', $6, 'image/webp', 1000)`,
        [
          tenantId,
          outletId,
          mediaId,
          `${tenantId}/${outletId}/menu-photo/${mediaId}.webp`,
          logoId,
          `${tenantId}/brand-logo/${logoId}.webp`,
        ],
      );
      const { rows } = await db.query<{
        id: string;
        logo_media_id: string | null;
      }>(
        `SELECT t.id, t.logo_media_id FROM tenant_themes t
           LEFT JOIN brands b ON b.tenant_id = t.tenant_id AND b.theme_id = t.id
          WHERE t.tenant_id = $1 AND t.brand_id = $2 AND t.status = 'active'
          ORDER BY (b.id IS NULL), t.version DESC LIMIT 1`,
        [tenantId, brandId],
      );
      if (rows[0]) {
        themeId = rows[0].id;
        previousLogoId = rows[0].logo_media_id;
      } else {
        // No active theme for the brand: seed one so the theme tests assert.
        themeId = randomUUID();
        seededTheme = true;
        await db.query(
          `INSERT INTO tenant_themes
             (id, tenant_id, brand_id, version, tokens, font_family, corners,
              contrast_check_passed, status, created_by, activated_at)
           SELECT $1, $2, $3, COALESCE(MAX(version), 0) + 1,
                  $4, $5, $6, true, 'active', $7, now()
             FROM tenant_themes WHERE tenant_id = $2 AND brand_id = $3`,
          [
            themeId,
            tenantId,
            brandId,
            JSON.stringify(cafeLegendPlatformFixtures.themes[0].tokens),
            cafeLegendPlatformFixtures.themes[0].fontFamily,
            cafeLegendPlatformFixtures.themes[0].corners,
            randomUUID(),
          ],
        );
      }
      await db.query(
        "UPDATE tenant_themes SET logo_media_id = $3 WHERE tenant_id = $1 AND id = $2",
        [tenantId, themeId, logoId],
      );
    });
  });

  afterAll(async () => {
    await asTenant(async (db) => {
      if (seededTheme)
        await db.query(
          "DELETE FROM tenant_themes WHERE tenant_id = $1 AND id = $2",
          [tenantId, themeId],
        );
      else
        await db.query(
          "UPDATE tenant_themes SET logo_media_id = $3 WHERE tenant_id = $1 AND id = $2",
          [tenantId, themeId, previousLogoId],
        );
      await db.query(
        "DELETE FROM core_storage_objects WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenantId, [mediaId, logoId]],
      );
    });
  });

  it("legend-tct6: the QR menu item carries the media-library photo URL", async () => {
    const response = await agent(storageApp)
      .get(`/api/qr/menu/${qrToken}`)
      .set("Host", hostname)
      .expect(200);
    const item = response.body.data.items.find(
      (entry: { id: string }) => entry.id === ids.visibleItem,
    );
    expect(item.photoUrl).toMatch(/^https:\/\/storage\.invalid\/public\//);
  });

  it("legend-tct6: the public website menu resolves the same photo URL", async () => {
    const response = await agent(storageApp)
      .get("/api/public/site/menu")
      .set("Host", hostname)
      .expect(200);
    const items = response.body.data.sections.flatMap(
      (section: { items: { id: string; imageUrl: string | null }[] }) =>
        section.items,
    );
    const item = items.find(
      (entry: { id: string }) => entry.id === ids.visibleItem,
    );
    expect(item.imageUrl).toMatch(/^https:\/\/storage\.invalid\/public\//);
  });

  it("legend-8qri: the QR menu carries the active theme and the logo URL", async () => {
    const { rows } = await asTenant((db) =>
      db.query<{ tokens: unknown; font_family: string; corners: string }>(
        "SELECT tokens, font_family, corners FROM tenant_themes WHERE tenant_id = $1 AND id = $2",
        [tenantId, themeId],
      ),
    );
    const response = await agent(storageApp)
      .get(`/api/qr/menu/${qrToken}`)
      .set("Host", hostname)
      .expect(200);
    const { theme, outlet } = response.body.data;
    expect(theme).toMatchObject({
      tokens: rows[0].tokens,
      fontFamily: rows[0].font_family,
      corners: rows[0].corners,
    });
    expect(theme.logoUrl).toMatch(/^https:\/\/storage\.invalid\/public\//);
    expect(typeof outlet.timeZone).toBe("string");
  });

  it("legend-8qri: without a storage the theme still ships and the logo URL is null", async () => {
    const response = await agent(createApp({ storageRuntime: null }))
      .get(`/api/qr/menu/${qrToken}`)
      .set("Host", hostname)
      .expect(200);
    expect(response.body.data.theme).not.toBeNull();
    expect(response.body.data.theme.logoUrl).toBeNull();
    expect(response.body.data.items[0].photoUrl).toBeNull();
  });

  const pointLogoAt = (mediaRef: string) =>
    asTenant((db) =>
      db.query(
        "UPDATE tenant_themes SET logo_media_id = $3 WHERE tenant_id = $1 AND id = $2",
        [tenantId, themeId, mediaRef],
      ),
    );

  it("legend-8qri: a logo that is a menu photo of the tenant is not a brand logo", async () => {
    await pointLogoAt(mediaId);
    try {
      const response = await agent(storageApp)
        .get(`/api/qr/menu/${qrToken}`)
        .set("Host", hostname)
        .expect(200);
      expect(response.body.data.theme).not.toBeNull();
      expect(response.body.data.theme.logoUrl).toBeNull();
    } finally {
      await pointLogoAt(logoId);
    }
  });

  it("legend-8qri: a logo from another tenant (menu photo or brand logo) gives no URL", async () => {
    const isolated = await createIsolatedTenant("8qri");
    const foreignPhoto = randomUUID();
    const foreignLogo = randomUUID();
    try {
      await owner.query(
        `INSERT INTO core_storage_objects
           (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes)
         VALUES ($1, $2, $3, 'menu_photo', $4, 'image/webp', 1000),
                ($1, NULL, $5, 'brand_logo', $6, 'image/webp', 1000)`,
        [
          isolated.tenantId,
          isolated.outletId,
          foreignPhoto,
          `${isolated.tenantId}/${isolated.outletId}/menu-photo/${foreignPhoto}.webp`,
          foreignLogo,
          `${isolated.tenantId}/brand-logo/${foreignLogo}.webp`,
        ],
      );
      for (const foreignId of [foreignPhoto, foreignLogo]) {
        await pointLogoAt(foreignId);
        const response = await agent(storageApp)
          .get(`/api/qr/menu/${qrToken}`)
          .set("Host", hostname)
          .expect(200);
        expect(response.body.data.theme).not.toBeNull();
        expect(response.body.data.theme.logoUrl).toBeNull();
      }
    } finally {
      await pointLogoAt(logoId);
      await owner.query(
        "DELETE FROM core_storage_objects WHERE tenant_id = $1",
        [isolated.tenantId],
      );
      await dropIsolatedTenant(isolated);
    }
  });

  it("legend-8qri: a stored theme the contract rejects leaves the menu without a theme", async () => {
    const { rows } = await asTenant((db) =>
      db.query<{ font_family: string }>(
        "SELECT font_family FROM tenant_themes WHERE tenant_id = $1 AND id = $2",
        [tenantId, themeId],
      ),
    );
    const originalFont = rows[0].font_family;
    await asTenant((db) =>
      db.query(
        "UPDATE tenant_themes SET font_family = 'comic-sans' WHERE tenant_id = $1 AND id = $2",
        [tenantId, themeId],
      ),
    );
    try {
      const response = await agent(storageApp)
        .get(`/api/qr/menu/${qrToken}`)
        .set("Host", hostname)
        .expect(200);
      expect(response.body.data.theme ?? null).toBeNull();
    } finally {
      await asTenant((db) =>
        db.query(
          "UPDATE tenant_themes SET font_family = $3 WHERE tenant_id = $1 AND id = $2",
          [tenantId, themeId, originalFont],
        ),
      );
    }
  });
});
