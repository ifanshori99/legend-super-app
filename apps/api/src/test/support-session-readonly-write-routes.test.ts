// Support session read_only across many routers (legend-hmig6, TEN-04, tier K: auth).
// "Data pribadi dan keuangan tenant hanya dapat dibuka Super Admin melalui sesi
// berjangka ... read-only secara default" (PRD v1.7 §3 F4 Support Access).
//
// support-session-readonly.test.ts proves the guard on a handful of routes. This
// file fires write requests (POST/PATCH/PUT/DELETE) at routers of different
// areas (org, access, menu, inventory, floor, tax, hris, payroll, pos) with a
// read_only support session and expects, for every one: HTTP 403
// SUPPORT_ACCESS_READ_ONLY and no changed row. GET routes stay open (200).
//
// Assumptions (spec silent):
// - The refusal is the same 403 + body.error.code "SUPPORT_ACCESS_READ_ONLY"
//   the sibling suite uses; the guard answers before validation or lookup, so
//   routes addressed by a random id (payroll run, pos order) are refused too.
// - "Nothing changed" is read through public GET routes by the normal
//   (non-impersonated) tenant session, or by SQL for floor zones and stations
//   (no GET with a stable shape was found in the existing suites).
// - The announcement feed and tax rule list show a freshly created unique
//   title/code only when the write happened; absence there is the check.
// - If a route ACCEPTS the write, its test fails with the real status in the
//   message; the route is a guard gap to fix, not to hide.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUlid } from "@starter/shared/core";
import { orderIdSchema } from "@starter/shared/kitchen";
import { payrollRunIdSchema } from "@starter/shared/hris/payroll";
import {
  cafeLegendPlatformFixtures,
  requestSupportAccessInputSchema,
  type RequestSupportAccessInput,
} from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { requestSupportAccess } from "../services/platform-support.service.ts";
import {
  agent,
  originHeader,
  setRole,
  signUp,
  verifySessionMfa,
} from "./helpers.ts";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletId = cafeLegendPlatformFixtures.outlets[0]!.id;
const db = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const REASON = "Menelusuri keluhan pelanggan atas pengaturan tenant.";
const unique = () => randomBytes(4).toString("hex");

type Client = ReturnType<typeof agent>;
type Tenant = {
  client: Client;
  userId: string;
  email: string;
  brandId: string;
};

const platformAdminIds: string[] = [];
const tenantUserIds: string[] = [];
const createdRoleIds: string[] = [];
const createdStationIds: string[] = [];
const domainIds: string[] = [];

let tenant: Tenant;
let support: Client;

// Fixtures made by the normal owner session before the support session starts.
let domainId: string;
let domainHostname: string;
let roleId: string;
let roleName: string;
let stationId: string;
let stationName: string;
let supplierId: string;
let supplierName: string;
let supplierUpdatedAt: string;
let categoryIds: string[] = [];
let legalEntityId: string;

async function asOwnerTenant<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
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

/** A tenant Owner (normal session). */
async function newTenantOwner(): Promise<Tenant> {
  const client = agent(app);
  const email = await signUp(client, "Pemilik Tenant");
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  tenantUserIds.push(userId);
  await db.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
     WHERE tenant_id = $1 AND template_key = 'owner'`,
    [tenantId, userId],
  );
  await verifySessionMfa(email);
  const brands = await client.get("/api/org/brands");
  expect(brands.status).toBe(200);
  return { client, userId, email, brandId: brands.body.data[0].id as string };
}

/** A Super Admin: Better Auth `admin` role plus a platform_admins row. */
async function newSuperAdmin() {
  const client = agent(app);
  const email = await signUp(client, "Super Admin Dukungan");
  await setRole(email, "admin");
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  await db.query("INSERT INTO platform_admins (user_id) VALUES ($1)", [userId]);
  platformAdminIds.push(userId);
  return { client, userId, email };
}

function openGrant(
  adminUserId: string,
  input: Partial<Omit<RequestSupportAccessInput, "mfaCode">> = {},
  now: Date = new Date(),
) {
  return requestSupportAccess({
    tenantId,
    actorUserId: adminUserId,
    request: requestSupportAccessInputSchema.parse({
      reason: REASON,
      mfaCode: "123456",
      ...input,
    }),
    mfaVerifiedAt: now.toISOString(),
    now,
  });
}

async function created<T extends { id: string }>(
  response: { status: number; body: { data: T } },
  label: string,
): Promise<T> {
  expect(response.status, `fixture ${label}: ${JSON.stringify(response)}`).toBe(
    201,
  );
  return response.body.data;
}

function expectReadOnlyRefusal(response: {
  status: number;
  body: { error?: { code?: string } };
}) {
  expect(response.status, JSON.stringify(response.body)).toBe(403);
  expect(response.body.error?.code).toBe("SUPPORT_ACCESS_READ_ONLY");
}

beforeAll(async () => {
  tenant = await newTenantOwner();

  // org: one domain to delete.
  domainHostname = `dukungan-${unique()}.example.com`;
  const domain = await created(
    await tenant.client
      .post("/api/org/domains")
      .set(originHeader)
      .send({ brandId: tenant.brandId, hostname: domainHostname }),
    "domain",
  );
  domainId = domain.id;
  domainIds.push(domainId);

  // access: one custom role to edit.
  roleName = `Peran dukungan ${unique()}`;
  const role = await created(
    await tenant.client
      .post("/api/access/roles")
      .set(originHeader)
      .send({
        name: roleName,
        permissions: ["access.role.view"],
        allowedScopeTypes: ["tenant"],
      }),
    "role",
  );
  roleId = role.id;
  createdRoleIds.push(roleId);

  // menu: a station (SQL, like station-config suites) and two categories.
  stationName = `Stasiun dukungan ${unique()}`;
  stationId = (
    await asOwnerTenant((client) =>
      client.query<{ id: string }>(
        `INSERT INTO stations (tenant_id, outlet_id, name, type)
         VALUES ($1, $2, $3, 'hot_kitchen') RETURNING id`,
        [tenantId, outletId, stationName],
      ),
    )
  ).rows[0]!.id;
  createdStationIds.push(stationId);
  categoryIds = [];
  for (const label of ["Satu", "Dua"]) {
    const category = await created(
      await tenant.client
        .post("/api/menu/categories")
        .set(originHeader)
        .send({ brandId: tenant.brandId, name: `Kat ${label} ${unique()}` }),
      "category",
    );
    categoryIds.push(category.id);
  }

  // inventory: one supplier to edit.
  supplierName = `Pemasok dukungan ${unique()}`;
  const supplier = await created(
    await tenant.client
      .post("/api/inventory/suppliers")
      .set(originHeader)
      .send({
        name: supplierName,
        paymentTermsDays: 14,
        idempotencyKey: `sup-${randomUUID()}`,
      }),
    "supplier",
  );
  supplierId = supplier.id;
  supplierUpdatedAt = (supplier as unknown as { updatedAt: string }).updatedAt;

  // payroll: a legal entity with no payout config yet.
  const entity = await created(
    await tenant.client
      .post("/api/org/legal-entities")
      .set(originHeader)
      .send({
        name: `PT Dukungan ${unique()}`,
        npwp: null,
        isPkp: false,
        address: "Kota Bandung",
      }),
    "legal entity",
  );
  legalEntityId = entity.id;

  // Read_only grant, then the Super Admin becomes the tenant owner's session.
  const admin = await newSuperAdmin();
  await openGrant(admin.userId);
  const started = await admin.client
    .post("/api/auth/admin/impersonate-user")
    .set(originHeader)
    .send({ userId: tenant.userId });
  expect(started.status).toBe(200);
  await verifySessionMfa(tenant.email);
  support = admin.client;
}, 120_000);

afterAll(async () => {
  for (const id of domainIds)
    await tenant.client
      .delete(`/api/org/domains/${id}`)
      .set(originHeader)
      .catch(() => undefined);
  await db.query(
    "DELETE FROM stations WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
    [tenantId, createdStationIds],
  );
  await db.query(
    "DELETE FROM support_access_grants WHERE super_admin_user_id = ANY($1::text[])",
    [platformAdminIds],
  );
  await db.query(
    "DELETE FROM platform_admins WHERE user_id = ANY($1::text[])",
    [platformAdminIds],
  );
  await db.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [tenantId, tenantUserIds],
  );
  await db.query(
    "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
    [tenantId, createdRoleIds],
  );
  await db.end();
});

const dataOf = (response: { body: { data: unknown } }) => response.body.data;

async function categoryOrder(): Promise<string[]> {
  const response = await tenant.client.get(
    `/api/menu/categories?limit=100&brandId=${tenant.brandId}`,
  );
  expect(response.status).toBe(200);
  return (dataOf(response) as Array<{ id: string }>)
    .map((row) => row.id)
    .filter((id) => categoryIds.includes(id));
}

async function stationRow() {
  const { rows } = await asOwnerTenant((client) =>
    client.query<{ name: string; deleted_at: Date | null }>(
      "SELECT name, deleted_at FROM stations WHERE id = $1",
      [stationId],
    ),
  );
  return rows[0];
}

describe("legend-hmig6 TEN-04 read_only support session refuses writes on every router", () => {
  it("TEN-04 org: POST /api/org/domains is refused and no domain appears", async () => {
    const hostname = `ditolak-${unique()}.example.com`;
    expectReadOnlyRefusal(
      await support
        .post("/api/org/domains")
        .set(originHeader)
        .send({ brandId: tenant.brandId, hostname }),
    );
    const list = await tenant.client.get("/api/org/domains");
    expect(JSON.stringify(list.body)).not.toContain(hostname);
  });

  it("TEN-04 org: DELETE /api/org/domains/:id is refused and the domain stays", async () => {
    expectReadOnlyRefusal(
      await support.delete(`/api/org/domains/${domainId}`).set(originHeader),
    );
    const list = await tenant.client.get("/api/org/domains");
    expect(JSON.stringify(list.body)).toContain(domainHostname);
  });

  it("TEN-04 org: POST /api/org/legal-entities is refused and no entity appears", async () => {
    const name = `PT Ditolak ${unique()}`;
    expectReadOnlyRefusal(
      await support.post("/api/org/legal-entities").set(originHeader).send({
        name,
        npwp: null,
        isPkp: false,
        address: "Kota Bandung",
      }),
    );
    const list = await tenant.client.get("/api/org/legal-entities");
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(name);
  });

  it("TEN-04 access: PATCH /api/access/roles/:id is refused and the role keeps its name", async () => {
    expectReadOnlyRefusal(
      await support
        .patch(`/api/access/roles/${roleId}`)
        .set(originHeader)
        .send({ name: `Diubah dukungan ${unique()}` }),
    );
    const roles = await tenant.client.get("/api/access/roles");
    expect(
      (dataOf(roles) as Array<{ id: string; name: string }>).find(
        (r) => r.id === roleId,
      )?.name,
    ).toBe(roleName);
  });

  it("TEN-04 menu: POST /api/menu/categories is refused and no category appears", async () => {
    const name = `Kat ditolak ${unique()}`;
    expectReadOnlyRefusal(
      await support
        .post("/api/menu/categories")
        .set(originHeader)
        .send({ brandId: tenant.brandId, name }),
    );
    const list = await tenant.client.get(
      `/api/menu/categories?limit=100&brandId=${tenant.brandId}`,
    );
    expect(JSON.stringify(list.body)).not.toContain(name);
  });

  it("TEN-04 menu: PUT /api/menu/categories/order is refused and the order is unchanged", async () => {
    const before = await categoryOrder();
    expect(before).toHaveLength(2);
    expectReadOnlyRefusal(
      await support
        .put("/api/menu/categories/order")
        .set(originHeader)
        .send({ orderedIds: [...before].reverse() }),
    );
    expect(await categoryOrder()).toEqual(before);
  });

  it("TEN-04 menu: PATCH /api/menu/stations/:id is refused and the station keeps its name", async () => {
    expectReadOnlyRefusal(
      await support
        .patch(`/api/menu/stations/${stationId}`)
        .set(originHeader)
        .send({ name: `Diubah ${unique()}` }),
    );
    expect((await stationRow())?.name).toBe(stationName);
  });

  it("TEN-04 menu: DELETE /api/menu/stations/:id is refused and the station is not deleted", async () => {
    expectReadOnlyRefusal(
      await support
        .delete(`/api/menu/stations/${stationId}`)
        .set(originHeader)
        .send(),
    );
    expect((await stationRow())?.deleted_at).toBeNull();
  });

  it("TEN-04 inventory: POST /api/inventory/suppliers is refused and no supplier appears", async () => {
    const name = `Pemasok ditolak ${unique()}`;
    expectReadOnlyRefusal(
      await support
        .post("/api/inventory/suppliers")
        .set(originHeader)
        .send({
          name,
          paymentTermsDays: 14,
          idempotencyKey: `sup-${randomUUID()}`,
        }),
    );
    const list = await tenant.client.get("/api/inventory/suppliers");
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(name);
  });

  it("TEN-04 inventory: PATCH /api/inventory/suppliers/:id is refused and the supplier is unchanged", async () => {
    expectReadOnlyRefusal(
      await support
        .patch(`/api/inventory/suppliers/${supplierId}`)
        .set(originHeader)
        .send({
          name: `Diubah ${unique()}`,
          expectedUpdatedAt: supplierUpdatedAt,
        }),
    );
    const detail = await tenant.client.get(
      `/api/inventory/suppliers/${supplierId}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.data.supplier.name).toBe(supplierName);
  });

  it("TEN-04 floor: POST /api/floor/zones is refused and no zone is stored", async () => {
    const name = `Zona ditolak ${unique()}`;
    expectReadOnlyRefusal(
      await support
        .post("/api/floor/zones")
        .set(originHeader)
        .send({
          name,
          paymentMode: "pay_first",
          serviceChargeBp: 0,
          minimumSpendIdr: 0,
          hours: [{ daysOfWeek: [1], start: "08:00", end: "22:00" }],
        }),
    );
    const { rows } = await asOwnerTenant((client) =>
      client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM floor_zones WHERE name = $1",
        [name],
      ),
    );
    expect(rows[0]!.n).toBe(0);
  });

  it("TEN-04 tax: POST /api/tax/rules is refused and no rule appears", async () => {
    const code = `TX-${unique()}`.toUpperCase();
    expectReadOnlyRefusal(
      await support
        .post("/api/tax/rules")
        .set(originHeader)
        .send({
          outletId: null,
          code,
          name: "Uji dukungan baca-saja",
          taxType: "pbjt",
          rateBp: 1100,
          regionCode: null,
          channels: [],
          appliesTo: {
            itemClasses: ["food_beverage"],
            categoryIds: [],
            itemIds: [],
          },
          includeServiceInBase: true,
          isActive: true,
          effectiveFrom: new Date().toISOString().slice(0, 10),
        }),
    );
    const list = await tenant.client.get("/api/tax/rules");
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(code);
  });

  it("TEN-04 hris: POST /api/hris/announcements is refused and nothing is published", async () => {
    const title = `Ditolak ${unique()}`;
    expectReadOnlyRefusal(
      await support
        .post("/api/hris/announcements")
        .set(originHeader)
        .send({
          title,
          body: "Isi.",
          audience: { kind: "outlets", outletIds: [outletId] },
          requiresReceipt: false,
          expiresAt: null,
        }),
    );
    const feed = await tenant.client.get("/api/hris/announcements?limit=100");
    expect(JSON.stringify(feed.body)).not.toContain(title);
  });

  it("TEN-04 payroll: PUT /api/hris/payroll/payout-configs/:id is refused and no config is stored", async () => {
    expectReadOnlyRefusal(
      await support
        .put(`/api/hris/payroll/payout-configs/${legalEntityId}`)
        .set(originHeader)
        .send({
          method: "manual_bank",
          integrationId: null,
          manualSourceBankAccountId: randomUUID(),
          manualBankFormat: "generic_csv",
          dailyCapIdr: null,
          feePerTransferIdr: 0,
          enabled: true,
        }),
    );
    const config = await tenant.client.get(
      `/api/hris/payroll/payout-configs/${legalEntityId}`,
    );
    expect(config.status).toBe(200);
    expect(config.body.data).toBeNull();
  });

  it("TEN-04 payroll: POST /api/hris/payroll/runs/:id/simulate is refused", async () => {
    const runId = payrollRunIdSchema.parse(randomUUID());
    expectReadOnlyRefusal(
      await support
        .post(`/api/hris/payroll/runs/${runId}/simulate`)
        .set(originHeader)
        .send({ idempotencyKey: `sim-${randomUUID()}` }),
    );
  });

  it("TEN-04 pos: PUT /api/pos/orders/:id/customer (ULID id) is refused", async () => {
    const orderId = orderIdSchema.parse(createUlid());
    expectReadOnlyRefusal(
      await support
        .put(`/api/pos/orders/${orderId}/customer`)
        .set(originHeader)
        .send({ customerProfileId: null }),
    );
  });

  it("TEN-04 GET routes of the same routers stay open to the read_only session", async () => {
    for (const path of [
      "/api/org/domains",
      "/api/org/legal-entities",
      "/api/access/roles",
      `/api/menu/categories?limit=100&brandId=${tenant.brandId}`,
      "/api/inventory/suppliers",
      `/api/inventory/suppliers/${supplierId}`,
      "/api/tax/rules",
      `/api/hris/payroll/payout-configs/${legalEntityId}`,
    ]) {
      const response = await support.get(path);
      expect(response.status, `${path}: ${JSON.stringify(response.body)}`).toBe(
        200,
      );
    }
  });
});
