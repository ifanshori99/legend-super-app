// Platform panel + tenant organisation API (TEN-02/03/04/05/06).
// HTTP tests run the real Express app, Better Auth and PostgreSQL; DB-role
// isolation lives in platform-org-db.test.ts.
import express from "express";
import request from "supertest";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  createBrandInputSchema,
  requestSupportAccessInputSchema,
} from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { outletIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { errorHandler } from "../middleware/error-handler";
import { requireModuleEnabled } from "../middleware/module";
import { developmentTenantContext } from "../middleware/tenant";
import {
  updateOutlet,
  setOutletStatus,
  listOutlets,
} from "../services/org.service";
import {
  requireSupportAccess,
  requestSupportAccess,
} from "../services/platform-support.service";
import {
  agent,
  originHeader,
  setRole,
  signUp,
  verifySessionMfa,
} from "./helpers";

const app = createApp();
const fixtures = cafeLegendPlatformFixtures;
const seededTenantId = fixtures.tenant.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

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

function tenantBody(slug: string) {
  return {
    slug,
    name: "Uji Panel",
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
  // legend-4f9: the global Better Auth admin no longer holds org.* (TEN-04).
  // Tenant org routes authorize through stored role_assignments, so the test
  // admin also holds the seeded Owner template in the synthetic tenant.
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
     WHERE tenant_id = $1 AND template_key = 'owner'`,
    [seededTenantId, userId],
  );
  // AUTH-05: the owner template requires MFA, so the platform panel and the
  // tenant back office stay closed until the session verifies a factor
  // (legend-qfvu). The TOTP path itself is covered by identity-mfa-api.test.ts.
  await verifySessionMfa(email);
  return { client, userId };
}

function scopedContext(outletIds?: string[]): ScopedTenantContext {
  const tenant = establishTenantContext({
    tenantId: seededTenantId,
    brandId: null,
    source: "session",
  });
  return outletIds === undefined
    ? establishScopedTenantContext(tenant, { kind: "tenant" })
    : establishScopedTenantContext(tenant, {
        kind: "outlets",
        outletIds: outletIds.map((id) => outletIdSchema.parse(id)),
      });
}

// legend-23tbw: many other files add outlets to the shared seeded tenant by
// raw SQL (no quota check), and vitest's file order changes between runs. The
// seeded plan allows 5 outlets, so TEN-06 Q39 got 409 QUOTA_EXCEEDED whenever
// it ran after enough of them. Lift the cap for this file and restore it after.
let originalMaxOutlets: string | null = null;

beforeAll(async () => {
  const current = await owner.query<{ max: string }>(
    "SELECT limits->>'maxOutlets' AS max FROM tenants WHERE id = $1",
    [seededTenantId],
  );
  originalMaxOutlets = current.rows[0]?.max ?? null;
  await owner.query(
    `UPDATE tenants SET limits = jsonb_set(limits, '{maxOutlets}', '1000'::jsonb)
      WHERE id = $1`,
    [seededTenantId],
  );
});

afterAll(async () => {
  if (originalMaxOutlets !== null) {
    await owner.query(
      `UPDATE tenants SET limits = jsonb_set(limits, '{maxOutlets}', to_jsonb($2::int))
        WHERE id = $1`,
      [seededTenantId, originalMaxOutlets],
    );
  }
  await owner.query("DELETE FROM support_access_grants WHERE tenant_id = $1", [
    seededTenantId,
  ]);
  if (platformAdminIds.length > 0)
    await owner.query(
      "DELETE FROM platform_admins WHERE user_id = ANY($1::text[])",
      [platformAdminIds],
    );
  await owner.end();
});

describe("Panel Platform API", () => {
  it("answers 401 without a session and 403 without a platform permission", async () => {
    expect((await agent(app).get("/api/platform/tenants")).status).toBe(401);

    const user = agent(app);
    await signUp(user, "Biasa");
    const denied = await user.get("/api/platform/tenants");
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("FORBIDDEN");

    const legacy = agent(app);
    const legacyEmail = await signUp(legacy, "Legacy Admin");
    await setRole(legacyEmail, "admin");
    expect((await legacy.get("/api/platform/tenants")).status).toBe(403);
    const admin = await adminClient();
    expect((await admin.client.get("/api/platform/tenants")).status).toBe(200);
    // The origin check still applies to a permitted role.
    expect(
      (
        await admin.client
          .post("/api/platform/tenants")
          .set({ Origin: "https://untrusted.example" })
          .send(tenantBody(`uji-${randomBytes(3).toString("hex")}`))
      ).status,
    ).toBe(403);
  });

  it("TEN-06 creates a tenant from panel input without a deploy", async () => {
    const { client } = await adminClient();
    const slug = `uji-${randomBytes(4).toString("hex")}`;
    const created = await client
      .post("/api/platform/tenants")
      .set(originHeader)
      .send(tenantBody(slug));
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      slug,
      status: "active",
      plan: "lengkap",
    });
    expect(created.headers.location).toBe(
      `/api/platform/tenants/${created.body.data.id}`,
    );

    // Flow R step 3 (legend-2ign): the first admin holds the tenant_admin
    // template at tenant scope, and the response carries no credential.
    const firstAdmin = await owner.query<{ user_id: string }>(
      `SELECT ra.user_id FROM role_assignments ra JOIN roles r
         ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
        WHERE ra.tenant_id = $1 AND r.template_key = 'tenant_admin'
          AND ra.scope_type = 'tenant'`,
      [created.body.data.id],
    );
    expect(firstAdmin.rows).toHaveLength(1);
    expect(JSON.stringify(created.body)).not.toMatch(
      /token|password|secret|6281234567890/i,
    );
    const audited = await owner.query<{ action: string }>(
      "SELECT event->>'action' AS action FROM audit_logs WHERE tenant_id = $1",
      [created.body.data.id],
    );
    // legend-4ryw: a new tenant also gets the standard UOM catalog, audited.
    // legend-9obf: and the default PBJT rule and tax settings.
    // legend-2qz7: and the default 5% dine-in service charge.
    expect(audited.rows.map((row) => row.action).sort()).toEqual([
      "inventory.uoms.provisioned",
      "role_assignment.granted",
      "tax.rules.provisioned",
      "tax.service_charge.provisioned",
      "tax.settings.provisioned",
      "tenant.created",
    ]);

    const fetched = await client.get(
      `/api/platform/tenants/${created.body.data.id}`,
    );
    expect(fetched.status).toBe(200);
    expect(fetched.body.data.slug).toBe(slug);

    const duplicate = await client
      .post("/api/platform/tenants")
      .set(originHeader)
      .send(tenantBody(slug));
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe("CONFLICT");

    // A module the package does not include is refused before any row exists.
    const outsidePackage = await client
      .post("/api/platform/tenants")
      .set(originHeader)
      .send({
        ...tenantBody(`uji-${randomBytes(4).toString("hex")}`),
        plan: "outlet-dasar",
        featureFlags: { modules: ["accounting"], integrationProviders: [] },
      });
    expect(outsidePackage.status).toBe(422);
    expect(outsidePackage.body.error.code).toBe("MODULE_NOT_IN_PACKAGE");
  });

  it("TEN-04 TEN-06 moves a tenant through its status machine and assigns a package (audited)", async () => {
    const { client, userId } = await adminClient();
    const created = await client
      .post("/api/platform/tenants")
      .set(originHeader)
      .send(tenantBody(`uji-${randomBytes(4).toString("hex")}`));
    const id = created.body.data.id as string;

    const suspended = await client
      .post(`/api/platform/tenants/${id}/status`)
      .set(originHeader)
      .send({
        status: "suspended",
        reason: "Tidak membayar tagihan bulan ini.",
      });
    expect(suspended.status).toBe(200);
    expect(suspended.body.data.status).toBe("suspended");

    const archived = await client
      .post(`/api/platform/tenants/${id}/status`)
      .set(originHeader)
      .send({ status: "archived", reason: "Tenant berhenti beroperasi." });
    expect(archived.status).toBe(200);

    const reopened = await client
      .post(`/api/platform/tenants/${id}/status`)
      .set(originHeader)
      .send({ status: "active", reason: "Mencoba membuka kembali arsip." });
    expect(reopened.status).toBe(409);
    expect(reopened.body.error.code).toBe("INVALID_TRANSITION");

    const pkg = await client
      .put(`/api/platform/tenants/${id}/package`)
      .set(originHeader)
      .send({
        plan: "outlet-dasar",
        featureFlags: { modules: ["pos"], integrationProviders: [] },
        limits: { ...limits, maxOutlets: 1 },
        reason: "Turun ke paket outlet dasar.",
      });
    expect(pkg.status).toBe(200);
    expect(pkg.body.data).toMatchObject({ plan: "outlet-dasar" });
    expect(pkg.body.data.featureFlags.modules).toEqual(["pos"]);

    // legend-bd95: each accepted change is audited on the tenant by the
    // signed-in Super Admin; the refused reopen wrote nothing.
    const audited = await owner.query<{
      action: string;
      actor_id: string;
      reason: string | null;
    }>(
      `SELECT event->>'action' AS action, event->>'actorId' AS actor_id,
              event->>'reason' AS reason
         FROM audit_logs
        WHERE tenant_id = $1 AND event->>'objectType' = 'tenant'
          AND event->>'action' <> 'tenant.created'
        ORDER BY id`,
      [id],
    );
    expect(audited.rows).toEqual([
      {
        action: "tenant.status_changed",
        actor_id: userId,
        reason: "Tidak membayar tagihan bulan ini.",
      },
      {
        action: "tenant.status_changed",
        actor_id: userId,
        reason: "Tenant berhenti beroperasi.",
      },
      {
        action: "tenant.package_changed",
        actor_id: userId,
        reason: "Turun ke paket outlet dasar.",
      },
    ]);
  });

  it("TEN-04 refuses a support session until MFA verification exists", async () => {
    const { client } = await adminClient();
    const response = await client
      .post(`/api/platform/tenants/${seededTenantId}/support-access`)
      .set(originHeader)
      .send({
        reason: "Memeriksa masalah data pelanggan di tenant ini.",
        durationMinutes: 60,
        accessMode: "read_only",
        mfaCode: "123456",
      });
    // The second factor is re-verified per request (TEN-04): "123456" matches
    // no enrolled factor, so no support session is opened. The enroll → verify
    // path is identity-mfa-api.test.ts.
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });
});

describe("Tenant organisation API", () => {
  it("TEN-06 Q39 creates a brand, legal entity and outlet (business day cutoff 04:00, audited change)", async () => {
    const { client } = await adminClient();

    const brandSlug = `brand-${randomBytes(4).toString("hex")}`;
    const brand = await client
      .post("/api/org/brands")
      .set(originHeader)
      .send({ slug: brandSlug, name: "Brand Uji", logoMediaId: null });
    expect(brand.status).toBe(201);
    expect(brand.body.data).toMatchObject({
      slug: brandSlug,
      primaryHostname: null,
    });

    const entity = await client
      .post("/api/org/legal-entities")
      .set(originHeader)
      .send({
        name: "PT Uji Isolasi",
        npwp: "01.234.567.8-901.000",
        isPkp: true,
        address: "Kota Bandung",
      });
    expect(entity.status).toBe(201);
    // NPWP never leaves the server: the response carries the last four digits.
    expect(entity.body.data.npwpLast4).toBe("1000");
    expect(JSON.stringify(entity.body)).not.toContain("01.234.567");

    // legend-1jxh8: jangan baca seluruh outlet tenant seed. Berkas lain menaruh
    // baris outlet lewat SQL mentah dengan jam buka `{}` (tidak lolos
    // openingHoursSchema), jadi daftar tenant-lebar melempar ZodError di
    // toOutlet. Daftar dibatasi ke brand milik tes ini.
    const brandOutletsUrl = `/api/org/outlets?limit=100&brandId=${brand.body.data.id}`;
    const before = await client.get(brandOutletsUrl);
    expect(before.status).toBe(200);
    expect(before.body.data).toEqual([]);

    const code = `UJI-${randomBytes(3).toString("hex")}`.toUpperCase();
    const outlet = await client
      .post("/api/org/outlets")
      .set(originHeader)
      .send({
        brandId: brand.body.data.id,
        legalEntityId: entity.body.data.id,
        code,
        name: "Outlet Uji",
        address: "Jl. Uji No. 1, Kota Bandung",
        regionId: null,
        geofence: null,
        timeZone: "Asia/Jakarta",
        openingHours: OPENING_HOURS,
      });
    expect(outlet.status).toBe(201);
    expect(outlet.body.data).toMatchObject({
      code,
      brandId: brand.body.data.id,
      legalEntityId: entity.body.data.id,
      status: "preopening",
    });
    expect(outlet.body.data.id).toMatch(/^[0-9a-f-]{36}$/);
    const after = await client.get(brandOutletsUrl);
    expect(after.status).toBe(200);
    expect(after.body.data.map((row: { id: string }) => row.id)).toEqual([
      outlet.body.data.id,
    ]);

    // Owner Q39: a new outlet starts its business day at 04:00 by default; the
    // admin may move it (audited) but only inside 00:00..11:59.
    expect(outlet.body.data.businessDayCutoff).toBe("04:00");
    const moved = await client
      .patch(`/api/org/outlets/${outlet.body.data.id}`)
      .set(originHeader)
      .send({ businessDayCutoff: "05:30" });
    expect(moved.status).toBe(200);
    expect(moved.body.data.businessDayCutoff).toBe("05:30");
    const audit = await owner.query<{
      event: { action: string; maskedChanges: unknown };
    }>(
      "SELECT event FROM audit_logs WHERE tenant_id = $1 AND outlet_id = $2 AND event->>'action' = 'outlet.business_day_cutoff.updated'",
      [seededTenantId, outlet.body.data.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.event.maskedChanges).toEqual({
      before: { businessDayCutoff: "04:00" },
      after: { businessDayCutoff: "05:30" },
    });
    for (const bad of ["12:00", "23:00", "4:00", "04:00:00"]) {
      const refused = await client
        .patch(`/api/org/outlets/${outlet.body.data.id}`)
        .set(originHeader)
        .send({ businessDayCutoff: bad });
      expect(refused.status).toBe(422);
    }
    // The DB check is the backstop for any writer that skips the contract.
    await expect(
      owner.query(
        "UPDATE outlets SET business_day_cutoff = '13:00' WHERE id = $1",
        [outlet.body.data.id],
      ),
    ).rejects.toThrow(/outlets_business_day_cutoff_check/);
  });

  it("TEN-02 rejects a client-supplied tenant on every org write", async () => {
    const { client } = await adminClient();
    // clientInputSchema refuses tenant fields: strict parse -> 422.
    expect(
      createBrandInputSchema.safeParse({
        slug: "brand-x",
        name: "Brand X",
        tenantId: seededTenantId,
      }).success,
    ).toBe(false);
    const response = await client
      .post("/api/org/brands")
      .set(originHeader)
      .send({ slug: "brand-y", name: "Brand Y", tenantId: seededTenantId });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    // A request without a resolved tenant is 404, never a guessed tenant.
    const anonymous = await agent(app).get("/api/org/brands");
    expect(anonymous.status).toBe(401);
  });

  it("TEN-03 an outlet-scoped context only reaches its own outlets", async () => {
    // legend-1jxh8: fixture sendiri (brand + entitas + 2 outlet berjam buka
    // valid) dan daftar dibatasi ke brand itu. Baris outlet berjam buka `{}`
    // dari berkas lain di tenant seed tidak ikut terbaca.
    const brandId = randomUUID();
    const entityId = randomUUID();
    const suffix = randomBytes(3).toString("hex").toUpperCase();
    await owner.query(
      `INSERT INTO brands (id, tenant_id, slug, name)
       VALUES ($1, $2, $3, 'Brand TEN-03')`,
      [brandId, seededTenantId, `ten03-${suffix.toLowerCase()}`],
    );
    await owner.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp)
       VALUES ($1, $2, 'Entitas TEN-03', false)`,
      [entityId, seededTenantId],
    );
    const outletIds = [randomUUID(), randomUUID()];
    for (const [index, outletId] of outletIds.entries())
      await owner.query(
        `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
         VALUES ($1, $2, $3, $4, $5, 'Outlet TEN-03', 'Jl. Uji', 'Asia/Jakarta', $6, 'active')`,
        [
          outletId,
          seededTenantId,
          brandId,
          entityId,
          `T03-${suffix}-${index + 1}`,
          JSON.stringify(OPENING_HOURS),
        ],
      );

    const tenantWide = scopedContext();
    const all = await listOutlets(tenantWide, { limit: 100, brandId });
    expect(all.data.map((outlet) => outlet.id).sort()).toEqual(
      [...outletIds].sort(),
    );
    const [first, second] = all.data;
    expect(first && second).toBeTruthy();

    const outletScoped = scopedContext([first!.id]);
    const scoped = await listOutlets(outletScoped, { limit: 100, brandId });
    expect(scoped.data.map((outlet) => outlet.id)).toEqual([first!.id]);

    await expect(
      updateOutlet(outletScoped, second!.id, { name: "Diubah" }, randomUUID()),
    ).rejects.toMatchObject({ code: "OUTLET_OUT_OF_SCOPE" });
    await expect(
      setOutletStatus(outletScoped, second!.id, {
        status: "active",
        reason: "Percobaan dari role yang hanya memegang outlet lain.",
      }),
    ).rejects.toMatchObject({ code: "OUTLET_OUT_OF_SCOPE" });
  });

  // legend-hb1u9 (1172): every accepted outlet status change writes exactly one
  // `outlet.status_changed` audit row, in the same transaction as the update;
  // a refused change (invalid transition, invalid body) leaves no audit row.
  // Assumption: the audit row follows the other outlet audits in this file
  // (objectType "outlet", objectId + audit_logs.outlet_id = the outlet, actorId
  // = signed-in user, reason, maskedChanges before/after holding only `status`).
  it("TEN-06 legend-hb1u9 audits an outlet status change once and a refused change not at all", async () => {
    const { client, userId } = await adminClient();
    const brandId = randomUUID();
    const entityId = randomUUID();
    const outletId = randomUUID();
    const suffix = randomBytes(3).toString("hex").toUpperCase();
    await owner.query(
      `INSERT INTO brands (id, tenant_id, slug, name)
       VALUES ($1, $2, $3, 'Brand Audit Status')`,
      [brandId, seededTenantId, `aud-st-${suffix.toLowerCase()}`],
    );
    await owner.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp)
       VALUES ($1, $2, 'Entitas Audit Status', false)`,
      [entityId, seededTenantId],
    );
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, 'Outlet Audit Status', 'Jl. Uji', 'Asia/Jakarta', $6, 'preopening')`,
      [
        outletId,
        seededTenantId,
        brandId,
        entityId,
        `AS-${suffix}`,
        JSON.stringify(OPENING_HOURS),
      ],
    );
    const statusAudits = () =>
      owner.query<{
        outlet_id: string | null;
        event: {
          action: string;
          actorId: string;
          reason: string | null;
          objectType: string;
          objectId: string;
          maskedChanges: {
            before: Record<string, unknown> | null;
            after: Record<string, unknown> | null;
          } | null;
        };
      }>(
        `SELECT outlet_id, event FROM audit_logs
          WHERE tenant_id = $1 AND outlet_id = $2
            AND event->>'action' = 'outlet.status_changed'
          ORDER BY id`,
        [seededTenantId, outletId],
      );

    expect((await statusAudits()).rows).toHaveLength(0);

    // Accepted change: preopening -> active writes one audit row.
    const activated = await client
      .post(`/api/org/outlets/${outletId}/status`)
      .set(originHeader)
      .send({ status: "active", reason: "Outlet siap dibuka untuk umum." });
    expect(activated.status).toBe(200);
    expect(activated.body.data.status).toBe("active");
    const afterActivate = await statusAudits();
    expect(afterActivate.rows).toHaveLength(1);
    expect(afterActivate.rows[0]!.outlet_id).toBe(outletId);
    expect(afterActivate.rows[0]!.event).toMatchObject({
      action: "outlet.status_changed",
      actorId: userId,
      objectType: "outlet",
      objectId: outletId,
      reason: "Outlet siap dibuka untuk umum.",
      maskedChanges: {
        before: { status: "preopening" },
        after: { status: "active" },
      },
    });

    // Accepted change: active -> closed writes a second, separate row.
    const closed = await client
      .post(`/api/org/outlets/${outletId}/status`)
      .set(originHeader)
      .send({ status: "closed", reason: "Outlet ditutup permanen." });
    expect(closed.status).toBe(200);
    expect(closed.body.data.status).toBe("closed");
    const afterClose = await statusAudits();
    expect(afterClose.rows).toHaveLength(2);
    expect(afterClose.rows[1]!.event).toMatchObject({
      actorId: userId,
      reason: "Outlet ditutup permanen.",
      maskedChanges: {
        before: { status: "active" },
        after: { status: "closed" },
      },
    });

    // Refused: closed is final through this endpoint (409 INVALID_TRANSITION).
    const reopened = await client
      .post(`/api/org/outlets/${outletId}/status`)
      .set(originHeader)
      .send({ status: "active", reason: "Mencoba membuka kembali outlet." });
    expect(reopened.status).toBe(409);
    expect(reopened.body.error.code).toBe("INVALID_TRANSITION");

    // Refused: invalid body (missing reason) is 422 and writes nothing.
    const invalid = await client
      .post(`/api/org/outlets/${outletId}/status`)
      .set(originHeader)
      .send({ status: "active" });
    expect(invalid.status).toBe(422);

    // Neither refusal wrote an audit row, and the status did not move.
    expect((await statusAudits()).rows).toHaveLength(2);
    const row = await owner.query<{ status: string }>(
      "SELECT status FROM outlets WHERE id = $1",
      [outletId],
    );
    expect(row.rows[0]!.status).toBe("closed");
  });

  // legend-hb1u9 (1172) atomicity: the audit row and the status update commit
  // together. Assumption: when the audit insert fails, the whole request fails
  // with a generic 500 and the outlet keeps its old status (no unaudited status
  // change). A trigger that raises on audit_logs inserts for this outlet only
  // simulates the failure; it is dropped in `finally`. A retry afterwards
  // (trigger gone) succeeds, which proves the trigger was the cause.
  it("TEN-06 legend-hb1u9 a failing audit write rolls the outlet status change back", async () => {
    const { client } = await adminClient();
    const brandId = randomUUID();
    const entityId = randomUUID();
    const outletId = randomUUID();
    const suffix = randomBytes(3).toString("hex");
    await owner.query(
      `INSERT INTO brands (id, tenant_id, slug, name)
       VALUES ($1, $2, $3, 'Brand Audit Atomik')`,
      [brandId, seededTenantId, `aud-at-${suffix}`],
    );
    await owner.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp)
       VALUES ($1, $2, 'Entitas Audit Atomik', false)`,
      [entityId, seededTenantId],
    );
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, 'Outlet Audit Atomik', 'Jl. Uji', 'Asia/Jakarta', $6, 'preopening')`,
      [
        outletId,
        seededTenantId,
        brandId,
        entityId,
        `AT-${suffix.toUpperCase()}`,
        JSON.stringify(OPENING_HOURS),
      ],
    );
    const statusOf = async () =>
      (
        await owner.query<{ status: string }>(
          "SELECT status FROM outlets WHERE id = $1",
          [outletId],
        )
      ).rows[0]!.status;
    const auditCount = async () =>
      Number(
        (
          await owner.query<{ n: string }>(
            `SELECT count(*) AS n FROM audit_logs
              WHERE tenant_id = $1 AND outlet_id = $2
                AND event->>'action' = 'outlet.status_changed'`,
            [seededTenantId, outletId],
          )
        ).rows[0]!.n,
      );

    const fnName = `fail_outlet_audit_${suffix}`;
    const triggerName = `fail_outlet_audit_trg_${suffix}`;
    await owner.query(
      `CREATE FUNCTION ${fnName}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         RAISE EXCEPTION 'simulated audit failure';
       END $$`,
    );
    await owner.query(
      `CREATE TRIGGER ${triggerName} BEFORE INSERT ON audit_logs
         FOR EACH ROW WHEN (NEW.outlet_id = '${outletId}')
         EXECUTE FUNCTION ${fnName}()`,
    );
    try {
      const failed = await client
        .post(`/api/org/outlets/${outletId}/status`)
        .set(originHeader)
        .send({ status: "active", reason: "Outlet siap dibuka untuk umum." });
      expect(failed.status).toBe(500);
      // The status did not move and no audit row exists.
      expect(await statusOf()).toBe("preopening");
      expect(await auditCount()).toBe(0);
    } finally {
      await owner.query(`DROP TRIGGER IF EXISTS ${triggerName} ON audit_logs`);
      await owner.query(`DROP FUNCTION IF EXISTS ${fnName}()`);
    }

    // Control: without the failing trigger the same request goes through, with
    // exactly one audit row.
    const retried = await client
      .post(`/api/org/outlets/${outletId}/status`)
      .set(originHeader)
      .send({ status: "active", reason: "Outlet siap dibuka untuk umum." });
    expect(retried.status).toBe(200);
    expect(await statusOf()).toBe("active");
    expect(await auditCount()).toBe(1);
  });

  it("TEN-04 gates tenant data behind an active support session and shows it to the tenant admin", async () => {
    const { client, userId } = await adminClient();
    await owner.query(
      "INSERT INTO platform_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [userId],
    );
    const requestBody = requestSupportAccessInputSchema.parse({
      reason: "Menelusuri keluhan pelanggan pada tenant ini.",
      durationMinutes: 60,
      accessMode: "read_only",
      mfaCode: "123456",
    });

    // Another Super Admin without a session reaches nothing personal.
    await expect(
      requireSupportAccess({
        tenantId: seededTenantId,
        actorUserId: randomUUID(),
        dataClass: "personal",
        intent: "read",
      }),
    ).rejects.toMatchObject({ code: "SUPPORT_ACCESS_REQUIRED" });

    const grant = await requestSupportAccess({
      tenantId: seededTenantId,
      actorUserId: userId,
      request: requestBody,
      mfaVerifiedAt: new Date().toISOString(),
    });
    expect(grant.tenantId).toBe(seededTenantId);
    expect(grant.accessMode).toBe("read_only");

    await expect(
      requireSupportAccess({
        tenantId: seededTenantId,
        actorUserId: userId,
        dataClass: "personal",
        intent: "read",
      }),
    ).resolves.toMatchObject({ id: grant.id });
    await expect(
      requireSupportAccess({
        tenantId: seededTenantId,
        actorUserId: userId,
        dataClass: "financial",
        intent: "write",
      }),
    ).rejects.toMatchObject({ code: "SUPPORT_ACCESS_READ_ONLY" });
    // Platform configuration is not gated by support access: a Super Admin
    // without any session still reads it (null = no grant to attribute).
    await expect(
      requireSupportAccess({
        tenantId: seededTenantId,
        actorUserId: randomUUID(),
        dataClass: "configuration",
        intent: "read",
      }),
    ).resolves.toBeNull();

    // "setiap sesi ... terlihat oleh admin tenant".
    const listed = await client.get("/api/org/support-access?limit=10");
    expect(listed.status).toBe(200);
    expect(listed.body.data.map((row: { id: string }) => row.id)).toContain(
      grant.id,
    );

    // A second open session for the same tenant is refused.
    await expect(
      requestSupportAccess({
        tenantId: seededTenantId,
        actorUserId: userId,
        request: requestBody,
        mfaVerifiedAt: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ code: "SUPPORT_ACCESS_ALREADY_ACTIVE" });

    // Ending the session keeps the row (history) and stamps who ended it.
    const ended = await client
      .post(
        `/api/platform/support-access/${grant.id}/end?tenantId=${seededTenantId}`,
      )
      .set(originHeader);
    expect(ended.status).toBe(200);
    expect(ended.body.data.endedAt).not.toBeNull();
    expect(ended.body.data.endedBy).toBe(userId);
    await expect(
      requireSupportAccess({
        tenantId: seededTenantId,
        actorUserId: userId,
        dataClass: "personal",
        intent: "read",
      }),
    ).rejects.toMatchObject({ code: "SUPPORT_ACCESS_REQUIRED" });
  });

  it("adds a custom domain, refuses a duplicate and removes it", async () => {
    const { client } = await adminClient();
    const brands = await client.get("/api/org/brands");
    expect(brands.status).toBe(200);
    const brandId = brands.body.data[0].id as string;
    const hostname = `uji-${randomBytes(3).toString("hex")}.example.com`;

    const created = await client
      .post("/api/org/domains")
      .set(originHeader)
      .send({ brandId, hostname });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      hostname,
      kind: "custom",
      tlsStatus: "pending",
      verifiedAt: null,
    });

    const duplicate = await client
      .post("/api/org/domains")
      .set(originHeader)
      .send({ brandId, hostname });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe("DOMAIN_TAKEN");

    const listed = await client.get("/api/org/domains");
    expect(
      listed.body.data.map((row: { hostname: string }) => row.hostname),
    ).toContain(hostname);

    expect(
      (
        await client
          .delete(`/api/org/domains/${created.body.data.id}`)
          .set(originHeader)
      ).status,
    ).toBe(204);
    const after = await client.get("/api/org/domains");
    expect(
      after.body.data.map((row: { hostname: string }) => row.hostname),
    ).not.toContain(hostname);
  });

  it("TEN-05 a switched-off module fails closed at the API", async () => {
    const probe = express();
    probe.use(
      developmentTenantContext({
        enabled: true,
        hasSession: async () => true,
        lookup: async () => ({ tenantId: seededTenantId, brandId: null }),
      }),
    );
    probe.get(
      "/probe",
      requireModuleEnabled("pos"),
      (_req, res) => void res.json({ ok: true }),
    );
    probe.use(errorHandler);

    const original = await owner.query(
      "SELECT feature_flags FROM tenants WHERE id = $1",
      [seededTenantId],
    );
    try {
      await owner.query(
        `UPDATE tenants SET feature_flags = '{"modules":["qr_order"],"integrationProviders":[]}' WHERE id = $1`,
        [seededTenantId],
      );
      const denied = await request(probe).get("/probe");
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe("FEATURE_DISABLED");

      // Malformed flags are also "off" (fail closed).
      await owner.query(
        `UPDATE tenants SET feature_flags = '{"modules":"pos"}' WHERE id = $1`,
        [seededTenantId],
      );
      expect((await request(probe).get("/probe")).status).toBe(403);
    } finally {
      await owner.query("UPDATE tenants SET feature_flags = $1 WHERE id = $2", [
        original.rows[0].feature_flags,
        seededTenantId,
      ]);
    }
    expect((await request(probe).get("/probe")).status).toBe(200);
  });
});
