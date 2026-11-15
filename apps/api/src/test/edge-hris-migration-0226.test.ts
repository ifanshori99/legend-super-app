import { dropTestDatabase, endTestPool } from "./helpers/database-cleanup.ts";
// Upgrade test for migration 0226 (legend-hwn02, design
// docs/design/hris-edge-replication.md sections 5, 6.1, 8): it adds the edge
// HRIS tables edge_people_sync_state, edge_attendance_qr_keys,
// edge_selfie_uploads and edge_received_selfies, and widens
// attendance_logs_method_check with 'outlet_device'.
// Modelled on the "non-superuser table owner" suite of
// edge-received-events-migration.test.ts: the scratch database is migrated to
// 0225 (journal cut at idx 225) by an owner with BYPASSRLS, seeded as the
// superuser, then the owner loses BYPASSRLS and applies the FULL folder as a
// plain table owner, like production (drizzle/0001). The scratch database lives
// on the disposable test server and is dropped in afterAll; the shared test
// database and the real journal are never touched.
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

const tenantId = randomUUID();
const brandId = randomUUID();
const entityId = randomUUID();
const outletId = randomUUID();
const edgeNodeId = randomUUID();
const employeeId = randomUUID();
const oldLogId = randomUUID();

const newTables = [
  "edge_people_sync_state",
  "edge_attendance_qr_keys",
  "edge_selfie_uploads",
  "edge_received_selfies",
];

function urlFor(database: string, user?: string, password?: string) {
  const url = new URL(adminUrl as string);
  url.pathname = `/${database}`;
  if (user) url.username = user;
  if (password) url.password = password;
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

// Temp copy of the migrations, journal cut at idx 225 (the last migration
// before 0226). The real folder and journal stay untouched.
function copyMigrationsUpTo0225() {
  const dir = mkdtempSync(join(tmpdir(), "legend-mig-0225-"));
  const upTo0225 = join(dir, "drizzle");
  cpSync(drizzleFolder, upTo0225, { recursive: true });
  const journalPath = join(upTo0225, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { idx: number }[];
  };
  journal.entries = journal.entries.filter((entry) => entry.idx <= 225);
  writeFileSync(journalPath, JSON.stringify(journal));
  return { dir, upTo0225 };
}

function insertAttendanceLog(
  db: Pool,
  id: string,
  method: string,
  clientEventId: string,
) {
  return db.query(
    `INSERT INTO attendance_logs (id, tenant_id, outlet_id, employee_id, type, method, occurred_at, validity, business_date, client_event_id)
     VALUES ($1, $2, $3, $4, 'in', $5, '2026-11-08T01:00:00Z', 'valid', '2026-11-08', $6)`,
    [id, tenantId, outletId, employeeId, method, clientEventId],
  );
}

// Pre-0226 data, seeded by the superuser (bypasses RLS on the owner's tables).
async function seedPre0226(db: Pool) {
  const suffix = randomBytes(4).toString("hex");
  await db.query(
    `INSERT INTO tenants (id, slug, name, plan, deployment_mode, limits, created_by)
     VALUES ($1, $2, 'Tenant Upgrade Uji', 'starter', 'shared', '{}'::jsonb, $3)`,
    [tenantId, `hris-uji-${suffix}`, randomUUID()],
  );
  await db.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand')`,
    [brandId, tenantId, `hris-uji-${suffix}`],
  );
  await db.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)`,
    [entityId, tenantId],
  );
  await db.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
     VALUES ($1, $2, $3, $4, 'UJI-01', 'Outlet Uji', 'Jl. Uji', '{}', 'active')`,
    [outletId, tenantId, brandId, entityId],
  );
  await db.query(
    `INSERT INTO edge_nodes (id, tenant_id, outlet_id, role, label, credential_hash)
     VALUES ($1, $2, $3, 'primary', 'node-primary', $4)`,
    [edgeNodeId, tenantId, outletId, randomBytes(32).toString("hex")],
  );
  await db.query(
    `INSERT INTO employees (id, tenant_id, employee_no, full_name, home_outlet_id, employment_type, join_date, status)
     VALUES ($1, $2, 'EMP-001', 'Karyawan Uji', $3, 'pkwtt', '2026-01-01', 'active')`,
    [employeeId, tenantId, outletId],
  );
  await insertAttendanceLog(db, oldLogId, "selfie_geo", "pre-0226-selfie-geo");
}

describe("legend-hwn02 migration 0226 run by a non-superuser table owner", () => {
  const ownerRole = `edge_hris_owner_${randomBytes(6).toString("hex")}`;
  const ownerPassword = randomBytes(16).toString("hex");
  const ownerDatabase = `edge_hris_own_${randomBytes(6).toString("hex")}`;
  let admin: Pool; // superuser, connected to the server's default database
  let adminInScratch: Pool; // superuser, connected to the owner's database
  let owner: Pool; // the migrator, NOSUPERUSER; reopened without BYPASSRLS
  let workDir: string;

  beforeAll(async () => {
    assertDisposableServer();
    admin = new Pool({ connectionString: adminUrl, max: 1 });
    // Role names and the hex password are generated here, so interpolation
    // into DDL (which takes no bind parameters) is safe.
    // Only 0226 is under test here. Migrations up to 0225 need BYPASSRLS for a
    // non-superuser owner (adding a foreign key to a table with FORCE ROW LEVEL
    // SECURITY validates existing rows under the tenant policy, which raises
    // "tenant context is required"). That is older than 0226 and out of scope,
    // so the role starts with BYPASSRLS and loses it before 0226 runs.
    await admin.query(
      `CREATE ROLE ${ownerRole} LOGIN PASSWORD '${ownerPassword}' NOSUPERUSER BYPASSRLS CREATEROLE NOCREATEDB`,
    );
    await admin.query(`CREATE DATABASE ${ownerDatabase} OWNER ${ownerRole}`);
    owner = new Pool({
      connectionString: urlFor(ownerDatabase, ownerRole, ownerPassword),
      max: 1,
    });
    adminInScratch = new Pool({
      connectionString: urlFor(ownerDatabase),
      max: 1,
    });
    const copy = copyMigrationsUpTo0225();
    workDir = copy.dir;
    await migrate(drizzle(owner), { migrationsFolder: copy.upTo0225 });
    await seedPre0226(adminInScratch);
    // Production shape from here on (drizzle/0001): a plain table owner with
    // CREATEROLE, subject to RLS. ALTER ROLE only applies to new sessions, so
    // the migrator gets a fresh pool.
    await endTestPool(owner);
    await admin.query(`ALTER ROLE ${ownerRole} NOBYPASSRLS`);
    owner = new Pool({
      connectionString: urlFor(ownerDatabase, ownerRole, ownerPassword),
      max: 1,
    });
    // ~217 migrations into a fresh database outlast the default hook timeout on
    // a slow disposable Postgres.
  }, 300_000);

  afterAll(async () => {
    if (owner) await endTestPool(owner);
    if (adminInScratch) await endTestPool(adminInScratch);
    if (admin) {
      try {
        await dropTestDatabase(admin, ownerDatabase);
        await admin.query(`DROP ROLE IF EXISTS ${ownerRole}`);
      } finally {
        await endTestPool(admin);
      }
    }
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("the fixture holds pre-0226 data and the migrator is a plain table owner", async () => {
    const role = await admin.query(
      `SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = $1`,
      [ownerRole],
    );
    expect(role.rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: true,
    });
    const session = await owner.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    expect(session.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const state = await adminInScratch.query(
      `SELECT to_regclass('public.edge_received_selfies') AS selfies,
              (SELECT count(*)::int FROM attendance_logs) AS logs`,
    );
    expect(state.rows[0]).toEqual({ selfies: null, logs: 1 });
  });

  it("applies the full migration folder as the non-superuser owner without error", async () => {
    await expect(
      migrate(drizzle(owner), { migrationsFolder: drizzleFolder }),
    ).resolves.not.toThrow();
  });

  it("creates the four edge HRIS tables with row level security enabled and forced", async () => {
    const flags = await adminInScratch.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1)`,
      [[...newTables, "attendance_logs", "outlets", "edge_nodes"]],
    );
    const byName = Object.fromEntries(flags.rows.map((r) => [r.relname, r]));
    for (const table of [
      ...newTables,
      "attendance_logs",
      "outlets",
      "edge_nodes",
    ]) {
      expect(byName[table]?.relrowsecurity, `${table} row security`).toBe(true);
      expect(byName[table]?.relforcerowsecurity, `${table} FORCE`).toBe(true);
    }
  });

  it("keeps the old selfie_geo attendance log", async () => {
    const rows = await adminInScratch.query(
      `SELECT method, client_event_id FROM attendance_logs WHERE id = $1`,
      [oldLogId],
    );
    expect(rows.rows).toEqual([
      { method: "selfie_geo", client_event_id: "pre-0226-selfie-geo" },
    ]);
  });

  it("now accepts attendance method outlet_device and still rejects an unknown method", async () => {
    await expect(
      insertAttendanceLog(
        adminInScratch,
        randomUUID(),
        "outlet_device",
        "post-0226-outlet-device",
      ),
    ).resolves.toBeDefined();
    await expect(
      insertAttendanceLog(
        adminInScratch,
        randomUUID(),
        "bogus",
        "post-0226-bogus",
      ),
    ).rejects.toThrow(/attendance_logs_method_check/);
  });

  it("makes edge_received_selfies append-only", async () => {
    const objectId = randomUUID();
    await adminInScratch.query(
      `INSERT INTO edge_received_selfies (tenant_id, object_id, outlet_id, edge_node_id, sealed_sha256, state)
       VALUES ($1, $2, $3, $4, $5, 'stored')`,
      [tenantId, objectId, outletId, edgeNodeId, randomBytes(32)],
    );
    await expect(
      adminInScratch.query(
        `UPDATE edge_received_selfies SET state = 'discarded' WHERE tenant_id = $1 AND object_id = $2`,
        [tenantId, objectId],
      ),
    ).rejects.toThrow(/append-only/i);
    await expect(
      adminInScratch.query(
        `DELETE FROM edge_received_selfies WHERE tenant_id = $1 AND object_id = $2`,
        [tenantId, objectId],
      ),
    ).rejects.toThrow(/append-only/i);
    const rows = await adminInScratch.query(
      `SELECT state FROM edge_received_selfies WHERE tenant_id = $1 AND object_id = $2`,
      [tenantId, objectId],
    );
    expect(rows.rows).toEqual([{ state: "stored" }]);
  });
});
