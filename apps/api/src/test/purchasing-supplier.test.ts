// Suppliers, contacts and the price catalog (PRD v1.7 §3.18 Supplier, §6.E
// suppliers / supplier_prices; bead legend-9yz slice C). Needs the disposable
// PostgreSQL database; the migration owner seeds fixtures, the restricted
// legend_app login checks RLS, and HTTP requests run as signed-in users with
// role assignments (HTTP is always tenant A; tenant B is reached through the
// service with its own context).
//
// Acceptance ids used in test names:
// - 9yz-SUP-1 supplier CRUD, contacts, validation
// - 9yz-SUP-2 price history supersedes by effective date
// - 9yz-SUP-3 permission denied without the permission
// - 9yz-ISO-1 tenant isolation
import { randomUUID } from "node:crypto";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  outletIdSchema,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  supplierPriceOnDate,
  type SupplierCatalogItem,
} from "@starter/shared/inventory";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  activeSupplierPricesOn,
  createSupplier,
  getSupplierDetail,
  listSuppliers,
  updateSupplier,
} from "../services/purchasing-supplier.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const tenantA = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendPlatformFixtures.outlets[0]!.id;
const tenantB = randomUUID();

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const appPool = new Pool({
  connectionString: process.env.APP_DATABASE_URL,
  max: 2,
});
const app = createApp();

const createdUserIds: string[] = [];
const createdSupplierIds: string[] = [];
const createdItemIds: string[] = [];
const createdUomIds: string[] = [];
const roleBId = randomUUID();
const userBId = randomUUID();
let uomKg: string;
let itemA: string;
let itemB: string;

function tenantContext(
  tenantId: string = tenantA,
  outletIds: readonly string[] | null = null,
): ScopedTenantContext {
  const reach = outletIds?.map((id) => outletIdSchema.parse(id) as OutletId);
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "domain" }),
    reach === null || reach === undefined
      ? { kind: "tenant" }
      : { kind: "outlets", outletIds: reach },
  );
}

async function asTenant<T>(
  tenantId: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    return await run(client as unknown as Client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantA, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role for tenant ${tenantA}`);
  return rows[0].id;
}

async function assignRole(
  userId: string,
  templateKey: string,
  scope: { type: "tenant" } | { type: "outlet"; id: string },
): Promise<void> {
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [
      tenantA,
      userId,
      await roleIdOf(templateKey),
      scope.type,
      scope.type === "outlet" ? scope.id : null,
    ],
  );
}

async function signedIn(name: string) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  return { client, userId };
}

async function signedInAs(
  name: string,
  templateKey: string,
  scope: { type: "tenant" } | { type: "outlet"; id: string } = {
    type: "tenant",
  },
) {
  const session = await signedIn(name);
  await assignRole(session.userId, templateKey, scope);
  return session;
}

const body = (overrides: Record<string, unknown> = {}) => ({
  name: `Supplier ${randomUUID().slice(0, 8)}`,
  paymentTermsDays: 14,
  idempotencyKey: `sup-${randomUUID()}`,
  ...overrides,
});

async function createViaHttp(
  client: ReturnType<typeof agent>,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; updatedAt: string; name: string }> {
  const response = await client
    .post("/api/inventory/suppliers")
    .set(originHeader)
    .send(body(overrides));
  expect(response.status).toBe(201);
  createdSupplierIds.push(response.body.data.id);
  return response.body.data;
}

let ownerUserId: string;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Supplier Tenant B', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      tenantB,
      `sup-b-${randomUUID().slice(0, 8)}`,
      JSON.stringify({ modules: [], integrationProviders: [] }),
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
  // A tenant B buyer who may manage suppliers, to prove RLS (not permission)
  // is what hides tenant A rows.
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [userBId, "Supplier Tenant B Buyer", `${userBId}@example.com`],
  );
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, permissions, allowed_scope_types)
     VALUES ($1, $2, 'Buyer B', $3, '["tenant"]')`,
    [
      roleBId,
      tenantB,
      JSON.stringify([
        "purchasing.supplier.manage",
        "purchasing.request.create",
      ]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
    [tenantB, userBId, roleBId],
  );

  const uom = await owner.query<{ id: string }>(
    "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
    [tenantA, `kg${randomUUID().slice(0, 6)}`],
  );
  uomKg = uom.rows[0]!.id;
  createdUomIds.push(uomKg);
  for (const name of ["Kopi Supplier", "Gula Supplier"]) {
    const item = await owner.query<{ id: string }>(
      "INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id) VALUES ($1, $2, 'Bahan Baku', 'raw_material', $3) RETURNING id",
      [tenantA, `${name} ${randomUUID().slice(0, 6)}`, uomKg],
    );
    createdItemIds.push(item.rows[0]!.id);
  }
  [itemA, itemB] = createdItemIds as [string, string];

  ownerUserId = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [ownerUserId, "Supplier Owner", `${ownerUserId}@example.com`],
  );
  await assignRole(ownerUserId, "owner", { type: "tenant" });
});

afterAll(async () => {
  const suppliers = createdSupplierIds;
  await owner.query(
    "DELETE FROM supplier_prices WHERE supplier_id = ANY($1::uuid[])",
    [suppliers],
  );
  await owner.query(
    "DELETE FROM supplier_contacts WHERE supplier_id = ANY($1::uuid[])",
    [suppliers],
  );
  await owner.query(
    "DELETE FROM purchasing_idempotency WHERE tenant_id = ANY($1::uuid[]) AND operation LIKE 'supplier.%'",
    [[tenantA, tenantB]],
  );
  await owner.query("DELETE FROM suppliers WHERE id = ANY($1::uuid[])", [
    suppliers,
  ]);
  await owner.query(
    "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
    [[...createdUserIds, ownerUserId, userBId]],
  );
  await owner.query("DELETE FROM roles WHERE id = $1", [roleBId]);
  await owner.query("DELETE FROM inventory_items WHERE id = ANY($1::uuid[])", [
    createdItemIds,
  ]);
  await owner.query("DELETE FROM uoms WHERE id = ANY($1::uuid[])", [
    createdUomIds,
  ]);
  await owner.query("DELETE FROM tenants WHERE id = $1", [tenantB]);
  await owner.end();
  await appPool.end();
});

describe("9yz-SUP-1 suppliers and contacts", () => {
  it("[9yz-SUP-1] creates, reads, lists and patches a supplier", async () => {
    const { client } = await signedInAs("Buyer SUP-1", "purchasing");
    const created = await createViaHttp(client, {
      legalName: "PT Kopi Jaya",
      phone: "+628123456789",
      email: "sales@kopijaya.example",
      address: "Jl. Kopi 1",
      rating: 4,
    });
    expect(created).toMatchObject({
      tenantId: tenantA,
      legalName: "PT Kopi Jaya",
      paymentTermsDays: 14,
      rating: 4,
      isActive: true,
    });

    const detail = await client.get(`/api/inventory/suppliers/${created.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.supplier.id).toBe(created.id);
    expect(detail.body.data.contacts).toEqual([]);

    const patched = await client
      .patch(`/api/inventory/suppliers/${created.id}`)
      .set(originHeader)
      .send({
        paymentTermsDays: 30,
        rating: null,
        isActive: false,
        expectedUpdatedAt: created.updatedAt,
      });
    expect(patched.status).toBe(200);
    expect(patched.body.data).toMatchObject({
      paymentTermsDays: 30,
      rating: null,
      isActive: false,
      legalName: "PT Kopi Jaya",
    });

    // A stale expectedUpdatedAt is refused (CORE PRECONDITION_FAILED).
    const stale = await client
      .patch(`/api/inventory/suppliers/${created.id}`)
      .set(originHeader)
      .send({ name: "Stale", expectedUpdatedAt: created.updatedAt });
    expect(stale.body.error.code).toBe("PRECONDITION_FAILED");

    const inactive = await client.get(
      "/api/inventory/suppliers?isActive=false",
    );
    expect(
      inactive.body.data.some((row: { id: string }) => row.id === created.id),
    ).toBe(true);
    const active = await client.get("/api/inventory/suppliers?isActive=true");
    expect(
      active.body.data.some((row: { id: string }) => row.id === created.id),
    ).toBe(false);
  });

  it("[9yz-SUP-1] replays a key, rejects a reused key and a duplicate name", async () => {
    const { client } = await signedInAs("Buyer SUP-1 idem", "purchasing");
    const input = body();
    const first = await client
      .post("/api/inventory/suppliers")
      .set(originHeader)
      .send(input);
    expect(first.status).toBe(201);
    createdSupplierIds.push(first.body.data.id);
    const replay = await client
      .post("/api/inventory/suppliers")
      .set(originHeader)
      .send(input);
    expect(replay.status).toBe(201);
    expect(replay.body.data.id).toBe(first.body.data.id);
    const reused = await client
      .post("/api/inventory/suppliers")
      .set(originHeader)
      .send({ ...input, paymentTermsDays: 7 });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    const duplicate = await client
      .post("/api/inventory/suppliers")
      .set(originHeader)
      .send(body({ name: String(input.name).toUpperCase() }));
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe("CONFLICT");
  });

  it("[9yz-SUP-1] validates bodies strictly", async () => {
    const { client } = await signedInAs("Buyer SUP-1 validation", "purchasing");
    const post = (payload: Record<string, unknown>) =>
      client.post("/api/inventory/suppliers").set(originHeader).send(payload);
    expect((await post(body({ phone: "12ab" }))).status).toBe(422);
    expect((await post(body({ paymentTermsDays: 400 }))).status).toBe(422);
    expect((await post(body({ rating: 6 }))).status).toBe(422);
    expect((await post(body({ name: "   " }))).status).toBe(422);
    expect((await post(body({ tenantId: tenantB }))).status).toBe(422);
    expect((await post(body({ email: "not-an-email" }))).status).toBe(422);
    const notFound = await client.get(
      `/api/inventory/suppliers/${randomUUID()}`,
    );
    expect(notFound.status).toBe(404);
  });

  it("[9yz-SUP-1] contacts: one primary, new primary demotes the old, replay is stable", async () => {
    const { client } = await signedInAs("Buyer SUP-1 contacts", "purchasing");
    const supplier = await createViaHttp(client);
    const contactInput = (overrides: Record<string, unknown> = {}) => ({
      name: "Budi",
      role: "Sales",
      phone: "081234567890",
      isPrimary: true,
      idempotencyKey: `con-${randomUUID()}`,
      ...overrides,
    });
    const send = (payload: Record<string, unknown>) =>
      client
        .post(`/api/inventory/suppliers/${supplier.id}/contacts`)
        .set(originHeader)
        .send(payload);
    const first = contactInput();
    const one = await send(first);
    expect(one.status).toBe(201);
    expect((await send(first)).body.data.id).toBe(one.body.data.id);
    const two = await send(contactInput({ name: "Sari" }));
    expect(two.status).toBe(201);
    const three = await send(
      contactInput({ name: "Andi", isPrimary: false, email: "a@x.example" }),
    );
    expect(three.status).toBe(201);
    expect((await send(contactInput({ phone: "abc" }))).status).toBe(422);

    const detail = await client.get(`/api/inventory/suppliers/${supplier.id}`);
    const contacts = detail.body.data.contacts as {
      id: string;
      isPrimary: boolean;
    }[];
    expect(contacts).toHaveLength(3);
    expect(contacts.filter((contact) => contact.isPrimary)).toHaveLength(1);
    expect(contacts[0]).toMatchObject({
      id: two.body.data.id,
      isPrimary: true,
    });
  });

  it("[9yz-SUP-1] paginates the supplier list by name", async () => {
    const { client } = await signedInAs("Buyer SUP-1 paging", "purchasing");
    const prefix = `Paging ${randomUUID().slice(0, 6)}`;
    for (const suffix of ["a", "b", "c"])
      await createViaHttp(client, { name: `${prefix} ${suffix}` });
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 200; page += 1) {
      const response = await client.get(
        `/api/inventory/suppliers?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(response.status).toBe(200);
      for (const row of response.body.data as { name: string }[])
        if (row.name.startsWith(prefix)) seen.push(row.name);
      cursor = response.body.meta.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([`${prefix} a`, `${prefix} b`, `${prefix} c`]);
    expect(
      (await client.get("/api/inventory/suppliers?cursor=garbage")).status,
    ).toBe(422);
  });
});

describe("9yz-SUP-2 catalog and price history", () => {
  it("[9yz-SUP-2] a new price row supersedes older ones from its date", async () => {
    const { client } = await signedInAs("Buyer SUP-2", "purchasing");
    const supplier = await createViaHttp(client);
    const post = (payload: Record<string, unknown>) =>
      client
        .post(`/api/inventory/suppliers/${supplier.id}/catalog`)
        .set(originHeader)
        .send({
          inventoryItemId: itemA,
          purchaseUomId: uomKg,
          idempotencyKey: `price-${randomUUID()}`,
          ...payload,
        });
    const base = await post({
      priceIdr: "10000.0000",
      effectiveFrom: "2025-01-01",
    });
    expect(base.status).toBe(201);
    expect(base.body.data).toMatchObject({
      supplierId: supplier.id,
      priceIdr: "10000.0000",
      isActive: true,
    });
    expect(
      (await post({ priceIdr: "12000.0000", effectiveFrom: "2025-06-01" }))
        .status,
    ).toBe(201);
    // Back-dated quote lands between the two (append-only, ordered by date).
    expect(
      (await post({ priceIdr: "9000.0000", effectiveFrom: "2025-03-01" }))
        .status,
    ).toBe(201);
    // Future-dated quote: in history, not in today's catalog.
    expect(
      (await post({ priceIdr: "15000.0000", effectiveFrom: "2999-01-01" }))
        .status,
    ).toBe(201);
    // A different item has its own history.
    expect(
      (
        await post({
          inventoryItemId: itemB,
          priceIdr: "500.5000",
          effectiveFrom: "2025-01-01",
        })
      ).status,
    ).toBe(201);

    const history = await client.get(
      `/api/inventory/suppliers/${supplier.id}/prices?inventoryItemId=${itemA}`,
    );
    expect(history.status).toBe(200);
    const rows = history.body.data as SupplierCatalogItem[];
    expect(rows.map((row) => row.effectiveFrom)).toEqual([
      "2999-01-01",
      "2025-06-01",
      "2025-03-01",
      "2025-01-01",
    ]);
    const priceOn = (onDate: string) =>
      supplierPriceOnDate(rows, {
        supplierId: supplier.id,
        inventoryItemId: itemA,
        onDate: onDate as never,
      })?.priceIdr;
    expect(priceOn("2025-02-01")).toBe("10000.0000");
    expect(priceOn("2025-04-01")).toBe("9000.0000");
    expect(priceOn("2025-07-01")).toBe("12000.0000");
    expect(priceOn("2024-12-31")).toBeUndefined();

    const catalog = await client.get(
      `/api/inventory/suppliers/${supplier.id}/catalog`,
    );
    expect(catalog.status).toBe(200);
    const catalogRows = catalog.body.data as SupplierCatalogItem[];
    expect(catalogRows).toHaveLength(2);
    expect(
      catalogRows.find((row) => row.inventoryItemId === itemA)?.priceIdr,
    ).toBe("12000.0000");

    // Service helper for the PR estimate: price in force on a date.
    const onDate = async (date: string, supplierId: string | null) =>
      withTenant(db, tenantContext(), (tx) =>
        activeSupplierPricesOn(tx, tenantContext(), supplierId, [itemA], date),
      );
    expect(
      (await onDate("2025-04-01", supplier.id)).map((r) => r.priceIdr),
    ).toEqual(["9000.0000"]);
    expect(
      (await onDate("2025-12-01", supplier.id)).map((r) => r.priceIdr),
    ).toEqual(["12000.0000"]);
    expect(await onDate("2024-01-01", supplier.id)).toEqual([]);
    expect(
      (await onDate("2025-12-01", null)).some(
        (r) => r.supplierId === supplier.id,
      ),
    ).toBe(true);
  });

  it("[9yz-SUP-2] refuses a price for an inactive supplier, unknown item or bad price", async () => {
    const { client } = await signedInAs("Buyer SUP-2 refuse", "purchasing");
    const supplier = await createViaHttp(client);
    const post = (payload: Record<string, unknown>) =>
      client
        .post(`/api/inventory/suppliers/${supplier.id}/catalog`)
        .set(originHeader)
        .send({
          inventoryItemId: itemA,
          purchaseUomId: uomKg,
          priceIdr: "1000.0000",
          effectiveFrom: "2025-01-01",
          idempotencyKey: `price-${randomUUID()}`,
          ...payload,
        });
    expect((await post({ inventoryItemId: randomUUID() })).status).toBe(404);
    expect((await post({ purchaseUomId: randomUUID() })).status).toBe(404);
    expect((await post({ priceIdr: "-1.0000" })).status).toBe(422);
    expect((await post({ effectiveFrom: "01-01-2025" })).status).toBe(422);
    const keyed = { idempotencyKey: `price-${randomUUID()}` };
    expect((await post(keyed)).status).toBe(201);
    expect((await post(keyed)).status).toBe(201);
    expect((await post({ ...keyed, priceIdr: "2000.0000" })).status).toBe(409);
    const current = await client.get(`/api/inventory/suppliers/${supplier.id}`);
    const deactivated = await client
      .patch(`/api/inventory/suppliers/${supplier.id}`)
      .set(originHeader)
      .send({
        isActive: false,
        expectedUpdatedAt: current.body.data.supplier.updatedAt,
      });
    expect(deactivated.status).toBe(200);
    expect((await post({})).status).toBe(409);
    const count = await owner.query(
      "SELECT count(*)::int AS n FROM supplier_prices WHERE supplier_id = $1",
      [supplier.id],
    );
    expect(count.rows[0]!.n).toBe(1);
  });
});

describe("9yz-SUP-3 permissions", () => {
  it("[9yz-SUP-3] needs a session and the supplier permission", async () => {
    expect((await agent(app).get("/api/inventory/suppliers")).status).toBe(401);

    // Cashier holds no purchasing permission: no read, no write.
    const cashier = await signedInAs("Cashier SUP-3", "cashier", {
      type: "outlet",
      id: outletA,
    });
    expect((await cashier.client.get("/api/inventory/suppliers")).status).toBe(
      403,
    );
    expect(
      (
        await cashier.client
          .post("/api/inventory/suppliers")
          .set(originHeader)
          .send(body())
      ).status,
    ).toBe(403);

    // Outlet manager may request purchases: reads suppliers, cannot manage.
    const manager = await signedInAs("Outlet manager SUP-3", "outlet_manager", {
      type: "outlet",
      id: outletA,
    });
    expect((await manager.client.get("/api/inventory/suppliers")).status).toBe(
      200,
    );
    expect(
      (
        await manager.client
          .post("/api/inventory/suppliers")
          .set(originHeader)
          .send(body())
      ).status,
    ).toBe(403);
    const supplier = await createViaHttp(
      (await signedInAs("Buyer SUP-3", "purchasing")).client,
    );
    expect(
      (
        await manager.client
          .patch(`/api/inventory/suppliers/${supplier.id}`)
          .set(originHeader)
          .send({ rating: 1, expectedUpdatedAt: supplier.updatedAt })
      ).status,
    ).toBe(403);
    expect(
      (
        await manager.client
          .post(`/api/inventory/suppliers/${supplier.id}/catalog`)
          .set(originHeader)
          .send({
            inventoryItemId: itemA,
            purchaseUomId: uomKg,
            priceIdr: "1.0000",
            effectiveFrom: "2025-01-01",
            idempotencyKey: `price-${randomUUID()}`,
          })
      ).status,
    ).toBe(403);
    expect(
      (await manager.client.get(`/api/inventory/suppliers/${supplier.id}`))
        .status,
    ).toBe(200);
    // Mutations without the trusted origin header are refused.
    expect(
      (await cashier.client.post("/api/inventory/suppliers").send(body()))
        .status,
    ).toBe(403);
  });

  it("[9yz-SUP-3] the service re-checks the permission without the route gate", async () => {
    const { userId } = await signedIn("Cashier SUP-3 service");
    await assignRole(userId, "cashier", { type: "outlet", id: outletA });
    const scoped = tenantContext(tenantA, [outletA]);
    await expect(
      createSupplier(scoped, userId, body() as never),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      listSuppliers(scoped, userId, { limit: 10 }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});

describe("9yz-ISO-1 tenant isolation", () => {
  it("[9yz-ISO-1] tenant B cannot read or patch a tenant A supplier and RLS returns no rows", async () => {
    const { client } = await signedInAs("Buyer ISO-1", "purchasing");
    const supplier = await createViaHttp(client);
    await client
      .post(`/api/inventory/suppliers/${supplier.id}/contacts`)
      .set(originHeader)
      .send({
        name: "Budi",
        phone: "081234567890",
        isPrimary: true,
        idempotencyKey: `con-${randomUUID()}`,
      });
    await client
      .post(`/api/inventory/suppliers/${supplier.id}/catalog`)
      .set(originHeader)
      .send({
        inventoryItemId: itemA,
        purchaseUomId: uomKg,
        priceIdr: "1000.0000",
        effectiveFrom: "2025-01-01",
        idempotencyKey: `price-${randomUUID()}`,
      });

    // Tenant B's buyer holds the permission, yet the row does not exist for it.
    const scopedB = tenantContext(tenantB);
    await expect(
      getSupplierDetail(scopedB, userBId, supplier.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      updateSupplier(scopedB, userBId, supplier.id, {
        name: "Hijacked",
        expectedUpdatedAt: supplier.updatedAt,
      } as never),
    ).rejects.toMatchObject({ status: 404 });
    const listB = await listSuppliers(scopedB, userBId, { limit: 100 });
    expect(listB.data).toEqual([]);
    const row = await owner.query<{ name: string }>(
      "SELECT name FROM suppliers WHERE id = $1",
      [supplier.id],
    );
    expect(row.rows[0]!.name).toBe(supplier.name);

    for (const table of [
      "suppliers",
      "supplier_contacts",
      "supplier_prices",
      "purchasing_idempotency",
    ]) {
      const seen = await asTenant(tenantB, (c) =>
        c.query(`SELECT 1 FROM ${table}`),
      );
      expect(seen.rows, table).toHaveLength(0);
    }
    // Tenant A's own app login sees its rows (the policy filters, not blocks).
    const own = await asTenant(tenantA, (c) =>
      c.query("SELECT 1 FROM suppliers WHERE id = $1", [supplier.id]),
    );
    expect(own.rows).toHaveLength(1);
  });
});
