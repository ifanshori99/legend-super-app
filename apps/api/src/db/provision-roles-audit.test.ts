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
import {
  dropTestDatabase,
  endTestPool,
} from "../test/helpers/database-cleanup.ts";

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
      await endTestPool(migrator);
    }
    await admin.query(
      `GRANT legend_maintenance TO "${migratorUser}" WITH ADMIN OPTION, INHERIT FALSE, SET FALSE`,
    );
  }, 240_000);

  afterAll(async () => {
    if (admin) {
      await restore();
      try {
        await dropTestDatabase(admin, database);
        await dropRoles(admin, [appUser, workerUser, maintUser, migratorUser]);
      } finally {
        await endTestPool(admin);
      }
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
        await endTestPool(inDatabase);
      }
      await expect(auditRoles(urls())).resolves.not.toThrow();
    }, 120_000);
  }
});

// legend-1081 (briefs docs/briefs/1081-provisioning-db-rls-pengerasan.md): the
// audit must reject three kinds of drift that an app/worker login can pick up
// and that a clean provision never grants. Written from the brief, not from
// the implementation. One scratch database for the whole describe; every drift
// is undone in a `finally` and the audit must pass again afterwards.
//
// Assumptions (the brief is silent), each easy to change:
//  - A rejecting audit names the offending relation, function or column
//    (a regex on the object name below), so the operator sees what to fix.
//  - Each drift test first proves the audit passes with the fixture present but
//    not yet over-granted ("control"), so a red result means the drift was
//    missed, not that the fixture upsets the audit.
//  - su9c: any right on a pgboss (queue login) relation held by the app login
//    is drift, even though app rights are allowed on other relations.
//  - ecgfy: a grant to the app login on an extension function (pg_init_privs
//    privtype 'e') or on a column of a sensitive catalog is drift. The
//    pg_user_mapping.umoptions and pg_subscription.subconninfo cases are
//    regression guards (already denied today through SENSITIVE_TABLES).
//  - eyscy: a SECURITY DEFINER function in schema `app` that PUBLIC may still
//    execute is drift; a SECURITY INVOKER one is not.
describe("legend-1081 audit rejects su9c, ecgfy and eyscy drift", () => {
  const database = `audit_1081_${hex(6)}`;
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
  let sup: Pool; // superuser on the scratch database
  let mig: Pool; // migrator on the scratch database

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
    // Same reason as the idle-timeout describe above.
    await admin.query(
      `GRANT legend_maintenance TO "${migratorUser}" WITH ADMIN OPTION, INHERIT FALSE, SET FALSE`,
    );
    sup = new Pool({ connectionString: urlFor(database), max: 1 });
    mig = new Pool({ connectionString: migratorUrl, max: 1 });
    await provisionRoles(urls());
  }, 240_000);

  afterAll(async () => {
    if (mig) await endTestPool(mig);
    if (sup) await endTestPool(sup);
    if (admin) {
      try {
        await dropTestDatabase(admin, database);
        await dropRoles(admin, [appUser, workerUser, maintUser, migratorUser]);
      } finally {
        await endTestPool(admin);
      }
    }
  });

  const urls = () => ({
    adminUrl: migratorUrl,
    appUrl,
    workerUrl,
    maintenanceUrl: maintUrl,
  });

  async function run(pool: Pool, statements: string[]) {
    for (const statement of statements) await pool.query(statement);
  }

  // prepare -> control audit passes -> drift -> audit rejects -> restore ->
  // audit passes again. `restore` always runs, errors in it are swallowed.
  async function drift(options: {
    pool: Pool;
    prepare: string[];
    drift: string[];
    restore: string[];
    pattern: RegExp;
  }) {
    try {
      await run(options.pool, options.prepare);
      await expect(auditRoles(urls())).resolves.not.toThrow();
      await run(options.pool, options.drift);
      await expect(auditRoles(urls())).rejects.toThrow(options.pattern);
    } finally {
      for (const statement of options.restore)
        await options.pool.query(statement).catch(() => undefined);
    }
    await expect(auditRoles(urls())).resolves.not.toThrow();
  }

  it("control: the freshly provisioned set passes the audit", async () => {
    await expect(auditRoles(urls())).resolves.not.toThrow();
  }, 120_000);

  // ---- su9c: app login may not hold rights on queue (pgboss) relations ----
  const queueFixture = "pgboss.zz_drift_fixture";
  const queuePrepare = [
    `CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION "${workerUser}"`,
    `CREATE TABLE ${queueFixture} (id int)`,
    `ALTER TABLE ${queueFixture} OWNER TO "${workerUser}"`,
  ];
  for (const right of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
    it(`legend-su9c audit fails when the app login holds ${right} on a pgboss table`, async () => {
      await drift({
        pool: sup,
        prepare: queuePrepare,
        drift: [`GRANT ${right} ON TABLE ${queueFixture} TO "${appUser}"`],
        restore: [
          `REVOKE ALL ON TABLE ${queueFixture} FROM "${appUser}"`,
          `DROP TABLE IF EXISTS ${queueFixture}`,
        ],
        pattern: /zz_drift_fixture/,
      });
    }, 120_000);
  }

  // su9c, schema level: the app login may not even USAGE the pgboss schema.
  const queueSchemaPrepare = [
    `CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION "${workerUser}"`,
  ];
  it("legend-su9c audit fails when the app login holds USAGE on the pgboss schema", async () => {
    await drift({
      pool: sup,
      prepare: queueSchemaPrepare,
      drift: [`GRANT USAGE ON SCHEMA pgboss TO "${appUser}"`],
      restore: [`REVOKE ALL ON SCHEMA pgboss FROM "${appUser}"`],
      pattern: /pgboss/,
    });
  }, 120_000);

  // su9c, sequences: any right on a pgboss sequence held by the app login.
  const queueSequence = "pgboss.zz_drift_seq";
  const queueSequencePrepare = [
    ...queueSchemaPrepare,
    `CREATE SEQUENCE ${queueSequence}`,
    `ALTER SEQUENCE ${queueSequence} OWNER TO "${workerUser}"`,
  ];
  for (const right of ["USAGE", "SELECT", "UPDATE"]) {
    it(`legend-su9c audit fails when the app login holds ${right} on a pgboss sequence`, async () => {
      await drift({
        pool: sup,
        prepare: queueSequencePrepare,
        drift: [`GRANT ${right} ON SEQUENCE ${queueSequence} TO "${appUser}"`],
        restore: [
          `REVOKE ALL ON SEQUENCE ${queueSequence} FROM "${appUser}"`,
          `DROP SEQUENCE IF EXISTS ${queueSequence}`,
        ],
        pattern: /pgboss/,
      });
    }, 120_000);
  }

  // su9c, default privileges: a default ACL that hands the app login rights on
  // every future table the queue login creates in pgboss is drift.
  it("legend-su9c audit fails on a default privilege from the queue login in pgboss to the app login", async () => {
    await drift({
      pool: sup,
      prepare: queueSchemaPrepare,
      drift: [
        `ALTER DEFAULT PRIVILEGES FOR ROLE "${workerUser}" IN SCHEMA pgboss GRANT SELECT ON TABLES TO "${appUser}"`,
      ],
      restore: [
        `ALTER DEFAULT PRIVILEGES FOR ROLE "${workerUser}" IN SCHEMA pgboss REVOKE ALL ON TABLES FROM "${appUser}"`,
      ],
      pattern: /pgboss/,
    });
  }, 120_000);

  // su9c, architect P2: a global default ACL of the queue login for functions
  // lists the built-in PUBLIC EXECUTE next to the new grantee. That grants the
  // app login nothing it did not already have, so it is not drift.
  it("legend-su9c audit ignores the built-in PUBLIC execute in a global function default of the queue login", async () => {
    try {
      await run(sup, [
        ...queueSchemaPrepare,
        `ALTER DEFAULT PRIVILEGES FOR ROLE "${workerUser}" GRANT EXECUTE ON FUNCTIONS TO pg_monitor`,
      ]);
      await expect(auditRoles(urls())).resolves.not.toThrow();
    } finally {
      await sup
        .query(
          `ALTER DEFAULT PRIVILEGES FOR ROLE "${workerUser}" REVOKE ALL ON FUNCTIONS FROM pg_monitor`,
        )
        .catch(() => undefined);
    }
  }, 120_000);

  // su9c control: pgboss objects (schema, table, sequence) with no right for
  // the app login at all pass the audit.
  it("legend-su9c audit passes when the app login holds no right on pgboss objects", async () => {
    try {
      await run(sup, [
        ...queueSequencePrepare,
        `CREATE TABLE IF NOT EXISTS ${queueFixture} (id int)`,
        `ALTER TABLE ${queueFixture} OWNER TO "${workerUser}"`,
        `REVOKE ALL ON SCHEMA pgboss FROM "${appUser}"`,
        `REVOKE ALL ON TABLE ${queueFixture} FROM "${appUser}"`,
        `REVOKE ALL ON SEQUENCE ${queueSequence} FROM "${appUser}"`,
      ]);
      await expect(auditRoles(urls())).resolves.not.toThrow();
    } finally {
      await sup
        .query(`DROP TABLE IF EXISTS ${queueFixture}`)
        .catch(() => undefined);
      await sup
        .query(`DROP SEQUENCE IF EXISTS ${queueSequence}`)
        .catch(() => undefined);
    }
  }, 120_000);

  // ---- ecgfy: extension functions and sensitive catalog columns ----
  it("legend-ecgfy audit fails when the app login can execute an extension function", async () => {
    await drift({
      pool: sup,
      prepare: [`CREATE EXTENSION IF NOT EXISTS pg_buffercache`],
      drift: [
        `GRANT EXECUTE ON FUNCTION public.pg_buffercache_pages() TO "${appUser}"`,
      ],
      restore: [
        `REVOKE ALL ON FUNCTION public.pg_buffercache_pages() FROM "${appUser}"`,
        `DROP EXTENSION IF EXISTS pg_buffercache`,
      ],
      pattern: /pg_buffercache/,
    });
  }, 120_000);

  it("legend-ecgfy regression: audit still fails on a pg_user_mapping.umoptions column grant", async () => {
    await drift({
      pool: sup,
      prepare: [],
      drift: [
        `GRANT SELECT (umoptions) ON TABLE pg_catalog.pg_user_mapping TO "${appUser}"`,
      ],
      restore: [
        `REVOKE ALL (umoptions) ON TABLE pg_catalog.pg_user_mapping FROM "${appUser}"`,
      ],
      pattern: /pg_user_mapping|umoptions/,
    });
  }, 120_000);

  it("legend-ecgfy regression: audit still fails on a pg_subscription.subconninfo column grant", async () => {
    await drift({
      pool: sup,
      prepare: [],
      drift: [
        `GRANT SELECT (subconninfo) ON TABLE pg_catalog.pg_subscription TO "${appUser}"`,
      ],
      restore: [
        `REVOKE ALL (subconninfo) ON TABLE pg_catalog.pg_subscription FROM "${appUser}"`,
      ],
      pattern: /pg_subscription|subconninfo/,
    });
  }, 120_000);

  // ---- eyscy: SECURITY DEFINER functions in schema app need PUBLIC revoked ----
  it("legend-eyscy audit fails on a SECURITY DEFINER app function that PUBLIC can execute", async () => {
    const fn = "app.zz_secdef_fixture()";
    await drift({
      pool: mig,
      prepare: [],
      drift: [
        `CREATE FUNCTION ${fn} RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$ SELECT 1 $$`,
      ],
      restore: [`DROP FUNCTION IF EXISTS ${fn}`],
      pattern: /zz_secdef_fixture/,
    });
  }, 120_000);

  it("legend-eyscy audit passes once PUBLIC execute is revoked from that function", async () => {
    const fn = "app.zz_secdef_revoked()";
    try {
      await mig.query(
        `CREATE FUNCTION ${fn} RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$ SELECT 1 $$`,
      );
      await mig.query(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC`);
      await expect(auditRoles(urls())).resolves.not.toThrow();
    } finally {
      await mig.query(`DROP FUNCTION IF EXISTS ${fn}`).catch(() => undefined);
    }
  }, 120_000);

  it("legend-eyscy audit ignores a SECURITY INVOKER app function that PUBLIC can execute", async () => {
    const fn = "app.zz_invoker_fixture()";
    try {
      await mig.query(
        `CREATE FUNCTION ${fn} RETURNS int LANGUAGE sql SET search_path = pg_catalog AS $$ SELECT 1 $$`,
      );
      await expect(auditRoles(urls())).resolves.not.toThrow();
    } finally {
      await mig.query(`DROP FUNCTION IF EXISTS ${fn}`).catch(() => undefined);
    }
  }, 120_000);
});
