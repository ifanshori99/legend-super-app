// Tenant settings contracts (beads legend-s6o8, legend-at8c, legend-2gvt).
// Written from the shared contract (packages/shared/src/platform), not from the
// route code. Real Express app, Better Auth and PostgreSQL (RLS).
//
// Surface under test:
//   DELETE /api/org/text-overrides/:overrideId   (contract: 204, no body)
//   POST   /api/org/config/import                (body {bundle, sections?}, the
//                                                 tenant comes from the session)
//   PATCH  /api/org/brands/:brandId              (logoMediaId, brand media)
//   GET    /api/org/support-access and /api/platform/support-access
//          -> page carries `serverNow` and each grant `actorName`
//
// Assumptions where the contract is silent:
// - HTTP tenant context comes from the caller's role assignment, and a throwaway
//   tenant has no HTTP route in (403). So every HTTP actor is a member of the
//   seeded tenant, and the throwaway tenant B is only "the other tenant": its
//   rows are seeded straight in the database and must stay invisible/untouched.
// - a tenant import refuses a bundle that CONTAINS a blocked section
//   (TENANT_IMPORT_BLOCKED_SECTIONS) and a `sections` filter that NAMES one, with
//   403 even when the section carries no items; nothing is written.
// - a text override or brand of another tenant answers 404 (same as an unknown
//   id, no existence oracle); a foreign/unknown logo media id answers 422
//   (matches org-brand-logo-media.test.ts); a role lacking the permission 403.
// - an import succeeds with 200 or 201 and `data.status = "applied"`; a bundle
//   that carries tenant identifiers is refused with 422 and nothing is written.
// - importing needs its own permission `org.config.import` (NOT org.config.export):
//   a role holding only export gets 403 on import, a role holding import passes.
//   The tenant admin template holds import by default; the cashier template not.
// - "another tenant is refused": a user whose only import-capable role is in
//   tenant B has no tenant context in the seeded tenant (403) and writes nothing.
// - `actorName` is the Super Admin's display name (user.name), never the email;
//   null/absent when the user row is unknown.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CONFIG_BUNDLE_FORMAT_VERSION,
  TENANT_IMPORT_BLOCKED_SECTIONS,
  cafeLegendPlatformFixtures,
  orgEndpoints,
  requestSupportAccessInputSchema,
  textOverrideEndpoints,
} from "@starter/shared/platform";
import { PERMISSION_CODES, roleTemplate } from "@starter/shared/access";
import { createApp } from "../app.ts";
import {
  endSupportAccess,
  requestSupportAccess,
} from "../services/platform-support.service.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";
import {
  createTestTenant,
  removeTestTenant,
  storedMedia,
  type TestTenant,
} from "./platform-theme-helpers.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const app: Express = createApp();
const seededTenantId = cafeLegendPlatformFixtures.tenant.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});

type Client = ReturnType<typeof agent>;
type Member = { client: Client; userId: string; email: string; name: string };

// Tenant B: a throwaway tenant, only ever "the other tenant" (never an HTTP actor).
let tenantB: TestTenant;
const seededRoleCache = new Map<string, string>();
const createdUsers: string[] = [];
const createdAdmins: string[] = [];
const createdBrands: string[] = [];
const createdMedia: string[] = [];
const openGrants: { tenantId: string; grantId: string; userId: string }[] = [];
let importsBefore: string[] = [];

/** A signed-up user holding a template role in the seeded tenant (MFA verified). */
async function memberOf(
  template: string,
  name = `Uji ${template}`,
): Promise<Member> {
  const client = agent(app);
  const email = await signUp(client, name);
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  createdUsers.push(userId);
  let roleId = seededRoleCache.get(template);
  if (!roleId) {
    const found = await owner.query<{ id: string }>(
      "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
      [seededTenantId, template],
    );
    roleId = found.rows[0]!.id;
    seededRoleCache.set(template, roleId);
  }
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by, assigned_at)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 day', $2, now() - interval '1 day')`,
    [seededTenantId, userId, roleId],
  );
  await verifySessionMfa(email);
  return { client, userId, email, name };
}

const createdRoles: string[] = [];

/** A signed-up user holding a custom tenant-scoped role with exactly `permissions`. */
async function memberWith(
  tenantId: string,
  permissions: string[],
  name = "Uji izin khusus",
): Promise<Member> {
  const client = agent(app);
  const email = await signUp(client, name);
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  createdUsers.push(userId);
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, $5)`,
    [
      roleId,
      tenantId,
      `Uji impor ${roleId.slice(0, 8)}`,
      JSON.stringify(permissions),
      JSON.stringify(["tenant"]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by, assigned_at)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 day', $2, now() - interval '1 day')`,
    [tenantId, userId, roleId],
  );
  await verifySessionMfa(email);
  return { client, userId, email, name };
}

const overrideRows = (tenantId: string, key: string) =>
  owner.query<{ id: string; value: string; locale: string }>(
    "SELECT id, value, locale FROM text_overrides WHERE tenant_id = $1 AND key = $2",
    [tenantId, key],
  );

const importIds = async () =>
  (
    await owner.query<{ id: string }>(
      "SELECT id FROM config_imports WHERE tenant_id = $1",
      [seededTenantId],
    )
  ).rows.map((row) => row.id);

beforeAll(async () => {
  tenantB = await createTestTenant("cfg-b");
  importsBefore = await importIds();
});

afterAll(async () => {
  for (const g of openGrants)
    await endSupportAccess({
      tenantId: g.tenantId,
      grantId: g.grantId,
      actorUserId: g.userId,
    }).catch(() => undefined);
  await owner.query(
    "DELETE FROM text_overrides WHERE tenant_id = $1 AND key = ANY($2::text[])",
    [
      seededTenantId,
      ["terms.stationPastry", "terms.stationBarKopi", "terms.tierGold"],
    ],
  );
  await owner
    .query(
      "DELETE FROM config_imports WHERE tenant_id = $1 AND id <> ALL($2::uuid[])",
      [seededTenantId, importsBefore],
    )
    .catch(() => undefined);
  for (const brandId of createdBrands)
    for (const sql of [
      "DELETE FROM outlets WHERE brand_id = $1",
      "DELETE FROM brands WHERE id = $1",
    ])
      await owner.query(sql, [brandId]).catch(() => undefined);
  await owner
    .query(
      "DELETE FROM core_storage_objects WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [seededTenantId, createdMedia],
    )
    .catch(() => undefined);
  await owner
    .query("DELETE FROM role_assignments WHERE user_id = ANY($1::text[])", [
      createdUsers,
    ])
    .catch(() => undefined);
  if (createdRoles.length)
    await owner
      .query("DELETE FROM roles WHERE id = ANY($1::uuid[])", [createdRoles])
      .catch(() => undefined);
  if (createdAdmins.length)
    await owner
      .query("DELETE FROM platform_admins WHERE user_id = ANY($1::text[])", [
        createdAdmins,
      ])
      .catch(() => undefined);
  await owner
    .query("DELETE FROM text_overrides WHERE tenant_id = $1", [
      tenantB.tenantId,
    ])
    .catch(() => undefined);
  await removeTestTenant(tenantB);
  await owner.end();
});

// ------------------------------------------------- legend-s6o8 contract shape

describe("legend-s6o8 shared contract", () => {
  it("declares DELETE /api/org/text-overrides/:overrideId next to list and put", () => {
    const endpoint = (
      textOverrideEndpoints as Record<
        string,
        { method?: string; path?: string } | undefined
      >
    ).deleteTextOverride;
    expect(endpoint).toBeDefined();
    expect(endpoint).toMatchObject({
      method: "DELETE",
      path: "/api/org/text-overrides/:overrideId",
    });
    expect(textOverrideEndpoints.listTextOverrides.method).toBe("GET");
    expect(textOverrideEndpoints.putTextOverride.method).toBe("PUT");
  });

  it("declares POST /api/org/config/import with no tenant id in the path", () => {
    const endpoint = (
      orgEndpoints as Record<
        string,
        { method?: string; path?: string } | undefined
      >
    ).importConfig;
    expect(endpoint).toBeDefined();
    expect(endpoint).toMatchObject({
      method: "POST",
      path: "/api/org/config/import",
    });
    expect(endpoint?.path).not.toContain(":tenantId");
  });
});

// ---------------------------------------------- legend-at8c text overrides

describe("legend-at8c /api/org/text-overrides", () => {
  const KEY = "terms.stationPastry";

  async function putOverride(
    member: Member,
    value: string,
    locale: "id" | "en" = "id",
  ) {
    const response = await member.client
      .put("/api/org/text-overrides")
      .set(originHeader)
      .send({ locale, key: KEY, value });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body.data as { id: string; tenantId: string };
  }

  it("clears a term: 204 without body, row gone, list no longer shows it", async () => {
    const admin = await memberOf("tenant_admin");
    const row = await putOverride(admin, "Roti Manis");
    expect(row.tenantId).toBe(seededTenantId);

    const deleted = await admin.client
      .delete(`/api/org/text-overrides/${row.id}`)
      .set(originHeader);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(204);
    expect(deleted.text).toBe("");

    expect((await overrideRows(seededTenantId, KEY)).rows).toHaveLength(0);
    const listed = await admin.client
      .get("/api/org/text-overrides")
      .query({ locale: "id" });
    expect(listed.status).toBe(200);
    expect(
      listed.body.data.map((item: { id: string }) => item.id),
    ).not.toContain(row.id);
  });

  it("deleting only removes that locale's row and the same id twice is 404", async () => {
    const admin = await memberOf("tenant_admin");
    const idRow = await putOverride(admin, "Roti ID", "id");
    const enRow = await putOverride(admin, "Pastry EN", "en");
    expect(idRow.id).not.toBe(enRow.id);

    const first = await admin.client
      .delete(`/api/org/text-overrides/${idRow.id}`)
      .set(originHeader);
    expect(first.status).toBe(204);
    const remaining = await overrideRows(seededTenantId, KEY);
    expect(remaining.rows.map((row) => row.locale)).toEqual(["en"]);

    const again = await admin.client
      .delete(`/api/org/text-overrides/${idRow.id}`)
      .set(originHeader);
    expect(again.status).toBe(404);

    await admin.client
      .delete(`/api/org/text-overrides/${enRow.id}`)
      .set(originHeader);
  });

  it("an unknown id is 404 and a malformed id is 422", async () => {
    const admin = await memberOf("tenant_admin");
    const unknown = await admin.client
      .delete(`/api/org/text-overrides/${randomUUID()}`)
      .set(originHeader);
    expect(unknown.status).toBe(404);
    const malformed = await admin.client
      .delete("/api/org/text-overrides/bukan-uuid")
      .set(originHeader);
    expect(malformed.status).toBe(422);
  });

  it("TEN-02 another tenant's override cannot be deleted (404, row stays) and is never listed", async () => {
    const admin = await memberOf("tenant_admin");
    const own = await putOverride(admin, "Milik Seeded");
    const foreign = await owner.query<{ id: string }>(
      `INSERT INTO text_overrides (tenant_id, locale, key, value, updated_by)
       VALUES ($1, 'id', $2, 'Milik B', 'uji') RETURNING id`,
      [tenantB.tenantId, KEY],
    );
    const foreignId = foreign.rows[0]!.id;

    const crossed = await admin.client
      .delete(`/api/org/text-overrides/${foreignId}`)
      .set(originHeader);
    expect(crossed.status).toBe(404);
    expect(
      (await overrideRows(tenantB.tenantId, KEY)).rows.map((r) => r.id),
    ).toContain(foreignId);

    const listed = await admin.client.get("/api/org/text-overrides");
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain(foreignId);
    expect(JSON.stringify(listed.body)).not.toContain("Milik B");

    await admin.client
      .delete(`/api/org/text-overrides/${own.id}`)
      .set(originHeader);
  });

  it("TEN-02 a tenantId in the PUT body is refused with 422 and writes nothing", async () => {
    const admin = await memberOf("tenant_admin");
    const forged = await admin.client
      .put("/api/org/text-overrides")
      .set(originHeader)
      .send({
        locale: "id",
        key: "terms.stationBarKopi",
        value: "Bocor",
        tenantId: tenantB.tenantId,
      });
    expect(forged.status).toBe(422);
    expect(
      (await overrideRows(tenantB.tenantId, "terms.stationBarKopi")).rows,
    ).toHaveLength(0);
    expect(
      (await overrideRows(seededTenantId, "terms.stationBarKopi")).rows,
    ).toHaveLength(0);
  });

  it("a role without settings permission gets 403 and the row stays; no session is 401", async () => {
    const admin = await memberOf("tenant_admin");
    const row = await putOverride(admin, "Tetap Ada");
    const cashier = await memberOf("cashier");

    const denied = await cashier.client
      .delete(`/api/org/text-overrides/${row.id}`)
      .set(originHeader);
    expect(denied.status).toBe(403);
    expect(
      (
        await cashier.client
          .put("/api/org/text-overrides")
          .set(originHeader)
          .send({ locale: "id", key: KEY, value: "Tidak Boleh" })
      ).status,
    ).toBe(403);
    expect((await cashier.client.get("/api/org/text-overrides")).status).toBe(
      403,
    );
    const anonymous = await agent(app)
      .delete(`/api/org/text-overrides/${row.id}`)
      .set(originHeader);
    expect(anonymous.status).toBe(401);
    expect((await agent(app).get("/api/org/text-overrides")).status).toBe(401);
    expect(
      (await overrideRows(seededTenantId, KEY)).rows.map((r) => r.value),
    ).toEqual(["Tetap Ada"]);

    await admin.client
      .delete(`/api/org/text-overrides/${row.id}`)
      .set(originHeader);
  });

  it("refuses a cookie-authenticated delete or put from an untrusted origin", async () => {
    const admin = await memberOf("tenant_admin");
    const row = await putOverride(admin, "Asal Tidak Dipercaya");
    const untrusted = { Origin: "https://untrusted.example" };
    const response = await admin.client
      .delete(`/api/org/text-overrides/${row.id}`)
      .set(untrusted);
    expect(response.status).toBe(403);
    const put = await admin.client
      .put("/api/org/text-overrides")
      .set(untrusted)
      .send({ locale: "id", key: KEY, value: "Asal Palsu" });
    expect(put.status).toBe(403);
    expect(
      (await overrideRows(seededTenantId, KEY)).rows.map((r) => r.value),
    ).toEqual(["Asal Tidak Dipercaya"]);
    await admin.client
      .delete(`/api/org/text-overrides/${row.id}`)
      .set(originHeader);
  });
});

// ------------------------------------------------------ tenant config import

describe("legend-at8c POST /api/org/config/import", () => {
  const IMPORT = "/api/org/config/import";
  const KEY = "terms.tierGold";

  const textSection = (value: string) => ({
    text_overrides: {
      version: 1,
      sets: [{ locale: "en", overrides: [{ key: KEY, value }] }],
    },
  });
  const bundle = (
    value = "Emas Plus",
    extra: Record<string, unknown> = {},
    sections: Record<string, unknown> = textSection(value),
  ) => ({
    formatVersion: CONFIG_BUNDLE_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    sections,
    ...extra,
  });

  it("imports a bundle into the caller's own tenant, taken from the session", async () => {
    const admin = await memberOf("tenant_admin");
    const response = await admin.client
      // A tenant id in the query string must be ignored, never trusted.
      .post(`${IMPORT}?tenantId=${tenantB.tenantId}`)
      .set(originHeader)
      .send({ bundle: bundle("Emas Plus") });
    expect([200, 201], JSON.stringify(response.body)).toContain(
      response.status,
    );
    expect(response.body.data).toMatchObject({
      tenantId: seededTenantId,
      status: "applied",
      errors: [],
    });
    expect(response.body.data.appliedSections).toContain("text_overrides");

    const inSeeded = await overrideRows(seededTenantId, KEY);
    expect(inSeeded.rows.map((row) => [row.locale, row.value])).toEqual([
      ["en", "Emas Plus"],
    ]);
    expect((await overrideRows(tenantB.tenantId, KEY)).rows).toHaveLength(0);
    expect(await importIds()).toContain(response.body.data.id);

    const listed = await admin.client
      .get("/api/org/text-overrides")
      .query({ locale: "en" });
    expect(listed.body.data.map((item: { key: string }) => item.key)).toContain(
      KEY,
    );
  });

  it("refuses a body that names a tenant, a stored template, or no bundle", async () => {
    const admin = await memberOf("tenant_admin");
    const before = (await importIds()).length;
    for (const body of [
      { tenantId: tenantB.tenantId, bundle: bundle("Dilarang") },
      { templateId: randomUUID() },
      { templateId: randomUUID(), bundle: bundle("Dilarang") },
      {},
    ]) {
      const response = await admin.client
        .post(IMPORT)
        .set(originHeader)
        .send(body);
      expect(response.status, JSON.stringify(body)).toBe(422);
    }
    expect(await importIds()).toHaveLength(before);
    for (const tenantId of [seededTenantId, tenantB.tenantId])
      expect(
        (await overrideRows(tenantId, KEY)).rows.map((row) => row.value),
      ).not.toContain("Dilarang");
  });

  it("refuses a bundle that carries tenant identifiers (nothing written)", async () => {
    const admin = await memberOf("tenant_admin");
    const before = await overrideRows(seededTenantId, KEY);
    const response = await admin.client
      .post(IMPORT)
      .set(originHeader)
      .send({
        bundle: bundle("Bocor", { tenantId: tenantB.tenantId }),
      });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(await overrideRows(seededTenantId, KEY)).toEqual(before);
    expect(JSON.stringify(response.body)).not.toContain(tenantB.tenantId);
  });

  it("every blocked section is refused with 403 (even empty) and nothing is written", async () => {
    const admin = await memberOf("tenant_admin");
    const before = (await importIds()).length;
    const beforeRows = await overrideRows(seededTenantId, KEY);
    for (const section of TENANT_IMPORT_BLOCKED_SECTIONS) {
      const response = await admin.client
        .post(IMPORT)
        .set(originHeader)
        .send({
          bundle: bundle(
            "Campuran",
            {},
            {
              ...textSection("Campuran"),
              [section]: { version: 1, items: [] },
            },
          ),
        });
      expect(
        response.status,
        `${section}: ${JSON.stringify(response.body)}`,
      ).toBe(403);
    }
    const named = await admin.client
      .post(IMPORT)
      .set(originHeader)
      .send({
        bundle: bundle("Campuran"),
        sections: ["payroll_settings"],
      });
    expect(named.status).toBe(403);
    expect(await importIds()).toHaveLength(before);
    expect(await overrideRows(seededTenantId, KEY)).toEqual(beforeRows);
  });

  it("a role without the permission gets 403, no session 401, untrusted origin 403; nothing is written", async () => {
    const cashier = await memberOf("cashier");
    const admin = await memberOf("tenant_admin");
    const before = (await importIds()).length;
    const beforeRows = await overrideRows(seededTenantId, KEY);
    const payload = { bundle: bundle("Tidak Boleh") };

    const denied = await cashier.client
      .post(IMPORT)
      .set(originHeader)
      .send(payload);
    expect(denied.status).toBe(403);
    const anonymous = await agent(app)
      .post(IMPORT)
      .set(originHeader)
      .send(payload);
    expect(anonymous.status).toBe(401);
    const untrusted = await admin.client
      .post(IMPORT)
      .set({ Origin: "https://untrusted.example" })
      .send(payload);
    expect(untrusted.status).toBe(403);

    expect(await importIds()).toHaveLength(before);
    expect(await overrideRows(seededTenantId, KEY)).toEqual(beforeRows);
  });

  it("org.config.import is a catalogued permission held by the tenant admin template, not the cashier", () => {
    expect(PERMISSION_CODES as readonly string[]).toContain(
      "org.config.import",
    );
    expect(
      roleTemplate("tenant_admin").permissions as readonly string[],
    ).toContain("org.config.import");
    expect(
      roleTemplate("cashier").permissions as readonly string[],
    ).not.toContain("org.config.import");
  });

  it("a role holding only org.config.export gets 403 on import; nothing is written", async () => {
    const exportOnly = await memberWith(seededTenantId, ["org.config.export"]);
    const before = (await importIds()).length;
    const beforeRows = await overrideRows(seededTenantId, KEY);
    const denied = await exportOnly.client
      .post(IMPORT)
      .set(originHeader)
      .send({ bundle: bundle("Hanya Ekspor") });
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(await importIds()).toHaveLength(before);
    expect(await overrideRows(seededTenantId, KEY)).toEqual(beforeRows);
    // Export itself stays allowed for that role: the two permissions are separate.
    const exported = await exportOnly.client
      .post("/api/org/config/export")
      .set(originHeader)
      .send({});
    expect(exported.status, JSON.stringify(exported.body)).not.toBe(403);
  });

  it("a role holding only org.config.import may import into its own tenant", async () => {
    const importOnly = await memberWith(seededTenantId, ["org.config.import"]);
    const response = await importOnly.client
      .post(IMPORT)
      .set(originHeader)
      .send({
        bundle: bundle(
          "Hanya Impor",
          {},
          {
            text_overrides: {
              version: 1,
              sets: [
                {
                  locale: "en",
                  // A key no other test imports, so an earlier import can't mask a skip.
                  overrides: [
                    { key: "terms.stationPastry", value: "Hanya Impor" },
                  ],
                },
              ],
            },
          },
        ),
      });
    expect([200, 201], JSON.stringify(response.body)).toContain(
      response.status,
    );
    expect(response.body.data).toMatchObject({
      tenantId: seededTenantId,
      status: "applied",
    });
    expect(
      (await overrideRows(seededTenantId, "terms.stationPastry")).rows.map(
        (row) => row.value,
      ),
    ).toContain("Hanya Impor");
  });

  it("a user whose import role lives in another tenant is refused and writes nothing", async () => {
    const foreign = await memberWith(tenantB.tenantId, ["org.config.import"]);
    const before = (await importIds()).length;
    const response = await foreign.client
      .post(IMPORT)
      .set(originHeader)
      .send({ bundle: bundle("Tenant Lain") });
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(await importIds()).toHaveLength(before);
    for (const tenantId of [seededTenantId, tenantB.tenantId])
      expect(
        (await overrideRows(tenantId, KEY)).rows.map((row) => row.value),
      ).not.toContain("Tenant Lain");
  });
});

// --------------------------------------------------------- brand media (logo)

describe("legend-at8c PATCH /api/org/brands/:brandId logoMediaId", () => {
  const patch = (member: Member, brandId: string, body: object) =>
    member.client
      .patch(`/api/org/brands/${brandId}`)
      .set(originHeader)
      .send(body);

  /** A new brand of the seeded tenant, so no other suite's brand is touched. */
  async function newBrand(admin: Member): Promise<string> {
    const slug = `logo-${randomUUID().slice(0, 8)}`;
    const created = await admin.client
      .post("/api/org/brands")
      .set(originHeader)
      .send({ slug, name: "Brand Logo Uji" });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    const brandId = created.body.data.id as string;
    createdBrands.push(brandId);
    return brandId;
  }

  // legend-bkdmc: a brand logo must be a `brand_logo` upload; pass "document"
  // for own-tenant media of another purpose.
  async function ownMedia(
    brandId: string,
    purpose: "document" | "brand_logo" = "brand_logo",
  ): Promise<string> {
    const mediaId = await storedMedia(
      { ...tenantB, tenantId: seededTenantId, brandId },
      purpose,
    );
    createdMedia.push(mediaId);
    return mediaId;
  }

  it("accepts the tenant's own media, null clears it", async () => {
    const admin = await memberOf("tenant_admin");
    const brandId = await newBrand(admin);
    const mediaId = await ownMedia(brandId);
    const set = await patch(admin, brandId, { logoMediaId: mediaId });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.data.logoMediaId).toBe(mediaId);
    const cleared = await patch(admin, brandId, { logoMediaId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.logoMediaId).toBeNull();
  });

  it("refuses another tenant's media and an unknown id with 422, logo unchanged", async () => {
    const admin = await memberOf("tenant_admin");
    const brandId = await newBrand(admin);
    const own = await ownMedia(brandId);
    await patch(admin, brandId, { logoMediaId: own });
    const foreign = await storedMedia(tenantB, "brand_logo");
    for (const logoMediaId of [foreign, randomUUID()]) {
      const response = await patch(admin, brandId, { logoMediaId });
      expect(response.status, String(logoMediaId)).toBe(422);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    }
    const { rows } = await owner.query<{ logo_media_id: string }>(
      "SELECT logo_media_id FROM brands WHERE id = $1",
      [brandId],
    );
    expect(rows[0]!.logo_media_id).toBe(own);
  });

  it("refuses own-tenant media of another purpose on PATCH and POST with 422", async () => {
    const admin = await memberOf("tenant_admin");
    const brandId = await newBrand(admin);
    const own = await ownMedia(brandId);
    await patch(admin, brandId, { logoMediaId: own });
    const document = await ownMedia(brandId, "document");
    const patched = await patch(admin, brandId, { logoMediaId: document });
    expect(patched.status, JSON.stringify(patched.body)).toBe(422);
    expect(patched.body.error.code).toBe("VALIDATION_ERROR");
    const slug = `logo-${randomUUID().slice(0, 8)}`;
    const posted = await admin.client
      .post("/api/org/brands")
      .set(originHeader)
      .send({ slug, name: "Brand Dokumen", logoMediaId: document });
    expect(posted.status, JSON.stringify(posted.body)).toBe(422);
    expect(posted.body.error.code).toBe("VALIDATION_ERROR");
    const { rows } = await owner.query<{ logo_media_id: string }>(
      "SELECT logo_media_id FROM brands WHERE id = $1",
      [brandId],
    );
    expect(rows[0]!.logo_media_id).toBe(own);
    const stored = await owner.query("SELECT 1 FROM brands WHERE slug = $1", [
      slug,
    ]);
    expect(stored.rows).toHaveLength(0);
  });

  it("a role without org.theme.manage gets 403, and another tenant's brand is 404", async () => {
    const admin = await memberOf("tenant_admin");
    const brandId = await newBrand(admin);
    const cashier = await memberOf("cashier");
    const denied = await patch(cashier, brandId, { logoMediaId: null });
    expect(denied.status).toBe(403);

    const crossed = await patch(admin, tenantB.brandId, { logoMediaId: null });
    expect(crossed.status).toBe(404);
  });
});

// ------------------------------------------------ legend-2gvt support access

describe("legend-2gvt support access list: serverNow + Super Admin name", () => {
  const SUPER_ADMIN_NAME = "Rina Super Admin";

  async function superAdmin(name: string | null): Promise<Member> {
    const client = agent(app);
    const email = await signUp(client, name ?? "Tanpa Nama");
    const userId = (await client.get("/api/auth/get-session")).body.user
      .id as string;
    createdUsers.push(userId);
    await owner.query(
      "INSERT INTO platform_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [userId],
    );
    createdAdmins.push(userId);
    await verifySessionMfa(email);
    return { client, userId, email, name: name ?? "Tanpa Nama" };
  }

  async function open(tenantId: string, actorUserId: string) {
    const grant = await requestSupportAccess({
      tenantId,
      actorUserId,
      request: requestSupportAccessInputSchema.parse({
        reason: "Menelusuri keluhan pelanggan pada tenant ini.",
        durationMinutes: 60,
        accessMode: "read_only",
        mfaCode: "123456",
      }),
      mfaVerifiedAt: new Date().toISOString(),
    });
    openGrants.push({ tenantId, grantId: grant.id, userId: actorUserId });
    return grant;
  }

  it("the tenant owner's list carries serverNow (API clock) and the Super Admin's display name", async () => {
    const ownerA = await memberOf("owner");
    const admin = await superAdmin(SUPER_ADMIN_NAME);
    const grant = await open(seededTenantId, admin.userId);

    const before = Date.now();
    const listed = await ownerA.client.get("/api/org/support-access?limit=100");
    const after = Date.now();
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);

    expect(typeof listed.body.serverNow).toBe("string");
    const serverNow = Date.parse(listed.body.serverNow);
    expect(Number.isNaN(serverNow)).toBe(false);
    expect(serverNow).toBeGreaterThanOrEqual(before - 5_000);
    expect(serverNow).toBeLessThanOrEqual(after + 5_000);

    const row = listed.body.data.find(
      (item: { id: string }) => item.id === grant.id,
    );
    expect(row).toBeDefined();
    expect(row.superAdminUserId).toBe(admin.userId);
    expect(row.actorName).toBe(SUPER_ADMIN_NAME);
    // Display name only: the Super Admin's email never reaches the tenant.
    expect(JSON.stringify(listed.body)).not.toContain(admin.email);

    // The wire shape still satisfies the shared contract.
    expect(
      orgEndpoints.listSupportAccess.response.safeParse(listed.body).success,
    ).toBe(true);
  });

  it("a Super Admin whose user row is unknown shows no name instead of failing", async () => {
    const ownerA = await memberOf("owner");
    const ghost = randomUUID();
    await owner.query(
      "INSERT INTO platform_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [ghost],
    );
    createdAdmins.push(ghost);
    const grant = await open(seededTenantId, ghost);

    const listed = await ownerA.client.get("/api/org/support-access?limit=100");
    expect(listed.status).toBe(200);
    const row = listed.body.data.find(
      (item: { id: string }) => item.id === grant.id,
    );
    expect(row).toBeDefined();
    expect(row.actorName ?? null).toBeNull();
    expect(typeof listed.body.serverNow).toBe("string");
  });

  it("TEN-02 a session of another tenant is never listed, and serverNow is still returned", async () => {
    const ownerA = await memberOf("owner");
    const admin = await superAdmin("Bima Super Admin");
    const grant = await open(tenantB.tenantId, admin.userId);

    const listed = await ownerA.client.get("/api/org/support-access?limit=100");
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(
      listed.body.data.map((item: { id: string }) => item.id),
    ).not.toContain(grant.id);
    expect(JSON.stringify(listed.body)).not.toContain("Bima Super Admin");
    expect(typeof listed.body.serverNow).toBe("string");
  });

  it("a role without access gets 403 and no session gets 401", async () => {
    const cashier = await memberOf("cashier");
    expect((await cashier.client.get("/api/org/support-access")).status).toBe(
      403,
    );
    expect((await agent(app).get("/api/org/support-access")).status).toBe(401);
  });

  it("the Super Admin's own platform list carries serverNow and actorName too", async () => {
    const admin = await superAdmin("Citra Super Admin");
    const grant = await open(seededTenantId, admin.userId);

    const listed = await admin.client.get(
      `/api/platform/support-access?tenantId=${seededTenantId}&limit=100`,
    );
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(Number.isNaN(Date.parse(listed.body.serverNow))).toBe(false);
    const row = listed.body.data.find(
      (item: { id: string }) => item.id === grant.id,
    );
    expect(row?.actorName).toBe("Citra Super Admin");
  });
});
