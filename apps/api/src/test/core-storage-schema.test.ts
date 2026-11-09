import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import * as schema from "../db/schema";
import { withTenant } from "../db/tenant";

const pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 1,
});
const db = drizzle(pool, { schema });
const context = (tenantId: string) =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "domain" }),
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

const row = (tenantId: string, outletId: string, id = randomUUID()) => ({
  tenantId,
  outletId,
  id,
  purpose: "selfie",
  objectKey: `${id}/original.webp`,
  contentType: "image/webp",
  sizeBytes: 1,
});

it("legend-ruf isolates storage metadata across tenants", async () => {
  const id = randomUUID();
  await withTenant(db, context(a.tenantId), (tx) =>
    tx
      .insert(schema.coreStorageObjects)
      .values(row(a.tenantId, a.outletId, id)),
  );
  const rows = await withTenant(db, context(b.tenantId), (tx) =>
    tx
      .select()
      .from(schema.coreStorageObjects)
      .where(eq(schema.coreStorageObjects.id, id)),
  );
  expect(rows).toEqual([]);
});

it("TEN-02 rejects storage metadata pointing at another tenant's outlet", async () => {
  await expect(
    withTenant(db, context(a.tenantId), (tx) =>
      tx.insert(schema.coreStorageObjects).values(row(a.tenantId, b.outletId)),
    ),
  ).rejects.toThrow();
});

const insertRaw = (
  tenant: { tenantId: string; outletId: string },
  columns: {
    ownerUserId?: string | null;
    sourceKind?: string | null;
    sourceId?: string | null;
  },
) => {
  const id = randomUUID();
  return owner.query(
    `INSERT INTO core_storage_objects
       (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes, owner_user_id, source_kind, source_id)
     VALUES ($1, $2, $3, 'receipt', $4, 'image/webp', 1, $5, $6, $7)`,
    [
      tenant.tenantId,
      tenant.outletId,
      id,
      `${id}/original.webp`,
      columns.ownerUserId ?? null,
      columns.sourceKind ?? null,
      columns.sourceId ?? null,
    ],
  );
};

it("legend-pszrm storage objects carry nullable owner, source kind and source id columns", async () => {
  const { rows } = await owner.query(
    `SELECT column_name, data_type, character_maximum_length, is_nullable
     FROM information_schema.columns
     WHERE table_name = 'core_storage_objects'
       AND column_name IN ('owner_user_id', 'source_kind', 'source_id')`,
  );
  const byName = Object.fromEntries(
    rows.map((r: { column_name: string }) => [r.column_name, r]),
  );
  expect(Object.keys(byName).sort()).toEqual([
    "owner_user_id",
    "source_id",
    "source_kind",
  ]);
  expect(byName.owner_user_id).toMatchObject({
    data_type: "text",
    is_nullable: "YES",
  });
  expect(byName.source_kind).toMatchObject({
    data_type: "character varying",
    character_maximum_length: 32,
    is_nullable: "YES",
  });
  expect(byName.source_id).toMatchObject({
    data_type: "uuid",
    is_nullable: "YES",
  });
});

it("legend-pszrm storage objects round-trip owner and source through the tenant client", async () => {
  const id = randomUUID();
  const sourceId = randomUUID();
  await withTenant(db, context(a.tenantId), (tx) =>
    tx.insert(schema.coreStorageObjects).values({
      ...row(a.tenantId, a.outletId, id),
      purpose: "receipt",
      ownerUserId: "user-schema",
      sourceKind: "reimbursement",
      sourceId,
    }),
  );
  const [stored] = await withTenant(db, context(a.tenantId), (tx) =>
    tx
      .select()
      .from(schema.coreStorageObjects)
      .where(eq(schema.coreStorageObjects.id, id)),
  );
  expect(stored).toMatchObject({
    ownerUserId: "user-schema",
    sourceKind: "reimbursement",
    sourceId,
  });
});

it("legend-pszrm storage objects accept legacy rows and a kind without a source id", async () => {
  // Legacy upload: all three columns null.
  await insertRaw(a, {});
  // Kind chosen at upload, document not created yet.
  await insertRaw(a, { ownerUserId: "user-schema", sourceKind: "expense" });
  // Linked.
  await insertRaw(a, {
    ownerUserId: "user-schema",
    sourceKind: "expense",
    sourceId: randomUUID(),
  });
});

it("legend-pszrm storage objects refuse a source id without a source kind", async () => {
  await expect(insertRaw(a, { sourceId: randomUUID() })).rejects.toThrow(
    /check constraint/i,
  );
  await expect(
    insertRaw(a, { ownerUserId: "user-schema", sourceId: randomUUID() }),
  ).rejects.toThrow(/check constraint/i);
});
