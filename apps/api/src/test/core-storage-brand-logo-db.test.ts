import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { outletIdSchema } from "@starter/shared/core";
import type { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import * as schema from "../db/schema";
import { withTenant } from "../db/tenant";
import { NoopMalwareScanner } from "../services/core-image";
import { uploadStorage } from "../services/core-storage";
import { S3ObjectStorage } from "../services/core-storage-provider";

// legend-a30j: tenant-level brand_logo (core_storage_objects.outlet_id NULL),
// migration 0201 (nullable column, CHECK, replaced outlet_isolation policy plus
// strict UPDATE/DELETE restrictive policies).

const pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 1,
});
const db = drizzle(pool, { schema });
const tenantContext = (tenantId: string) =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
const outletContext = (tenantId: string, ...outletIds: string[]) =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    {
      kind: "outlets",
      outletIds: outletIds.map((id) => outletIdSchema.parse(id)),
    },
  );

/** Owner-seeded tenant with two outlets (the storage FK needs real outlets). */
async function seedTenant() {
  const [tenantId, brandId, legalEntityId, outletA, outletB] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  const tag = tenantId.slice(0, 8);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Uji Logo', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', $3, $4)`,
    [
      tenantId,
      `uji-logo-${tag}`,
      JSON.stringify({
        maxOutlets: 2,
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
  for (const [outletId, code] of [
    [outletA, "U-01"],
    [outletB, "U-02"],
  ] as const)
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
       VALUES ($1, $2, $3, $4, $5, 'Outlet Uji', 'Jl. Uji', '{}')`,
      [outletId, tenantId, brandId, legalEntityId, code],
    );
  return { tenantId, outletA, outletB };
}

let a: Awaited<ReturnType<typeof seedTenant>>;
let b: Awaited<ReturnType<typeof seedTenant>>;
beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  a = await seedTenant();
  b = await seedTenant();
});
afterAll(async () => {
  await pool.end();
  await owner.end();
});

const png = () =>
  sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } })
    .png()
    .toBuffer();

const columns = (
  tenantId: string,
  outletId: string | null,
  purpose: string,
  id = randomUUID(),
) => ({
  tenantId,
  outletId,
  id,
  purpose,
  objectKey: `${id}/original.webp`,
  contentType: "image/webp",
  sizeBytes: 1,
});

/** Owner-seeded row (bypasses RLS); returns the id. */
async function seedRow(
  tenantId: string,
  outletId: string | null,
  purpose: string,
) {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO core_storage_objects
       (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes)
     VALUES ($1, $2, $3, $4, $5, 'image/webp', 1)`,
    [tenantId, outletId, id, purpose, `${id}/original.webp`],
  );
  return id;
}

const ownerRow = async (tenantId: string, id: string) =>
  (
    await owner.query(
      "SELECT outlet_id, purpose, content_type FROM core_storage_objects WHERE tenant_id = $1 AND id = $2",
      [tenantId, id],
    )
  ).rows[0] as
    | { outlet_id: string | null; purpose: string; content_type: string }
    | undefined;

/** Drizzle wraps pg errors; match the underlying message too. */
async function expectRejected(run: Promise<unknown>, pattern: RegExp) {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e as { message: string; cause?: { message: string } },
  );
  expect(error, "expected the statement to be rejected").toBeDefined();
  expect(`${error!.message} ${error!.cause?.message ?? ""}`).toMatch(pattern);
}

const readAs = (context: ReturnType<typeof tenantContext>, id: string) =>
  withTenant(db, context, (tx) =>
    tx
      .select({ id: schema.coreStorageObjects.id })
      .from(schema.coreStorageObjects)
      .where(eq(schema.coreStorageObjects.id, id)),
  );

describe("legend-a30j service: brand_logo upload", () => {
  it("stores a null outlet, returns public URLs and writes under <tenant>/tenant", async () => {
    const send = vi.fn<(command: unknown) => Promise<object>>(async () => ({}));
    const storage = new S3ObjectStorage({
      client: { send } as unknown as S3Client,
      privateBucket: "private",
      publicBucket: "public",
      publicBaseUrl: "https://cdn.example/images",
      sign: async () => "https://storage.example/signed",
    });
    const authorize = vi.fn(async () => true);
    const stored = await uploadStorage(
      db,
      tenantContext(a.tenantId),
      { purpose: "brand_logo" },
      await png(),
      {
        storage,
        scanner: new NoopMalwareScanner(),
        authorize,
        actorUserId: `user-${randomUUID()}`,
      },
    );
    expect(authorize).toHaveBeenCalledWith("upload", "brand_logo", null, {
      sourceKind: null,
    });
    const prefix = `${a.tenantId}/tenant/${stored.id}`;
    expect(stored.purpose).toBe("brand_logo");
    expect(stored.publicUrl).toBe(
      `https://cdn.example/images/${prefix}/original.webp`,
    );
    expect(stored.thumbnailUrl).toBe(
      `https://cdn.example/images/${prefix}/thumbnail.webp`,
    );
    const keys = send.mock.calls.map(
      ([command]) => (command as unknown as PutObjectCommand).input.Key,
    );
    expect(keys).toEqual([
      `${prefix}/original.webp`,
      `${prefix}/thumbnail.webp`,
    ]);
    const row = await ownerRow(a.tenantId, stored.id);
    expect(row).toMatchObject({ outlet_id: null, purpose: "brand_logo" });
  });

  it("refuses an outlet-scoped caller and an unauthorized caller before writing", async () => {
    const storage = new FakeObjectStorage();
    const put = vi.spyOn(storage, "put");
    const deps = (authorize: () => Promise<boolean>) => ({
      storage,
      scanner: new NoopMalwareScanner(),
      authorize,
      actorUserId: randomUUID(),
    });
    await expect(
      uploadStorage(
        db,
        outletContext(a.tenantId, a.outletA),
        { purpose: "brand_logo" },
        await png(),
        deps(async () => true),
      ),
    ).rejects.toMatchObject({ code: "OUTLET_OUT_OF_SCOPE" });
    await expect(
      uploadStorage(
        db,
        tenantContext(a.tenantId),
        { purpose: "brand_logo" },
        await png(),
        deps(async () => false),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(put).not.toHaveBeenCalled();
  });

  it("keeps the legacy outlet upload working and tied to its outlet", async () => {
    const stored = await uploadStorage(
      db,
      tenantContext(a.tenantId),
      { purpose: "menu_photo", outletId: outletIdSchema.parse(a.outletA) },
      await png(),
      {
        storage: new FakeObjectStorage(),
        scanner: new NoopMalwareScanner(),
        authorize: async () => true,
        actorUserId: randomUUID(),
      },
    );
    expect(stored.publicUrl).toMatch(/^https:\/\//);
    expect(await ownerRow(a.tenantId, stored.id)).toMatchObject({
      outlet_id: a.outletA,
      purpose: "menu_photo",
    });
  });
});

describe("legend-a30j RLS: tenant isolation of null-outlet rows", () => {
  it("tenant B cannot SELECT tenant A's brand_logo row", async () => {
    const id = await seedRow(a.tenantId, null, "brand_logo");
    expect(await readAs(tenantContext(a.tenantId), id)).toHaveLength(1);
    expect(await readAs(tenantContext(b.tenantId), id)).toEqual([]);
  });

  it("tenant B cannot UPDATE or overwrite tenant A's brand_logo row", async () => {
    const id = await seedRow(a.tenantId, null, "brand_logo");
    const updated = await withTenant(db, tenantContext(b.tenantId), (tx) =>
      tx
        .update(schema.coreStorageObjects)
        .set({ contentType: "image/png" })
        .where(eq(schema.coreStorageObjects.id, id))
        .returning({ id: schema.coreStorageObjects.id }),
    );
    expect(updated).toEqual([]);
    // Writing a row under tenant A's id from tenant B's context is refused too.
    await expectRejected(
      withTenant(db, tenantContext(b.tenantId), (tx) =>
        tx
          .insert(schema.coreStorageObjects)
          .values(columns(a.tenantId, null, "brand_logo")),
      ),
      /row-level security/i,
    );
    expect((await ownerRow(a.tenantId, id))?.content_type).toBe("image/webp");
  });
});

describe("legend-a30j RLS: outlet scope vs null-outlet rows", () => {
  it("an outlet-scoped context can SELECT a null-outlet row", async () => {
    const id = await seedRow(a.tenantId, null, "brand_logo");
    expect(await readAs(outletContext(a.tenantId, a.outletA), id)).toHaveLength(
      1,
    );
  });

  it("an outlet-scoped context cannot INSERT a row with outlet_id NULL", async () => {
    await expectRejected(
      withTenant(db, outletContext(a.tenantId, a.outletA), (tx) =>
        tx
          .insert(schema.coreStorageObjects)
          .values(columns(a.tenantId, null, "brand_logo")),
      ),
      /row-level security/i,
    );
  });

  it("an outlet-scoped context cannot UPDATE a null-outlet row or null out an outlet row", async () => {
    const tenantRow = await seedRow(a.tenantId, null, "brand_logo");
    // The strict UPDATE policy hides the row from the write: 0 rows, no error.
    const updated = await withTenant(
      db,
      outletContext(a.tenantId, a.outletA),
      (tx) =>
        tx
          .update(schema.coreStorageObjects)
          .set({ contentType: "image/png" })
          .where(eq(schema.coreStorageObjects.id, tenantRow))
          .returning({ id: schema.coreStorageObjects.id }),
    );
    expect(updated).toEqual([]);
    const outletRow = await seedRow(a.tenantId, a.outletA, "menu_photo");
    await expectRejected(
      withTenant(db, outletContext(a.tenantId, a.outletA), (tx) =>
        tx
          .update(schema.coreStorageObjects)
          .set({ outletId: null, purpose: "brand_logo" })
          .where(eq(schema.coreStorageObjects.id, outletRow)),
      ),
      /row-level security/i,
    );
    expect((await ownerRow(a.tenantId, tenantRow))?.content_type).toBe(
      "image/webp",
    );
    expect((await ownerRow(a.tenantId, outletRow))?.outlet_id).toBe(a.outletA);
  });

  it("an outlet-scoped context cannot take over a brand_logo row by setting its own outlet_id", async () => {
    const id = await seedRow(a.tenantId, null, "brand_logo");
    const taken = await withTenant(
      db,
      outletContext(a.tenantId, a.outletA),
      (tx) =>
        tx
          .update(schema.coreStorageObjects)
          .set({ outletId: a.outletA })
          .where(eq(schema.coreStorageObjects.id, id))
          .returning({ id: schema.coreStorageObjects.id }),
    );
    expect(taken).toEqual([]);
    expect((await ownerRow(a.tenantId, id))?.outlet_id).toBeNull();
  });

  it("an outlet-scoped context cannot DELETE a null-outlet row but can delete its own outlet row", async () => {
    const tenantRow = await seedRow(a.tenantId, null, "brand_logo");
    const deleted = await withTenant(
      db,
      outletContext(a.tenantId, a.outletA),
      (tx) =>
        tx
          .delete(schema.coreStorageObjects)
          .where(eq(schema.coreStorageObjects.id, tenantRow))
          .returning({ id: schema.coreStorageObjects.id }),
    );
    expect(deleted).toEqual([]);
    expect(await ownerRow(a.tenantId, tenantRow)).toBeDefined();
    const ownRow = await seedRow(a.tenantId, a.outletA, "menu_photo");
    const deletedOwn = await withTenant(
      db,
      outletContext(a.tenantId, a.outletA),
      (tx) =>
        tx
          .delete(schema.coreStorageObjects)
          .where(eq(schema.coreStorageObjects.id, ownRow))
          .returning({ id: schema.coreStorageObjects.id }),
    );
    expect(deletedOwn).toHaveLength(1);
  });

  it("a tenant-scope context can INSERT and UPDATE a null-outlet row", async () => {
    const id = randomUUID();
    await withTenant(db, tenantContext(a.tenantId), (tx) =>
      tx
        .insert(schema.coreStorageObjects)
        .values(columns(a.tenantId, null, "brand_logo", id)),
    );
    const updated = await withTenant(db, tenantContext(a.tenantId), (tx) =>
      tx
        .update(schema.coreStorageObjects)
        .set({ contentType: "image/png" })
        .where(
          and(
            eq(schema.coreStorageObjects.tenantId, a.tenantId),
            eq(schema.coreStorageObjects.id, id),
          ),
        )
        .returning({ id: schema.coreStorageObjects.id }),
    );
    expect(updated).toHaveLength(1);
    expect((await ownerRow(a.tenantId, id))?.content_type).toBe("image/png");
  });

  it("a tenant-scope context can DELETE a null-outlet row", async () => {
    const id = await seedRow(a.tenantId, null, "brand_logo");
    const deleted = await withTenant(db, tenantContext(a.tenantId), (tx) =>
      tx
        .delete(schema.coreStorageObjects)
        .where(eq(schema.coreStorageObjects.id, id))
        .returning({ id: schema.coreStorageObjects.id }),
    );
    expect(deleted).toHaveLength(1);
    expect(await ownerRow(a.tenantId, id)).toBeUndefined();
  });

  it("outlet RLS still hides outlet A rows from an outlet B scope and keeps own-outlet writes", async () => {
    const id = await seedRow(a.tenantId, a.outletA, "menu_photo");
    expect(await readAs(outletContext(a.tenantId, a.outletB), id)).toEqual([]);
    expect(await readAs(outletContext(a.tenantId, a.outletA), id)).toHaveLength(
      1,
    );
    const own = randomUUID();
    await withTenant(db, outletContext(a.tenantId, a.outletA), (tx) =>
      tx
        .insert(schema.coreStorageObjects)
        .values(columns(a.tenantId, a.outletA, "menu_photo", own)),
    );
    await expectRejected(
      withTenant(db, outletContext(a.tenantId, a.outletB), (tx) =>
        tx
          .insert(schema.coreStorageObjects)
          .values(columns(a.tenantId, a.outletA, "menu_photo")),
      ),
      /row-level security/i,
    );
  });
});

describe("legend-a30j policies on core_storage_objects", () => {
  it("has the tenant policies and the strict UPDATE/DELETE restrictive policies", async () => {
    const { rows } = await owner.query(
      `SELECT polname, polcmd, polpermissive FROM pg_policy
       WHERE polrelid = 'public.core_storage_objects'::regclass ORDER BY polname`,
    );
    expect(rows).toEqual([
      { polname: "outlet_isolation", polcmd: "*", polpermissive: false },
      { polname: "outlet_isolation_delete", polcmd: "d", polpermissive: false },
      { polname: "outlet_isolation_update", polcmd: "w", polpermissive: false },
      { polname: "tenant_access", polcmd: "*", polpermissive: true },
      { polname: "tenant_isolation", polcmd: "*", polpermissive: false },
    ]);
  });
});

describe("legend-a30j CHECK core_storage_objects_outlet_purpose_check", () => {
  it("rejects outlet_id NULL for a purpose other than brand_logo", async () => {
    for (const purpose of ["menu_photo", "selfie", "document", "receipt"])
      await expect(seedRow(a.tenantId, null, purpose)).rejects.toThrow(
        /core_storage_objects_outlet_purpose_check/,
      );
  });

  it("rejects a brand_logo row that carries an outlet", async () => {
    await expect(seedRow(a.tenantId, a.outletA, "brand_logo")).rejects.toThrow(
      /core_storage_objects_outlet_purpose_check/,
    );
  });

  it("accepts outlet_id NULL for brand_logo and an outlet for any other purpose", async () => {
    await seedRow(a.tenantId, null, "brand_logo");
    await seedRow(a.tenantId, a.outletA, "menu_photo");
  });
});
