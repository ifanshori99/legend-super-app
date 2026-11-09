// legend-4xai (Codex 159): migration 0147_station_printer_binding_cleanup.sql
// clears every station printer binding that is not an active printer of the
// same tenant and outlet. The test seeds good and bad bindings as the owner,
// runs the migration statements in one transaction (as drizzle does), and
// checks the final state plus FORCE RLS on stations and devices.
//
// Assumptions (recorded in the report):
// - The rule is the one in the migration header: device exists, same tenant,
//   same outlet, type 'printer', status 'active', revoked_at NULL.
// - Seed rows are compared by id, so rows other test files leave behind do
//   not matter (the migration may clear their stale bindings too).
// - "Cleared" also bumps stations.updated_at (sync watermark); a kept binding
//   keeps its updated_at.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendFixtures } from "@starter/shared/core";
import {
  createIsolatedTenant,
  dropIsolatedTenant,
  type IsolatedTenant,
} from "./floor-test-helpers";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});

const readMigration = (file: string) =>
  readFileSync(new URL(`../../drizzle/${file}`, import.meta.url), "utf8");
const statements = readMigration("0147_station_printer_binding_cleanup.sql")
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter(Boolean);

const { tenant, outlets } = cafeLegendFixtures;
const tenantId = tenant.id as string;
const outletA = outlets[0].id as string;
const outletB = outlets[1].id as string;
const OLD = "2024-01-02T03:04:05.000Z";

const runTag = randomUUID().slice(0, 8);
let other: IsolatedTenant;

type Seed = { tenantId: string; id: string };
const seededStations: Seed[] = [];
const seededDevices: Seed[] = [];

/** FORCE RLS is on: every read and write carries the tenant settings. */
async function asTenant<T>(
  forTenant: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [forTenant],
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

async function seedDevice(
  forTenant: string,
  outletId: string,
  type: "printer" | "kds",
  status: "active" | "revoked" = "active",
): Promise<string> {
  const id = randomUUID();
  await asTenant(forTenant, (c) =>
    c.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, status, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6::varchar,
               CASE WHEN $6::varchar = 'revoked' THEN now() ELSE NULL END)`,
      [id, forTenant, outletId, type, `Uji ${runTag} ${type}`, status],
    ),
  );
  seededDevices.push({ tenantId: forTenant, id });
  return id;
}

async function seedStation(
  forTenant: string,
  outletId: string,
  printerDeviceId: string | null,
): Promise<string> {
  const id = randomUUID();
  await asTenant(forTenant, (c) =>
    c.query(
      `INSERT INTO stations
         (id, tenant_id, outlet_id, name, type, printer_device_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'hot_kitchen', $5, $6, $6)`,
      [
        id,
        forTenant,
        outletId,
        `Uji ${runTag} ${id.slice(0, 8)}`,
        printerDeviceId,
        OLD,
      ],
    ),
  );
  seededStations.push({ tenantId: forTenant, id });
  return id;
}

async function readStation(forTenant: string, id: string) {
  const { rows } = await asTenant(forTenant, (c) =>
    c.query<{ printer_device_id: string | null; updated_at: Date }>(
      "SELECT printer_device_id, updated_at FROM stations WHERE id = $1",
      [id],
    ),
  );
  return rows[0];
}

/** One transaction, no tenant context: the migrator role, like drizzle. */
async function runMigration(): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    for (const statement of statements) await client.query(statement);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function forcedRls(table: "stations" | "devices"): Promise<boolean> {
  const { rows } = await owner.query<{ forced: boolean }>(
    `SELECT relforcerowsecurity AS forced FROM pg_class
     WHERE oid = ('public.' || $1)::regclass`,
    [table],
  );
  return rows[0].forced;
}

let valid: string;
let revoked: string;
let otherOutlet: string;
let notPrinter: string;
let otherTenantPrinter: string;
let missing: string;
let unbound: string;
let otherTenantRevoked: string;
let ids: Record<string, string>;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  other = await createIsolatedTenant(`bind-${randomUUID().slice(0, 8)}`);

  const goodPrinter = await seedDevice(tenantId, outletA, "printer");
  const revokedPrinter = await seedDevice(
    tenantId,
    outletA,
    "printer",
    "revoked",
  );
  const printerOfOutletB = await seedDevice(tenantId, outletB, "printer");
  const kds = await seedDevice(tenantId, outletA, "kds");
  const foreignPrinter = await seedDevice(
    other.tenantId,
    other.outletId,
    "printer",
  );
  const foreignRevoked = await seedDevice(
    other.tenantId,
    other.outletId,
    "printer",
    "revoked",
  );

  valid = await seedStation(tenantId, outletA, goodPrinter);
  revoked = await seedStation(tenantId, outletA, revokedPrinter);
  otherOutlet = await seedStation(tenantId, outletA, printerOfOutletB);
  notPrinter = await seedStation(tenantId, outletA, kds);
  otherTenantPrinter = await seedStation(tenantId, outletA, foreignPrinter);
  missing = await seedStation(tenantId, outletA, randomUUID());
  unbound = await seedStation(tenantId, outletA, null);
  // Another tenant's own station bound to its own revoked printer: the
  // migration runs without tenant context and must clean every tenant.
  otherTenantRevoked = await seedStation(
    other.tenantId,
    other.outletId,
    foreignRevoked,
  );
  ids = {
    valid,
    revoked,
    otherOutlet,
    notPrinter,
    otherTenantPrinter,
    missing,
    unbound,
  };

  expect(statements.length).toBe(5);
  await runMigration();
});

afterAll(async () => {
  for (const station of seededStations)
    await asTenant(station.tenantId, (c) =>
      c.query("DELETE FROM stations WHERE id = $1", [station.id]),
    );
  for (const device of seededDevices)
    await asTenant(device.tenantId, (c) =>
      c.query("DELETE FROM devices WHERE id = $1", [device.id]),
    );
  if (other) await dropIsolatedTenant(other);
  await owner.end();
});

describe("legend-4xai migration 0147 clears invalid station printer bindings", () => {
  it("keeps only the active printer of the same tenant and outlet", async () => {
    const goodBinding = (await readStation(tenantId, valid)).printer_device_id;
    expect(goodBinding).not.toBeNull();
    expect(seededDevices.some((d) => d.id === goodBinding)).toBe(true);
    expect((await readStation(tenantId, valid)).updated_at.toISOString()).toBe(
      OLD,
    );
  });

  it.each([
    "revoked",
    "otherOutlet",
    "notPrinter",
    "otherTenantPrinter",
    "missing",
  ])(
    "clears a binding to a bad device (%s) and bumps updated_at",
    async (key) => {
      const row = await readStation(tenantId, ids[key]);
      expect(row.printer_device_id).toBeNull();
      expect(row.updated_at.getTime()).toBeGreaterThan(new Date(OLD).getTime());
    },
  );

  it("leaves a station without a binding untouched", async () => {
    const row = await readStation(tenantId, unbound);
    expect(row.printer_device_id).toBeNull();
    expect(row.updated_at.toISOString()).toBe(OLD);
  });

  it("cleans other tenants too, without a tenant context", async () => {
    const row = await readStation(other.tenantId, otherTenantRevoked);
    expect(row.printer_device_id).toBeNull();
  });

  it("restores FORCE ROW LEVEL SECURITY on stations and devices", async () => {
    expect(await forcedRls("stations")).toBe(true);
    expect(await forcedRls("devices")).toBe(true);
  });

  it("is idempotent: a second run changes nothing", async () => {
    const before = await Promise.all(
      Object.values(ids).map((id) => readStation(tenantId, id)),
    );
    await runMigration();
    const after = await Promise.all(
      Object.values(ids).map((id) => readStation(tenantId, id)),
    );
    expect(after).toEqual(before);
    expect(await forcedRls("stations")).toBe(true);
    expect(await forcedRls("devices")).toBe(true);
  });
});
