import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import sharp from "sharp";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { outletIdSchema } from "@starter/shared/core";
import * as schema from "../db/schema";
import { withTenant } from "../db/tenant";
import { NoopMalwareScanner } from "../services/core-image";
import {
  linkStorageObjectSource,
  uploadStorage,
} from "../services/core-storage";

const pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 1,
});
const db = drizzle(pool, { schema });
const context = (tenantId: string) =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );

/** Owner-seeded tenant with one outlet; the storage FK needs a real outlet. */
async function seedOutlet() {
  const [tenantId, brandId, legalEntityId, outletId] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  const tag = tenantId.slice(0, 8);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Uji Storage', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', $3, $4)`,
    [
      tenantId,
      `uji-storage-${tag}`,
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
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'uji', 'Uji')",
    [brandId, tenantId],
  );
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)",
    [legalEntityId, tenantId],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
     VALUES ($1, $2, $3, $4, 'U-01', 'Outlet Uji', 'Jl. Uji', '{}')`,
    [outletId, tenantId, brandId, legalEntityId],
  );
  return { tenantId, outletId };
}

let a: Awaited<ReturnType<typeof seedOutlet>>;
let b: Awaited<ReturnType<typeof seedOutlet>>;
beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  a = await seedOutlet();
  b = await seedOutlet();
});
afterAll(async () => {
  await pool.end();
  await owner.end();
});

const png = () =>
  sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } })
    .png()
    .toBuffer();

/** Seeds a stored object through the owner pool, bypassing the service. */
async function seedObject(
  tenant: { tenantId: string; outletId: string },
  columns: {
    purpose: string;
    ownerUserId?: string | null;
    sourceKind?: string | null;
    sourceId?: string | null;
  },
) {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO core_storage_objects
       (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes, owner_user_id, source_kind, source_id)
     VALUES ($1, $2, $3, $4, $5, 'image/webp', 1, $6, $7, $8)`,
    [
      tenant.tenantId,
      tenant.outletId,
      id,
      columns.purpose,
      `${id}/original.webp`,
      columns.ownerUserId ?? null,
      columns.sourceKind ?? null,
      columns.sourceId ?? null,
    ],
  );
  return id;
}

async function readObject(tenantId: string, id: string) {
  const { rows } = await owner.query(
    `SELECT owner_user_id, source_kind, source_id FROM core_storage_objects
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return rows[0] as {
    owner_user_id: string | null;
    source_kind: string | null;
    source_id: string | null;
  };
}

const link = (
  tenantId: string,
  input: {
    objectId: string;
    sourceKind: "reimbursement" | "expense" | "attendance";
    sourceId: string;
    actorUserId: string;
    ownerUserId?: string;
    /** Defaults to tenant a's outlet, where `seedObject(a, ...)` puts objects. */
    outletId?: string;
  },
) =>
  withTenant(db, context(tenantId), (tx) =>
    linkStorageObjectSource(tx, {
      tenantId,
      outletId: a.outletId,
      ...input,
    }),
  );

const CANNOT_ATTACH = "The file cannot be attached here.";

it("legend-ruf rejects unauthorized uploads before writing objects", async () => {
  const input = {
    purpose: "menu_photo" as const,
    outletId: outletIdSchema.parse(randomUUID()),
  };
  const authorize = vi.fn(async () => false);
  const storage = new FakeObjectStorage();
  const put = vi.spyOn(storage, "put");
  await expect(
    uploadStorage(db, context(randomUUID()), input, await png(), {
      storage,
      scanner: new NoopMalwareScanner(),
      authorize,
      actorUserId: randomUUID(),
    }),
  ).rejects.toThrow();
  // The authorizer sees the resolved kind (menu_photo defaults to menu_item).
  expect(authorize).toHaveBeenCalledWith(
    "upload",
    "menu_photo",
    input.outletId,
    { sourceKind: "menu_item" },
  );
  expect(put).not.toHaveBeenCalled();
});

it("legend-pszrm upload stores the actor as owner and defaults selfie to attendance", async () => {
  const actorUserId = `user-${randomUUID()}`;
  const authorize = vi.fn(async () => true);
  const stored = await uploadStorage(
    db,
    context(a.tenantId),
    { purpose: "selfie", outletId: outletIdSchema.parse(a.outletId) },
    await png(),
    {
      storage: new FakeObjectStorage(),
      scanner: new NoopMalwareScanner(),
      authorize,
      actorUserId,
    },
  );
  expect(authorize).toHaveBeenCalledWith("upload", "selfie", a.outletId, {
    sourceKind: "attendance",
  });
  expect(await readObject(a.tenantId, stored.id)).toEqual({
    owner_user_id: actorUserId,
    source_kind: "attendance",
    source_id: null,
  });
});

it("legend-pszrm upload of a receipt without a kind stores a null source kind", async () => {
  const actorUserId = `user-${randomUUID()}`;
  const authorize = vi.fn(async () => true);
  const stored = await uploadStorage(
    db,
    context(a.tenantId),
    { purpose: "receipt", outletId: outletIdSchema.parse(a.outletId) },
    await png(),
    {
      storage: new FakeObjectStorage(),
      scanner: new NoopMalwareScanner(),
      authorize,
      actorUserId,
    },
  );
  expect(authorize).toHaveBeenCalledWith("upload", "receipt", a.outletId, {
    sourceKind: null,
  });
  expect(await readObject(a.tenantId, stored.id)).toEqual({
    owner_user_id: actorUserId,
    source_kind: null,
    source_id: null,
  });
});

it("legend-pszrm upload keeps the source kind the caller names", async () => {
  const actorUserId = `user-${randomUUID()}`;
  const authorize = vi.fn(async () => true);
  const stored = await uploadStorage(
    db,
    context(a.tenantId),
    {
      purpose: "receipt",
      outletId: outletIdSchema.parse(a.outletId),
      sourceKind: "reimbursement",
    },
    await png(),
    {
      storage: new FakeObjectStorage(),
      scanner: new NoopMalwareScanner(),
      authorize,
      actorUserId,
    },
  );
  expect(authorize).toHaveBeenCalledWith("upload", "receipt", a.outletId, {
    sourceKind: "reimbursement",
  });
  expect(await readObject(a.tenantId, stored.id)).toEqual({
    owner_user_id: actorUserId,
    source_kind: "reimbursement",
    source_id: null,
  });
});

it("legend-pszrm upload refuses a source kind that belongs to another purpose", async () => {
  const authorize = vi.fn(async () => true);
  const storage = new FakeObjectStorage();
  const put = vi.spyOn(storage, "put");
  await expect(
    uploadStorage(
      db,
      context(a.tenantId),
      {
        purpose: "selfie",
        outletId: outletIdSchema.parse(a.outletId),
        sourceKind: "reimbursement",
      },
      await png(),
      {
        storage,
        scanner: new NoopMalwareScanner(),
        authorize,
        actorUserId: randomUUID(),
      },
    ),
  ).rejects.toThrow();
  expect(put).not.toHaveBeenCalled();
});

it("legend-pszrm linkStorageObjectSource sets kind, source id and owner once", async () => {
  const objectId = await seedObject(a, {
    purpose: "receipt",
    ownerUserId: "uploader",
  });
  const sourceId = randomUUID();
  await link(a.tenantId, {
    objectId,
    sourceKind: "reimbursement",
    sourceId,
    actorUserId: "uploader",
    ownerUserId: "claimant",
  });
  expect(await readObject(a.tenantId, objectId)).toEqual({
    owner_user_id: "claimant",
    source_kind: "reimbursement",
    source_id: sourceId,
  });
  // A linked object cannot be attached to a second document, even by the same kind.
  await expect(
    link(a.tenantId, {
      objectId,
      sourceKind: "reimbursement",
      sourceId: randomUUID(),
      actorUserId: "claimant",
    }),
  ).rejects.toThrow(CANNOT_ATTACH);
  expect((await readObject(a.tenantId, objectId)).source_id).toBe(sourceId);
});

it("legend-pszrm linkStorageObjectSource keeps the owner when none is given", async () => {
  const objectId = await seedObject(a, {
    purpose: "receipt",
    ownerUserId: "uploader",
  });
  await link(a.tenantId, {
    objectId,
    sourceKind: "expense",
    sourceId: randomUUID(),
    actorUserId: "uploader",
  });
  expect((await readObject(a.tenantId, objectId)).owner_user_id).toBe(
    "uploader",
  );
});

it("legend-pszrm linkStorageObjectSource accepts the kind chosen at upload and refuses another", async () => {
  const objectId = await seedObject(a, {
    purpose: "receipt",
    ownerUserId: "uploader",
    sourceKind: "expense",
  });
  await expect(
    link(a.tenantId, {
      objectId,
      sourceKind: "reimbursement",
      sourceId: randomUUID(),
      actorUserId: "uploader",
    }),
  ).rejects.toThrow(CANNOT_ATTACH);
  expect((await readObject(a.tenantId, objectId)).source_id).toBeNull();
  // Positive control: the matching kind links.
  const sourceId = randomUUID();
  await link(a.tenantId, {
    objectId,
    sourceKind: "expense",
    sourceId,
    actorUserId: "uploader",
  });
  expect((await readObject(a.tenantId, objectId)).source_id).toBe(sourceId);
});

it("legend-pszrm linkStorageObjectSource refuses an object of the wrong purpose", async () => {
  const objectId = await seedObject(a, {
    purpose: "selfie",
    ownerUserId: "someone",
  });
  await expect(
    link(a.tenantId, {
      objectId,
      sourceKind: "reimbursement",
      sourceId: randomUUID(),
      actorUserId: "someone",
    }),
  ).rejects.toThrow(CANNOT_ATTACH);
  expect(await readObject(a.tenantId, objectId)).toEqual({
    owner_user_id: "someone",
    source_kind: null,
    source_id: null,
  });
  // Positive control: the kind that belongs to a selfie links.
  await link(a.tenantId, {
    objectId,
    sourceKind: "attendance",
    sourceId: randomUUID(),
    actorUserId: "someone",
  });
});

it("legend-pszrm linkStorageObjectSource refuses an unowned object (no opt-in exists)", async () => {
  const objectId = await seedObject(a, { purpose: "receipt" });
  await expect(
    link(a.tenantId, {
      objectId,
      sourceKind: "expense",
      sourceId: randomUUID(),
      actorUserId: "someone",
    }),
  ).rejects.toThrow(CANNOT_ATTACH);
  expect(await readObject(a.tenantId, objectId)).toEqual({
    owner_user_id: null,
    source_kind: null,
    source_id: null,
  });
});

it("legend-pszrm linkStorageObjectSource refuses an object at another outlet", async () => {
  const objectId = await seedObject(a, {
    purpose: "receipt",
    ownerUserId: "uploader",
  });
  await expect(
    link(a.tenantId, {
      objectId,
      sourceKind: "expense",
      sourceId: randomUUID(),
      actorUserId: "uploader",
      outletId: randomUUID(),
    }),
  ).rejects.toThrow(CANNOT_ATTACH);
  expect((await readObject(a.tenantId, objectId)).source_id).toBeNull();
  // Positive control: the object's own outlet links.
  await link(a.tenantId, {
    objectId,
    sourceKind: "expense",
    sourceId: randomUUID(),
    actorUserId: "uploader",
    outletId: a.outletId,
  });
});

it("legend-pszrm linkStorageObjectSource refuses another tenant's object and a missing one", async () => {
  const foreign = await seedObject(b, { purpose: "receipt" });
  await expect(
    link(a.tenantId, {
      objectId: foreign,
      sourceKind: "reimbursement",
      sourceId: randomUUID(),
      actorUserId: "someone",
    }),
  ).rejects.toThrow(CANNOT_ATTACH);
  expect(await readObject(b.tenantId, foreign)).toEqual({
    owner_user_id: null,
    source_kind: null,
    source_id: null,
  });
  await expect(
    link(a.tenantId, {
      objectId: randomUUID(),
      sourceKind: "reimbursement",
      sourceId: randomUUID(),
      actorUserId: "someone",
    }),
  ).rejects.toThrow(CANNOT_ATTACH);
});

it("legend-pszrm linkStorageObjectSource refuses an object another user owns", async () => {
  const objectId = await seedObject(a, {
    purpose: "receipt",
    ownerUserId: "uploader",
  });
  await expect(
    link(a.tenantId, {
      objectId,
      sourceKind: "reimbursement",
      sourceId: randomUUID(),
      actorUserId: "someone-else",
      ownerUserId: "someone-else",
    }),
  ).rejects.toThrow(CANNOT_ATTACH);
  // Nothing changed, including the owner.
  expect(await readObject(a.tenantId, objectId)).toEqual({
    owner_user_id: "uploader",
    source_kind: null,
    source_id: null,
  });
  // Positive control: the owner links the same object.
  await link(a.tenantId, {
    objectId,
    sourceKind: "reimbursement",
    sourceId: randomUUID(),
    actorUserId: "uploader",
  });
});
