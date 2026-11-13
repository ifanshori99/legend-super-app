// Platform restore of an archived tenant / closed outlet within 30 days
// (founder Q40, legend-umzos). Real Express app, Better Auth and PostgreSQL.
// Time travel moves `archived_at` / `closed_at` through the owner pool.
//
// Assumptions: request-body validation answers 422 VALIDATION_ERROR in this
// codebase (see platform-org-api.test.ts) and the brief says 400, so the
// validation cases accept either. Outlet cases run in one dedicated tenant
// (created through the platform API with maxOutlets 50, owned by a fresh tenant
// user resolved by Host, as in provisioning-defaults.test.ts); the seeded
// tenant is never mutated. The "tenant archived" outlet case archives and
// restores that dedicated tenant through the platform API.
import request from "supertest";
import type { Test } from "supertest";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  RESTORE_WINDOW_DAYS,
  RESTORE_WINDOW_MS,
  canRestoreFrom,
  cafeLegendPlatformFixtures,
  restoreDeadline,
} from "@starter/shared/platform";
import { createApp } from "../app";
import {
  agent,
  originHeader,
  setRole,
  signUp,
  verifySessionMfa,
} from "./helpers";

const app = createApp();
const seededTenantId = cafeLegendPlatformFixtures.tenant.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

type Client = ReturnType<typeof agent>;

const OPENING_HOURS = {
  mon: { opens: "08:00", closes: "22:00" },
  tue: { opens: "08:00", closes: "22:00" },
  wed: { opens: "08:00", closes: "22:00" },
  thu: { opens: "08:00", closes: "22:00" },
  fri: { opens: "08:00", closes: "23:00" },
  sat: { opens: "08:00", closes: "23:00" },
  sun: { opens: "08:00", closes: "22:00" },
};

const limits = {
  maxOutlets: 5,
  maxActiveEmployees: 30,
  maxDevices: 10,
  aiRequestsPerMonth: 100,
  whatsappCostCapIdr: 0,
  aiCostCapIdr: 50_000,
  emailCostCapIdr: 10_000,
};

const REASON = "Pulihkan sesuai permintaan pemilik usaha.";

function tenantBody(slug: string) {
  return {
    slug,
    name: "Uji Pemulihan",
    plan: "lengkap",
    deploymentMode: "shared",
    featureFlags: { modules: ["pos", "qr_order"], integrationProviders: [] },
    limits,
    firstAdmin: {
      name: "Admin Pertama",
      whatsapp: "6281234567890",
      email: null,
    },
  };
}

// Platform admin user ids this file inserted; cleanup deletes only these.
const platformAdminIds: string[] = [];

// Same setup as platform-org-api.test.ts: platform admin + Owner template in
// the seeded tenant + verified MFA session.
async function adminClient() {
  const client = agent(app);
  const email = await signUp(client, "Platform Admin");
  await setRole(email, "admin");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    "INSERT INTO platform_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [userId],
  );
  platformAdminIds.push(userId);
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
     WHERE tenant_id = $1 AND template_key = 'owner'`,
    [seededTenantId, userId],
  );
  await verifySessionMfa(email);
  return { client, userId };
}

async function createTenant(client: Client): Promise<string> {
  const created = await client
    .post("/api/platform/tenants")
    .set(originHeader)
    .send(tenantBody(`pulih-${randomBytes(4).toString("hex")}`));
  expect(created.status).toBe(201);
  return created.body.data.id as string;
}

async function setTenantStatus(
  client: Client,
  tenantId: string,
  status: "suspended" | "archived" | "active",
) {
  return client
    .post(`/api/platform/tenants/${tenantId}/status`)
    .set(originHeader)
    .send({ status, reason: "Perubahan status untuk uji pemulihan." });
}

/** Tenant moved (active | suspended) -> archived through the platform API. */
async function archivedTenant(
  client: Client,
  from: "active" | "suspended",
): Promise<string> {
  const id = await createTenant(client);
  if (from === "suspended")
    expect((await setTenantStatus(client, id, "suspended")).status).toBe(200);
  const archived = await setTenantStatus(client, id, "archived");
  expect(archived.status).toBe(200);
  expect(archived.body.data.status).toBe("archived");
  return id;
}

function restoreTenant(client: Client, tenantId: string, body: object) {
  return client
    .post(`/api/platform/tenants/${tenantId}/restore`)
    .set(originHeader)
    .send(body);
}

function restoreOutlet(
  client: Client,
  tenantId: string,
  outletId: string,
  body: object,
) {
  return client
    .post(`/api/platform/tenants/${tenantId}/outlets/${outletId}/restore`)
    .set(originHeader)
    .send(body);
}

async function tenantRow(id: string) {
  const { rows } = await owner.query<{
    status: string;
    archived_at: Date | null;
    status_before_archive: string | null;
  }>(
    "SELECT status, archived_at, status_before_archive FROM tenants WHERE id = $1",
    [id],
  );
  return rows[0]!;
}

async function outletRow(id: string) {
  const { rows } = await owner.query<{
    status: string;
    closed_at: Date | null;
    status_before_close: string | null;
  }>(
    "SELECT status, closed_at, status_before_close FROM outlets WHERE id = $1",
    [id],
  );
  return rows[0]!;
}

async function auditRows(tenantId: string, action: string) {
  const { rows } = await owner.query<{
    event: {
      actorId: string;
      reason: string | null;
      objectType: string;
      objectId: string;
      maskedChanges: {
        before: Record<string, unknown> | null;
        after: Record<string, unknown> | null;
      } | null;
    };
    outlet_id: string | null;
  }>(
    `SELECT event, outlet_id FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = $2 ORDER BY id`,
    [tenantId, action],
  );
  return rows;
}

// ----------------------------------------------------------------- outlets

const unique = () => randomBytes(4).toString("hex");

type DedicatedTenant = {
  org: Client;
  tenantId: string;
  brandId: string;
  legalEntityId: string;
};

/**
 * Signed-in owner of a dedicated tenant with a generous outlet quota. Closed
 * outlets still count toward the quota and each case adds one, so the cases do
 * not share the seeded tenant. The tenant is created through the platform
 * panel (so it has its role templates), then a fresh user becomes its owner;
 * the tenant is resolved from the Host of every call of the returned client.
 */
async function tenantAdminClient() {
  const { client: platform } = await adminClient();
  const created = await platform
    .post("/api/platform/tenants")
    .set(originHeader)
    .send({
      ...tenantBody(`pulih-${unique()}`),
      limits: { ...limits, maxOutlets: 50 },
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const tenantId = created.body.data.id as string;

  const client = agent(app);
  const email = await signUp(client, "Pemilik Tenant Uji");
  await setRole(email, "admin");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
     WHERE tenant_id = $1 AND template_key = 'owner'`,
    [tenantId, userId],
  );
  await verifySessionMfa(email);

  const hostname = `pulih-${unique()}.contoh.example`;
  const domainBrandId = randomUUID();
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand domain')",
    [domainBrandId, tenantId, `dom-${unique()}`],
  );
  await owner.query(
    `INSERT INTO tenant_domains (id, tenant_id, brand_id, hostname, kind, tls_status, verified_at)
     VALUES ($1, $2, $3, $4, 'custom', 'active', now())`,
    [randomUUID(), tenantId, domainBrandId, hostname],
  );
  const methods = new Set(["get", "post", "put", "patch", "delete"]);
  const hosted = new Proxy(client, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && methods.has(prop))
        return (url: string) =>
          (target as unknown as Record<string, (u: string) => Test>)[prop]!(
            url,
          ).set("Host", hostname);
      return Reflect.get(target, prop, receiver);
    },
  });
  return { client: hosted as Client, tenantId };
}

let dedicated: Promise<DedicatedTenant> | undefined;

/** The one dedicated tenant (with brand and legal entity) for the outlet cases. */
function outletTenant(): Promise<DedicatedTenant> {
  dedicated ??= (async () => {
    const { client: org, tenantId } = await tenantAdminClient();
    const brand = await org
      .post("/api/org/brands")
      .set(originHeader)
      .send({
        slug: `pulih-${randomBytes(3).toString("hex")}`,
        name: "Brand Uji Pemulihan",
      });
    expect(brand.status, JSON.stringify(brand.body)).toBe(201);
    const entity = await org
      .post("/api/org/legal-entities")
      .set(originHeader)
      .send({
        name: "PT Uji Pemulihan",
        npwp: "01.234.567.8-901.000",
        isPkp: false,
        address: "Kota Bandung",
      });
    expect(entity.status, JSON.stringify(entity.body)).toBe(201);
    return {
      org,
      tenantId,
      brandId: brand.body.data.id as string,
      legalEntityId: entity.body.data.id as string,
    };
  })();
  return dedicated;
}

/** New outlet in the dedicated tenant; starts `preopening`. */
async function createOutlet(): Promise<string> {
  const { org, brandId, legalEntityId } = await outletTenant();
  const created = await org
    .post("/api/org/outlets")
    .set(originHeader)
    .send({
      brandId,
      legalEntityId,
      code: `PL-${randomBytes(3).toString("hex")}`.toUpperCase(),
      name: "Outlet Uji Pemulihan",
      address: "Jl. Uji No. 1, Kota Bandung",
      regionId: null,
      geofence: null,
      timeZone: "Asia/Jakarta",
      openingHours: OPENING_HOURS,
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect(created.body.data.status).toBe("preopening");
  return created.body.data.id as string;
}

/** Tenant user (org API) moves an outlet; used for activate and close. */
async function setOutletStatus(outletId: string, status: "active" | "closed") {
  const { org } = await outletTenant();
  return org
    .post(`/api/org/outlets/${outletId}/status`)
    .set(originHeader)
    .send({ status, reason: "Perubahan status untuk uji pemulihan." });
}

async function closedOutlet(from: "preopening" | "active"): Promise<string> {
  const id = await createOutlet();
  if (from === "active")
    expect((await setOutletStatus(id, "active")).status).toBe(200);
  const closed = await setOutletStatus(id, "closed");
  expect(closed.status).toBe(200);
  expect(closed.body.data.status).toBe("closed");
  return id;
}

afterAll(async () => {
  if (platformAdminIds.length > 0)
    await owner.query(
      "DELETE FROM platform_admins WHERE user_id = ANY($1::text[])",
      [platformAdminIds],
    );
  await owner.end();
});

// -------------------------------------------------------- shared contract

describe("restore window contract (Q40)", () => {
  const archivedAt = new Date("2026-01-01T00:00:00.000Z");

  it("allows a restore until exactly 30 days after the transition (inclusive)", () => {
    expect(RESTORE_WINDOW_DAYS).toBe(30);
    expect(RESTORE_WINDOW_MS).toBe(30 * 24 * 60 * 60 * 1000);
    const deadline = restoreDeadline(archivedAt);
    expect(deadline.toISOString()).toBe("2026-01-31T00:00:00.000Z");

    expect(canRestoreFrom(archivedAt, "active", archivedAt)).toEqual({
      ok: true,
      deadline,
    });
    expect(canRestoreFrom(archivedAt, "active", deadline)).toEqual({
      ok: true,
      deadline,
    });
    expect(
      canRestoreFrom(archivedAt, "suspended", new Date(deadline.getTime() - 1)),
    ).toMatchObject({ ok: true });
  });

  it("refuses one millisecond after the deadline", () => {
    const late = new Date(restoreDeadline(archivedAt).getTime() + 1);
    expect(canRestoreFrom(archivedAt, "active", late)).toEqual({
      ok: false,
      code: "RESTORE_WINDOW_EXPIRED",
    });
  });

  it("treats a missing transition time or previous status as final", () => {
    const now = new Date("2026-01-02T00:00:00.000Z");
    expect(canRestoreFrom(null, "active", now)).toEqual({
      ok: false,
      code: "RESTORE_NOT_AVAILABLE",
    });
    expect(canRestoreFrom(archivedAt, null, now)).toEqual({
      ok: false,
      code: "RESTORE_NOT_AVAILABLE",
    });
    expect(canRestoreFrom(null, null, now)).toEqual({
      ok: false,
      code: "RESTORE_NOT_AVAILABLE",
    });
  });
});

// ------------------------------------------------------------------ tenant

describe("Platform restore of an archived tenant (TEN-04, Q40)", () => {
  it("restores an archived active tenant to active, clears the record and audits it", async () => {
    const { client, userId } = await adminClient();
    const id = await archivedTenant(client, "active");

    const archivedRow = await tenantRow(id);
    expect(archivedRow.status).toBe("archived");
    expect(archivedRow.archived_at).toBeInstanceOf(Date);
    expect(archivedRow.status_before_archive).toBe("active");

    const restored = await restoreTenant(client, id, { reason: REASON });
    expect(restored.status).toBe(200);
    expect(restored.body.data).toMatchObject({ id, status: "active" });

    const after = await tenantRow(id);
    expect(after).toEqual({
      status: "active",
      archived_at: null,
      status_before_archive: null,
    });

    const audited = await auditRows(id, "tenant.restored");
    expect(audited).toHaveLength(1);
    expect(audited[0]!.event).toMatchObject({
      actorId: userId,
      reason: REASON,
      objectType: "tenant",
    });
    expect(audited[0]!.event.objectId).toBe(id);
    expect(audited[0]!.event.maskedChanges?.before).toMatchObject({
      status: "archived",
    });
    expect(audited[0]!.event.maskedChanges?.after).toMatchObject({
      status: "active",
    });

    // The restored tenant can be archived again and the window restarts.
    expect((await setTenantStatus(client, id, "archived")).status).toBe(200);
    expect((await tenantRow(id)).status_before_archive).toBe("active");
  });

  it("restores an archived suspended tenant to suspended", async () => {
    const { client } = await adminClient();
    const id = await archivedTenant(client, "suspended");
    expect((await tenantRow(id)).status_before_archive).toBe("suspended");

    const restored = await restoreTenant(client, id, { reason: REASON });
    expect(restored.status).toBe(200);
    expect(restored.body.data.status).toBe("suspended");
    expect((await tenantRow(id)).status).toBe("suspended");
  });

  it("refuses after 30 days (RESTORE_WINDOW_EXPIRED) and restores at 30 days minus 1 minute", async () => {
    const { client } = await adminClient();
    const expired = await archivedTenant(client, "active");
    await owner.query(
      "UPDATE tenants SET archived_at = now() - interval '31 days' WHERE id = $1",
      [expired],
    );
    const refused = await restoreTenant(client, expired, { reason: REASON });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("RESTORE_WINDOW_EXPIRED");
    expect((await tenantRow(expired)).status).toBe("archived");
    expect(await auditRows(expired, "tenant.restored")).toHaveLength(0);

    const edge = await archivedTenant(client, "active");
    await owner.query(
      `UPDATE tenants SET archived_at = now() - interval '30 days' + interval '1 minute'
        WHERE id = $1`,
      [edge],
    );
    const ok = await restoreTenant(client, edge, { reason: REASON });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe("active");
  });

  it("treats an archived tenant without a recorded time (legacy) as final", async () => {
    const { client } = await adminClient();
    const id = await archivedTenant(client, "active");
    await owner.query(
      "UPDATE tenants SET archived_at = NULL, status_before_archive = NULL WHERE id = $1",
      [id],
    );
    const refused = await restoreTenant(client, id, { reason: REASON });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("RESTORE_NOT_AVAILABLE");
    expect((await tenantRow(id)).status).toBe("archived");
  });

  it("requires a reason of at least 10 characters and changes nothing without one", async () => {
    const { client } = await adminClient();
    const id = await archivedTenant(client, "active");
    for (const body of [{}, { reason: "" }, { reason: "pendek" }]) {
      const refused = await restoreTenant(client, id, body);
      // Repo convention is 422 VALIDATION_ERROR; the brief says 400.
      expect([400, 422]).toContain(refused.status);
    }
    expect((await tenantRow(id)).status).toBe("archived");
    expect(await auditRows(id, "tenant.restored")).toHaveLength(0);
  });

  it("answers 401 without a session and 403 for a non-platform user; status stays archived", async () => {
    const { client } = await adminClient();
    const id = await archivedTenant(client, "active");

    const anonymous = await restoreTenant(agent(app), id, { reason: REASON });
    expect(anonymous.status).toBe(401);

    const user = agent(app);
    await signUp(user, "Pengguna Biasa");
    const denied = await restoreTenant(user, id, { reason: REASON });
    expect(denied.status).toBe(403);

    expect((await tenantRow(id)).status).toBe("archived");
    expect(await auditRows(id, "tenant.restored")).toHaveLength(0);
  });

  it("keeps the generic status endpoint closed: archived -> active is INVALID_TRANSITION", async () => {
    const { client } = await adminClient();
    const id = await archivedTenant(client, "active");
    const reopened = await setTenantStatus(client, id, "active");
    expect(reopened.status).toBe(409);
    expect(reopened.body.error.code).toBe("INVALID_TRANSITION");
    expect((await tenantRow(id)).status).toBe("archived");
  });

  it("refuses to restore a tenant that is not archived", async () => {
    const { client } = await adminClient();
    const id = await createTenant(client);
    const refused = await restoreTenant(client, id, { reason: REASON });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("RESTORE_NOT_AVAILABLE");
    expect((await tenantRow(id)).status).toBe("active");

    const missing = await restoreTenant(client, randomUUID(), {
      reason: REASON,
    });
    expect(missing.status).toBe(404);
  });

  it("reports the restore window: restorable inside it, not after", async () => {
    const { client } = await adminClient();
    const id = await archivedTenant(client, "suspended");

    const inside = await client.get(
      `/api/platform/tenants/${id}/restore-window`,
    );
    expect(inside.status).toBe(200);
    expect(inside.body.data).toMatchObject({
      tenantId: id,
      status: "archived",
      restoreTo: "suspended",
      restorable: true,
    });
    const archivedAt = new Date(inside.body.data.archivedAt).getTime();
    expect(new Date(inside.body.data.restorableUntil).getTime()).toBe(
      archivedAt + RESTORE_WINDOW_MS,
    );

    await owner.query(
      "UPDATE tenants SET archived_at = now() - interval '31 days' WHERE id = $1",
      [id],
    );
    const after = await client.get(
      `/api/platform/tenants/${id}/restore-window`,
    );
    expect(after.status).toBe(200);
    expect(after.body.data).toMatchObject({
      restorable: false,
      status: "archived",
    });

    const active = await createTenant(client);
    const notArchived = await client.get(
      `/api/platform/tenants/${active}/restore-window`,
    );
    expect(notArchived.body.data).toMatchObject({
      status: "active",
      restorable: false,
      restoreTo: null,
      restorableUntil: null,
    });

    const denied = await request(app).get(
      `/api/platform/tenants/${id}/restore-window`,
    );
    expect(denied.status).toBe(401);
  });
});

// ------------------------------------------------------------------ outlet

describe("Platform restore of a closed outlet (TEN-04, Q40)", () => {
  it("restores a closed active outlet to active and audits it", async () => {
    const { client, userId } = await adminClient();
    const { tenantId } = await outletTenant();
    const id = await closedOutlet("active");
    const closedRow = await outletRow(id);
    expect(closedRow.closed_at).toBeInstanceOf(Date);
    expect(closedRow.status_before_close).toBe("active");

    const restored = await restoreOutlet(client, tenantId, id, {
      reason: REASON,
    });
    expect(restored.status).toBe(200);
    expect(restored.body.data).toMatchObject({ id, status: "active" });
    expect(await outletRow(id)).toEqual({
      status: "active",
      closed_at: null,
      status_before_close: null,
    });

    const audited = (await auditRows(tenantId, "outlet.restored")).filter(
      (row) => row.outlet_id === id,
    );
    expect(audited).toHaveLength(1);
    expect(audited[0]!.event).toMatchObject({
      actorId: userId,
      reason: REASON,
      objectType: "outlet",
      objectId: id,
    });
    expect(audited[0]!.event.maskedChanges?.before).toMatchObject({
      status: "closed",
    });
    expect(audited[0]!.event.maskedChanges?.after).toMatchObject({
      status: "active",
    });
  });

  it("restores a closed preopening outlet to preopening", async () => {
    const { client } = await adminClient();
    const { tenantId } = await outletTenant();
    const id = await closedOutlet("preopening");
    expect((await outletRow(id)).status_before_close).toBe("preopening");

    const restored = await restoreOutlet(client, tenantId, id, {
      reason: REASON,
    });
    expect(restored.status).toBe(200);
    expect(restored.body.data.status).toBe("preopening");
    expect((await outletRow(id)).status).toBe("preopening");

    // Not closed any more: a second restore has nothing to restore.
    const again = await restoreOutlet(client, tenantId, id, {
      reason: REASON,
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("RESTORE_NOT_AVAILABLE");
  });

  it("refuses after 30 days, refuses legacy rows and a short reason", async () => {
    const { client } = await adminClient();
    const { tenantId } = await outletTenant();
    const id = await closedOutlet("active");

    await owner.query(
      "UPDATE outlets SET closed_at = now() - interval '31 days' WHERE id = $1",
      [id],
    );
    const expired = await restoreOutlet(client, tenantId, id, {
      reason: REASON,
    });
    expect(expired.status).toBe(409);
    expect(expired.body.error.code).toBe("RESTORE_WINDOW_EXPIRED");
    expect((await outletRow(id)).status).toBe("closed");

    await owner.query(
      "UPDATE outlets SET closed_at = NULL, status_before_close = NULL WHERE id = $1",
      [id],
    );
    const legacy = await restoreOutlet(client, tenantId, id, {
      reason: REASON,
    });
    expect(legacy.status).toBe(409);
    expect(legacy.body.error.code).toBe("RESTORE_NOT_AVAILABLE");

    const short = await restoreOutlet(client, tenantId, id, {
      reason: "pendek",
    });
    expect([400, 422]).toContain(short.status);
    expect((await outletRow(id)).status).toBe("closed");
    const restoredAudit = await auditRows(tenantId, "outlet.restored");
    expect(restoredAudit.filter((row) => row.outlet_id === id)).toHaveLength(0);
  });

  it("refuses to restore an outlet that is not closed, belongs to no such tenant, or for a non-platform user", async () => {
    const { client } = await adminClient();
    const { tenantId } = await outletTenant();
    const open = await createOutlet();
    const notClosed = await restoreOutlet(client, tenantId, open, {
      reason: REASON,
    });
    expect(notClosed.status).toBe(409);
    expect(notClosed.body.error.code).toBe("RESTORE_NOT_AVAILABLE");

    const otherTenant = await createTenant(client);
    const wrongTenant = await restoreOutlet(client, otherTenant, open, {
      reason: REASON,
    });
    expect(wrongTenant.status).toBe(404);

    const closed = await closedOutlet("active");
    const user = agent(app);
    await signUp(user, "Pengguna Biasa");
    expect(
      (await restoreOutlet(user, tenantId, closed, { reason: REASON })).status,
    ).toBe(403);
    expect(
      (
        await restoreOutlet(agent(app), tenantId, closed, {
          reason: REASON,
        })
      ).status,
    ).toBe(401);
    expect((await outletRow(closed)).status).toBe("closed");
  });

  it("keeps the generic outlet status endpoint closed: closed -> active is INVALID_TRANSITION", async () => {
    const id = await closedOutlet("active");
    const reopened = await setOutletStatus(id, "active");
    expect(reopened.status).toBe(409);
    expect(reopened.body.error.code).toBe("INVALID_TRANSITION");
    expect((await outletRow(id)).status).toBe("closed");
  });

  it("refuses to restore an outlet while its tenant is archived", async () => {
    const { client } = await adminClient();
    const { tenantId } = await outletTenant();
    const id = await closedOutlet("active");
    const before = await tenantRow(tenantId);
    expect(before.status).toBe("active");

    const archived = await setTenantStatus(client, tenantId, "archived");
    expect(archived.status).toBe(200);
    try {
      const refused = await restoreOutlet(client, tenantId, id, {
        reason: REASON,
      });
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe("INVALID_TRANSITION");
      expect((await outletRow(id)).status).toBe("closed");
    } finally {
      // Put the dedicated tenant back so later outlet cases keep working.
      if ((await tenantRow(tenantId)).status === "archived")
        await restoreTenant(client, tenantId, { reason: REASON });
    }
    expect((await tenantRow(tenantId)).status).toBe(before.status);

    // Tenant back to active: the same outlet now restores.
    const ok = await restoreOutlet(client, tenantId, id, {
      reason: REASON,
    });
    expect(ok.status).toBe(200);
  });

  it("keeps receipt numbering and edge credentials across close and restore", async () => {
    const { client } = await adminClient();
    const { tenantId } = await outletTenant();
    const id = await createOutlet();
    expect((await setOutletStatus(id, "active")).status).toBe(200);

    const sequenceId = randomUUID();
    const edgeNodeId = randomUUID();
    await owner.query(
      `INSERT INTO receipt_sequences (id, tenant_id, outlet_id, device_id, prefix, last_number)
       VALUES ($1, $2, $3, $4, 'PLR', 42)`,
      [sequenceId, tenantId, id, randomUUID()],
    );
    await owner.query(
      `INSERT INTO edge_nodes (id, tenant_id, outlet_id, role, status, label, credential_hash)
       VALUES ($1, $2, $3, 'primary', 'active', 'Server lokal uji', $4)`,
      [edgeNodeId, tenantId, id, "a".repeat(64)],
    );

    expect((await setOutletStatus(id, "closed")).status).toBe(200);
    const restored = await restoreOutlet(client, tenantId, id, {
      reason: REASON,
    });
    expect(restored.status).toBe(200);

    const sequence = await owner.query<{ last_number: number }>(
      "SELECT last_number FROM receipt_sequences WHERE id = $1",
      [sequenceId],
    );
    expect(sequence.rows[0]!.last_number).toBe(42);
    const edge = await owner.query<{
      status: string;
      revoked_at: Date | null;
      credential_hash: string;
    }>(
      "SELECT status, revoked_at, credential_hash FROM edge_nodes WHERE id = $1",
      [edgeNodeId],
    );
    expect(edge.rows[0]).toEqual({
      status: "active",
      revoked_at: null,
      credential_hash: "a".repeat(64),
    });

    const audited = (await auditRows(tenantId, "outlet.restored")).filter(
      (row) => row.outlet_id === id,
    );
    expect(audited).toHaveLength(1);
    expect(audited[0]!.event).toMatchObject({
      reason: REASON,
      objectType: "outlet",
      objectId: id,
    });
    expect(audited[0]!.event.maskedChanges?.after).toMatchObject({
      status: "active",
      activeEdgeNodes: 1,
    });
  });

  it("reports the outlet restore window: restorable inside it, not after", async () => {
    const { client } = await adminClient();
    const { tenantId } = await outletTenant();
    const id = await closedOutlet("preopening");
    const path = `/api/platform/tenants/${tenantId}/outlets/${id}/restore-window`;

    const inside = await client.get(path);
    expect(inside.status).toBe(200);
    expect(inside.body.data).toMatchObject({
      tenantId: tenantId,
      outletId: id,
      status: "closed",
      restoreTo: "preopening",
      restorable: true,
    });
    const closedAt = new Date(inside.body.data.closedAt).getTime();
    expect(new Date(inside.body.data.restorableUntil).getTime()).toBe(
      closedAt + RESTORE_WINDOW_MS,
    );

    await owner.query(
      "UPDATE outlets SET closed_at = now() - interval '31 days' WHERE id = $1",
      [id],
    );
    const after = await client.get(path);
    expect(after.status).toBe(200);
    expect(after.body.data).toMatchObject({
      status: "closed",
      restorable: false,
    });

    const open = await createOutlet();
    const notClosed = await client.get(
      `/api/platform/tenants/${tenantId}/outlets/${open}/restore-window`,
    );
    expect(notClosed.body.data).toMatchObject({
      status: "preopening",
      restorable: false,
      restoreTo: null,
      restorableUntil: null,
    });

    expect((await request(app).get(path)).status).toBe(401);
  });
});
