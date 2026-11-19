// RBAC engine API (bead legend-4f9; PRD v1.7 §3.7 RBAC, Organisasi & Matriks
// Approval, §6 B, TEN-03/TEN-04) and GET /api/me/access (legend-t4y7).
// HTTP tests run the real Express app, Better Auth and PostgreSQL; the DB-role
// isolation for the new tables lives in platform-access-db.test.ts.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cafeLegendAccessFixtures,
  grantRoleSchema,
} from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { cafeLegendFixtures } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { setAuditWriter } from "../services/audit-writer";
import { coreAuditWriter } from "../services/core-audit-writer";
import { grantRoleAssignment } from "../services/access.service";
import { createIsolatedTenant } from "./floor-test-helpers";
import { deleteHires, seedHire } from "./hire-seed";
import {
  agent,
  originHeader,
  setRole,
  signUp,
  verifySessionMfa,
} from "./helpers";

const app = createApp();
const seededTenantId = cafeLegendPlatformFixtures.tenant.id;
const bandung = cafeLegendAccessFixtures.outletIds.bandung;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const createdUserIds: string[] = [];
const createdHireIds: string[] = [];
const createdRoleIds: string[] = [];
const createdStationIds: string[] = [];
// Throwaway org rows of the seeded tenant made by the legend-ebt9f outlet
// tests; removed in afterAll so no seed outlet is ever mutated.
const createdOutletIds: string[] = [];
const createdDomainIds: string[] = [];
const createdBrandIds: string[] = [];
const bandung2 = cafeLegendAccessFixtures.outletIds.bandung2;
// Seed outlets of the cafe-legend tenant (legend-ebt9f). Sorted by name, the
// first one comes before "... Bandung 2 (contoh)".
const bandungFixture = cafeLegendFixtures.outlets[0];
const bandung2Fixture = cafeLegendFixtures.outlets[1];

/** One live station in `outletId`, written as the owner (stations has FORCED RLS). */
async function createStation(outletId: string): Promise<string> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [seededTenantId],
    );
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO stations (tenant_id, outlet_id, name, type)
       VALUES ($1, $2, $3, 'coffee_bar') RETURNING id`,
      [seededTenantId, outletId, `Uji ${randomUUID().slice(0, 8)}`],
    );
    await client.query("COMMIT");
    createdStationIds.push(rows[0]!.id);
    return rows[0]!.id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Tenant-local custom role allowed at station scope (no template). */
async function stationRole(): Promise<string> {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles
       (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4::jsonb, false, $5::jsonb)`,
    [
      roleId,
      seededTenantId,
      `Uji ${roleId.slice(0, 8)}`,
      JSON.stringify(["kds.ticket.process"]),
      JSON.stringify(["station"]),
    ],
  );
  createdRoleIds.push(roleId);
  return roleId;
}

type AuditedEvent = {
  action: string;
  objectId: string | null;
  actorId: string | null;
  tenantId: string;
};

// Audit rows are read back from audit_logs as the owner (the real core writer
// commits them on the domain transaction), not from an in-memory recorder.
async function auditEvents(tenantId: string): Promise<AuditedEvent[]> {
  const { rows } = await owner.query<{ event: AuditedEvent }>(
    "SELECT event FROM audit_logs WHERE tenant_id = $1",
    [tenantId],
  );
  return rows.map((row) => row.event);
}

function scopedContext(tenantId = seededTenantId): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

async function signedIn(name = "RBAC user", options: { mfa?: boolean } = {}) {
  const client = agent(app);
  const email = await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  // AUTH-05: /api/access and /api/org are closed until this session verified a
  // second factor (legend-qfvu mounted the gate). Suites about the pre-MFA
  // snapshot opt out with { mfa: false }.
  if (options.mfa ?? true) await verifySessionMfa(email);
  return { client, userId, email };
}

/** A signed-in account that is already a new hire of the tenant (G2). */
async function signedInHire(name: string) {
  const account = await signedIn(name);
  createdHireIds.push(
    await seedHire(owner, {
      tenantId: seededTenantId,
      userId: account.userId,
      outletId: bandung,
    }),
  );
  return account;
}

async function roleIdOf(
  templateKey: string,
  tenantId = seededTenantId,
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  if (!rows[0])
    throw new Error(`No ${templateKey} role for tenant ${tenantId}`);
  return rows[0].id;
}

async function assign(
  userId: string,
  templateKey: string,
  scope: { type: string; id?: string } = { type: "tenant" },
): Promise<{ id: string }> {
  const { rows } = await owner.query<{ id: string }>(
    // Backdate one minute: the test database runs in a container whose clock
    // may drift sub-second from the Node clock the resolver reads.
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)
     RETURNING id`,
    [
      seededTenantId,
      userId,
      await roleIdOf(templateKey),
      scope.type,
      scope.id ?? null,
    ],
  );
  return rows[0]!;
}

const unique = () => randomBytes(4).toString("hex");

/** A throwaway brand in the seeded tenant (owner pool). */
async function createBrand(): Promise<string> {
  const id = randomUUID();
  const suffix = id.slice(0, 8);
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    [id, seededTenantId, `uji-${suffix}`, `Merek Uji ${suffix}`],
  );
  createdBrandIds.push(id);
  return id;
}

/**
 * A throwaway outlet in the seeded tenant. Legal entity and opening hours are
 * copied from the seeded Bandung outlet, so only the fields under test differ.
 */
async function createOutlet(options: {
  brandId?: string;
  status?: "preopening" | "active" | "closed";
  timeZone?: string;
  name?: string;
}): Promise<{ id: string; name: string }> {
  const id = randomUUID();
  const suffix = id.slice(0, 8);
  // "Zz" keeps these after the seeded "Cafe Legend ..." outlets by name.
  const name = options.name ?? `Zz Outlet Uji ${suffix}`;
  await owner.query(
    `INSERT INTO outlets
       (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, $2, $3, legal_entity_id, $4, $5, 'Jl. Uji 1', $6, opening_hours, $7
       FROM outlets WHERE id = $8`,
    [
      id,
      seededTenantId,
      options.brandId ?? cafeLegendFixtures.brand.id,
      `UJI-${suffix}`.toUpperCase(),
      name,
      options.timeZone ?? "Asia/Jakarta",
      options.status ?? "active",
      bandung,
    ],
  );
  createdOutletIds.push(id);
  return { id, name };
}

const outletIdsOf = (res: { body: { data: { outlets: { id: string }[] } } }) =>
  res.body.data.outlets.map((row) => row.id);

beforeAll(() => {
  setAuditWriter(coreAuditWriter);
});

afterAll(async () => {
  setAuditWriter(null);
  await deleteHires(owner, seededTenantId, createdHireIds);
  if (createdUserIds.length > 0)
    await owner.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [seededTenantId, createdUserIds],
    );
  if (createdRoleIds.length > 0)
    await owner.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [seededTenantId, createdRoleIds],
    );
  // Order matters: outlets reference brands, domains reference brands.
  if (createdOutletIds.length > 0)
    await owner.query("DELETE FROM outlets WHERE id = ANY($1::uuid[])", [
      createdOutletIds,
    ]);
  if (createdDomainIds.length > 0)
    await owner.query("DELETE FROM tenant_domains WHERE id = ANY($1::uuid[])", [
      createdDomainIds,
    ]);
  if (createdBrandIds.length > 0)
    await owner.query("DELETE FROM brands WHERE id = ANY($1::uuid[])", [
      createdBrandIds,
    ]);
  if (createdStationIds.length > 0) {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [seededTenantId],
      );
      await client.query("DELETE FROM stations WHERE id = ANY($1::uuid[])", [
        createdStationIds,
      ]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  }
  await owner.end();
});

describe("legend-t4y7 GET /api/me/access", () => {
  it("TEN-03 fails closed without an assignment and lists effective codes with one", async () => {
    expect((await agent(app).get("/api/me/access")).status).toBe(401);

    const plain = await signedIn("No role", { mfa: false });
    const empty = await plain.client.get("/api/me/access");
    expect(empty.status).toBe(200);
    expect(empty.body.data).toEqual({
      permissions: [],
      mfaRequired: false,
      mfaVerified: false,
      // No assignment, no station reach (legend-fsb7).
      stations: [],
      // No assignment, no outlet reach (legend-ebt9f).
      outlets: [],
      // No assigned outlet, so none is active (legend-6vgv).
      activeOutletId: null,
      // Not an impersonated support session (legend-cg071).
      supportSession: null,
      // No assignment, so no right to change an employee's manager (legend-qhqf8).
      canChangeEmployeeManager: false,
      // No assignment, so no menu.item.manage for the station rename hint (legend-huz8).
      canManageStationConfig: false,
    });

    const ownerUser = await signedIn("Owner Access", { mfa: false });
    await assign(ownerUser.userId, "owner");
    const access = await ownerUser.client.get("/api/me/access");
    expect(access.status).toBe(200);
    expect(access.body.data.permissions).toContain("org.structure.manage");
    expect(access.body.data.permissions).toContain("access.role.view");
    expect(access.body.data.mfaRequired).toBe(true);
    expect(access.body.data.mfaVerified).toBe(false);
    expect(
      access.body.data.permissions.some((code: string) =>
        code.startsWith("platform."),
      ),
    ).toBe(false);
  });

  // legend-ebt9f: the staff web app builds its outlet context from `outlets`.
  // Assumption: names sort ascending, "Cafe Legend Bandung" before
  // "Cafe Legend Bandung 2 (contoh)" (spec: urut nama).
  const outletView = (fixture: { id: string; name: string }) =>
    expect.objectContaining({ id: fixture.id, name: fixture.name });

  it("legend-ebt9f an outlet-scoped cashier gets only that outlet", async () => {
    const cashier = await signedIn("Kasir satu outlet", { mfa: false });
    await assign(cashier.userId, "cashier", { type: "outlet", id: bandung });
    const res = await cashier.client.get("/api/me/access");
    expect(res.status).toBe(200);
    expect(res.body.data.outlets).toHaveLength(1);
    expect(res.body.data.outlets[0]).toEqual({
      id: bandungFixture.id,
      name: bandungFixture.name,
      timeZone: bandungFixture.timeZone,
      businessDayCutoff: bandungFixture.businessDayCutoff,
    });
    // The other seeded outlet of the same tenant is not assigned.
    expect(
      res.body.data.outlets.map((row: { id: string }) => row.id),
    ).not.toContain(bandung2);
  });

  it("legend-ebt9f two outlet assignments list both outlets sorted by name", async () => {
    const staff = await signedIn("Kasir dua outlet", { mfa: false });
    // Assign the later-sorting outlet first: order must come from the name.
    await assign(staff.userId, "cashier", { type: "outlet", id: bandung2 });
    await assign(staff.userId, "cashier", { type: "outlet", id: bandung });
    const res = await staff.client.get("/api/me/access");
    expect(res.status).toBe(200);
    expect(res.body.data.outlets).toEqual([
      outletView(bandungFixture),
      outletView(bandung2Fixture),
    ]);
  });

  it("legend-ebt9f a tenant-wide owner gets every outlet of the tenant sorted by name", async () => {
    const ownerUser = await signedIn("Pemilik semua outlet", { mfa: false });
    await assign(ownerUser.userId, "owner");
    const res = await ownerUser.client.get("/api/me/access");
    expect(res.status).toBe(200);
    const names = res.body.data.outlets.map(
      (row: { name: string }) => row.name,
    );
    expect(names).toContain(bandungFixture.name);
    expect(names).toContain(bandung2Fixture.name);
    // Literal order: "Cafe Legend Bandung" sorts before "... Bandung 2 (contoh)".
    expect(names.indexOf("Cafe Legend Bandung")).toBeLessThan(
      names.indexOf("Cafe Legend Bandung 2 (contoh)"),
    );
  });

  it("legend-ebt9f a station-only assignment gives that station's outlet", async () => {
    const stationId = await createStation(bandung2);
    const staff = await signedIn("Staf stasiun", { mfa: false });
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'station', $4, now() - interval '1 minute', $2)`,
      [seededTenantId, staff.userId, await stationRole(), stationId],
    );
    const res = await staff.client.get("/api/me/access");
    expect(res.status).toBe(200);
    expect(res.body.data.outlets).toEqual([outletView(bandung2Fixture)]);
  });

  it("legend-ebt9f an expired assignment gives no outlet", async () => {
    const staff = await signedIn("Staf kedaluwarsa", { mfa: false });
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, valid_until, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '2 hours', now() - interval '1 minute', $2)`,
      [seededTenantId, staff.userId, await roleIdOf("cashier"), bandung],
    );
    const res = await staff.client.get("/api/me/access");
    expect(res.status).toBe(200);
    expect(res.body.data.outlets).toEqual([]);
  });

  it("legend-ebt9f a closed outlet is not listed", async () => {
    const closed = await createOutlet({ status: "closed" });
    const open = await createOutlet({ status: "active" });
    const ownerUser = await signedIn("Pemilik outlet tutup", { mfa: false });
    await assign(ownerUser.userId, "owner");
    const res = await ownerUser.client.get("/api/me/access");
    expect(res.status).toBe(200);
    const ids = outletIdsOf(res);
    // Control: the sibling that is not closed is listed, so the closed one is
    // absent because of its status and not because of the insert.
    expect(ids).toContain(open.id);
    expect(ids).not.toContain(closed.id);
  });

  it("legend-ebt9f a brand-scoped assignment lists only that brand's outlets", async () => {
    const otherBrand = await createBrand();
    const other = await createOutlet({ brandId: otherBrand });
    const staff = await signedIn("GM satu merek", { mfa: false });
    await assign(staff.userId, "general_manager", {
      type: "brand",
      id: otherBrand,
    });
    const onlyOther = await staff.client.get("/api/me/access");
    expect(onlyOther.status).toBe(200);
    expect(onlyOther.body.data.outlets).toEqual([outletView(other)]);

    const seededBrandStaff = await signedIn("GM merek seed", { mfa: false });
    await assign(seededBrandStaff.userId, "general_manager", {
      type: "brand",
      id: cafeLegendFixtures.brand.id,
    });
    const seeded = await seededBrandStaff.client.get("/api/me/access");
    expect(seeded.status).toBe(200);
    const ids = outletIdsOf(seeded);
    expect(ids).toContain(bandung);
    expect(ids).toContain(bandung2);
    expect(ids).not.toContain(other.id);
  });

  it("legend-ebt9f a tenant pinned to a brand hides another brand's outlet even from a tenant-wide owner", async () => {
    const otherBrand = await createBrand();
    const other = await createOutlet({ brandId: otherBrand });
    const pinnedHost = `pin-${unique()}.legend.test`;
    const domainId = randomUUID();
    await owner.query(
      `INSERT INTO tenant_domains (id, tenant_id, brand_id, hostname, kind, tls_status, verified_at)
       VALUES ($1, $2, $3, $4, 'platform_subdomain', 'active', now())`,
      [domainId, seededTenantId, cafeLegendFixtures.brand.id, pinnedHost],
    );
    createdDomainIds.push(domainId);

    const ownerUser = await signedIn("Pemilik domain merek", { mfa: false });
    await assign(ownerUser.userId, "owner");

    // Control: without a pinned domain the tenant-wide owner sees both brands.
    const unpinned = await ownerUser.client.get("/api/me/access");
    expect(unpinned.status).toBe(200);
    expect(outletIdsOf(unpinned)).toContain(other.id);

    const pinned = await ownerUser.client
      .get("/api/me/access")
      .set("Host", pinnedHost);
    expect(pinned.status).toBe(200);
    const ids = outletIdsOf(pinned);
    expect(ids).toContain(bandung);
    expect(ids).toContain(bandung2);
    expect(ids).not.toContain(other.id);
  });

  it("legend-ebt9f another tenant's outlets never appear", async () => {
    const tenantB = await createIsolatedTenant(`me${unique()}`);
    const staff = await signedIn("Pemilik hanya tenant A", { mfa: false });
    await assign(staff.userId, "owner");
    const res = await staff.client.get("/api/me/access");
    expect(res.status).toBe(200);
    expect(outletIdsOf(res)).not.toContain(tenantB.outletId);

    // Same user also assigned in tenant B: each host shows only its tenant.
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [tenantB.tenantId, staff.userId, tenantB.roleId],
    );
    try {
      const viaA = await staff.client.get("/api/me/access");
      expect(outletIdsOf(viaA)).not.toContain(tenantB.outletId);
      expect(outletIdsOf(viaA)).toContain(bandung);
      const viaB = await staff.client
        .get("/api/me/access")
        .set("Host", tenantB.hostname);
      expect(viaB.status).toBe(200);
      expect(outletIdsOf(viaB)).toEqual([tenantB.outletId]);
    } finally {
      await owner.query(
        "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = $2",
        [tenantB.tenantId, staff.userId],
      );
    }
  });

  it("legend-ebt9f an outlet with an invalid stored timezone is skipped and the rest of the response is intact", async () => {
    const broken = await createOutlet({ timeZone: "Not/AZone" });
    const good = await createOutlet({});
    const ownerUser = await signedIn("Pemilik zona rusak", { mfa: false });
    await assign(ownerUser.userId, "owner");
    const res = await ownerUser.client.get("/api/me/access");
    expect(res.status).toBe(200);
    const ids = outletIdsOf(res);
    expect(ids).not.toContain(broken.id);
    expect(ids).toContain(good.id);
    expect(ids).toContain(bandung);
    expect(res.body.data.permissions).toContain("org.structure.manage");
  });
});

describe("TEN-04 platform and tenant authority are separate", () => {
  it("TEN-04 a global Better Auth admin without tenant membership is denied", async () => {
    const client = agent(app);
    const email = await signUp(client, "Legacy Admin");
    await setRole(email, "admin");
    const session = await client.get("/api/auth/get-session");
    createdUserIds.push(session.body.user.id as string);

    expect((await client.get("/api/org/brands")).status).toBe(403);
    expect((await client.get("/api/access/roles")).status).toBe(403);
    const write = await client
      .post("/api/org/brands")
      .set(originHeader)
      .send({ slug: `legacy-${unique()}`, name: "Legacy", logoMediaId: null });
    expect(write.status).toBe(403);
  });
});

describe("TEN-03 tenant routes use stored assignments", () => {
  it("TEN-03 an owner reaches tenant org routes while an outlet role cannot", async () => {
    const ownerUser = await signedIn("Owner Org");
    await assign(ownerUser.userId, "owner");
    const brand = await ownerUser.client
      .post("/api/org/brands")
      .set(originHeader)
      .send({
        slug: `rbac-${unique()}`,
        name: "Brand RBAC",
        logoMediaId: null,
      });
    expect(brand.status).toBe(201);

    const cashier = await signedIn("Cashier Org");
    await assign(cashier.userId, "cashier", { type: "outlet", id: bandung });
    const denied = await cashier.client
      .post("/api/org/brands")
      .set(originHeader)
      .send({ slug: `rbac-${unique()}`, name: "Denied", logoMediaId: null });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("PERMISSION_DENIED");
  });
});

describe("§3.7 role templates and custom roles", () => {
  it("§3.7 seeds the 17 tenant templates and validates custom roles against the catalog", async () => {
    const admin = await signedIn("Role Admin");
    await assign(admin.userId, "owner");

    const listed = await admin.client.get("/api/access/roles");
    expect(listed.status).toBe(200);
    const templates = listed.body.data.filter(
      (role: { isTemplate: boolean }) => role.isTemplate,
    );
    expect(templates).toHaveLength(17);
    const keys = templates.map(
      (role: { templateKey: string | null }) => role.templateKey,
    );
    for (const key of [
      "owner",
      "tenant_admin",
      "general_manager",
      "finance",
      "employee",
    ])
      expect(keys).toContain(key);
    expect(keys).not.toContain("super_admin");

    const platform = await admin.client
      .post("/api/access/roles")
      .set(originHeader)
      .send({
        name: `Platform ${unique()}`,
        permissions: ["platform.tenant.manage"],
        allowedScopeTypes: ["tenant"],
      });
    expect(platform.status).toBe(422);

    const custom = await admin.client
      .post("/api/access/roles")
      .set(originHeader)
      .send({
        name: `Payroll operator ${unique()}`,
        permissions: ["payroll.lock", "payroll.view"],
        allowedScopeTypes: ["tenant"],
      });
    expect(custom.status).toBe(201);
    createdRoleIds.push(custom.body.data.id);
    expect(custom.body.data.isTemplate).toBe(false);
    expect(custom.body.data.templateKey).toBeNull();
    // AUTH-05: a custom role reaching payroll requires MFA.
    expect(custom.body.data.mfaRequired).toBe(true);

    const updated = await admin.client
      .patch(`/api/access/roles/${custom.body.data.id}`)
      .set(originHeader)
      .send({ permissions: ["payroll.lock"] });
    expect(updated.status).toBe(200);
    expect(updated.body.data.permissions).toEqual(["payroll.lock"]);
    const roleEvents = await owner.query<{ name: string; sequence: string }>(
      `SELECT event->>'name' AS name, sequence FROM domain_event_outbox
       WHERE tenant_id = $1 AND aggregate_type = 'role' AND aggregate_id = $2
       ORDER BY sequence`,
      [seededTenantId, custom.body.data.id],
    );
    expect(roleEvents.rows.map((row) => [row.name, row.sequence])).toEqual([
      ["role.created", "1"],
      ["role.updated", "2"],
    ]);

    const template = templates.find(
      (role: { templateKey: string | null }) => role.templateKey === "owner",
    );
    const patch = await admin.client
      .patch(`/api/access/roles/${template.id}`)
      .set(originHeader)
      .send({ name: "Renamed template" });
    expect(patch.status).toBe(422);

    const roleAudits = await auditEvents(seededTenantId);
    expect(
      roleAudits.some(
        (entry) =>
          entry.action === "role.created" &&
          entry.objectId === custom.body.data.id,
      ),
    ).toBe(true);
    expect(
      roleAudits.some(
        (entry) =>
          entry.action === "role.created" &&
          entry.actorId === admin.userId &&
          entry.tenantId === seededTenantId,
      ),
    ).toBe(true);
  });
});

describe("§3.7 no self-elevation through role edits or assignment ends", () => {
  it("§3.7 refuses adding rights to a role the editor holds; others may", async () => {
    const owner1 = await signedIn("Role Owner");
    await assign(owner1.userId, "owner");
    const created = await owner1.client
      .post("/api/access/roles")
      .set(originHeader)
      .send({
        name: `Role editor ${unique()}`,
        permissions: ["access.role.view", "access.role.manage"],
        allowedScopeTypes: ["tenant"],
      });
    expect(created.status).toBe(201);
    const roleId = created.body.data.id as string;
    createdRoleIds.push(roleId);

    const editor = await signedIn("Role Editor");
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $4)`,
      [seededTenantId, editor.userId, roleId, owner1.userId],
    );

    const elevate = await editor.client
      .patch(`/api/access/roles/${roleId}`)
      .set(originHeader)
      .send({
        permissions: ["access.role.view", "access.role.manage", "payroll.view"],
      });
    expect(elevate.status).toBe(403);
    expect(elevate.body.error.code).toBe("SELF_ELEVATION_FORBIDDEN");
    const rename = await editor.client
      .patch(`/api/access/roles/${roleId}`)
      .set(originHeader)
      .send({ name: `Role editor renamed ${unique()}` });
    expect(rename.status).toBe(200);

    const byOwner = await owner1.client
      .patch(`/api/access/roles/${roleId}`)
      .set(originHeader)
      .send({
        permissions: [
          "access.role.view",
          "access.role.manage",
          "audit.log.view",
        ],
      });
    expect(byOwner.status).toBe(200);
    expect(byOwner.body.data.permissions).toContain("audit.log.view");
  });

  it("§3.7 a role editor may add a permission they hold but not one they lack", async () => {
    const boss = await signedIn("Held Permission Owner");
    await assign(boss.userId, "owner");
    const target = await boss.client
      .post("/api/access/roles")
      .set(originHeader)
      .send({
        name: `Held target ${unique()}`,
        permissions: ["access.role.view", "access.role.manage"],
        allowedScopeTypes: ["tenant"],
      });
    expect(target.status).toBe(201);
    const targetId = target.body.data.id as string;
    createdRoleIds.push(targetId);
    const editorRole = await boss.client
      .post("/api/access/roles")
      .set(originHeader)
      .send({
        name: `Held editor ${unique()}`,
        permissions: ["access.role.manage", "report.operational.view"],
        allowedScopeTypes: ["tenant"],
      });
    expect(editorRole.status).toBe(201);
    createdRoleIds.push(editorRole.body.data.id);

    const editor = await signedIn("Held Permission Editor");
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $4)`,
      [seededTenantId, editor.userId, editorRole.body.data.id, boss.userId],
    );

    // The editor holds report.operational.view through their own role, so the
    // grant rule allows adding it to another custom role.
    const held = await editor.client
      .patch(`/api/access/roles/${targetId}`)
      .set(originHeader)
      .send({
        permissions: [
          "access.role.view",
          "access.role.manage",
          "report.operational.view",
        ],
      });
    expect(held.status).toBe(200);
    expect(held.body.data.permissions).toContain("report.operational.view");

    // payroll.view is not held and the session has no re-auth, so still 403.
    const unheld = await editor.client
      .patch(`/api/access/roles/${targetId}`)
      .set(originHeader)
      .send({
        permissions: [
          "access.role.view",
          "access.role.manage",
          "report.operational.view",
          "payroll.view",
        ],
      });
    expect(unheld.status).toBe(403);
    expect(unheld.body.error.code).toBe("SELF_ELEVATION_FORBIDDEN");
  });

  it("§3.7 ending an assignment never extends or re-activates it", async () => {
    const grantor = await signedIn("End Grantor");
    await assign(grantor.userId, "owner");
    const grantee = await signedInHire("End Grantee");
    const now = new Date();
    const assignment = await grantRoleAssignment(
      scopedContext(),
      grantRoleSchema.parse({
        userId: grantee.userId,
        roleId: await roleIdOf("supervisor"),
        scope: { type: "outlet", id: bandung },
        validFrom: new Date(now.getTime() - 3_600_000).toISOString(),
        validUntil: new Date(now.getTime() - 1_800_000).toISOString(),
      }),
      {
        actorUserId: grantor.userId,
        reauthenticatedAt: now,
        mfaVerified: true,
      },
    );
    const revive = await grantor.client
      .post(`/api/access/role-assignments/${assignment.id}/end`)
      .set(originHeader)
      .send({
        validUntil: new Date(now.getTime() + 86_400_000).toISOString(),
        reason: "Coba aktifkan lagi.",
      });
    expect(revive.status).toBe(422);
    const access = await grantee.client.get("/api/me/access");
    expect(access.body.data.permissions).toEqual([]);
  });
});

describe("§3.7 Pemberian Role", () => {
  it("§3.7 blocks self-grant and requires a recent re-authentication", async () => {
    const grantor = await signedIn("Grantor");
    await assign(grantor.userId, "owner");
    const cashierRole = await roleIdOf("cashier");

    const self = await grantor.client
      .post("/api/access/role-assignments")
      .set(originHeader)
      .send({
        userId: grantor.userId,
        roleId: cashierRole,
        scope: { type: "outlet", id: bandung },
      });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe("SELF_ELEVATION_FORBIDDEN");

    // A session whose second factor was verified within the 5-minute window
    // is the re-authentication (legend-ma2v): the grant goes through over HTTP.
    const grantee = await signedInHire("Grantee");
    const granted = await grantor.client
      .post("/api/access/role-assignments")
      .set(originHeader)
      .send({
        userId: grantee.userId,
        roleId: cashierRole,
        scope: { type: "outlet", id: bandung },
      });
    expect(granted.status).toBe(201);
    expect(granted.body.data).toMatchObject({
      userId: grantee.userId,
      scope: { type: "outlet", id: bandung },
    });

    // The same session past the window cannot grant again.
    await owner.query(
      // The session must stay internally consistent (sessionSchema), so age
      // its creation and activity along with the verification.
      `UPDATE "session"
       SET created_at = now() - interval '10 minutes',
           last_seen_at = now() - interval '6 minutes',
           mfa_verified_at = now() - interval '6 minutes'
       WHERE user_id = $1`,
      [grantor.userId],
    );
    const staleGrantee = await signedIn("Grantee Stale");
    const stale = await grantor.client
      .post("/api/access/role-assignments")
      .set(originHeader)
      .send({
        userId: staleGrantee.userId,
        roleId: cashierRole,
        scope: { type: "outlet", id: bandung },
      });
    expect(stale.status).toBe(401);
    expect(stale.body.error.code).toBe("REAUTH_REQUIRED");
  });

  it("TEN-03 a verified grant is scoped, audited, emitted and revocable", async () => {
    const grantor = await signedIn("Service Grantor");
    await assign(grantor.userId, "owner");
    const grantee = await signedInHire("Service Grantee");
    const context = scopedContext();
    const assignment = await grantRoleAssignment(
      context,
      grantRoleSchema.parse({
        userId: grantee.userId,
        roleId: await roleIdOf("cashier"),
        scope: { type: "outlet", id: bandung },
      }),
      {
        actorUserId: grantor.userId,
        reauthenticatedAt: new Date(),
        mfaVerified: true,
      },
    );
    expect(assignment.scope).toEqual({ type: "outlet", id: bandung });

    const access = await grantee.client.get("/api/me/access");
    expect(access.body.data.permissions).toContain("pos.sale.create");
    expect(access.body.data.permissions).not.toContain("org.structure.manage");

    expect(
      (await auditEvents(seededTenantId)).some(
        (entry) =>
          entry.action === "role_assignment.granted" &&
          entry.objectId === assignment.id,
      ),
    ).toBe(true);
    const outbox = await owner.query<{
      aggregate_type: string;
      sequence: string;
    }>(
      `SELECT aggregate_type, sequence FROM domain_event_outbox
       WHERE tenant_id = $1 AND aggregate_id = $2`,
      [seededTenantId, assignment.id],
    );
    expect(outbox.rows).toEqual([
      { aggregate_type: "role_assignment", sequence: "1" },
    ]);

    const ended = await grantor.client
      .post(`/api/access/role-assignments/${assignment.id}/end`)
      .set(originHeader)
      .send({ reason: "Penugasan uji sudah selesai." });
    expect(ended.status).toBe(200);
    expect(ended.body.data.validUntil).not.toBeNull();
    const after = await grantee.client.get("/api/me/access");
    expect(after.body.data.permissions).not.toContain("pos.sale.create");
  });

  it("TEN-03 an expired assignment grants nothing", async () => {
    const grantor = await signedIn("Window Grantor");
    await assign(grantor.userId, "owner");
    const grantee = await signedInHire("Window Grantee");
    const now = new Date();
    const assignment = await grantRoleAssignment(
      scopedContext(),
      grantRoleSchema.parse({
        userId: grantee.userId,
        roleId: await roleIdOf("supervisor"),
        scope: { type: "outlet", id: bandung },
        validFrom: new Date(now.getTime() - 3_600_000).toISOString(),
        validUntil: new Date(now.getTime() - 1_800_000).toISOString(),
      }),
      {
        actorUserId: grantor.userId,
        reauthenticatedAt: now,
        mfaVerified: true,
      },
    );
    expect(assignment.validUntil).not.toBeNull();
    const access = await grantee.client.get("/api/me/access");
    expect(access.body.data.permissions).toEqual([]);
  });

  it("TEN-03 a role from another tenant is unreachable", async () => {
    const grantor = await signedIn("Cross Tenant Grantor");
    await assign(grantor.userId, "owner");
    const grantee = await signedIn("Cross Tenant Grantee");
    const otherTenant = randomUUID();
    const foreignRole = randomUUID();
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       VALUES ($1, $2, 'RBAC other tenant', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
      [otherTenant, `rbac-other-${otherTenant}`, grantor.userId],
    );
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, permissions, allowed_scope_types)
       VALUES ($1, $2, 'Foreign role', '["org.structure.manage"]', '["tenant"]')`,
      [foreignRole, otherTenant],
    );
    try {
      await expect(
        grantRoleAssignment(
          scopedContext(),
          grantRoleSchema.parse({
            userId: grantee.userId,
            roleId: foreignRole,
            scope: { type: "tenant", id: null },
          }),
          {
            actorUserId: grantor.userId,
            reauthenticatedAt: new Date(),
            mfaVerified: true,
          },
        ),
      ).rejects.toMatchObject({ status: 404 });
      const roles = await grantor.client.get("/api/access/roles");
      expect(
        roles.body.data.some((role: { id: string }) => role.id === foreignRole),
      ).toBe(false);
    } finally {
      await owner.query("DELETE FROM roles WHERE tenant_id = $1", [
        otherTenant,
      ]);
      await owner.query("DELETE FROM tenants WHERE id = $1", [otherTenant]);
    }
  });
});

describe("§3.7 Matriks Approval", () => {
  it("§3.7 saves tiers and rejects a matrix with a missing level", async () => {
    // The PUT replaces the seeded tenant's whole matrix (refund and
    // cash_shift_close defaults included); put it back afterwards so later
    // files see the seeded matrix (legend-ccpn).
    const savedPolicies = (
      await owner.query(
        "SELECT * FROM approval_policies WHERE tenant_id = $1",
        [seededTenantId],
      )
    ).rows;
    try {
      const admin = await signedIn("Matrix Admin");
      await assign(admin.userId, "owner");
      const supervisor = await roleIdOf("supervisor");
      const outletManager = await roleIdOf("outlet_manager");

      const saved = await admin.client
        .put("/api/access/approval-policies")
        .set(originHeader)
        .send({
          policies: [
            {
              actionType: "void",
              thresholdIdr: null,
              approverRoleId: supervisor,
              levels: 1,
            },
            {
              actionType: "refund",
              thresholdIdr: 500_000,
              approverRoleId: supervisor,
              levels: 1,
            },
            {
              actionType: "refund",
              thresholdIdr: 500_000,
              approverRoleId: outletManager,
              levels: 2,
            },
          ],
        });
      expect(saved.status).toBe(200);
      expect(saved.body.data).toHaveLength(3);
      expect(
        saved.body.data.every(
          (row: { requiresDistinctActor: boolean }) =>
            row.requiresDistinctActor === true,
        ),
      ).toBe(true);

      const listed = await admin.client.get("/api/access/approval-policies");
      expect(listed.status).toBe(200);
      expect(listed.body.data).toHaveLength(3);

      const gap = await admin.client
        .put("/api/access/approval-policies")
        .set(originHeader)
        .send({
          policies: [
            {
              actionType: "refund",
              thresholdIdr: 500_000,
              approverRoleId: outletManager,
              levels: 2,
            },
          ],
        });
      expect(gap.status).toBe(422);

      expect(
        (await auditEvents(seededTenantId)).some(
          (entry) =>
            entry.action === "approval_policy.changed" &&
            entry.tenantId === seededTenantId,
        ),
      ).toBe(true);
      const events = await owner.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM domain_event_outbox
       WHERE tenant_id = $1 AND aggregate_type = 'approval_policy'`,
        [seededTenantId],
      );
      expect(events.rows[0]!.count).toBeGreaterThan(0);
    } finally {
      await owner.query("DELETE FROM approval_policies WHERE tenant_id = $1", [
        seededTenantId,
      ]);
      for (const row of savedPolicies)
        await owner.query(
          `INSERT INTO approval_policies (id, tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            row.id,
            row.tenant_id,
            row.action_type,
            row.threshold_idr,
            row.approver_role_id,
            row.levels,
            row.requires_distinct_actor,
          ],
        );
    }
  });
});
