import { dropTestDatabase, endTestPool } from "./helpers/database-cleanup.ts";
// Upgrade test for migration 0234 (bead legend-ie6m): it adds uoms.is_system
// and backfills the standard codes with a plain UPDATE. `uoms` has FORCE ROW
// LEVEL SECURITY (0127), and the production migrator is a plain table owner
// (NOSUPERUSER, no BYPASSRLS, drizzle/0001) that runs without app.tenant_id.
// On a POPULATED database that UPDATE is filtered by the tenant policy and
// raises "tenant context is required", which rolls back the whole migration
// run. A test whose pool bypasses RLS (superuser) cannot see that, so this
// suite migrates a scratch database to 0233 as a generated owner, seeds legacy
// uoms rows, drops BYPASSRLS from the owner, and then applies the real folder
// (only 0234 is pending) as that plain owner.
// The scratch database lives on the disposable test server and is dropped in
// afterAll; the shared test database and the real journal are never touched.
// Modeled on edge-received-events-migration.test.ts (second describe).
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
// Legacy rows as a pre-0234 database holds them. Codes are case-sensitive:
// 'KG' is a custom unit that only looks like the standard 'kg'. 'box' keeps
// its standard code even though a tenant renamed it ("Dus Besar").
const legacyUoms = [
  { code: "kg", name: "Kilogram", isSystem: true },
  { code: "box", name: "Dus Besar", isSystem: true },
  { code: "KG", name: "Kilo besar", isSystem: false },
  { code: "tray", name: "Tray", isSystem: false },
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

// Temp copy of the migrations, journal cut at idx 233 (the last migration
// before 0234). The real folder and journal stay untouched.
function copyMigrationsUpTo0233() {
  const dir = mkdtempSync(join(tmpdir(), "legend-mig-0233-"));
  const upTo0233 = join(dir, "drizzle");
  cpSync(drizzleFolder, upTo0233, { recursive: true });
  const journalPath = join(upTo0233, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { idx: number }[];
  };
  journal.entries = journal.entries.filter((entry) => entry.idx <= 233);
  writeFileSync(journalPath, JSON.stringify(journal));
  return { dir, upTo0233 };
}

describe("legend-ie6m migration 0234 run by a non-superuser table owner", () => {
  const ownerRole = `uom_sys_owner_${randomBytes(6).toString("hex")}`;
  const ownerPassword = randomBytes(16).toString("hex");
  const ownerDatabase = `uom_sys_mig_${randomBytes(6).toString("hex")}`;
  let admin: Pool; // superuser, connected to the server's default database
  let adminInScratch: Pool; // superuser, connected to the owner's database
  let owner: Pool; // the migrator, NOSUPERUSER; reopened without BYPASSRLS
  let workDir: string;

  async function uomFlags() {
    const { rows } = await adminInScratch.query<{
      code: string;
      is_system: boolean;
    }>(`SELECT code, is_system FROM uoms WHERE tenant_id = $1 ORDER BY code`, [
      tenantId,
    ]);
    return Object.fromEntries(rows.map((r) => [r.code, r.is_system]));
  }

  beforeAll(async () => {
    assertDisposableServer();
    admin = new Pool({ connectionString: adminUrl, max: 1 });
    // Role names and the hex password are generated here, so interpolation
    // into DDL (which takes no bind parameters) is safe.
    // Only 0234 is under test. Earlier migrations need BYPASSRLS for a
    // non-superuser owner (foreign keys onto FORCE RLS tables validate rows
    // under the tenant policy, e.g. 0004 and 0063). That is older than 0234
    // and out of scope, so the role starts with BYPASSRLS and loses it before
    // 0234 runs.
    await admin.query(
      `CREATE ROLE ${ownerRole} LOGIN PASSWORD '${ownerPassword}' NOSUPERUSER BYPASSRLS CREATEROLE NOCREATEDB`,
    );
    // legend_payout (drizzle/0410) is cluster-wide and already exists, created by
    // the bootstrap superuser; the migrator manages it through ADMIN OPTION only,
    // as provisionMigrator gives it in production (db/migrator-role.ts).
    await admin.query(
      `GRANT legend_payout TO ${ownerRole} WITH ADMIN OPTION, INHERIT FALSE, SET FALSE`,
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
    const copy = copyMigrationsUpTo0233();
    workDir = copy.dir;
    await migrate(drizzle(owner), { migrationsFolder: copy.upTo0233 });

    // Legacy data, seeded by the superuser (bypasses RLS). Minimum columns the
    // tenants constraints require.
    await adminInScratch.query(
      `INSERT INTO tenants (id, slug, name, plan, deployment_mode, limits, created_by)
       VALUES ($1, $2, 'Tenant Satuan Uji', 'starter', 'shared', '{}'::jsonb, $3)`,
      [tenantId, `uom-uji-${randomBytes(4).toString("hex")}`, randomUUID()],
    );
    for (const uom of legacyUoms)
      await adminInScratch.query(
        `INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $3)`,
        [tenantId, uom.code, uom.name],
      );

    // Production shape from here on (drizzle/0001): a plain table owner with
    // CREATEROLE, subject to RLS. ALTER ROLE only applies to new sessions, so
    // the migrator gets a fresh pool.
    await endTestPool(owner);
    await admin.query(`ALTER ROLE ${ownerRole} NOBYPASSRLS`);
    owner = new Pool({
      connectionString: urlFor(ownerDatabase, ownerRole, ownerPassword),
      max: 1,
    });
  }, 180_000);

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

  it("the fixture is a populated pre-0234 database and the migrator is a plain table owner", async () => {
    const role = await owner.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });

    const table = await adminInScratch.query(
      `SELECT pg_get_userbyid(relowner) AS owner, relforcerowsecurity FROM pg_class
        WHERE oid = 'public.uoms'::regclass`,
    );
    expect(table.rows[0]).toEqual({
      owner: ownerRole,
      relforcerowsecurity: true,
    });

    const column = await adminInScratch.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'uoms' AND column_name = 'is_system'`,
    );
    expect(column.rowCount).toBe(0);

    const rows = await adminInScratch.query(
      `SELECT count(*)::int AS n FROM uoms WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(rows.rows[0].n).toBe(legacyUoms.length);
  });

  it("applies the full migration folder as the plain owner without tenant context", async () => {
    // Red on the unfixed SQL: the backfill UPDATE hits FORCE RLS and raises
    // "tenant context is required".
    await expect(
      migrate(drizzle(owner), { migrationsFolder: drizzleFolder }),
    ).resolves.not.toThrow();
  });

  it("marks the standard codes as system units and leaves the rest custom", async () => {
    const flags = await uomFlags();
    expect(flags).toEqual({
      kg: true,
      box: true, // renamed to "Dus Besar" but still the standard code
      KG: false, // case-sensitive: not the standard 'kg'
      tray: false,
    });
  });

  it("keeps row level security forced on uoms after the migration", async () => {
    const flags = await adminInScratch.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE oid = 'public.uoms'::regclass`,
    );
    expect(flags.rows[0]).toEqual({
      relrowsecurity: true,
      relforcerowsecurity: true,
    });
  });

  it("is a no-op when the migrator runs again", async () => {
    await expect(
      migrate(drizzle(owner), { migrationsFolder: drizzleFolder }),
    ).resolves.not.toThrow();
    expect(await uomFlags()).toEqual({
      kg: true,
      box: true,
      KG: false,
      tray: false,
    });
    const count = await adminInScratch.query(
      `SELECT count(*)::int AS n FROM uoms WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(count.rows[0].n).toBe(legacyUoms.length);
  });
});
