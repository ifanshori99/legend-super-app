// SOP media (legend-m7yeb, 1087 kartu 2) against PostgreSQL with the restricted
// app role: media get their own source kind `sop_document` and a link table
// `sop_document_media` that binds each SOP version to its media. Legacy media
// (document objects with no source kind, attached before this change) stay
// readable and are carried to a new version as they are. New media are
// tenant- and outlet-bound.
//
// Assumptions (spec is the card, not a PRD page):
// - a legacy object is carried only when the previous version already lists it
//   in `media_ids`; as NEW media an unclassified object stays refused;
// - every refusal is 422 SOP_MEDIA_NOT_FOUND (ids are not probeable);
// - an actor who lost the outlet's manage code is refused, either by the SOP
//   gate (403) or by the media rule (422): both are accepted, what matters is
//   that nothing gets linked.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import type {
  CreateSopDocumentInput,
  PublishSopVersionInput,
} from "@starter/shared/hris";
import {
  createSopDocument,
  publishSopVersion,
} from "../services/hris-sop.service.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[0].id);
const outletB = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[1].id);
const otherTenant = randomUUID();

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdStations: string[] = [];
const createdStorage: string[] = [];

const base = (tenant: string = tenantId) =>
  establishTenantContext({
    tenantId: tenant,
    brandId: null,
    source: "session",
  });
const tenantScope = (tenant: string = tenantId) =>
  establishScopedTenantContext(base(tenant), { kind: "tenant" });
const outletScope = (outletId: string) =>
  establishScopedTenantContext(base(), {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(outletId)],
  });

async function asOwner<T>(
  tenant: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
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

async function newUser(): Promise<string> {
  const userId = randomUUID();
  createdUsers.push(userId);
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'SOP media', $2)`,
    [userId, `${userId}@example.test`],
  );
  return userId;
}

async function grantRole(
  userId: string,
  scope: { type: "tenant" } | { type: "outlet"; id: string },
  tenant: string = tenantId,
  validToPast = false,
) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asOwner(tenant, async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant,
        `SOP media ${roleId.slice(0, 8)}`,
        JSON.stringify(["hr.sop.manage"]),
        JSON.stringify([scope.type]),
      ],
    );
    await client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, valid_to, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '2 days', $6, $2)`,
      [
        tenant,
        userId,
        roleId,
        scope.type,
        scope.type === "outlet" ? scope.id : null,
        validToPast ? new Date(Date.now() - 3_600_000).toISOString() : null,
      ],
    );
  });
}

async function actor(
  scope: { type: "tenant" } | { type: "outlet"; id: string },
  tenant: string = tenantId,
): Promise<string> {
  const userId = await newUser();
  await grantRole(userId, scope, tenant);
  return userId;
}

async function seedStation(outletId: string): Promise<string> {
  const id = randomUUID();
  createdStations.push(id);
  await asOwner(tenantId, (client) =>
    client.query(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type)
       VALUES ($1, $2, $3, $4, 'coffee_bar')`,
      [id, tenantId, outletId, `SOP media ${id.slice(0, 8)}`],
    ),
  );
  return id;
}

type Stored = {
  /** null = legacy object with no source kind. */
  sourceKind?: string | null;
  outletId?: string | null;
  tenant?: string;
  ownerUserId: string | null;
  uploadedBy?: string | null;
  sourceId?: string | null;
  purpose?: "document" | "receipt";
};

async function stored(input: Stored): Promise<string> {
  const id = randomUUID();
  const tenant = input.tenant ?? tenantId;
  if (tenant === tenantId) createdStorage.push(id);
  await asOwner(tenant, (client) =>
    client.query(
      `INSERT INTO core_storage_objects
         (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes,
          source_kind, owner_user_id, uploaded_by, source_id)
       VALUES ($1, $2, $3, $4, $5, 'image/webp', 1024, $6, $7, $8, $9)`,
      [
        tenant,
        input.outletId === undefined ? outletA : input.outletId,
        id,
        input.purpose ?? "document",
        `private/${tenant}/${id}.webp`,
        input.sourceKind === undefined ? "sop_document" : input.sourceKind,
        input.ownerUserId,
        input.uploadedBy === undefined ? input.ownerUserId : input.uploadedBy,
        input.sourceId ?? null,
      ],
    ),
  );
  return id;
}

/** A SOP version published before 1087: media_ids only, no link rows. */
async function seedLegacySop(
  publishedBy: string,
  mediaIds: string[],
  stationId: string | null = null,
): Promise<string> {
  const id = randomUUID();
  await asOwner(tenantId, (client) =>
    client.query(
      `INSERT INTO sop_documents
         (id, tenant_id, lineage_id, version, station_id, title, body, media_ids,
          requires_acknowledgement, effective_from, published_by)
       VALUES ($1, $2, $1, 1, $3, 'SOP lama', 'Isi lama', $4, false, '2026-01-01', $5)`,
      [id, tenantId, stationId, mediaIds, publishedBy],
    ),
  );
  return id;
}

async function linkRows(sopDocumentId: string) {
  const { rows } = await asOwner(tenantId, (client) =>
    client.query<{ media_id: string; sort_order: number; legacy: boolean }>(
      `SELECT media_id, sort_order, legacy FROM sop_document_media
        WHERE tenant_id = $1 AND sop_document_id = $2 ORDER BY sort_order`,
      [tenantId, sopDocumentId],
    ),
  );
  return rows;
}

async function objectRow(objectId: string) {
  const { rows } = await asOwner(tenantId, (client) =>
    client.query<{ source_kind: string | null; source_id: string | null }>(
      `SELECT source_kind, source_id FROM core_storage_objects
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, objectId],
    ),
  );
  return rows[0];
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code?: string; status?: number };
  }
  throw new Error("Expected the call to fail");
}

const content = (overrides: Record<string, unknown> = {}) => ({
  title: "Lampiran SOP",
  body: "Langkah kerja.",
  mediaIds: [] as string[],
  requiresAcknowledgement: false,
  effectiveFrom: "2026-02-01",
  ...overrides,
});
const createInput = (overrides: Record<string, unknown> = {}) =>
  ({
    ...content(),
    stationId: null,
    positionId: null,
    ...overrides,
  }) as CreateSopDocumentInput;
const versionInput = (overrides: Record<string, unknown> = {}) =>
  content(overrides) as PublishSopVersionInput;

let hr: string; // tenant-wide hr.sop.manage
let managerA: string; // hr.sop.manage at outlet A
let hrOther: string; // hr.sop.manage in another tenant
let stationA: string;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'SOP media tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenant, `sop-media-${otherTenant.slice(0, 8)}`, tenantId],
  );
  hr = await actor({ type: "tenant" });
  managerA = await actor({ type: "outlet", id: outletA });
  hrOther = await actor({ type: "tenant" }, otherTenant);
  stationA = await seedStation(outletA);
});

afterAll(async () => {
  await asOwner(tenantId, async (client) => {
    await client.query(
      `DELETE FROM sop_document_media WHERE tenant_id = $1
         AND sop_document_id IN (SELECT id FROM sop_documents WHERE tenant_id = $1 AND published_by = ANY($2))`,
      [tenantId, createdUsers],
    );
    await client.query(
      "DELETE FROM sop_documents WHERE tenant_id = $1 AND published_by = ANY($2)",
      [tenantId, createdUsers],
    );
    await client.query(
      "DELETE FROM stations WHERE tenant_id = $1 AND id = ANY($2)",
      [tenantId, createdStations],
    );
    await client.query(
      "DELETE FROM core_storage_objects WHERE tenant_id = $1 AND id = ANY($2)",
      [tenantId, createdStorage],
    );
    await client.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
      [tenantId, createdUsers],
    );
    await client.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)",
      [tenantId, createdRoles],
    );
  });
  await asOwner(otherTenant, async (client) => {
    await client.query("DELETE FROM sop_document_media WHERE tenant_id = $1", [
      otherTenant,
    ]);
    await client.query("DELETE FROM sop_documents WHERE tenant_id = $1", [
      otherTenant,
    ]);
    await client.query("DELETE FROM role_assignments WHERE tenant_id = $1", [
      otherTenant,
    ]);
    await client.query("DELETE FROM roles WHERE tenant_id = $1", [otherTenant]);
    await client.query(
      "DELETE FROM core_storage_objects WHERE tenant_id = $1",
      [otherTenant],
    );
  });
  await owner
    .query("DELETE FROM tenants WHERE id = $1", [otherTenant])
    .catch(() => undefined);
  await owner
    .query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers])
    .catch(() => undefined);
  await owner.end();
});

describe("SOP media: legacy media carried to a new version", () => {
  it("publishing v2 keeps v1's legacy media (was 422) and records it as legacy", async () => {
    const legacy = await stored({ sourceKind: null, ownerUserId: hr });
    const v1Id = await seedLegacySop(hr, [legacy]);
    const v2 = await publishSopVersion(
      tenantScope(),
      hr,
      v1Id,
      versionInput({ mediaIds: [legacy] }),
    );
    expect(v2.version).toBe(2);
    expect(v2.mediaIds).toEqual([legacy]);
    expect(await linkRows(v2.id)).toEqual([
      { media_id: legacy, sort_order: 0, legacy: true },
    ]);
    // Never relinked: the object keeps no source kind.
    expect(await objectRow(legacy)).toEqual({
      source_kind: null,
      source_id: null,
    });
  });

  it("a different manager can carry the legacy media, and v1 stays untouched", async () => {
    const legacy = await stored({
      sourceKind: null,
      outletId: outletA,
      ownerUserId: hr,
    });
    const v1Id = await seedLegacySop(hr, [legacy], stationA);
    const v2 = await publishSopVersion(
      outletScope(outletA),
      managerA,
      v1Id,
      versionInput({ mediaIds: [legacy] }),
    );
    expect(v2.mediaIds).toEqual([legacy]);
    expect(await linkRows(v1Id)).toEqual([]);
  });

  it("a legacy object the previous version did not carry is refused as new media", async () => {
    const legacy = await stored({ sourceKind: null, ownerUserId: hr });
    const v1 = await createSopDocument(
      tenantScope(),
      hr,
      createInput({ title: "Tanpa lampiran" }),
    );
    const error = await failure(
      publishSopVersion(
        tenantScope(),
        hr,
        v1.id,
        versionInput({ mediaIds: [legacy] }),
      ),
    );
    expect(error.status).toBe(422);
    expect(error.code).toBe("SOP_MEDIA_NOT_FOUND");
  });

  it("legacy media dropped in v2 cannot be added back in v3 as new media", async () => {
    const legacy = await stored({ sourceKind: null, ownerUserId: hr });
    const v1Id = await seedLegacySop(hr, [legacy]);
    const v2 = await publishSopVersion(
      tenantScope(),
      hr,
      v1Id,
      versionInput({ mediaIds: [] }),
    );
    const error = await failure(
      publishSopVersion(
        tenantScope(),
        hr,
        v2.id,
        versionInput({ mediaIds: [legacy] }),
      ),
    );
    expect(error.status).toBe(422);
    expect(error.code).toBe("SOP_MEDIA_NOT_FOUND");
  });
});

describe("SOP media: new media are linked", () => {
  it("creating a SOP links a sop_document upload to the version and the lineage", async () => {
    const first = await stored({ ownerUserId: hr });
    const second = await stored({ ownerUserId: hr });
    const v1 = await createSopDocument(
      tenantScope(),
      hr,
      createInput({ mediaIds: [first, second], title: "Dua lampiran" }),
    );
    expect(v1.mediaIds).toEqual([first, second]);
    expect(await linkRows(v1.id)).toEqual([
      { media_id: first, sort_order: 0, legacy: false },
      { media_id: second, sort_order: 1, legacy: false },
    ]);
    expect(await objectRow(first)).toEqual({
      source_kind: "sop_document",
      source_id: v1.lineageId,
    });
  });

  it("v2 carries v1's linked media for another manager and links its own new upload", async () => {
    const carried = await stored({ outletId: outletA, ownerUserId: managerA });
    const v1 = await createSopDocument(
      outletScope(outletA),
      managerA,
      createInput({
        stationId: stationA,
        mediaIds: [carried],
        title: "Lintas versi",
      }),
    );
    const second = await actor({ type: "outlet", id: outletA });
    const fresh = await stored({ outletId: outletA, ownerUserId: second });
    const v2 = await publishSopVersion(
      outletScope(outletA),
      second,
      v1.id,
      versionInput({ mediaIds: [carried, fresh] }),
    );
    expect(v2.mediaIds).toEqual([carried, fresh]);
    expect(await linkRows(v2.id)).toEqual([
      { media_id: carried, sort_order: 0, legacy: false },
      { media_id: fresh, sort_order: 1, legacy: false },
    ]);
    expect((await objectRow(fresh)).source_id).toBe(v1.lineageId);
  });

  it("media of another SOP lineage is refused", async () => {
    const mine = await stored({ ownerUserId: hr });
    await createSopDocument(
      tenantScope(),
      hr,
      createInput({ mediaIds: [mine], title: "SOP pemilik media" }),
    );
    const error = await failure(
      createSopDocument(
        tenantScope(),
        hr,
        createInput({ mediaIds: [mine], title: "SOP pencuri media" }),
      ),
    );
    expect(error.status).toBe(422);
    expect(error.code).toBe("SOP_MEDIA_NOT_FOUND");
  });

  it("another user's upload, a receipt and an HR file are refused", async () => {
    const theirs = await stored({ ownerUserId: managerA });
    const receipt = await stored({
      ownerUserId: hr,
      purpose: "receipt",
      sourceKind: null,
    });
    const hrFile = await stored({
      ownerUserId: hr,
      sourceKind: "employee_document",
    });
    for (const mediaId of [theirs, receipt, hrFile]) {
      const error = await failure(
        createSopDocument(
          tenantScope(),
          hr,
          createInput({ mediaIds: [mediaId], title: "Ditolak" }),
        ),
      );
      expect(error.status).toBe(422);
      expect(error.code).toBe("SOP_MEDIA_NOT_FOUND");
    }
  });
});

describe("SOP media: tenant and outlet isolation", () => {
  it("media of another tenant is refused as 422 on create and on a new version", async () => {
    const foreign = await stored({
      tenant: otherTenant,
      ownerUserId: hrOther,
      outletId: null,
    });
    const created = await failure(
      createSopDocument(
        tenantScope(),
        hr,
        createInput({ mediaIds: [foreign], title: "Lintas tenant" }),
      ),
    );
    expect(created.status).toBe(422);
    expect(created.code).toBe("SOP_MEDIA_NOT_FOUND");
    const v1 = await createSopDocument(
      tenantScope(),
      hr,
      createInput({ title: "Versi lintas tenant" }),
    );
    const published = await failure(
      publishSopVersion(
        tenantScope(),
        hr,
        v1.id,
        versionInput({ mediaIds: [foreign] }),
      ),
    );
    expect(published.status).toBe(422);
    expect(published.code).toBe("SOP_MEDIA_NOT_FOUND");
    expect(await linkRows(v1.id)).toEqual([]);
  });

  it("an outlet SOP refuses media stored at another outlet, on create and on a new version", async () => {
    const atB = await stored({ outletId: outletB, ownerUserId: managerA });
    const refused = await failure(
      createSopDocument(
        outletScope(outletA),
        managerA,
        createInput({
          stationId: stationA,
          mediaIds: [atB],
          title: "Media outlet lain",
        }),
      ),
    );
    expect(refused.status).toBe(422);
    expect(refused.code).toBe("SOP_MEDIA_NOT_FOUND");
    const v1 = await createSopDocument(
      outletScope(outletA),
      managerA,
      createInput({ stationId: stationA, title: "Outlet A tanpa media" }),
    );
    const atB2 = await stored({ outletId: outletB, ownerUserId: managerA });
    const refusedVersion = await failure(
      publishSopVersion(
        outletScope(outletA),
        managerA,
        v1.id,
        versionInput({ mediaIds: [atB2] }),
      ),
    );
    expect(refusedVersion.status).toBe(422);
    expect(refusedVersion.code).toBe("SOP_MEDIA_NOT_FOUND");
    expect(await objectRow(atB)).toEqual({
      source_kind: "sop_document",
      source_id: null,
    });
  });

  it("a tenant-wide SOP takes media from any outlet the publisher manages, not an outlet-less object", async () => {
    const atB = await stored({ outletId: outletB, ownerUserId: hr });
    const ok = await createSopDocument(
      tenantScope(),
      hr,
      createInput({ mediaIds: [atB], title: "Tenant-wide media outlet B" }),
    );
    expect(ok.mediaIds).toEqual([atB]);
    const noOutlet = await stored({ outletId: null, ownerUserId: hr });
    const refused = await failure(
      createSopDocument(
        tenantScope(),
        hr,
        createInput({ mediaIds: [noOutlet], title: "Tanpa outlet" }),
      ),
    );
    expect(refused.status).toBe(422);
    expect(refused.code).toBe("SOP_MEDIA_NOT_FOUND");
  });

  it("an actor whose access to the media's outlet ended cannot attach it", async () => {
    // Manager of A and B uploads at B, then the B assignment ends.
    const manager = await newUser();
    await grantRole(manager, { type: "outlet", id: outletA });
    await grantRole(manager, { type: "outlet", id: outletB }, tenantId, true);
    const atB = await stored({ outletId: outletB, ownerUserId: manager });
    const v1 = await createSopDocument(
      outletScope(outletA),
      manager,
      createInput({ stationId: stationA, title: "Akses B berakhir" }),
    );
    const error = await failure(
      publishSopVersion(
        outletScope(outletB),
        manager,
        v1.id,
        versionInput({ mediaIds: [atB] }),
      ),
    );
    expect([403, 404, 422]).toContain(error.status);
    expect(await linkRows(v1.id)).toEqual([]);
    expect((await objectRow(atB)).source_id).toBeNull();
  });
});
