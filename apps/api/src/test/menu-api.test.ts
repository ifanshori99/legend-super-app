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

/** Signed-in client holding one seeded role (or a custom role id) at one scope. */
async function menuClient(
  role: string | { roleId: string },
  scope:
    | { type: "tenant"; id: null }
    | { type: "brand"; id: string }
    | { type: "outlet"; id: string },
): Promise<{ client: ReturnType<typeof agent>; userId: string }> {
  const client = agent(app);
  await signUp(client, "Menu User");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  if (typeof role === "string")
    await ownerPool.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       SELECT $1, $2, id, $3, $4, now() - interval '1 minute', $2 FROM roles
       WHERE tenant_id = $1 AND template_key = $5`,
      [tenantId, userId, scope.type, scope.id, role],
    );
  else
    await ownerPool.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
      [tenantId, userId, role.roleId, scope.type, scope.id],
    );
  return { client, userId };
}

/** A tenant-local custom role (no template) for narrow permission sets. */
async function customRole(
  name: string,
  permissions: readonly string[],
  allowedScopeTypes: readonly string[] = ["tenant", "brand", "outlet"],
): Promise<{ roleId: string }> {
  const roleId = randomUUID();
  await ownerPool.query(
    `INSERT INTO roles
       (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4::jsonb, false, $5::jsonb)`,
    [
      roleId,
      tenantId,
      name,
      JSON.stringify(permissions),
      JSON.stringify(allowedScopeTypes),
    ],
  );
  createdRoleIds.push(roleId);
  return { roleId };
}

const createdUserIds: string[] = [];
const createdTenantIds: string[] = [];
const createdRoleIds: string[] = [];

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
  if (createdRoleIds.length > 0)
    await ownerPool.query("DELETE FROM roles WHERE id = ANY($1::uuid[])", [
      createdRoleIds,
    ]);
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

/**
 * Uploads a real menu photo through the storage fake and answers its media id
 * (Q23: an item needs a photo before it can be active). The actor must hold
 * menu.item.manage at an outlet it reaches.
 */
async function menuPhoto(actorUserId: string): Promise<string> {
  const context = establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
  const png = await sharp({
    create: { width: 8, height: 8, channels: 3, background: "#ffffff" },
  })
    .png()
    .toBuffer();
  const uploaded = await uploadMenuPhoto(
    context,
    actorUserId,
    {
      fileName: "foto.png",
      contentType: "image/png",
      dataBase64: png.toString("base64"),
      width: 8,
      height: 8,
    },
    { storage: new FakeObjectStorage() },
  );
  return uploaded.mediaId;
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
      // Q23: an item without a photo starts as a draft, never as published.
      isActive: false,
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
    // Q23: a restore republishes the item, so this one carries its photo.
    const mediaId = await menuPhoto(userId);
    const item = await client.post("/api/menu/items").set(originHeader).send({
      brandId,
      categoryId,
      name: "Espresso Uji",
      mediaId,
      isActive: true,
    });
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
         VALUES ($1, $2, 'Tenant Lain', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', $3, $4)`,
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

  it("finding HIGH menu-internals.ts:128 outlet-scoped manage cannot write shared modifiers", async () => {
    const owner = await menuClient("owner", { type: "tenant", id: null });
    createdUserIds.push(owner.userId);
    const groupName = `Grup Bersama ${randomBytes(2).toString("hex")}`;
    const group = await owner.client
      .post("/api/menu/modifier-groups")
      .set(originHeader)
      .send({ name: groupName, minSelect: 0, maxSelect: 1 });
    expect(group.status).toBe(201);
    const groupId = data(group).id as string;
    const modifier = await owner.client
      .post(`/api/menu/modifier-groups/${groupId}/modifiers`)
      .set(originHeader)
      .send({ name: "Extra Shot", priceIdr: 0 });
    expect(modifier.status).toBe(201);
    const modifierId = data(modifier).id as string;

    // A grant held only at one outlet must not rewrite data every outlet shares.
    const outletManager = await menuClient("general_manager", {
      type: "outlet",
      id: outletA,
    });
    createdUserIds.push(outletManager.userId);
    const rename = await outletManager.client
      .patch(`/api/menu/modifier-groups/${groupId}`)
      .set(originHeader)
      .send({ name: "Dibajak" });
    expect(rename.status).toBe(403);
    expect(body(rename).error).toMatchObject({ code: "PERMISSION_DENIED" });
    const repriced = await outletManager.client
      .patch(`/api/menu/modifiers/${modifierId}`)
      .set(originHeader)
      .send({ priceIdr: 5_000 });
    expect(repriced.status).toBe(403);
    const created = await outletManager.client
      .post("/api/menu/modifier-groups")
      .set(originHeader)
      .send({ name: "Grup Baru", minSelect: 0, maxSelect: 1 });
    expect(created.status).toBe(403);
    const groups = page(
      await owner.client.get("/api/menu/modifier-groups?limit=100"),
    );
    expect(groups.data.find((row) => row.id === groupId)).toMatchObject({
      name: groupName,
    });

    // Brand scope is still narrower than the tenant-shared record, so it is
    // refused fail closed (its event could not enter the tenant-level stream).
    const brandManager = await menuClient("general_manager", {
      type: "brand",
      id: brandId,
    });
    createdUserIds.push(brandManager.userId);
    const brandRename = await brandManager.client
      .patch(`/api/menu/modifier-groups/${groupId}`)
      .set(originHeader)
      .send({ name: "Grup Diubah" });
    expect(brandRename.status).toBe(403);
    expect(body(brandRename).error).toMatchObject({
      code: "PERMISSION_DENIED",
    });
    const brandRepriced = await brandManager.client
      .patch(`/api/menu/modifiers/${modifierId}`)
      .set(originHeader)
      .send({ priceIdr: 5_000 });
    expect(brandRepriced.status).toBe(403);

    // A tenant-scoped grant may write the shared record (owner created it).
    const tenantManager = await menuClient("general_manager", {
      type: "tenant",
      id: null,
    });
    createdUserIds.push(tenantManager.userId);
    const tenantRename = await tenantManager.client
      .patch(`/api/menu/modifier-groups/${groupId}`)
      .set(originHeader)
      .send({ name: "Grup Tenant" });
    expect(tenantRename.status).toBe(200);
    expect(data(tenantRename)).toMatchObject({
      id: groupId,
      name: "Grup Tenant",
    });
  });

  it("finding HIGH menu.service.ts:1728 price-affecting modifier writes need menu.price.manage", async () => {
    // A tenant-scoped role that may manage menu content but not sell prices.
    const editor = await menuClient(
      await customRole("Editor Menu Uji", [
        "menu.item.view",
        "menu.item.manage",
      ]),
      { type: "tenant", id: null },
    );
    createdUserIds.push(editor.userId);
    const group = await editor.client
      .post("/api/menu/modifier-groups")
      .set(originHeader)
      .send({ name: "Level Gula Editor", minSelect: 0, maxSelect: 1 });
    expect(group.status).toBe(201);
    const groupId = data(group).id as string;

    // Creating a modifier sets its price, so the sell-price permission is needed.
    const deniedCreate = await editor.client
      .post(`/api/menu/modifier-groups/${groupId}/modifiers`)
      .set(originHeader)
      .send({ name: "Less Sugar", priceIdr: 0 });
    expect(deniedCreate.status).toBe(403);

    const owner = await menuClient("owner", { type: "tenant", id: null });
    createdUserIds.push(owner.userId);
    const modifier = await owner.client
      .post(`/api/menu/modifier-groups/${groupId}/modifiers`)
      .set(originHeader)
      .send({ name: "Less Sugar", priceIdr: 2_000 });
    expect(modifier.status).toBe(201);
    const modifierId = data(modifier).id as string;

    // Content edits stay allowed; only the price needs menu.price.manage.
    const renamed = await editor.client
      .patch(`/api/menu/modifiers/${modifierId}`)
      .set(originHeader)
      .send({ name: "Less Sugar 2" });
    expect(renamed.status).toBe(200);
    const repriced = await editor.client
      .patch(`/api/menu/modifiers/${modifierId}`)
      .set(originHeader)
      .send({ priceIdr: 3_000 });
    expect(repriced.status).toBe(403);
    expect(body(repriced).error).toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("review legend-0gvh the same item can be 86'd at two outlets (one outbox stream per availability row)", async () => {
    const { client, userId } = await menuClient("owner", {
      type: "tenant",
      id: null,
    });
    createdUserIds.push(userId);
    const category = await client
      .post("/api/menu/categories")
      .set(originHeader)
      .send({ brandId, name: `Dua Outlet ${randomBytes(2).toString("hex")}` });
    const item = await client
      .post("/api/menu/items")
      .set(originHeader)
      .send({
        brandId,
        categoryId: data(category).id as string,
        name: "Latte Dua Outlet",
      });
    const itemId = data(item).id as string;
    for (const outletId of [outletA, outletB]) {
      const list = page(
        await client.get(
          `/api/menu/availability?limit=100&outletId=${outletId}`,
        ),
      );
      const row = list.data.find((entry) => entry.menuItemId === itemId);
      expect(row).toBeDefined();
      const soldOut = await client
        .post(`/api/menu/availability/${row?.id as string}/status`)
        .set(originHeader)
        .send({ action: "sell_out", idempotencyKey: `86-${randomUUID()}` });
      expect(soldOut.status).toBe(200);
      expect(data(soldOut).status).toBe("sold_out");
    }
    const events = await asOwnerTenant(tenantId, (db) =>
      db.query<{ outlet: string }>(
        `SELECT outlet_id::text AS outlet FROM domain_event_outbox
         WHERE tenant_id = $1 AND event->>'name' = 'item.sold_out'
           AND event->'payload'->>'itemId' = $2`,
        [tenantId, itemId],
      ),
    );
    expect(events.rows.map((r) => r.outlet).sort()).toEqual(
      [outletA, outletB].map((id) => id.toLowerCase()).sort(),
    );
  });

  it("finding HIGH menu-pricing.service.ts:861 the idempotency key is bound to the request fingerprint", async () => {
    const owner = await menuClient("owner", { type: "tenant", id: null });
    createdUserIds.push(owner.userId);
    const category = await owner.client
      .post("/api/menu/categories")
      .set(originHeader)
      .send({ brandId, name: `Idempotensi ${randomBytes(2).toString("hex")}` });
    const categoryId = data(category).id as string;
    const itemIds: string[] = [];
    for (const name of ["Kopi Idem A", "Kopi Idem B"]) {
      const item = await owner.client
        .post("/api/menu/items")
        .set(originHeader)
        .send({ brandId, categoryId, name });
      expect(item.status).toBe(201);
      itemIds.push(data(item).id as string);
    }
    const list = page(
      await owner.client.get(
        `/api/menu/availability?limit=100&outletId=${outletA}`,
      ),
    );
    const availabilityOf = (itemId: string): string => {
      const row = list.data.find((entry) => entry.menuItemId === itemId);
      expect(row).toBeDefined();
      return row?.id as string;
    };
    const firstAvailability = availabilityOf(itemIds[0]);
    const secondAvailability = availabilityOf(itemIds[1]);

    const key = `86-${randomUUID()}`;
    const deadline = "2026-11-02T12:00:00.000Z";
    const soldOut = await owner.client
      .post(`/api/menu/availability/${firstAvailability}/status`)
      .set(originHeader)
      .send({
        action: "sell_out",
        soldOutUntil: deadline,
        idempotencyKey: key,
      });
    expect(soldOut.status).toBe(200);

    // An exact retry replays the recorded outcome.
    const replay = await owner.client
      .post(`/api/menu/availability/${firstAvailability}/status`)
      .set(originHeader)
      .send({
        action: "sell_out",
        soldOutUntil: deadline,
        idempotencyKey: key,
      });
    expect(replay.status).toBe(200);
    expect(data(replay).status).toBe("sold_out");

    // Same key, different payload (deadline) is a reuse, not a retry.
    const otherDeadline = await owner.client
      .post(`/api/menu/availability/${firstAvailability}/status`)
      .set(originHeader)
      .send({
        action: "sell_out",
        soldOutUntil: "2026-11-02T13:00:00.000Z",
        idempotencyKey: key,
      });
    expect(otherDeadline.status).toBe(409);
    expect(body(otherDeadline).error).toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
    });

    // Same key on another record is a reuse as well, never a silent replay.
    const otherRecord = await owner.client
      .post(`/api/menu/availability/${secondAvailability}/status`)
      .set(originHeader)
      .send({ action: "sell_out", idempotencyKey: key });
    expect(otherRecord.status).toBe(409);
    expect(body(otherRecord).error).toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
    });

    const events = await asOwnerTenant(tenantId, (db) =>
      db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM domain_event_outbox
         WHERE tenant_id = $1 AND event->>'idempotencyKey' = $2`,
        [tenantId, key],
      ),
    );
    expect(events.rows[0].count).toBe("1");
  });

  it("finding MED menu-internals.ts:403 events route by the affected outlet, not the actor scope", async () => {
    const owner = await menuClient("owner", { type: "tenant", id: null });
    createdUserIds.push(owner.userId);

    // Outlet-owned data: a tenant-wide caller's station change is outlet-local.
    const station = await owner.client
      .post("/api/menu/stations")
      .set(originHeader)
      .send({ outletId: outletA, name: "Bar Uji", type: "coffee_bar" });
    expect(station.status).toBe(201);
    const stationId = data(station).id as string;
    const stationEvents = await asOwnerTenant(tenantId, (db) =>
      db.query<{ outlet_id: string | null }>(
        `SELECT outlet_id FROM domain_event_outbox
         WHERE tenant_id = $1 AND destination = 'cloud-sync' AND aggregate_id = $2`,
        [tenantId, stationId],
      ),
    );
    expect(stationEvents.rows.map((row) => row.outlet_id)).toEqual([outletA]);

    // Brand-owned data joins the brand's stream instead of a tenant-level one:
    // the outbox requires one outlet per aggregate, so the deterministic anchor
    // is the brand's first outlet — never the actor's scope.
    const category = await owner.client
      .post("/api/menu/categories")
      .set(originHeader)
      .send({ brandId, name: `Rute Brand ${randomBytes(2).toString("hex")}` });
    expect(category.status).toBe(201);
    const categoryId = data(category).id as string;
    const categoryEvents = async () =>
      asOwnerTenant(tenantId, (db) =>
        db.query<{ outlet_id: string | null }>(
          `SELECT outlet_id FROM domain_event_outbox
           WHERE tenant_id = $1 AND destination = 'cloud-sync' AND aggregate_id = $2`,
          [tenantId, categoryId],
        ),
      );
    expect((await categoryEvents()).rows.map((row) => row.outlet_id)).toEqual([
      outletA,
    ]);

    // A narrower (brand) writer updating the same aggregate must reuse the same
    // stream — a second outlet would violate the outbox's aggregate guard.
    const brandManager = await menuClient("general_manager", {
      type: "brand",
      id: brandId,
    });
    createdUserIds.push(brandManager.userId);
    const renamed = await brandManager.client
      .patch(`/api/menu/categories/${categoryId}`)
      .set(originHeader)
      .send({ name: "Rute Brand Diubah" });
    expect(renamed.status).toBe(200);
    const afterUpdate = await categoryEvents();
    expect(afterUpdate.rows).toHaveLength(2);
    expect(afterUpdate.rows.every((row) => row.outlet_id === outletA)).toBe(
      true,
    );
  });

  it("KDS-01 clearing the station of an item clears its station type; an explicit type in the same patch wins", async () => {
    const { client, userId } = await menuClient("owner", {
      type: "tenant",
      id: null,
    });
    createdUserIds.push(userId);
    const station = await client
      .post("/api/menu/stations")
      .set(originHeader)
      .send({ outletId: outletA, name: "Bar Tipe Uji", type: "coffee_bar" });
    expect(station.status).toBe(201);
    const stationId = data(station).id as string;
    const category = await client
      .post("/api/menu/categories")
      .set(originHeader)
      .send({
        brandId,
        name: `Tipe Stasiun ${randomBytes(2).toString("hex")}`,
      });
    const categoryId = data(category).id as string;
    const created = await client
      .post("/api/menu/items")
      .set(originHeader)
      .send({ brandId, categoryId, name: "Tipe Stasiun Uji", stationId });
    expect(created.status).toBe(201);
    const itemId = data(created).id as string;
    expect(data(created)).toMatchObject({
      stationId,
      stationType: "coffee_bar",
    });

    // Clearing the station alone clears the type: no stale routing by type.
    const cleared = await client
      .patch(`/api/menu/items/${itemId}`)
      .set(originHeader)
      .send({ stationId: null });
    expect(cleared.status).toBe(200);
    expect(data(cleared)).toMatchObject({ stationId: null, stationType: null });

    // Assigning the station again carries its type.
    const assigned = await client
      .patch(`/api/menu/items/${itemId}`)
      .set(originHeader)
      .send({ stationId });
    expect(data(assigned)).toMatchObject({
      stationId,
      stationType: "coffee_bar",
    });

    // An explicit type in the same request wins over the clearing.
    const explicit = await client
      .patch(`/api/menu/items/${itemId}`)
      .set(originHeader)
      .send({ stationId: null, stationType: "pastry" });
    expect(explicit.status).toBe(200);
    expect(data(explicit)).toMatchObject({
      stationId: null,
      stationType: "pastry",
    });

    // A patch that does not touch the station leaves the type alone.
    const renamed = await client
      .patch(`/api/menu/items/${itemId}`)
      .set(originHeader)
      .send({ name: "Tipe Stasiun Uji 2" });
    expect(data(renamed)).toMatchObject({ stationType: "pastry" });
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

// Owner decision Q23 (2026-11-02): every menu item must have a photo — no
// placeholder in production. `isActive` is the published flag, so an item can
// only be active (created active, activated, or restored from 86) with a
// `mediaId`. Existing rows without a photo stay readable and editable; they
// just cannot be published again.
describe("legend-pnsa · Q23 menu item photo", () => {
  async function owner() {
    const { client, userId } = await menuClient("owner", {
      type: "tenant",
      id: null,
    });
    createdUserIds.push(userId);
    return { client, userId };
  }

  async function categoryOf(
    client: ReturnType<typeof agent>,
    label: string,
  ): Promise<string> {
    const category = await client
      .post("/api/menu/categories")
      .set(originHeader)
      .send({ brandId, name: `${label} ${randomBytes(2).toString("hex")}` });
    return data(category).id as string;
  }

  it("Q23 MENU_PHOTO_REQUIRED: an item cannot be created active without a photo", async () => {
    const { client, userId } = await owner();
    const categoryId = await categoryOf(client, "Foto Buat");

    const refused = await client
      .post("/api/menu/items")
      .set(originHeader)
      .send({ brandId, categoryId, name: "Tanpa Foto", isActive: true });
    expect(refused.status).toBe(422);
    expect(body(refused).error).toMatchObject({ code: "MENU_PHOTO_REQUIRED" });

    // The default is a draft: the import template has no photo column, so
    // imported rows must not become published items.
    const draft = await client
      .post("/api/menu/items")
      .set(originHeader)
      .send({ brandId, categoryId, name: "Draf" });
    expect(draft.status).toBe(201);
    expect(data(draft)).toMatchObject({ isActive: false, mediaId: null });

    // A media id outside this tenant is invisible under RLS: 404, no oracle.
    const foreignPhoto = await client
      .post("/api/menu/items")
      .set(originHeader)
      .send({
        brandId,
        categoryId,
        name: "Foto Asing",
        mediaId: randomUUID(),
        isActive: true,
      });
    expect(foreignPhoto.status).toBe(404);

    const mediaId = await menuPhoto(userId);
    const published = await client
      .post("/api/menu/items")
      .set(originHeader)
      .send({
        brandId,
        categoryId,
        name: "Dengan Foto",
        mediaId,
        isActive: true,
      });
    expect(published.status).toBe(201);
    expect(data(published)).toMatchObject({ isActive: true, mediaId });
  });

  it("Q23 update: activation and photo removal are refused; deactivate first", async () => {
    const { client, userId } = await owner();
    const categoryId = await categoryOf(client, "Foto Ubah");
    const created = await client
      .post("/api/menu/items")
      .set(originHeader)
      .send({ brandId, categoryId, name: "Aktivasi Uji" });
    const itemId = data(created).id as string;

    const activated = await client
      .patch(`/api/menu/items/${itemId}`)
      .set(originHeader)
      .send({ isActive: true });
    expect(activated.status).toBe(422);
    expect(body(activated).error).toMatchObject({
      code: "MENU_PHOTO_REQUIRED",
    });

    // Photo and activation in one request is one valid publish.
    const mediaId = await menuPhoto(userId);
    const published = await client
      .patch(`/api/menu/items/${itemId}`)
      .set(originHeader)
      .send({ mediaId, isActive: true });
    expect(published.status).toBe(200);
    expect(data(published)).toMatchObject({ isActive: true, mediaId });

    const stripped = await client
      .patch(`/api/menu/items/${itemId}`)
      .set(originHeader)
      .send({ mediaId: null });
    expect(stripped.status).toBe(422);
    expect(body(stripped).error).toMatchObject({ code: "MENU_PHOTO_REQUIRED" });

    // Deactivating in the same request is allowed, and the item is a draft.
    const deactivated = await client
      .patch(`/api/menu/items/${itemId}`)
      .set(originHeader)
      .send({ mediaId: null, isActive: false });
    expect(deactivated.status).toBe(200);
    expect(data(deactivated)).toMatchObject({ isActive: false, mediaId: null });

    const again = await client
      .patch(`/api/menu/items/${itemId}`)
      .set(originHeader)
      .send({ isActive: true });
    expect(again.status).toBe(422);
  });

  it("Q23 legacy: an active item without a photo stays readable and editable but cannot be published again", async () => {
    const { client, userId } = await owner();
    const categoryId = await categoryOf(client, "Foto Lama");
    const itemId = randomUUID();
    const availabilityId = randomUUID();
    await asOwnerTenant(tenantId, async (db) => {
      await db.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
         VALUES ($1, $2, $3, $4, 'Item Lama', true, NULL)`,
        [itemId, tenantId, brandId, categoryId],
      );
      await db.query(
        `INSERT INTO item_availability (id, tenant_id, outlet_id, menu_item_id)
         VALUES ($1, $2, $3, $4)`,
        [availabilityId, tenantId, outletA, itemId],
      );
    });

    // Reads and unrelated edits keep working.
    expect((await client.get(`/api/menu/items/${itemId}`)).status).toBe(200);
    const list = page(
      await client.get(
        `/api/menu/items?limit=100&brandId=${brandId}&search=Item%20Lama`,
      ),
    );
    expect(list.data.some((row) => row.id === itemId)).toBe(true);
    expect(
      (
        await client
          .patch(`/api/menu/items/${itemId}`)
          .set(originHeader)
          .send({ name: "Item Lama Baru" })
      ).status,
    ).toBe(200);

    // Publishing it again is refused, both by the item write and by 86 restore.
    const activated = await client
      .patch(`/api/menu/items/${itemId}`)
      .set(originHeader)
      .send({ isActive: true });
    expect(activated.status).toBe(422);
    expect(body(activated).error).toMatchObject({
      code: "MENU_PHOTO_REQUIRED",
    });
    const soldOut = await client
      .post(`/api/menu/availability/${availabilityId}/status`)
      .set(originHeader)
      .send({ action: "sell_out", idempotencyKey: `86-${randomUUID()}` });
    expect(soldOut.status).toBe(200);
    const restore = await client
      .post(`/api/menu/availability/${availabilityId}/status`)
      .set(originHeader)
      .send({ action: "restore", idempotencyKey: `86-${randomUUID()}` });
    expect(restore.status).toBe(422);
    expect(body(restore).error).toMatchObject({ code: "MENU_PHOTO_REQUIRED" });

    // With a photo, restore works again.
    const mediaId = await menuPhoto(userId);
    expect(
      (
        await client
          .patch(`/api/menu/items/${itemId}`)
          .set(originHeader)
          .send({ mediaId })
      ).status,
    ).toBe(200);
    const restored = await client
      .post(`/api/menu/availability/${availabilityId}/status`)
      .set(originHeader)
      .send({ action: "restore", idempotencyKey: `86-${randomUUID()}` });
    expect(restored.status).toBe(200);
    expect(data(restored).status).toBe("available");
  });

  it("Q23 TEN-03: an outlet manager cannot activate a brand item", async () => {
    const { client: admin } = await owner();
    const categoryId = await categoryOf(admin, "Foto Izin");
    const created = await admin
      .post("/api/menu/items")
      .set(originHeader)
      .send({ brandId, categoryId, name: "Item Izin" });
    const itemId = data(created).id as string;

    const manager = await menuClient("outlet_manager", {
      type: "outlet",
      id: outletA,
    });
    createdUserIds.push(manager.userId);
    const attempt = await manager.client
      .patch(`/api/menu/items/${itemId}`)
      .set(originHeader)
      .send({ isActive: true });
    // Item writes are brand-owned: an outlet-scoped manager has no brand reach.
    expect(attempt.status).toBe(403);
    expect(data(await admin.get(`/api/menu/items/${itemId}`))).toMatchObject({
      isActive: false,
    });
  });
});
