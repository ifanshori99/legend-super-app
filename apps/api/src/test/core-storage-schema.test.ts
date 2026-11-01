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
     VALUES ($1, $2, 'Uji Storage', 'lengkap', 'active', 'shared', '{"modules":[]}', $3, $4)`,
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
