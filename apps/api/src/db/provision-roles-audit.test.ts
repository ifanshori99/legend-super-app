// Role audit must FIND a missing idle_in_transaction_session_timeout (bead
// legend-sdqni, brief docs/briefs/ecf-482.md card 3). `deploy/single-vm/deploy.sh`
// runs `provision-roles.sh --audit` before it starts the services; the audit
// (`auditRoles`) must fail when the application or the queue login has no
// idle_in_transaction_session_timeout = 5min, because one idle open transaction
// then pins pg_snapshot_xmin and stops catalog and PIN sync (docs/deployment.md,
// "Idle transactions"). Written from the brief and docs/deployment.md, not from
// the implementation. Same disposable-server guard and scratch database as
// provision-roles-idle-timeout.test.ts (legend-9h0kg), which covers the WRONG
// value; this file covers the MISSING value.
//
// Assumptions (the brief is silent), each easy to change:
//  - A failing audit rejects with a message that names
//    `idle_in_transaction_session_timeout` (so the operator sees what to fix).
//  - A role with other role-level settings but no timeout also fails.
// Tests inside the describe run in order and share state.
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provisionMigrator } from "./migrator-role";
import { auditRoles, provisionRoles } from "./provision-roles";

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

// Pool.end() resolves before the server has closed the sessions; wait them out
// so DROP DATABASE ... WITH (FORCE) does not race a closing client (57P01).
async function waitForNoSessions(admin: Pool, database: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { rows } = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1",
      [database],
    );
    if (rows[0]?.n === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// Best effort: the whole server is disposable.
async function dropRoles(admin: Pool, roles: string[]) {
  for (const role of roles)
    await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined);
}

describe("legend-sdqni audit demands idle_in_transaction_session_timeout on app and queue", () => {
  const database = `audit_idle_${hex(6)}`;
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
      await migrator.end();
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
      await waitForNoSessions(admin, database);
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      await dropRoles(admin, [appUser, workerUser, maintUser, migratorUser]);
      await admin.end();
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
  const urls = () => ({
    adminUrl: migratorUrl,
    appUrl,
    workerUrl,
    maintenanceUrl: maintUrl,
  });
  const provision = () => provisionRoles(urls());

  it("control: a freshly provisioned set passes the audit", async () => {
    await provision();
    expect(await settings(appUser)).toEqual(timeout);
    expect(await settings(workerUser)).toEqual(timeout);
    await expect(auditRoles(urls())).resolves.not.toThrow();
  }, 120_000);

  it("fails when the application login has no timeout", async () => {
    await admin.query(
      `ALTER ROLE "${appUser}" RESET idle_in_transaction_session_timeout`,
    );
    expect(await settings(appUser)).toEqual([]);
    await expect(auditRoles(urls())).rejects.toThrow(
      /idle_in_transaction_session_timeout/,
    );
    await provision();
    await expect(auditRoles(urls())).resolves.not.toThrow();
  }, 120_000);

  it("fails when the queue login has no timeout", async () => {
    await admin.query(
      `ALTER ROLE "${workerUser}" RESET idle_in_transaction_session_timeout`,
    );
    expect(await settings(workerUser)).toEqual([]);
    await expect(auditRoles(urls())).rejects.toThrow(
      /idle_in_transaction_session_timeout/,
    );
    await provision();
    await expect(auditRoles(urls())).resolves.not.toThrow();
  }, 120_000);

  it("fails when a login was reset completely (RESET ALL, the state before legend-9h0kg)", async () => {
    await admin.query(`ALTER ROLE "${appUser}" RESET ALL`);
    await admin.query(`ALTER ROLE "${workerUser}" RESET ALL`);
    await expect(auditRoles(urls())).rejects.toThrow(
      /idle_in_transaction_session_timeout/,
    );
    await provision();
    await expect(auditRoles(urls())).resolves.not.toThrow();
  }, 120_000);

  it("fails when another role-level setting is present but the timeout is not", async () => {
    await admin.query(
      `ALTER ROLE "${appUser}" RESET idle_in_transaction_session_timeout`,
    );
    await admin.query(`ALTER ROLE "${appUser}" SET search_path = public`);
    await expect(auditRoles(urls())).rejects.toThrow(
      /idle_in_transaction_session_timeout|role-level settings/,
    );
    await provision();
    expect(await settings(appUser)).toEqual(timeout);
  }, 120_000);
});

// legend-qh11l F3: the audit must find a membership of legend_payout_recon that
// INHERITs. legend_app may reach the role by SET ROLE only (INHERIT FALSE, SET
// TRUE, drizzle/0481); with INHERIT TRUE every runtime login would hold
// EXECUTE on observe_ok and could record an 'ok' read, which frees a payout slip.
// Same scratch database pattern as above. The membership is cluster-wide, so
// every test restores it before it ends. Assumption: the failing audit names
// legend_payout_recon in its message.
describe("legend-qh11l audit demands legend_payout_recon to stay SET-only", () => {
  const database = `audit_recon_${hex(6)}`;
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
  let admin: Pool;

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
      await migrator.end();
    }
    await admin.query(
      `GRANT legend_maintenance TO "${migratorUser}" WITH ADMIN OPTION, INHERIT FALSE, SET FALSE`,
    );
  }, 240_000);

  afterAll(async () => {
    if (admin) {
      await restore();
      await waitForNoSessions(admin, database);
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      await dropRoles(admin, [appUser, workerUser, maintUser, migratorUser]);
      await admin.end();
    }
  });

  const urls = () => ({
    adminUrl: migratorUrl,
    appUrl,
    workerUrl,
    maintenanceUrl: maintUrl,
  });
  /** The state 0481 creates: legend_app reaches the recon role by SET only; the login has no direct grant. */
  async function restore() {
    await admin.query(`REVOKE legend_payout_recon FROM "${appUser}"`);
    await admin.query("REVOKE legend_payout_recon FROM legend_app");
    await admin.query(
      "GRANT legend_payout_recon TO legend_app WITH INHERIT FALSE, SET TRUE",
    );
  }

  it("control: a freshly provisioned set passes the audit with legend_app SET-only on the recon role", async () => {
    await provisionRoles(urls());
    const { rows } = await admin.query(
      `SELECT m.inherit_option AS inherit, m.set_option AS set, m.admin_option AS admin
         FROM pg_auth_members m
        WHERE m.roleid = 'legend_payout_recon'::regrole AND m.member = 'legend_app'::regrole`,
    );
    expect(rows).toEqual([{ inherit: false, set: true, admin: false }]);
    await expect(auditRoles(urls())).resolves.not.toThrow();
  }, 120_000);

  it("fails when legend_app is granted legend_payout_recon WITH INHERIT TRUE", async () => {
    try {
      await admin.query("REVOKE legend_payout_recon FROM legend_app");
      await admin.query(
        "GRANT legend_payout_recon TO legend_app WITH INHERIT TRUE, SET TRUE",
      );
      await expect(auditRoles(urls())).rejects.toThrow(/legend_payout_recon/);
    } finally {
      await restore();
    }
    await expect(auditRoles(urls())).resolves.not.toThrow();
  }, 120_000);

  it("fails when the runtime login itself is granted legend_payout_recon WITH INHERIT TRUE", async () => {
    try {
      await admin.query(
        `GRANT legend_payout_recon TO "${appUser}" WITH INHERIT TRUE, SET TRUE`,
      );
      await expect(auditRoles(urls())).rejects.toThrow(/legend_payout_recon/);
    } finally {
      await restore();
    }
    await expect(auditRoles(urls())).resolves.not.toThrow();
  }, 120_000);

  // The two proof observation functions may be executed by legend_payout_recon
  // only. A direct EXECUTE grant to legend_app must fail the audit; the grant is
  // revoked again in finally so the shared state stays clean.
  const observationFunctions = [
    "app.payout_recon_evidence_observe_difference(uuid,uuid,text,text)",
    "app.payout_recon_evidence_observe_internal(uuid,uuid,text,text,boolean)",
  ];
  for (const fn of observationFunctions) {
    it(`fails when legend_app is granted EXECUTE on ${fn.split("(")[0]}`, async () => {
      // Function ACLs are per database: `admin` is connected to the default
      // database, so the grant goes through a pool on the audited database.
      const inDatabase = new Pool({
        connectionString: urlFor(database, bootstrap.user, bootstrap.password),
        max: 1,
      });
      try {
        await inDatabase.query(`GRANT EXECUTE ON FUNCTION ${fn} TO legend_app`);
        await expect(auditRoles(urls())).rejects.toThrow(
          /proof observation functions outside legend_payout_recon/,
        );
      } finally {
        await inDatabase.query(
          `REVOKE EXECUTE ON FUNCTION ${fn} FROM legend_app`,
        );
        await inDatabase.end();
      }
      await expect(auditRoles(urls())).resolves.not.toThrow();
    }, 120_000);
  }
});
