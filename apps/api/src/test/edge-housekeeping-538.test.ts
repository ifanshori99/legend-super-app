import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import * as schema from "../db/schema/index.ts";
import { sweepEdgeSelfies } from "../edge/selfie-retention.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 1,
});
const appPool = new Pool({
  connectionString: process.env.APP_DATABASE_URL,
  max: 1,
});
const database = drizzle(appPool, { schema });
const roots: string[] = [];
const DAY = 86_400_000;

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  await appPool.end();
  await owner.end();
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const tenant = randomUUID();
  const brand = randomUUID();
  const legal = randomUUID();
  const user = randomUUID();
  const outlets = [randomUUID(), randomUUID()];
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
    VALUES ($1, $2, 'Edge housekeeping test', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', $3, $4)`,
    [
      tenant,
      `edge-housekeeping-${tenant}`,
      JSON.stringify({
        maxOutlets: 2,
        maxActiveEmployees: 1,
        maxDevices: 2,
        aiRequestsPerMonth: 0,
        whatsappCostCapIdr: 0,
        aiCostCapIdr: 0,
        emailCostCapIdr: 0,
      }),
      user,
    ],
  );
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [user, "Housekeeping", `${user}@housekeeping.test`],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'uji', 'Uji')",
    [brand, tenant],
  );
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)",
    [legal, tenant],
  );
  const devices: string[] = [];
  for (const [index, outlet] of outlets.entries()) {
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
      VALUES ($1, $2, $3, $4, $5, 'Uji', 'Jl Uji', '{}')`,
      [outlet, tenant, brand, legal, `U-${index}`],
    );
    const device = randomUUID();
    devices.push(device);
    await owner.query(
      "INSERT INTO devices (id, tenant_id, outlet_id, type, label) VALUES ($1, $2, $3, 'pos', 'Housekeeping')",
      [device, tenant, outlet],
    );
  }
  return { tenant, user, outlets, devices };
}

async function proof(
  fx: Awaited<ReturnType<typeof fixture>>,
  createdAt: Date,
  now: Date,
  outletIndex = 0,
  consumed = false,
) {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO staff_pin_proofs (id, tenant_id, outlet_id, device_id, user_id, purpose, token_hash, created_at, expires_at, consumed_at)
    VALUES ($1, $2, $3, $4, $5, 'attendance_clock', $6, $7, $8, $9)`,
    [
      id,
      fx.tenant,
      fx.outlets[outletIndex],
      fx.devices[outletIndex],
      fx.user,
      randomBytes(32),
      createdAt,
      new Date(now.getTime() - 60_000),
      consumed ? new Date(now.getTime() - 1_000) : null,
    ],
  );
  return id;
}

it("legend-8e0a3 purges proofs strictly older than one day in the edge scope and preserves linked storage", async () => {
  const a = await fixture();
  const b = await fixture();
  const now = new Date();
  const old = await proof(a, new Date(now.getTime() - DAY - 1), now);
  const consumed = await proof(
    a,
    new Date(now.getTime() - 2 * DAY),
    now,
    0,
    true,
  );
  const boundary = await proof(a, new Date(now.getTime() - DAY), now);
  const recent = await proof(a, new Date(now.getTime() - 60_000), now);
  const otherOutlet = await proof(a, new Date(now.getTime() - 2 * DAY), now, 1);
  const otherTenant = await proof(b, new Date(now.getTime() - 2 * DAY), now);
  const object = randomUUID();
  await owner.query(
    `INSERT INTO core_storage_objects (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes, pin_proof_id)
    VALUES ($1, $2, $3, 'selfie', $4, 'image/jpeg', 10, $5)`,
    [a.tenant, a.outlets[0], object, `selfies/${object}.jpg`, old],
  );
  const dir = await mkdtemp(path.join(tmpdir(), "edge-housekeeping-538-"));
  roots.push(dir);
  await sweepEdgeSelfies({
    database,
    context: establishScopedTenantContext(
      establishTenantContext({
        tenantId: a.tenant,
        brandId: null,
        source: "session",
      }),
      { kind: "outlets", outletIds: [outletIdSchema.parse(a.outlets[0])] },
    ),
    dir,
    maxAgeDays: 30,
    now: () => now,
  });
  const ids = [old, consumed, boundary, recent, otherOutlet, otherTenant];
  const remaining = await owner.query<{ id: string }>(
    "SELECT id FROM staff_pin_proofs WHERE id = ANY($1::uuid[])",
    [ids],
  );
  expect(remaining.rows.map((row) => row.id).sort()).toEqual(
    [boundary, recent, otherOutlet, otherTenant].sort(),
  );
  const stored = await owner.query<{ pin_proof_id: string | null }>(
    "SELECT pin_proof_id FROM core_storage_objects WHERE tenant_id = $1 AND id = $2",
    [a.tenant, object],
  );
  expect(stored.rows).toEqual([{ pin_proof_id: null }]);
});
