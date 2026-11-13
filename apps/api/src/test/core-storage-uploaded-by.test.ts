// legend-0pth: core_storage_objects.uploaded_by is the immutable record of who
// uploaded a file. Expected behavior (from the bead card, not the code):
// - set once at insert from the verified actor (never from a request body);
// - never rewritten when owner_user_id is reassigned through
//   linkStorageObjectSource (the call hris-contract makes for contracts and
//   employee documents);
// - legacy rows stay null (no backfill from owner_user_id).
// Assumption: a body field named `uploadedBy` is refused with 422 like the
// existing `ownerUserId` field (strict upload schema).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import sharp from "sharp";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { outletIdSchema } from "@starter/shared/core";
import * as schema from "../db/schema";
import { withTenant } from "../db/tenant";

vi.mock("../middleware/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../middleware/origin", () => ({
  requireTrustedOrigin: (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));
import { createStorageRouter } from "../routes/core-storage.routes";
import { errorHandler } from "../middleware/error-handler";
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
      `uji-uploaded-by-${tag}`,
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
beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  a = await seedOutlet();
});
afterAll(async () => {
  await pool.end();
  await owner.end();
});

const png = () =>
  sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } })
    .png()
    .toBuffer();

type Columns = {
  purpose: string;
  ownerUserId?: string | null;
  sourceKind?: string | null;
  uploadedBy?: string | null;
};

/** Seeds an object through the owner pool. Omits uploaded_by unless given, like a legacy row. */
async function seedObject(columns: Columns) {
  const id = randomUUID();
  const hasUploader = columns.uploadedBy !== undefined;
  await owner.query(
    hasUploader
      ? `INSERT INTO core_storage_objects
           (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes, owner_user_id, source_kind, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, 'image/webp', 1, $6, $7, $8)`
      : `INSERT INTO core_storage_objects
           (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes, owner_user_id, source_kind)
         VALUES ($1, $2, $3, $4, $5, 'image/webp', 1, $6, $7)`,
    [
      a.tenantId,
      a.outletId,
      id,
      columns.purpose,
      `${id}/original.webp`,
      columns.ownerUserId ?? null,
      columns.sourceKind ?? null,
      ...(hasUploader ? [columns.uploadedBy] : []),
    ],
  );
  return id;
}

async function readRow(id: string) {
  const { rows } = await owner.query(
    `SELECT owner_user_id, source_id, uploaded_by FROM core_storage_objects
     WHERE tenant_id = $1 AND id = $2`,
    [a.tenantId, id],
  );
  return rows[0] as {
    owner_user_id: string | null;
    source_id: string | null;
    uploaded_by: string | null;
  };
}

/** Every stored row whose owner is this actor (upload sets owner = actor). */
async function rowsOwnedBy(userId: string) {
  const { rows } = await owner.query(
    `SELECT id, uploaded_by FROM core_storage_objects
     WHERE tenant_id = $1 AND owner_user_id = $2`,
    [a.tenantId, userId],
  );
  return rows as { id: string; uploaded_by: string | null }[];
}

const link = (input: {
  objectId: string;
  sourceKind: "employment_contract" | "employee_document" | "reimbursement";
  actorUserId: string;
  ownerUserId?: string;
}) =>
  withTenant(db, context(a.tenantId), (tx) =>
    linkStorageObjectSource(tx, {
      tenantId: a.tenantId,
      outletId: a.outletId,
      sourceId: randomUUID(),
      ...input,
    }),
  );

function app(actorUserId: string) {
  const server = express();
  server.use(
    "/api",
    createStorageRouter({
      database: db,
      storage: new FakeObjectStorage(),
      scanner: new NoopMalwareScanner(),
      resolveRequest: async () => ({
        context: context(a.tenantId),
        authorize: async () => true,
        actorUserId,
      }),
    }),
  );
  server.use(errorHandler);
  return server;
}

describe("legend-0pth storage uploaded_by", () => {
  it("adds a nullable text uploaded_by column", async () => {
    const { rows } = await owner.query(
      `SELECT data_type, is_nullable FROM information_schema.columns
       WHERE table_name = 'core_storage_objects' AND column_name = 'uploaded_by'`,
    );
    expect(rows).toEqual([{ data_type: "text", is_nullable: "YES" }]);
  });

  it("upload through the service records the verified actor as uploader", async () => {
    const actorUserId = `user-${randomUUID()}`;
    const stored = await uploadStorage(
      db,
      context(a.tenantId),
      { purpose: "receipt", outletId: outletIdSchema.parse(a.outletId) },
      await png(),
      {
        storage: new FakeObjectStorage(),
        scanner: new NoopMalwareScanner(),
        authorize: async () => true,
        actorUserId,
      },
    );
    expect(await readRow(stored.id)).toMatchObject({
      owner_user_id: actorUserId,
      uploaded_by: actorUserId,
    });
  });

  it("upload through the HTTP route records the session actor as uploader", async () => {
    const actorUserId = `user-${randomUUID()}`;
    const res = await request(app(actorUserId))
      .post("/api/storage/uploads")
      .field("purpose", "receipt")
      .field("outletId", a.outletId)
      .attach("file", await png(), "x.png");
    expect(res.status).toBe(201);
    const rows = await rowsOwnedBy(actorUserId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.uploaded_by).toBe(actorUserId);
  });

  it("a request body cannot set uploaded_by", async () => {
    const actorUserId = `user-${randomUUID()}`;
    const res = await request(app(actorUserId))
      .post("/api/storage/uploads")
      .field("purpose", "receipt")
      .field("outletId", a.outletId)
      .field("uploadedBy", "someone-else")
      .attach("file", await png(), "x.png");
    expect(res.status).toBe(422);
    // Nothing was stored for this actor, and nobody else got the claim.
    expect(await rowsOwnedBy(actorUserId)).toEqual([]);
    const { rows } = await owner.query(
      `SELECT 1 FROM core_storage_objects WHERE tenant_id = $1 AND uploaded_by = 'someone-else'`,
      [a.tenantId],
    );
    expect(rows).toEqual([]);
  });

  it("a body field cannot override the actor when the upload is otherwise accepted", async () => {
    // snake_case spelling is also unknown to the strict upload schema.
    const actorUserId = `user-${randomUUID()}`;
    const res = await request(app(actorUserId))
      .post("/api/storage/uploads")
      .field("purpose", "receipt")
      .field("outletId", a.outletId)
      .field("uploaded_by", "someone-else")
      .attach("file", await png(), "x.png");
    expect(res.status).toBe(422);
    expect(await rowsOwnedBy(actorUserId)).toEqual([]);
  });

  it.each(["employment_contract", "employee_document"] as const)(
    "uploaded_by stays with the uploader when %s linking reassigns the owner",
    async (sourceKind) => {
      const hrAdmin = `hr-${randomUUID()}`;
      const employeeUser = `emp-${randomUUID()}`;
      const objectId = await seedObject({
        purpose: "document",
        ownerUserId: hrAdmin,
        uploadedBy: hrAdmin,
      });
      await link({
        objectId,
        sourceKind,
        actorUserId: hrAdmin,
        ownerUserId: employeeUser,
      });
      expect(await readRow(objectId)).toMatchObject({
        owner_user_id: employeeUser,
        uploaded_by: hrAdmin,
      });
    },
  );

  it("uploaded_by is untouched when linking keeps the owner", async () => {
    const uploader = `user-${randomUUID()}`;
    const objectId = await seedObject({
      purpose: "receipt",
      ownerUserId: uploader,
      uploadedBy: uploader,
    });
    await link({
      objectId,
      sourceKind: "reimbursement",
      actorUserId: uploader,
    });
    expect(await readRow(objectId)).toMatchObject({
      owner_user_id: uploader,
      uploaded_by: uploader,
    });
  });

  it("legacy rows keep a null uploaded_by, even after the owner changes", async () => {
    const legacyOwner = `user-${randomUUID()}`;
    const newOwner = `user-${randomUUID()}`;
    const objectId = await seedObject({
      purpose: "document",
      ownerUserId: legacyOwner,
    });
    expect((await readRow(objectId)).uploaded_by).toBeNull();
    await link({
      objectId,
      sourceKind: "employee_document",
      actorUserId: legacyOwner,
      ownerUserId: newOwner,
    });
    // Not backfilled from the old or the new owner.
    expect(await readRow(objectId)).toMatchObject({
      owner_user_id: newOwner,
      uploaded_by: null,
    });
  });
});
