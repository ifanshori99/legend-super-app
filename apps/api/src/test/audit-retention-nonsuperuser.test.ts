import { dropTestDatabase, endTestPool } from "./helpers/database-cleanup.ts";
// legend-usyi: migration 0187 and the two audit retention functions with a
// plain (non-superuser) table owner, the way production runs them.
//
// The suite in audit-retention.test.ts migrates with whatever owner the test
// server provides. A superuser ignores RLS, so it cannot show that 0187 or the
// SECURITY DEFINER functions still work once FORCE ROW LEVEL SECURITY applies
// to the owner. Here a NOSUPERUSER role owns a scratch database, runs every
// migration through 0187, and the purge runs as a maintenance login, first
// while the owner still has BYPASSRLS (migrator-role.ts) and then without it.
import { randomBytes, randomUUID } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migration-session";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const drizzleDir = join(apiRoot, "drizzle");
const adminUrl = process.env.STARTER_TEST_DATABASE_URL;
const TAG = "0187_audit_retention_maintenance";
const PURGE_ACTION = "audit.retention_purged";

function urlFor(db: string, user?: string, password?: string) {
  const url = new URL(adminUrl as string);
  url.pathname = `/${db}`;
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

type Journal = {
  entries: { idx: number; when: number; tag: string }[];
};

// A copy of drizzle/ that ends with 0187, so later migrations from other
// branches do not change what this suite tests.
function copyFolderThrough0187(workDir: string): string {
  const journal = JSON.parse(
    readFileSync(join(drizzleDir, "meta", "_journal.json"), "utf8"),
  ) as Journal;
  const last = journal.entries.findIndex((entry) => entry.tag === TAG);
  expect(last).toBeGreaterThan(0);
  const kept = journal.entries.slice(0, last + 1);
  const keptTags = new Set(kept.map((entry) => entry.tag));
  const folder = join(workDir, "drizzle-through-0187");
  mkdirSync(join(folder, "meta"), { recursive: true });
  for (const file of readdirSync(drizzleDir))
    if (file.endsWith(".sql") && keptTags.has(file.replace(/\.sql$/, "")))
      cpSync(join(drizzleDir, file), join(folder, file));
  writeFileSync(
    join(folder, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries: kept }),
  );
  return folder;
}

const EXPIRED = "2 years 1 day";
const YOUNG = "2 years - 1 day";

describe("legend-usyi migration 0187 and purge with a non-superuser table owner", () => {
  const ownerRole = `auditret_owner_${randomBytes(6).toString("hex")}`;
  const ownerPassword = randomBytes(16).toString("hex");
  const ownerDatabase = `auditret_own_${randomBytes(6).toString("hex")}`;
  const maintUser = `auditret_maint_${randomBytes(6).toString("hex")}`;
  const maintPassword = randomBytes(16).toString("hex");
  let admin: Pool; // superuser, default database
  let adminInScratch: Pool; // superuser, the owner's database
  let maintenance: Pool; // login in legend_maintenance, EXECUTE only
  let workDir: string;
  let migrationError: unknown;

  function openMaintenance() {
    return new Pool({
      connectionString: urlFor(ownerDatabase, maintUser, maintPassword),
      max: 2,
    });
  }

  /** Inserts a tenant as superuser (foreign keys and triggers skipped). */
  async function newTenant(status: "active" | "archived" = "active") {
    const id = randomUUID();
    const client = await adminInScratch.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
         VALUES ($1, $2, 'Audit retention tenant', 'lengkap', 'active', 'shared', $3, $4, $5)`,
        [
          id,
          `audit-ret-${id.slice(0, 8)}`,
          JSON.stringify({ modules: [], integrationProviders: [] }),
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
      if (status === "archived")
        await client.query(
          `UPDATE tenants SET status = 'archived', status_before_archive = 'active', archived_at = now() WHERE id = $1`,
          [id],
        );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return id;
  }

  /**
   * Inserts `count` audit rows `age` old as superuser. Replica mode skips the
   * creation-time trigger, so the backdated created_at stays.
   */
  async function seed(tenantId: string, count: number, age: string) {
    const client = await adminInScratch.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      for (let index = 0; index < count; index += 1) {
        const event = {
          id: `seed-${index}`,
          tenantId,
          outletId: null,
          actorType: "system",
          actorId: null,
          deviceId: null,
          action: "settings.updated",
          objectType: "retention_seed",
          objectId: null,
          reason: null,
          maskedChanges: { before: null, after: null },
          ipHash: null,
          sensitiveAccess: false,
          retentionClass: "audit_2y",
          createdAt: new Date().toISOString(),
        };
        await client.query(
          `INSERT INTO public.audit_logs (tenant_id, id, outlet_id, event, retention_class, created_at)
           VALUES ($1, $2, NULL, $3, 'audit_2y', now() - $4::interval)`,
          [tenantId, randomUUID(), JSON.stringify(event), age],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Counts rows as superuser (RLS bypassed). */
  async function count(tenantId: string, where = "TRUE") {
    const { rows } = await adminInScratch.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.audit_logs WHERE tenant_id = $1 AND ${where}`,
      [tenantId],
    );
    return rows[0]?.n ?? -1;
  }
  const seeded = "event->>'objectType' = 'retention_seed'";
  const summaries = `event->>'action' = '${PURGE_ACTION}'`;

  async function dueTenants() {
    const { rows } = await maintenance.query<{ id: string }>(
      "SELECT id::text AS id FROM app.audit_retention_due_tenants() AS id",
    );
    return rows.map((row) => row.id);
  }

  async function purge(tenantId: string, batch: number) {
    const { rows } = await maintenance.query<{ n: string }>(
      "SELECT app.purge_audit_retention_batch($1::uuid, $2::int)::text AS n",
      [tenantId, batch],
    );
    return Number(rows[0]?.n);
  }

  async function ownerBypassesRls() {
    const { rows } = await admin.query<{ rolbypassrls: boolean }>(
      "SELECT rolbypassrls FROM pg_roles WHERE rolname = $1",
      [ownerRole],
    );
    return rows[0]?.rolbypassrls;
  }

  // Due tenants (archived included), purge of one tenant only, one summary
  // per non-empty batch, other tenants untouched.
  async function purgeStaysInsideOneTenant() {
    const active = await newTenant();
    const archived = await newTenant("archived");
    const bystander = await newTenant();
    const youngOnly = await newTenant();
    await seed(active, 3, EXPIRED);
    await seed(archived, 2, EXPIRED);
    await seed(bystander, 2, EXPIRED);
    await seed(youngOnly, 2, YOUNG);

    const due = await dueTenants();
    expect(due).toEqual(expect.arrayContaining([active, archived, bystander]));
    expect(due).not.toContain(youngOnly);

    expect(await purge(archived, 10)).toBe(2);
    expect(await count(archived, seeded)).toBe(0);
    expect(await count(archived, summaries)).toBe(1);
    const summary = await adminInScratch.query<{
      event: {
        tenantId: string;
        maskedChanges: { after: { deletedCount: number } };
      };
    }>(
      `SELECT event FROM public.audit_logs WHERE tenant_id = $1 AND ${summaries}`,
      [archived],
    );
    expect(summary.rows[0]?.event.tenantId).toBe(archived);
    expect(summary.rows[0]?.event.maskedChanges.after.deletedCount).toBe(2);

    expect(await purge(active, 2)).toBe(2);
    expect(await count(active, seeded)).toBe(1);
    expect(await count(active, summaries)).toBe(1);

    // Nothing leaked into the tenants that were not asked for.
    expect(await count(bystander, seeded)).toBe(2);
    expect(await count(bystander, summaries)).toBe(0);
    expect(await count(youngOnly, seeded)).toBe(2);
    expect(await count(youngOnly, summaries)).toBe(0);
  }

  beforeAll(async () => {
    assertDisposableServer();
    admin = new Pool({ connectionString: adminUrl, max: 1 });
    // Names and hex passwords are generated here, so interpolation into DDL
    // (no bind parameters) is safe. Older migrations need BYPASSRLS for a
    // non-superuser owner (foreign keys onto force-RLS tables validate rows
    // under the tenant policy); migrator-role.ts keeps it in production.
    await admin.query(
      `CREATE ROLE ${ownerRole} LOGIN PASSWORD '${ownerPassword}' NOSUPERUSER BYPASSRLS CREATEROLE NOCREATEDB`,
    );
    await admin.query(`CREATE DATABASE ${ownerDatabase} OWNER ${ownerRole}`);
    const owner = new Pool({
      connectionString: urlFor(ownerDatabase, ownerRole, ownerPassword),
      max: 1,
    });
    adminInScratch = new Pool({
      connectionString: urlFor(ownerDatabase),
      max: 1,
    });
    workDir = mkdtempSync(join(tmpdir(), "legend-audit-retention-owner-"));
    migrationError = await runMigrations(
      owner,
      copyFolderThrough0187(workDir),
      {
        lockTimeout: "10s",
        statementTimeout: "0",
      },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    await endTestPool(owner);

    await admin.query(
      `CREATE ROLE ${maintUser} LOGIN PASSWORD '${maintPassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT IN ROLE legend_maintenance`,
    );
    maintenance = openMaintenance();
  }, 240_000);

  afterAll(async () => {
    if (maintenance) await endTestPool(maintenance);
    if (adminInScratch) await endTestPool(adminInScratch);
    if (admin) {
      try {
        await dropTestDatabase(admin, ownerDatabase);
        await admin.query(`DROP ROLE IF EXISTS ${maintUser}`);
        await admin.query(`DROP ROLE IF EXISTS ${ownerRole}`);
      } finally {
        await endTestPool(admin);
      }
    }
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("every migration through 0187 succeeds for the non-superuser migrator", async () => {
    expect(migrationError).toBeNull();
    const role = await admin.query(
      "SELECT rolsuper FROM pg_roles WHERE rolname = $1",
      [ownerRole],
    );
    expect(role.rows[0]).toEqual({ rolsuper: false });
    const applied = await adminInScratch.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations",
    );
    const journal = JSON.parse(
      readFileSync(
        join(workDir, "drizzle-through-0187", "meta", "_journal.json"),
        "utf8",
      ),
    ) as Journal;
    expect(applied.rows[0]?.n).toBe(journal.entries.length);
    const functions = await adminInScratch.query(
      `SELECT to_regprocedure('app.audit_retention_due_tenants()') IS NOT NULL AS due,
              to_regprocedure('app.purge_audit_retention_batch(uuid, integer)') IS NOT NULL AS batch,
              to_regprocedure('app.purge_expired_audit_logs(uuid)') IS NULL AS old_gone,
              has_schema_privilege('legend_maintenance', 'app', 'USAGE') AS schema_usage`,
    );
    expect(functions.rows[0]).toEqual({
      due: true,
      batch: true,
      old_gone: true,
      schema_usage: true,
    });
  });

  it("both functions belong to the audit_logs owner, are SECURITY DEFINER and lock search_path", async () => {
    const { rows } = await adminInScratch.query(
      `SELECT p.proname, p.prosecdef, p.proconfig,
              pg_get_userbyid(p.proowner) AS function_owner,
              (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.audit_logs'::regclass) AS table_owner
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app'
          AND p.proname IN ('audit_retention_due_tenants', 'purge_audit_retention_batch')
        ORDER BY p.proname`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows)
      expect(row).toMatchObject({
        prosecdef: true,
        proconfig: ["search_path=pg_catalog, pg_temp"],
        function_owner: ownerRole,
        table_owner: ownerRole,
      });
  });

  it("with the owner still BYPASSRLS (production migrator), the purge stays inside one tenant", async () => {
    expect(await ownerBypassesRls()).toBe(true);
    await purgeStaysInsideOneTenant();
  });

  it("with the owner NOBYPASSRLS (FORCE RLS applies), the purge still works and stays inside one tenant", async () => {
    await endTestPool(maintenance);
    await admin.query(`ALTER ROLE ${ownerRole} NOBYPASSRLS`);
    maintenance = openMaintenance();
    expect(await ownerBypassesRls()).toBe(false);
    await purgeStaysInsideOneTenant();
  });

  it("rows younger than two years cannot be removed through this path", async () => {
    expect(await ownerBypassesRls()).toBe(false);
    const tenant = await newTenant();
    await seed(tenant, 2, EXPIRED);
    await seed(tenant, 3, YOUNG);
    expect(await purge(tenant, 5000)).toBe(2);
    expect(await count(tenant, seeded)).toBe(3);
    // A second run finds nothing more and writes no new summary.
    expect(await purge(tenant, 5000)).toBe(0);
    expect(await count(tenant, seeded)).toBe(3);
    expect(await count(tenant, summaries)).toBe(1);
    // The maintenance login has no direct DELETE right either.
    const direct = await maintenance
      .query("DELETE FROM public.audit_logs WHERE tenant_id = $1", [tenant])
      .then(
        () => null,
        (error: { code?: string }) => error.code,
      );
    expect(direct).toBe("42501");
    expect(await count(tenant, seeded)).toBe(3);
  });
});
