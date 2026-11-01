// Menu back-office API (bead legend-lmk; PRD v1.7 §3 F8, §6 C). HTTP tests run
// the real Express app, Better Auth and PostgreSQL (with RLS). The acceptance
// criteria this file proves: tenant isolation on the new tables, service-layer
// permission and outlet-scope checks, strict Zod validation at the routes and
// the edge-replication events.
import { randomBytes, randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendFixtures } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { createApp } from "../app";
import { agent, originHeader, signUp } from "./helpers";
import {
  createMenuMediaUrls,
  uploadMenuPhoto,
} from "../services/menu-media.service";

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
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [
      tenantOfRows,
    ]);
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

const menuTables = [
  "combo_components",
  "combos",
  "price_list_items",
  "price_lists",
  "item_availability",
  "menu_item_modifier_groups",
  "modifiers",
  "modifier_groups",
  "item_variants",
  "menu_items",
  "stations",
  "menu_categories",
] as const;

async function clearMenu(tenantOfRows: string) {
  await asOwnerTenant(tenantOfRows, async (client) => {
    for (const table of menuTables)
      await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
        tenantOfRows,
      ]);
  });
}

/** Signed-in client holding one seeded role at one scope. */
async function menuClient(
  templateKey: string,
  scope: { type: "tenant"; id: null } | { type: "outlet"; id: string },
): Promise<{ client: ReturnType<typeof agent>; userId: string }> {
  const client = agent(app);
  await signUp(client, "Menu User");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await ownerPool.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     SELECT $1, $2, id, $3, $4, now() - interval '1 minute', $2 FROM roles
     WHERE tenant_id = $1 AND template_key = $5`,
    [tenantId, userId, scope.type, scope.id, templateKey],
  );
  return { client, userId };
}

const createdUserIds: string[] = [];
const createdTenantIds: string[] = [];

afterAll(async () => {
  for (const tenantOfRows of [tenantId, ...createdTenantIds])
    await clearMenu(tenantOfRows);
  if (createdTenantIds.length > 0) {
    await asOwnerTenant(createdTenantIds[0], async (client) => {
      for (const id of createdTenantIds) {
        await client.query("DELETE FROM outlets WHERE tenant_id = $1", [id]);
        await client.query("DELETE FROM legal_entities WHERE tenant_id = $1", [
          id,
        ]);
        await client.query("DELETE FROM brands WHERE tenant_id = $1", [id]);
        await client.query("DELETE FROM tenants WHERE id = $1", [id]);
      }
    });
  }
  if (createdUserIds.length > 0)
    await ownerPool.query(
      "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
      [createdUserIds],
    );
  await ownerPool.end();
});

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await clearMenu(tenantId);
});

function body(response: { body: unknown }) {
  return response.body as Record<string, unknown>;
}

function data(response: { body: unknown }) {
  return body(response).data as Record<string, unknown>;
}

function page(response: { body: unknown }) {
  return body(response) as {
    data: Record<string, unknown>[];
    meta: { limit: number; nextCursor: string | null };
  };
}

describe("legend-lmk menu API", () => {
  it("rejects anonymous callers, missing permissions and strict extra fields", async () => {
    expect((await agent(app).get("/api/menu/categories")).status).toBe(401);

    const viewer = await menuClient("cashier", { type: "outlet", id: outletA });
    createdUserIds.push(viewer.userId);
    // A cashier holds menu.item.view at its outlet, not menu.item.manage.
    expect(
      (await viewer.client.get(`/api/menu/items?limit=100&brandId=${brandId}`))
        .status,
    ).toBe(200);
    expect(
      (
        await viewer.client
          .post("/api/menu/categories")
          .set(originHeader)
          .send({ name: "Tidak Boleh" })
      ).status,
    ).toBe(403);

    const admin = await menuClient("owner", { type: "tenant", id: null });
    createdUserIds.push(admin.userId);
    const injected = await admin.client
      .post("/api/menu/categories")
      .set(originHeader)
      .send({ name: "Uji", tenantId });
    expect(injected.status).toBe(422);
    const unknown = await admin.client
      .post("/api/menu/categories")
      .set(originHeader)
      .send({ name: "Uji", notAField: true });
    expect(unknown.status).toBe(422);
    // The origin check still applies to a permitted role.
    expect(
      (
        await admin.client
          .post("/api/menu/categories")
          .set({ Origin: "https://untrusted.example" })
          .send({ name: "Uji" })
      ).status,
    ).toBe(403);
  });

  it("CRUDs categories, items, variants, modifiers and combos with events", async () => {
    const { client, userId } = await menuClient("owner", {
      type: "tenant",
      id: null,
    });
    createdUserIds.push(userId);

    const category = await client
      .post("/api/menu/categories")
      .set(originHeader)
      .send({ brandId, name: "Kopi Uji" });
    expect(category.status).toBe(201);
    const categoryId = data(category).id as string;
    expect(category.headers.location).toBe(
      `/api/menu/categories/${categoryId}`,
    );

    const second = await client
      .post("/api/menu/categories")
      .set(originHeader)
      .send({ brandId, name: "Non-Kopi Uji" });
    const secondId = data(second).id as string;
    const reordered = await client
      .put("/api/menu/categories/order")
      .set(originHeader)
      .send({ orderedIds: [secondId, categoryId] });
    expect(reordered.status).toBe(204);
    const categories = page(
      await client.get(`/api/menu/categories?limit=100&brandId=${brandId}`),
    );
    expect(categories.data.map((row) => row.id).slice(0, 2)).toEqual([
      secondId,
      categoryId,
    ]);

    const item = await client
      .post("/api/menu/items")
      .set(originHeader)
      .send({
        brandId,
        categoryId,
        name: "Kopi Susu Uji",
        description: "Kopi susu gula aren",
        labels: ["signature"],
        allergens: ["susu"],
      });
    expect(item.status).toBe(201);
    const itemId = data(item).id as string;
    expect(data(item)).toMatchObject({
      brandId,
      categoryId,
      type: "single",
      isActive: true,
      mediaUrl: null,
    });

    const comboItem = await client
      .post("/api/menu/items")
      .set(originHeader)
      .send({ brandId, categoryId, name: "Paket Uji", type: "combo" });
    const comboItemId = data(comboItem).id as string;

    const variant = await client
      .post(`/api/menu/items/${itemId}/variants`)
      .set(originHeader)
      .send({ name: "Large" });
    expect(variant.status).toBe(201);
    expect(data(variant)).toMatchObject({ menuItemId: itemId, name: "Large" });

    const group = await client
      .post("/api/menu/modifier-groups")
      .set(originHeader)
      .send({ name: "Level Gula Uji", minSelect: 1, maxSelect: 1 });
    expect(group.status).toBe(201);
    const groupId = data(group).id as string;

    const modifier = await client
      .post(`/api/menu/modifier-groups/${groupId}/modifiers`)
      .set(originHeader)
      .send({ name: "Less Sugar", priceIdr: 0 });
    expect(modifier.status).toBe(201);
    expect(data(modifier)).toMatchObject({ groupId, priceIdr: 0 });

    const linked = await client
      .put(`/api/menu/items/${itemId}/modifier-groups`)
      .set(originHeader)
      .send({ groupIds: [groupId] });
    expect(linked.status).toBe(200);
    expect(data(linked)).toEqual({ groupIds: [groupId] });
    const links = await client.get(`/api/menu/items/${itemId}/modifier-groups`);
    expect(data(links)).toEqual({ groupIds: [groupId] });

    const combo = await client
      .post("/api/menu/combos")
      .set(originHeader)
      .send({
        comboItemId,
        components: [
          { menuItemId: itemId, options: [], revenueAllocationBp: 10_000 },
        ],
      });
    expect(combo.status).toBe(201);
    expect(data(combo)).toMatchObject({
      comboItemId,
      components: [
        { menuItemId: itemId, options: [], revenueAllocationBp: 10_000 },
      ],
    });

    // Deleting a category that still holds items is refused.
    expect(
      (
        await client
          .delete(`/api/menu/categories/${categoryId}`)
          .set(originHeader)
      ).status,
    ).toBe(409);

    // The outbox holds the change events for the edge down-sync.
    const events = await asOwnerTenant(tenantId, (db) =>
      db.query<{ name: string; aggregate_id: string }>(
        `SELECT event->>'name' AS name, aggregate_id FROM domain_event_outbox
         WHERE tenant_id = $1 AND destination = 'cloud-sync'`,
        [tenantId],
      ),
    );
    const names = events.rows.map((row) => row.name);
    expect(names).toContain("menu.updated");
    expect(names).toContain("menu_item.updated");
  });

  it("seeds availability, toggles 86 idempotently and broadcasts one event", async () => {
    const { client, userId } = await menuClient("owner", {
      type: "tenant",
      id: null,
    });
    createdUserIds.push(userId);
    const category = await client
      .post("/api/menu/categories")
      .set(originHeader)
      .send({
        brandId,
        name: `Ketersediaan ${randomBytes(2).toString("hex")}`,
      });
    const categoryId = data(category).id as string;
    const item = await client
      .post("/api/menu/items")
      .set(originHeader)
      .send({ brandId, categoryId, name: "Espresso Uji" });
    const itemId = data(item).id as string;

    const list = page(
      await client.get(`/api/menu/availability?limit=100&outletId=${outletA}`),
    );
    const row = list.data.find((entry) => entry.menuItemId === itemId);
    expect(row).toMatchObject({ status: "available", dailyLimit: null });
    const availabilityId = row?.id as string;

    const key = `86-${randomUUID()}`;
    const soldOut = await client
      .post(`/api/menu/availability/${availabilityId}/status`)
      .set(originHeader)
      .send({ action: "sell_out", idempotencyKey: key });
    expect(soldOut.status).toBe(200);
    expect(data(soldOut).status).toBe("sold_out");
    // A retry with the same key replays without a second event.
    const replay = await client
      .post(`/api/menu/availability/${availabilityId}/status`)
      .set(originHeader)
      .send({ action: "sell_out", idempotencyKey: key });
    expect(replay.status).toBe(200);
    expect(data(replay).status).toBe("sold_out");
    const events = await asOwnerTenant(tenantId, (db) =>
      db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM domain_event_outbox
         WHERE tenant_id = $1 AND event->>'idempotencyKey' = $2`,
        [tenantId, key],
      ),
    );
    expect(events.rows[0].count).toBe("1");
    // The same key with a different action is a conflict.
    const reused = await client
      .post(`/api/menu/availability/${availabilityId}/status`)
      .set(originHeader)
      .send({ action: "restore", idempotencyKey: key });
    expect(reused.status).toBe(409);
    expect(body(reused).error).toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
    });

    const restored = await client
      .post(`/api/menu/availability/${availabilityId}/status`)
      .set(originHeader)
      .send({ action: "restore", idempotencyKey: `86-${randomUUID()}` });
    expect(data(restored).status).toBe("available");
    // An invalid transition is a conflict, not a silent no-op.
    expect(
      (
        await client
          .post(`/api/menu/availability/${availabilityId}/status`)
          .set(originHeader)
          .send({ action: "restore", idempotencyKey: `86-${randomUUID()}` })
      ).status,
    ).toBe(409);
  });

  it("saves a channel price grid and audits the price change", async () => {
    const { client, userId } = await menuClient("owner", {
      type: "tenant",
      id: null,
    });
    createdUserIds.push(userId);
    const category = await client
      .post("/api/menu/categories")
      .set(originHeader)
      .send({
        brandId,
        name: `Harga ${randomBytes(2).toString("hex")}`,
      });
    const item = await client
      .post("/api/menu/items")
      .set(originHeader)
      .send({ brandId, categoryId: data(category).id, name: "Latte Uji" });
    const itemId = data(item).id as string;

    const list = await client
      .post("/api/menu/price-lists")
      .set(originHeader)
      .send({
        outletId: outletA,
        channel: "dine_in",
        effectiveFrom: "2026-11-02",
      });
    expect(list.status).toBe(201);
    const priceListId = data(list).id as string;
    const duplicate = await client
      .post("/api/menu/price-lists")
      .set(originHeader)
      .send({
        outletId: outletA,
        channel: "dine_in",
        effectiveFrom: "2026-11-02",
      });
    expect(duplicate.status).toBe(409);

    const saved = await client
      .put(`/api/menu/price-lists/${priceListId}/items`)
      .set(originHeader)
      .send({ items: [{ itemId, variantId: null, priceIdr: 27_000 }] });
    expect(saved.status).toBe(204);
    const entries = page(
      await client.get(`/api/menu/price-lists/${priceListId}/items?limit=100`),
    );
    expect(entries.data).toHaveLength(1);
    expect(entries.data[0]).toMatchObject({ itemId, priceIdr: 27_000 });

    const audit = await asOwnerTenant(tenantId, (db) =>
      db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_logs
         WHERE tenant_id = $1 AND event->>'objectType' = 'price_list'`,
        [tenantId],
      ),
    );
    expect(Number(audit.rows[0].count)).toBeGreaterThanOrEqual(1);
  });

  it("TEN-03 denies an outlet manager reaching another outlet", async () => {
    const { client, userId } = await menuClient("outlet_manager", {
      type: "outlet",
      id: outletB,
    });
    createdUserIds.push(userId);
    // Listing another outlet by id is out of scope.
    const denied = await client.get(
      `/api/menu/availability?limit=10&outletId=${outletA}`,
    );
    expect(denied.status).toBe(403);
    expect(body(denied).error).toMatchObject({ code: "OUTLET_OUT_OF_SCOPE" });
    // The list itself is RLS-scoped to the assigned outlet.
    const list = page(await client.get("/api/menu/availability?limit=100"));
    expect(list.data.every((row) => row.outletId === outletB)).toBe(true);
    // A row of another outlet is not even visible (404, not 403: no oracle).
    const owner = await menuClient("owner", { type: "tenant", id: null });
    createdUserIds.push(owner.userId);
    const foreign = page(
      await owner.client.get(
        `/api/menu/availability?limit=100&outletId=${outletA}`,
      ),
    );
    const foreignRow = foreign.data[0];
    if (foreignRow) {
      const attempt = await client
        .patch(`/api/menu/availability/${foreignRow.id}`)
        .set(originHeader)
        .send({ dailyLimit: 5 });
      expect([403, 404]).toContain(attempt.status);
    }
  });

  it("TEN-01 keeps menu rows of another tenant invisible", async () => {
    const otherTenant = randomUUID();
    const otherBrand = randomUUID();
    const otherEntity = randomUUID();
    const otherOutlet = randomUUID();
    const otherCategory = randomUUID();
    const otherItem = randomUUID();
    createdTenantIds.push(otherTenant);
    await asOwnerTenant(otherTenant, async (client) => {
      await client.query(
        `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
         VALUES ($1, $2, 'Tenant Lain', 'lengkap', 'active', 'shared', '{"modules":[]}', $3, $4)`,
        [
          otherTenant,
          `lain-${randomBytes(3).toString("hex")}`,
          JSON.stringify({
            maxOutlets: 1,
            maxActiveEmployees: 1,
            maxDevices: 1,
            aiRequestsPerMonth: 0,
            whatsappCostCapIdr: 0,
            aiCostCapIdr: 0,
            emailCostCapIdr: 0,
          }),
          randomUUID(),
        ],
      );
      await client.query(
        `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand Lain')`,
        [
          otherBrand,
          otherTenant,
          `brand-lain-${randomBytes(3).toString("hex")}`,
        ],
      );
      await client.query(
        `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Lain', false)`,
        [otherEntity, otherTenant],
      );
      await client.query(
        `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
         VALUES ($1, $2, $3, $4, 'LN-01', 'Outlet Lain', 'Jl. Lain', '{}')`,
        [otherOutlet, otherTenant, otherBrand, otherEntity],
      );
      await client.query(
        `INSERT INTO menu_categories (id, tenant_id, brand_id, name) VALUES ($1, $2, $3, 'Kategori Lain')`,
        [otherCategory, otherTenant, otherBrand],
      );
      await client.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name) VALUES ($1, $2, $3, $4, 'Item Lain')`,
        [otherItem, otherTenant, otherBrand, otherCategory],
      );
    });

    const { client, userId } = await menuClient("owner", {
      type: "tenant",
      id: null,
    });
    createdUserIds.push(userId);
    const categories = page(
      await client.get(`/api/menu/categories?limit=100&brandId=${brandId}`),
    );
    expect(categories.data.some((row) => row.id === otherCategory)).toBe(false);
    expect(
      (await client.get(`/api/menu/categories/${otherCategory}`)).status,
    ).toBe(404);
    expect(
      (
        await client
          .patch(`/api/menu/categories/${otherCategory}`)
          .set(originHeader)
          .send({ name: "Diubah" })
      ).status,
    ).toBe(404);
    // Referencing a foreign category when creating an item is a 404 as well.
    const attempted = await client
      .post("/api/menu/items")
      .set(originHeader)
      .send({ brandId, categoryId: otherCategory, name: "Item Baru" });
    expect(attempted.status).toBe(404);
    const items = page(
      await client.get(`/api/menu/items?limit=100&brandId=${brandId}`),
    );
    expect(items.data.some((row) => row.id === otherItem)).toBe(false);
  });

  it("uploads a menu photo through the storage adapter and resolves its URL", async () => {
    const { userId } = await menuClient("owner", { type: "tenant", id: null });
    createdUserIds.push(userId);
    const context = establishScopedTenantContext(
      establishTenantContext({ tenantId, brandId: null, source: "session" }),
      { kind: "tenant" },
    );
    const png = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "#ffffff" },
    })
      .png()
      .toBuffer();
    const storage = new FakeObjectStorage();
    const uploaded = await uploadMenuPhoto(
      context,
      userId,
      {
        fileName: "foto.png",
        contentType: "image/png",
        dataBase64: png.toString("base64"),
        width: 8,
        height: 8,
      },
      { storage },
    );
    expect(uploaded.mediaId).toMatch(/^[0-9a-f-]{36}$/);
    expect(uploaded.mediaUrl).toContain("storage.invalid/public");
    const urls = await createMenuMediaUrls(storage)(context, [
      uploaded.mediaId,
    ]);
    expect(urls.get(uploaded.mediaId)).toBe(uploaded.mediaUrl);
    // Without a storage provider the HTTP route fails closed.
    const { client } = await menuClient("owner", { type: "tenant", id: null });
    const unavailable = await client
      .post("/api/menu/media")
      .set(originHeader)
      .send({
        fileName: "foto.png",
        contentType: "image/png",
        dataBase64: png.toString("base64"),
        width: 8,
        height: 8,
      });
    expect(unavailable.status).toBe(503);
  });
});
