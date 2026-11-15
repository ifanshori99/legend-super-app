import { dropTestDatabase, endTestPool } from "./helpers/database-cleanup.ts";
// Upgrade test for migration 0175_pickup_call_letters. It widens
// pickup_calls.number from smallint (CHECK 1..999) to integer (CHECK >= 1) and
// adds the 'delivery' channel. Existing rows (including the old edge numbers 1
// and 999) must survive unchanged, and the guard trigger from 0168 must still
// freeze number/channel. Like edge-received-events-migration.test.ts: migrate a
// scratch database to 0168 (journal cut), seed, then apply the full folder.
// The scratch database lives on the disposable test server and is dropped in
// afterAll; the shared test database and the real journal are never touched.
import { randomBytes, randomUUID } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const drizzleFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../drizzle",
);
const adminUrl = process.env.STARTER_TEST_DATABASE_URL;
const scratchName = `pickup_ltr_mig_${randomBytes(6).toString("hex")}`;

const tenantId = randomUUID();
const outletId = randomUUID();
const DAY = "2026-11-08";
const CALLED_AT = "2026-11-08T10:00:05.123Z";
const seeded = [1, 998, 999].map((number) => ({
  number,
  orderId: randomUUID(),
  callId: randomUUID(),
}));

function urlFor(database: string) {
  const url = new URL(adminUrl as string);
  url.pathname = `/${database}`;
  return url.toString();
}

// Refuse to create databases on anything but the disposable test server.
function assertDisposableServer() {
  if (
    !adminUrl ||
    !process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-")
  )
    throw new Error(
      "Run this suite through pnpm test so it gets the disposable PostgreSQL server.",
    );
}

// Temp copy of the migrations, journal cut at idx 168 (0168_expo_pickup_tables,
// the migration that creates pickup_calls). Everything after it, including
// 0175, is applied by the test. The real folder and journal stay untouched.
function copyMigrationsUpTo0168() {
  const dir = mkdtempSync(join(tmpdir(), "legend-mig-0168-"));
  const upTo0168 = join(dir, "drizzle");
  cpSync(drizzleFolder, upTo0168, { recursive: true });
  const journalPath = join(upTo0168, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { idx: number }[];
  };
  journal.entries = journal.entries.filter((entry) => entry.idx <= 168);
  writeFileSync(journalPath, JSON.stringify(journal));
  return { dir, upTo0168 };
}

async function insertOrder(scratch: Pool, orderId: string) {
  await scratch.query(
    `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
       subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
       status, business_date, placed_at)
     VALUES ($1, $2, $3, $4, 'pos', 'dine_in', 'pay_first', 10000, 0, 0, 0, 0, 10000,
       'sent', $5, $6)`,
    [orderId, tenantId, outletId, `PK-${orderId.slice(0, 8)}`, DAY, CALLED_AT],
  );
}

// Seeded by the superuser, which bypasses RLS on the owner's tables (no seed
// tenant exists in a database that stops at migration 0168).
async function seedPreMigrationData(scratch: Pool) {
  const brand = randomUUID();
  const entity = randomUUID();
  const suffix = randomBytes(4).toString("hex");
  await scratch.query(
    `INSERT INTO tenants (id, slug, name, plan, deployment_mode, limits, created_by)
     VALUES ($1, $2, 'Tenant Upgrade Uji', 'starter', 'shared', '{}'::jsonb, $3)`,
    [tenantId, `upgrade-uji-${suffix}`, randomUUID()],
  );
  await scratch.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand')`,
    [brand, tenantId, `upgrade-uji-${suffix}`],
  );
  await scratch.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)`,
    [entity, tenantId],
  );
  await scratch.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
     VALUES ($1, $2, $3, $4, 'UJI-01', 'Outlet Uji', 'Jl. Uji', '{}', 'active')`,
    [outletId, tenantId, brand, entity],
  );
  for (const row of seeded) {
    await insertOrder(scratch, row.orderId);
    await scratch.query(
      `INSERT INTO pickup_calls (id, tenant_id, outlet_id, order_id, channel, number, business_date, status, called_at)
       VALUES ($1, $2, $3, $4, 'takeaway', $5, $6, 'called', $7)`,
      [row.callId, tenantId, outletId, row.orderId, row.number, DAY, CALLED_AT],
    );
  }
}

describe("migration 0175_pickup_call_letters on pre-0175 pickup_calls", () => {
  let admin: Pool;
  let scratch: Pool;
  let workDir: string;

  beforeAll(async () => {
    assertDisposableServer();
    admin = new Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`CREATE DATABASE ${scratchName}`);
    scratch = new Pool({ connectionString: urlFor(scratchName), max: 2 });
    const copy = copyMigrationsUpTo0168();
    workDir = copy.dir;
    await migrate(drizzle(scratch), { migrationsFolder: copy.upTo0168 });
    await seedPreMigrationData(scratch);
    // ~170 migrations into a fresh database outlast the default hook timeout
    // on a slow disposable Postgres.
  }, 180_000);

  afterAll(async () => {
    if (scratch) await endTestPool(scratch);
    if (admin) {
      try {
        await dropTestDatabase(admin, scratchName);
      } finally {
        await endTestPool(admin);
      }
    }
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("the fixture really holds the pre-0175 shape: smallint, no delivery, max 999", async () => {
    const type = await scratch.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name = 'pickup_calls' AND column_name = 'number'`,
    );
    expect(type.rows[0].data_type).toBe("smallint");
    const count = await scratch.query(
      `SELECT count(*)::int AS n FROM pickup_calls`,
    );
    expect(count.rows[0].n).toBe(3);
  });

  it("applies the full migration folder without error", async () => {
    await expect(
      migrate(drizzle(scratch), { migrationsFolder: drizzleFolder }),
    ).resolves.not.toThrow();
  });

  it("keeps every row with the same number, status and timestamps", async () => {
    const rows = await scratch.query(
      `SELECT id, number, status, channel, called_at, picked_up_at
         FROM pickup_calls WHERE tenant_id = $1 ORDER BY number`,
      [tenantId],
    );
    expect(rows.rowCount).toBe(3);
    expect(rows.rows.map((r) => r.number)).toEqual([1, 998, 999]);
    for (const [index, row] of rows.rows.entries()) {
      expect(row.id).toBe(seeded[index]?.callId);
      expect(row.status).toBe("called");
      expect(row.channel).toBe("takeaway");
      expect(row.called_at.toISOString()).toBe(CALLED_AT);
      expect(row.picked_up_at).toBeNull();
    }
  });

  it("widens the number column to integer", async () => {
    const type = await scratch.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name = 'pickup_calls' AND column_name = 'number'`,
    );
    expect(type.rows[0].data_type).toBe("integer");
  });

  it("accepts number 1000 on channel 'delivery'", async () => {
    const orderId = randomUUID();
    await insertOrder(scratch, orderId);
    const inserted = await scratch.query(
      `INSERT INTO pickup_calls (tenant_id, outlet_id, order_id, channel, number, business_date, status)
       VALUES ($1, $2, $3, 'delivery', 1000, $4, 'assigned')
       RETURNING number, channel`,
      [tenantId, outletId, orderId, DAY],
    );
    expect(inserted.rows[0]).toEqual({ number: 1000, channel: "delivery" });
  });

  it("still rejects number 0 with pickup_calls_number_check", async () => {
    const orderId = randomUUID();
    await insertOrder(scratch, orderId);
    await expect(
      scratch.query(
        `INSERT INTO pickup_calls (tenant_id, outlet_id, order_id, channel, number, business_date, status)
         VALUES ($1, $2, $3, 'takeaway', 0, $4, 'assigned')`,
        [tenantId, outletId, orderId, DAY],
      ),
    ).rejects.toThrow(/pickup_calls_number_check/);
  });

  it("the guard trigger still blocks changing the number of an existing row", async () => {
    await expect(
      scratch.query(`UPDATE pickup_calls SET number = 500 WHERE id = $1`, [
        seeded[0]?.callId,
      ]),
    ).rejects.toThrow(
      /order, outlet, number, business_date and channel are fixed/,
    );
    const row = await scratch.query(
      `SELECT number FROM pickup_calls WHERE id = $1`,
      [seeded[0]?.callId],
    );
    expect(row.rows[0].number).toBe(1);
  });
});
