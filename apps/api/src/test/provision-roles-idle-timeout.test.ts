import { dropTestDatabase, endTestPool } from "./helpers/database-cleanup.ts";
// legend-9h0kg: provisionRoles sets idle_in_transaction_session_timeout = 5min
// on the application and queue logins only. An idle open transaction pins
// pg_snapshot_xmin and stops edge catalog and PIN sync. Same disposable-server
// guard and scratch database as migrator-role.test.ts:
//   - a new run sets exactly '5min' on app and queue, nothing on maintenance;
//   - a re-run after role-level drift (search_path) removes the drift and keeps
//     the timeout, and maintenance never gets one;
//   - a timeout set by hand on the maintenance login is not tolerated.
// Tests inside the describe run in order and share state.
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provisionMigrator } from "../db/migrator-role";
import { auditRoles, provisionRoles } from "../db/provision-roles";

const drizzleFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../drizzle",
);
const adminUrl = process.env.STARTER_TEST_DATABASE_URL;
const hex = (bytes: number) => randomBytes(bytes).toString("hex");

function urlFor(database: string, user?: string, password?: string) {
  const url = new URL(adminUrl as string);
  url.pathname = `/${database}`;
  if (user) url.username = user;
  if (password) url.password = password;
  return url.toString();
}

// Refuse to create databases or roles on anything but the disposable server.
function assertDisposableServer() {
  if (
    !adminUrl ||
    !process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-")
  )
    throw new Error(
      "Run this suite through pnpm test so it gets the disposable PostgreSQL server.",
    );
}

// Best effort: the whole server is disposable.
async function dropRoles(admin: Pool, roles: string[]) {
  for (const role of roles)
    await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined);
}

describe("legend-9h0kg idle transaction timeout on the runtime logins", () => {
  const database = `idle_timeout_${hex(6)}`;
  const bootstrap = {
    user: new URL(adminUrl ?? "postgres://x@localhost/x").username,
    password: new URL(adminUrl ?? "postgres://x@localhost/x").password,
  };
  const migratorUser = `legend_migrator_${hex(8)}`;
  const migratorPassword = hex(24);
  const appUser = `legend_runtime_${hex(8)}`;
  const appPassword = hex(24);
  const workerUser = `legend_worker_${hex(8)}`;
  const workerPassword = hex(24);
  const maintUser = `legend_maint_${hex(8)}`;
  const maintPassword = hex(24);
  let migratorUrl: string;
  let appUrl: string;
  let workerUrl: string;
  let maintUrl: string;
  let admin: Pool; // superuser on the server's default database

  beforeAll(async () => {
    assertDisposableServer();
    migratorUrl = urlFor(database, migratorUser, migratorPassword);
    appUrl = urlFor(database, appUser, appPassword);
    workerUrl = urlFor(database, workerUser, workerPassword);
    maintUrl = urlFor(database, maintUser, maintPassword);
    admin = new Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`CREATE DATABASE "${database}"`);
    await provisionMigrator({ bootstrap, migratorUrl, appUrl, workerUrl });
    const migrator = new Pool({ connectionString: migratorUrl, max: 2 });
    try {
      await migrate(drizzle(migrator), { migrationsFolder: drizzleFolder });
    } finally {
      await endTestPool(migrator);
    }
    // legend_maintenance is cluster-wide: another suite on this server usually
    // created it first, so this migrator did not get the implicit ADMIN that
    // migration 0187 gives the creator. Grant it as a superuser, the way
    // provisionMigrator does for legend_app (ADMIN only, no INHERIT, no SET).
    await admin.query(
      `GRANT legend_maintenance TO "${migratorUser}" WITH ADMIN OPTION, INHERIT FALSE, SET FALSE`,
    );
  }, 240_000);

  afterAll(async () => {
    if (admin) {
      try {
        await dropTestDatabase(admin, database);
        await dropRoles(admin, [appUser, workerUser, maintUser, migratorUser]);
      } finally {
        await endTestPool(admin);
      }
    }
  });

  // Role-level settings (all databases) as stored in pg_db_role_setting.
  async function settings(role: string) {
    const { rows } = await admin.query<{ config: string }>(
      `SELECT c AS config
         FROM pg_db_role_setting s, unnest(s.setconfig) AS c
        WHERE s.setrole = (SELECT oid FROM pg_roles WHERE rolname = $1)
        ORDER BY c`,
      [role],
    );
    return rows.map((row) => row.config);
  }

  const timeout = ["idle_in_transaction_session_timeout=5min"];
  const provision = () =>
    provisionRoles({
      adminUrl: migratorUrl,
      appUrl,
      workerUrl,
      maintenanceUrl: maintUrl,
    });

  it("creates the logins with 5min on app and queue and nothing on maintenance", async () => {
    const result = await provision();
    expect(result.app.outcome).toBe("created");
    expect(result.worker?.outcome).toBe("created");
    expect(result.maintenance?.outcome).toBe("created");
    expect(await settings(appUser)).toEqual(timeout);
    expect(await settings(workerUser)).toEqual(timeout);
    expect(await settings(maintUser)).toEqual([]);
  }, 120_000);

  it("a re-run removes drift but keeps the timeout; maintenance stays without one", async () => {
    await admin.query(`ALTER ROLE "${appUser}" SET search_path = public`);
    await admin.query(`ALTER ROLE "${workerUser}" SET search_path = public`);
    await admin.query(`ALTER ROLE "${maintUser}" SET search_path = public`);
    expect(await settings(appUser)).toEqual([
      "idle_in_transaction_session_timeout=5min",
      "search_path=public",
    ]);

    const result = await provision();
    expect(result.app.outcome).toBe("updated");
    expect(result.worker?.outcome).toBe("updated");
    expect(result.maintenance?.outcome).toBe("updated");
    expect(await settings(appUser)).toEqual(timeout);
    expect(await settings(workerUser)).toEqual(timeout);
    expect(await settings(maintUser)).toEqual([]);
    await expect(
      auditRoles({
        adminUrl: migratorUrl,
        appUrl,
        workerUrl,
        maintenanceUrl: maintUrl,
      }),
    ).resolves.not.toThrow();
  }, 120_000);

  it("rejects the timeout on the maintenance login and any other value on app and queue", async () => {
    await admin.query(
      `ALTER ROLE "${maintUser}" SET idle_in_transaction_session_timeout = '5min'`,
    );
    await expect(
      auditRoles({
        adminUrl: migratorUrl,
        appUrl,
        workerUrl,
        maintenanceUrl: maintUrl,
      }),
    ).rejects.toThrow(/role-level settings/);
    // Provisioning resets the hand-set value again.
    await provision();
    expect(await settings(maintUser)).toEqual([]);

    await admin.query(
      `ALTER ROLE "${appUser}" SET idle_in_transaction_session_timeout = '15min'`,
    );
    await expect(
      auditRoles({
        adminUrl: migratorUrl,
        appUrl,
        workerUrl,
        maintenanceUrl: maintUrl,
      }),
    ).rejects.toThrow(/role-level settings/);
    await provision();
    expect(await settings(appUser)).toEqual(timeout);
  }, 120_000);
});
