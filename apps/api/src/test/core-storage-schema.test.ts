import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
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
const db = drizzle(pool, { schema });
const context = (tenantId: string) =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "domain" }),
    { kind: "tenant" },
  );
afterAll(async () => pool.end());

it("legend-ruf isolates storage metadata across tenants", async () => {
  const a = context(randomUUID());
  const b = context(randomUUID());
  const id = randomUUID();
  await withTenant(db, a, (tx) =>
    tx.insert(schema.coreStorageObjects).values({
      tenantId: a.tenant.tenantId,
      outletId: randomUUID(),
      id,
      purpose: "selfie",
      objectKey: `${id}/original.webp`,
      contentType: "image/webp",
      sizeBytes: 1,
    }),
  );
  const rows = await withTenant(db, b, (tx) =>
    tx
      .select()
      .from(schema.coreStorageObjects)
      .where(eq(schema.coreStorageObjects.id, id)),
  );
  expect(rows).toEqual([]);
});
