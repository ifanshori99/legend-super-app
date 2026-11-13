// legend-bkdmc (WS-01 BE): install an uploaded `brand_logo` on a brand
// (brands.logo_media_id) and on a theme draft (tenant_themes.logo_media_id).
// Written from the shared contract and the coordinator's route brief:
// PUT /api/org/brands/:brandId/logo body {logoMediaId: uuid|null}, response
// {data:{id, logoMediaId}}, permission org.theme.manage; POST /api/org/themes
// takes `logoMediaId` for a draft. Storage purposes from
// the storage purposes (packages/shared/src/storage), not from the route code.
// Real Express app, Better Auth and PostgreSQL (RLS).
//
// Assumptions where the contract is silent:
// - theme drafts apply the same logo rule as the brand route (brand_logo of the
//   own tenant only).
// - a logo must be a `brand_logo` object (tenant level, outlet_id NULL) of the
//   caller's own tenant. A media id of another purpose (e.g. an own-tenant
//   `document`), of another tenant, or unknown is refused with 422
//   VALIDATION_ERROR, the same answer for all three (no existence oracle), and
//   the stored logo stays unchanged. Matches org-tenant-config-contracts.test.ts.
//   createBrand/updateBrand (PATCH/POST /api/org/brands) apply the same
//   `brand_logo` rule; org-tenant-config-contracts.test.ts and
//   org-brand-logo-media.test.ts cover them.
// - a role without `org.theme.manage` gets 403; another tenant's brand 404.
// - HTTP actors belong to the seeded tenant; the throwaway tenant B only owns
//   foreign rows.
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { createApp } from "../app.ts";
import { setBrandLogo } from "../services/platform-brand.service.ts";
import { agent, originHeader } from "./helpers.ts";
import {
  createTestTenant,
  removeTestTenant,
  storedMedia,
  type TestTenant,
} from "./platform-theme-helpers.ts";
import {
  cleanupMembers,
  memberOf,
  memberWith,
  owner,
  seededTenantId,
  type Member,
} from "./ws01-brand-config-helpers.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const app: Express = createApp();
let tenantB: TestTenant;
const createdBrands: string[] = [];
const createdMedia: string[] = [];

/** Tenant-level `brand_logo` object (outlet_id NULL), as the upload route stores it. */
async function brandLogoMedia(tenantId: string): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO core_storage_objects (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes)
     VALUES ($1, NULL, $2, 'brand_logo', $3, 'image/webp', 1024)`,
    [tenantId, id, `ws01-bkdmc/${id}.webp`],
  );
  if (tenantId === seededTenantId) createdMedia.push(id);
  return id;
}

/** Own-tenant media that is NOT a brand logo (purpose `document`, in an outlet). */
async function ownDocumentMedia(brandId: string): Promise<string> {
  const id = await storedMedia({
    ...tenantB,
    tenantId: seededTenantId,
    brandId,
  });
  createdMedia.push(id);
  return id;
}

async function newBrand(admin: Member): Promise<string> {
  const created = await admin.client
    .post("/api/org/brands")
    .set(originHeader)
    .send({ slug: `bkdmc-${randomUUID().slice(0, 8)}`, name: "Brand bkdmc" });
  expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
  const brandId = created.body.data.id as string;
  createdBrands.push(brandId);
  return brandId;
}

const patchBrand = (m: Member, brandId: string, body: object) =>
  m.client.put(`/api/org/brands/${brandId}/logo`).set(originHeader).send(body);

const draftBody = (brandId: string, logoMediaId: string | null) => ({
  brandId,
  tokens: { light: {}, dark: {} },
  logoMediaId,
  fontFamily: "inter",
  corners: "lembut",
});
const postDraft = (m: Member, body: object) =>
  m.client.post("/api/org/themes").set(originHeader).send(body);

const brandLogo = async (brandId: string) =>
  (
    await owner.query<{ logo_media_id: string | null }>(
      "SELECT logo_media_id FROM brands WHERE id = $1",
      [brandId],
    )
  ).rows[0]!.logo_media_id;
const themeRows = async (brandId: string) =>
  (
    await owner.query<{ id: string; logo_media_id: string | null }>(
      "SELECT id, logo_media_id FROM tenant_themes WHERE brand_id = $1",
      [brandId],
    )
  ).rows;

beforeAll(async () => {
  tenantB = await createTestTenant("ws01-logo-b");
});

afterAll(async () => {
  for (const brandId of createdBrands) {
    const legalEntities = await owner
      .query<{ legal_entity_id: string }>(
        "SELECT legal_entity_id FROM outlets WHERE brand_id = $1",
        [brandId],
      )
      .then((r) => r.rows.map((row) => row.legal_entity_id))
      .catch(() => [] as string[]);
    await owner
      .query(
        "DELETE FROM core_storage_objects WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [seededTenantId, createdMedia],
      )
      .catch(() => undefined);
    for (const [sql, params] of [
      ["UPDATE brands SET theme_id = NULL WHERE id = $1", [brandId]],
      ["DELETE FROM tenant_themes WHERE brand_id = $1", [brandId]],
      ["DELETE FROM outlets WHERE brand_id = $1", [brandId]],
      [
        "DELETE FROM legal_entities WHERE id = ANY($1::uuid[])",
        [legalEntities],
      ],
      ["DELETE FROM brands WHERE id = $1", [brandId]],
    ] as [string, unknown[]][])
      await owner.query(sql, params).catch(() => undefined);
  }
  await cleanupMembers();
  await removeTestTenant(tenantB);
  await owner.end();
});

const refused = { status: 422, code: "VALIDATION_ERROR" };

describe("legend-bkdmc brand logo: PUT /api/org/brands/:brandId/logo", () => {
  it("installs the tenant's own brand_logo upload, null clears it", async () => {
    const admin = await memberOf(app, "tenant_admin");
    const brandId = await newBrand(admin);
    const mediaId = await brandLogoMedia(seededTenantId);
    const set = await patchBrand(admin, brandId, { logoMediaId: mediaId });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.data.logoMediaId).toBe(mediaId);
    expect(await brandLogo(brandId)).toBe(mediaId);
    const cleared = await patchBrand(admin, brandId, { logoMediaId: null });
    expect(cleared.status).toBe(200);
    expect(await brandLogo(brandId)).toBeNull();
  });

  it("records a brand.logo_set audit event with the before and after logo", async () => {
    const admin = await memberOf(app, "tenant_admin");
    const brandId = await newBrand(admin);
    const mediaId = await brandLogoMedia(seededTenantId);
    const set = await patchBrand(admin, brandId, { logoMediaId: mediaId });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const { rows } = await owner.query<{
      event: {
        actorId: string;
        maskedChanges: {
          before: { logoMediaId: string | null };
          after: { logoMediaId: string | null };
        };
      };
    }>(
      `SELECT event FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = 'brand.logo_set'
          AND event->>'objectId' = $2`,
      [seededTenantId, brandId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event.actorId).toBe(admin.userId);
    expect(rows[0]!.event.maskedChanges.before.logoMediaId).toBeNull();
    expect(rows[0]!.event.maskedChanges.after.logoMediaId).toBe(mediaId);
  });

  it("refuses an outlet-scoped context with PERMISSION_DENIED, logo unchanged", async () => {
    const admin = await memberOf(app, "tenant_admin");
    const brandId = await newBrand(admin);
    const mediaId = await brandLogoMedia(seededTenantId);
    const scoped = establishScopedTenantContext(
      establishTenantContext({
        tenantId: seededTenantId,
        brandId: null,
        source: "session",
      }),
      { kind: "outlets", outletIds: [outletIdSchema.parse(randomUUID())] },
    );
    await expect(
      setBrandLogo(scoped, brandId, { logoMediaId: mediaId }, admin.userId),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(await brandLogo(brandId)).toBeNull();
  });

  it("refuses an own-tenant media id that is not a brand_logo (422), logo unchanged", async () => {
    const admin = await memberOf(app, "tenant_admin");
    const brandId = await newBrand(admin);
    const own = await brandLogoMedia(seededTenantId);
    await patchBrand(admin, brandId, { logoMediaId: own });
    const document = await ownDocumentMedia(brandId);
    const response = await patchBrand(admin, brandId, {
      logoMediaId: document,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(refused.status);
    expect(response.body.error.code).toBe(refused.code);
    expect(await brandLogo(brandId)).toBe(own);
  });

  it("refuses another tenant's brand_logo and an unknown id (422), logo unchanged", async () => {
    const admin = await memberOf(app, "tenant_admin");
    const brandId = await newBrand(admin);
    const own = await brandLogoMedia(seededTenantId);
    await patchBrand(admin, brandId, { logoMediaId: own });
    const foreign = await brandLogoMedia(tenantB.tenantId);
    for (const logoMediaId of [foreign, randomUUID()]) {
      const response = await patchBrand(admin, brandId, { logoMediaId });
      expect(response.status, String(logoMediaId)).toBe(refused.status);
      expect(response.body.error.code).toBe(refused.code);
    }
    expect(await brandLogo(brandId)).toBe(own);
  });

  it("a role without org.theme.manage gets 403, another tenant's brand is 404, no session is 401", async () => {
    const admin = await memberOf(app, "tenant_admin");
    const brandId = await newBrand(admin);
    const media = await brandLogoMedia(seededTenantId);
    const noTheme = await memberWith(app, seededTenantId, [
      "org.config.export",
    ]);
    const denied = await patchBrand(noTheme, brandId, { logoMediaId: media });
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(await brandLogo(brandId)).toBeNull();

    const crossed = await patchBrand(admin, tenantB.brandId, {
      logoMediaId: null,
    });
    expect(crossed.status).toBe(404);

    const anonymous = await agent(app)
      .put(`/api/org/brands/${brandId}/logo`)
      .set(originHeader)
      .send({ logoMediaId: null });
    expect(anonymous.status).toBe(401);
  });
});

describe("legend-bkdmc theme logo: POST /api/org/themes logoMediaId", () => {
  it("stores the tenant's own brand_logo upload on the draft", async () => {
    const admin = await memberOf(app, "tenant_admin");
    const brandId = await newBrand(admin);
    const mediaId = await brandLogoMedia(seededTenantId);
    const response = await postDraft(admin, draftBody(brandId, mediaId));
    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
    expect(response.body.data.logoMediaId).toBe(mediaId);
    expect((await themeRows(brandId)).map((row) => row.logo_media_id)).toEqual([
      mediaId,
    ]);
  });

  it("refuses an own-tenant media id that is not a brand_logo (422), no draft stored", async () => {
    const admin = await memberOf(app, "tenant_admin");
    const brandId = await newBrand(admin);
    const document = await ownDocumentMedia(brandId);
    const response = await postDraft(admin, draftBody(brandId, document));
    expect(response.status, JSON.stringify(response.body)).toBe(refused.status);
    expect(response.body.error.code).toBe(refused.code);
    expect(await themeRows(brandId)).toHaveLength(0);
  });

  it("refuses another tenant's brand_logo and an unknown id (422), no draft stored", async () => {
    const admin = await memberOf(app, "tenant_admin");
    const brandId = await newBrand(admin);
    const foreign = await brandLogoMedia(tenantB.tenantId);
    for (const logoMediaId of [foreign, randomUUID()]) {
      const response = await postDraft(admin, draftBody(brandId, logoMediaId));
      expect(response.status, String(logoMediaId)).toBe(refused.status);
      expect(response.body.error.code).toBe(refused.code);
    }
    expect(await themeRows(brandId)).toHaveLength(0);
  });

  it("a role without org.theme.manage gets 403 and no draft is stored", async () => {
    const admin = await memberOf(app, "tenant_admin");
    const brandId = await newBrand(admin);
    const media = await brandLogoMedia(seededTenantId);
    const noTheme = await memberWith(app, seededTenantId, [
      "org.config.export",
    ]);
    const denied = await postDraft(noTheme, draftBody(brandId, media));
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(await themeRows(brandId)).toHaveLength(0);
  });

  it("a draft for another tenant's brand is refused and stores nothing", async () => {
    const admin = await memberOf(app, "tenant_admin");
    const media = await brandLogoMedia(seededTenantId);
    const response = await postDraft(admin, draftBody(tenantB.brandId, media));
    expect(
      response.status,
      JSON.stringify(response.body),
    ).toBeGreaterThanOrEqual(400);
    expect(await themeRows(tenantB.brandId)).toHaveLength(0);
  });
});
