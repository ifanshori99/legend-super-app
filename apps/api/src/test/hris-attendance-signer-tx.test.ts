import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
import { createAttendanceSelfieSigner } from "../services/core-storage-runtime";

// The attendance selfie signer signs inside the caller's tenant transaction
// when given one (presentLog, toReviewItem): no extra pooled connection per
// photo row. Real DB, fake storage.

const ROWS = 6;
// One connection only: a signer that opens its own transaction while the
// caller holds the single connection can never get one.
const pool = new Pool({
  connectionString: process.env.APP_DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: 1500,
});
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 1,
});
const db = drizzle(pool, { schema });

const outletContext = (tenantId: string, outletId: string) =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );

let tenantId: string;
let outletId: string;
const objectIds: string[] = [];

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const [brandId, legalEntityId] = [randomUUID(), randomUUID()];
  tenantId = randomUUID();
  outletId = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Uji Signer Tx', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', $3, $4)`,
    [
      tenantId,
      `uji-signer-tx-${tenantId.slice(0, 8)}`,
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
     VALUES ($1, $2, $3, $4, 'ST-01', 'Outlet Uji', 'Jl. Uji', '{}')`,
    [outletId, tenantId, brandId, legalEntityId],
  );
  for (let i = 0; i < ROWS; i += 1) {
    const id = randomUUID();
    objectIds.push(id);
    await owner.query(
      `INSERT INTO core_storage_objects
         (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes)
       VALUES ($1, $2, $3, 'selfie', $4, 'image/webp', 1)`,
      [tenantId, outletId, id, `${id}/original.webp`],
    );
  }
});
afterAll(async () => {
  await pool.end();
  await owner.end();
});

describe("attendance selfie signer inside the caller's transaction", () => {
  it("signs many rows on one connection, without touching the database", async () => {
    // Any use of this database means the signer opened its own connection.
    const forbidden = new Proxy(
      {},
      {
        get() {
          throw new Error("signer must not open a connection of its own");
        },
      },
    ) as typeof db;
    const log = { error: vi.fn() };
    const sign = createAttendanceSelfieSigner({
      database: forbidden,
      storage: new FakeObjectStorage(),
      log,
    });
    const context = outletContext(tenantId, outletId);
    const connect = vi.spyOn(pool, "connect");
    const urls = await withTenant(db, context, async (tx) => {
      const out: (string | null)[] = [];
      for (const id of objectIds) out.push(await sign(context, id, tx));
      return out;
    });
    expect(connect).toHaveBeenCalledTimes(1);
    connect.mockRestore();
    expect(log.error).not.toHaveBeenCalled();
    expect(urls).toHaveLength(ROWS);
    for (const url of urls)
      expect(url).toMatch(/^https:\/\/storage\.invalid\/private\//);
  });

  it("still signs without a tx through its own database (old path)", async () => {
    const sign = createAttendanceSelfieSigner({
      database: db,
      storage: new FakeObjectStorage(),
      log: { error: vi.fn() },
    });
    expect(
      await sign(outletContext(tenantId, outletId), objectIds[0]!),
    ).toMatch(/^https:\/\/storage\.invalid\/private\//);
  });
});
