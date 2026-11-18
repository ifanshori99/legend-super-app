import { dropTestDatabase, endTestPool } from "./helpers/database-cleanup.ts";
// Brief 88 section D (beads legend-jtnd, legend-k1np). Proves the production
// migrator login and the pre-deploy check on scratch databases of the
// disposable test server (same guard and cleanup as
// edge-received-events-migration.test.ts):
//   - provisionMigrator creates legend_migrator_<16 hex> (LOGIN NOSUPERUSER
//     BYPASSRLS CREATEROLE) and makes it the database owner;
//   - that login can run all of apps/api/drizzle from zero (jtnd: a plain owner
//     without BYPASSRLS cannot, because FK validation under FORCE RLS raises
//     "tenant context is required");
//   - restricted app/worker logins can then be provisioned through it and
//     remain subject to tenant RLS;
//   - runPredeployCheck accepts per-destination outbox streams and rejects an
//     old-scheme stream (k1np).
// Tests inside a describe run in order and share state, like the pattern test.
// Assumptions where the brief is silent: the report for an absent outbox is
// only asserted on `present: false`; the failure message for k1np is asserted
// to name the offending destination and to leak no tenant id.
import { randomBytes, randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provisionMigrator, MIGRATOR_LOGIN } from "../db/migrator-role";
import { runPredeployCheck } from "../db/predeploy-check";
import { readJournal } from "../db/release-gates";
import { provisionRoles } from "../db/provision-roles";

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

// drizzle-orm wraps a failing statement in an error whose message is only the
// SQL; the server message lives on `cause`. Join the whole chain.
async function failureText(promise: Promise<unknown>) {
  const texts: string[] = [];
  await promise.then(
    () => texts.push("(resolved)"),
    (error: unknown) => {
      for (let e = error; e instanceof Error; e = e.cause)
        texts.push(e.message);
    },
  );
  return texts.join("\n");
}

// Best effort: the whole server is disposable, a role that cannot be dropped
// (for example because it granted membership in a shared group) must not turn
// a green run red.
async function dropRoles(admin: Pool, roles: string[]) {
  for (const role of roles)
    await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined);
}

// Seeds one tenant with an outlet through a session that bypasses RLS.
async function seedTenant(pool: Pool, tenantId: string, label: string) {
  const brand = randomUUID();
  const entity = randomUUID();
  const suffix = hex(4);
  await pool.query(
    `INSERT INTO tenants (id, slug, name, plan, deployment_mode, limits, created_by)
     VALUES ($1, $2, $3, 'starter', 'shared', '{}'::jsonb, $4)`,
    [tenantId, `migrator-uji-${suffix}`, `Tenant ${label}`, randomUUID()],
  );
  await pool.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand')`,
    [brand, tenantId, `migrator-uji-${suffix}`],
  );
  await pool.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)`,
    [entity, tenantId],
  );
  await pool.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Uji', '{}', 'active')`,
    [
      randomUUID(),
      tenantId,
      brand,
      entity,
      // Outlet code must match ^[A-Z0-9][A-Z0-9-]{0,19}$: uppercase suffix.
      `UJI-${suffix.toUpperCase()}`,
      `Outlet ${label}`,
    ],
  );
}

// One outbox row. The table CHECK requires the event JSON to repeat tenant,
// aggregate type and sequence.
function outboxRow(
  pool: Pool,
  row: {
    tenantId: string;
    aggregateId: string;
    destination: string;
    sequence: number;
  },
) {
  const eventId = randomUUID();
  return pool.query(
    `INSERT INTO domain_event_outbox
       (tenant_id, id, event_id, aggregate_type, aggregate_id, sequence, event, destination)
     VALUES ($1, $2, $3, 'order', $4, $5, $6::jsonb, $7)`,
    [
      row.tenantId,
      randomUUID(),
      eventId,
      row.aggregateId,
      row.sequence,
      JSON.stringify({
        tenantId: row.tenantId,
        aggregateType: "order",
        aggregateId: row.aggregateId,
        eventId,
        sequence: row.sequence,
      }),
      row.destination,
    ],
  );
}

describe("legend-jtnd dedicated migrator login owns the database", () => {
  const database = `migrator_role_${hex(6)}`;
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
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  let migratorUrl: string;
  let appUrl: string;
  let workerUrl: string;
  let admin: Pool; // superuser on the server's default database
  let migrator: Pool; // the new login, on the scratch database
  let strangerRole: string | undefined;

  beforeAll(async () => {
    assertDisposableServer();
    migratorUrl = urlFor(database, migratorUser, migratorPassword);
    appUrl = urlFor(database, appUser, appPassword);
    workerUrl = urlFor(database, workerUser, workerPassword);
    admin = new Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`CREATE DATABASE "${database}"`);
  }, 60_000);

  afterAll(async () => {
    if (migrator) await endTestPool(migrator);
    if (admin) {
      try {
        await dropTestDatabase(admin, database);
        await dropRoles(admin, [
          appUser,
          workerUser,
          migratorUser,
          ...(strangerRole ? [strangerRole] : []),
        ]);
      } finally {
        await endTestPool(admin);
      }
    }
  });

  const roleFlags = (role: string) =>
    admin.query(
      `SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolcanlogin
         FROM pg_roles WHERE rolname = $1`,
      [role],
    );

  it("creates the migrator login (NOSUPERUSER, BYPASSRLS, CREATEROLE) and makes it database owner; a second run reports updated", async () => {
    expect(MIGRATOR_LOGIN.test(migratorUser)).toBe(true);
    const first = await provisionMigrator({
      bootstrap,
      migratorUrl,
      appUrl,
      workerUrl,
    });
    expect(first).toEqual({ user: migratorUser, outcome: "created" });
    expect((await roleFlags(migratorUser)).rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: true,
      rolcreaterole: true,
      rolcreatedb: false,
      rolreplication: false,
      rolcanlogin: true,
    });
    const owner = await admin.query(
      `SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1`,
      [database],
    );
    expect(owner.rows[0].owner).toBe(migratorUser);

    const second = await provisionMigrator({
      bootstrap,
      migratorUrl,
      appUrl,
      workerUrl,
    });
    expect(second).toEqual({ user: migratorUser, outcome: "updated" });
    expect((await roleFlags(migratorUser)).rows[0]).toMatchObject({
      rolsuper: false,
      rolbypassrls: true,
      rolcreaterole: true,
    });
    // New session, after the role exists: used by every test below.
    migrator = new Pool({ connectionString: migratorUrl, max: 2 });
  }, 60_000);

  it("refuses a migrator login that equals the bootstrap login or has a bad name", async () => {
    await expect(
      provisionMigrator({
        bootstrap,
        migratorUrl: urlFor(database, "not_a_migrator", migratorPassword),
      }),
    ).rejects.toThrow();
    await expect(
      provisionMigrator({
        bootstrap: { user: migratorUser, password: migratorPassword },
        migratorUrl,
      }),
    ).rejects.toThrow();
  });

  it("passes the pre-deploy check on the empty database (outbox absent)", async () => {
    const lines: string[] = [];
    const report = await runPredeployCheck(migratorUrl, {
      log: (line) => lines.push(line),
    });
    expect(report.migrator).toEqual({
      user: migratorUser,
      superuser: false,
      bypassRls: true,
    });
    expect(report.outbox.present).toBe(false);
    // legend-1100: a brand new database has no applied migrations, so the
    // release 1 data gates are N/A and say so in the log.
    expect(report.releaseGates).toEqual({ status: "n/a" });
    expect(lines).toContain("gerbang data rilis 1: N/A (DB baru)");
  });

  it("applies every migration from zero as the migrator", async () => {
    await expect(
      migrate(drizzle(migrator), { migrationsFolder: drizzleFolder }),
    ).resolves.not.toThrow();
  }, 180_000);

  // Assumption: PostgreSQL 16+ (pg_auth_members.inherit_option/set_option), as
  // the brief states. legend_app is created by drizzle/0001, so it exists here.
  it("gives the migrator ADMIN-only membership (no inherit, no set) on a pre-existing legend_app, and nothing on unlisted roles", async () => {
    // Role names beginning legend_runtime_ that are NOT in the URLs: another
    // deploy's login on the same server. Must receive no grant.
    const stranger = `legend_runtime_${hex(8)}`;
    strangerRole = stranger;
    expect(stranger).not.toBe(appUser);
    await admin.query(`CREATE ROLE "${stranger}" NOLOGIN`);
    // Start from a state where the migrator holds no explicit membership.
    await admin
      .query(`REVOKE "legend_app" FROM "${migratorUser}"`)
      .catch(() => undefined);

    await provisionMigrator({ bootstrap, migratorUrl, appUrl, workerUrl });

    const memberships = (role: string) =>
      admin.query(
        `SELECT m.admin_option, m.inherit_option, m.set_option
           FROM pg_auth_members m
           JOIN pg_roles r ON r.oid = m.roleid
           JOIN pg_roles u ON u.oid = m.member
          WHERE r.rolname = $1 AND u.rolname = $2`,
        [role, migratorUser],
      );
    const onApp = await memberships("legend_app");
    expect(onApp.rows.length).toBeGreaterThan(0);
    for (const row of onApp.rows)
      expect(row).toEqual({
        admin_option: true,
        inherit_option: false,
        set_option: false,
      });
    expect((await memberships(stranger)).rows).toEqual([]);
  }, 60_000);

  it("leaves every table owned by the migrator with row level security still forced", async () => {
    const foreign = await migrator.query(
      `SELECT n.nspname, c.relname, pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('public', 'app', 'drizzle')
          AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
          AND pg_get_userbyid(c.relowner) <> $1`,
      [migratorUser],
    );
    expect(foreign.rows).toEqual([]);
    const tables = await migrator.query(
      `SELECT count(*)::int AS n FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
          AND pg_get_userbyid(relowner) = $1`,
      [migratorUser],
    );
    expect(tables.rows[0].n).toBeGreaterThan(10);
    const flags = await migrator.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relnamespace = 'public'::regnamespace
          AND relname IN ('domain_event_outbox', 'outlets')`,
    );
    expect(flags.rows.map((r) => r.relname).sort()).toEqual([
      "domain_event_outbox",
      "outlets",
    ]);
    for (const row of flags.rows) {
      expect(row.relrowsecurity, `${row.relname} row security`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} FORCE`).toBe(true);
    }
  });

  it("provisions the restricted logins through the migrator; the app login stays under tenant RLS", async () => {
    await expect(
      provisionRoles({ adminUrl: migratorUrl, appUrl, workerUrl }),
    ).resolves.toMatchObject({
      app: { user: appUser },
      worker: { user: workerUser },
    });
    const app = await roleFlags(appUser);
    expect(app.rows[0]).toMatchObject({
      rolbypassrls: false,
      rolsuper: false,
      rolcanlogin: true,
    });

    // Seeded through the migrator, which bypasses RLS.
    await seedTenant(migrator, tenantA, "A");
    await seedTenant(migrator, tenantB, "B");

    const client = new Client({ connectionString: appUrl });
    await client.connect();
    try {
      await expect(
        client.query("SELECT tenant_id FROM outlets"),
      ).rejects.toThrow(/tenant context is required/);
      // Session-level setting: the same connection keeps it across queries.
      await client.query("SELECT set_config('app.tenant_id', $1, false)", [
        tenantA,
      ]);
      const own = await client.query("SELECT tenant_id FROM outlets");
      expect(own.rowCount).toBe(1);
      expect(own.rows.every((r) => r.tenant_id === tenantA)).toBe(true);
    } finally {
      await client.end();
    }
  }, 60_000);

  it("re-runs provisionMigrator after provisionRoles: still allowed, reports updated", async () => {
    // provisionWorker leaves the migrator with SET (no INHERIT) on the queue
    // login; that membership must not make the migrator check refuse.
    await expect(
      provisionMigrator({ bootstrap, migratorUrl, appUrl, workerUrl }),
    ).resolves.toEqual({ user: migratorUser, outcome: "updated" });
  }, 60_000);

  it("passes the pre-deploy check with per-destination contiguous outbox rows and fails with legend-k1np on an old-scheme stream", async () => {
    const aggregateOk = randomUUID();
    // Same aggregate, two destinations, each counting 1, 2 from its own start.
    for (const [destination, sequence] of [
      ["dest-x", 1],
      ["dest-x", 2],
      ["dest-y", 1],
    ] as const)
      await outboxRow(migrator, {
        tenantId: tenantA,
        aggregateId: aggregateOk,
        destination,
        sequence,
      });
    const total = await migrator.query(
      "SELECT count(*)::int AS n FROM domain_event_outbox",
    );
    const clean = await runPredeployCheck(migratorUrl);
    expect(clean.outbox).toEqual({
      present: true,
      rows: total.rows[0].n,
      oldSchemeStreams: 0,
    });
    // legend-1100: after a full migration the 1100 gates have their "before"
    // migration applied, so they are skipped and nothing is blocked. Gates
    // with "before: none" (other branches) may still run on clean data.
    expect(clean.releaseGates.status).toBe("ok");
    if (clean.releaseGates.status === "ok") {
      expect(clean.releaseGates.applied).toBe(
        readJournal(drizzleFolder).length,
      );
      for (const gate of ["legend-176r3", "legend-oh2a5"])
        expect(clean.releaseGates.skipped).toContainEqual({
          gate,
          reason: "before-applied",
        });
    }

    // Old scheme: one count shared across destinations, so destination
    // dest-old-y starts at 2.
    const aggregateOld = randomUUID();
    await outboxRow(migrator, {
      tenantId: tenantA,
      aggregateId: aggregateOld,
      destination: "dest-old-x",
      sequence: 1,
    });
    await outboxRow(migrator, {
      tenantId: tenantA,
      aggregateId: aggregateOld,
      destination: "dest-old-y",
      sequence: 2,
    });
    const failure = await runPredeployCheck(migratorUrl).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toMatch(/legend-k1np/);
    expect(message).toContain("dest-old-y");
    // Destination names only: no tenant id, no URL, no password.
    expect(message).not.toContain(tenantA);
    expect(message).not.toContain(migratorPassword);
  }, 60_000);

  it("fails the pre-deploy check with legend-fgg1h when an applied migration hash differs from its file", async () => {
    // Assumption: the outbox check (legend-k1np) runs first, so remove the
    // old-scheme rows of the previous test; this test is about migration drift.
    await migrator.query(
      "DELETE FROM domain_event_outbox WHERE destination LIKE 'dest-old-%'",
    );
    const entries = readJournal(drizzleFolder);
    const target = entries[entries.length - 1] as (typeof entries)[number];
    const original = await migrator.query(
      "SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at = $1",
      [target.when],
    );
    expect(original.rowCount).toBe(1);
    const originalHash = original.rows[0].hash as string;
    await migrator.query(
      "UPDATE drizzle.__drizzle_migrations SET hash = $1 WHERE created_at = $2",
      ["0".repeat(64), target.when],
    );
    try {
      const failure = await runPredeployCheck(migratorUrl).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toMatch(/legend-fgg1h/);
      expect(message).toContain(target.tag);
      expect(message).not.toMatch(/postgres(ql)?:\/\//);
      expect(message).not.toContain(migratorPassword);
    } finally {
      await migrator.query(
        "UPDATE drizzle.__drizzle_migrations SET hash = $1 WHERE created_at = $2",
        [originalHash, target.when],
      );
    }
    // Restored: the check no longer reports drift.
    const after = await runPredeployCheck(migratorUrl);
    expect(after.releaseGates.status).toBe("ok");
  }, 60_000);
});

describe("legend-jtnd refusal: bootstrap-owned objects in the database", () => {
  const database = `migrator_boot_${hex(6)}`;
  const migratorUser = `legend_migrator_${hex(8)}`;
  const migratorPassword = hex(24);
  let admin: Pool;
  let bootstrap: { user: string; password: string };

  beforeAll(async () => {
    assertDisposableServer();
    const url = new URL(adminUrl as string);
    bootstrap = {
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
    admin = new Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`CREATE DATABASE "${database}"`);
    // Object owned by the bootstrap (test) superuser, as an earlier migration
    // run by that login would leave it.
    const client = new Client({ connectionString: urlFor(database) });
    await client.connect();
    try {
      await client.query("CREATE TABLE earlier_run (id int)");
    } finally {
      await client.end();
    }
  }, 60_000);

  afterAll(async () => {
    if (admin) {
      try {
        await dropTestDatabase(admin, database);
        await dropRoles(admin, [migratorUser]);
      } finally {
        await endTestPool(admin);
      }
    }
  });

  it("refuses and points at ALTER ... OWNER when the bootstrap superuser owns tables", async () => {
    const oid = await admin.query(
      "SELECT oid::int AS oid FROM pg_roles WHERE rolname = current_user",
    );
    const text = await failureText(
      provisionMigrator({
        bootstrap,
        migratorUrl: urlFor(database, migratorUser, migratorPassword),
      }),
    );
    expect(text).not.toBe("(resolved)");
    expect(text).toMatch(/migrated by another login/);
    expect(text).not.toContain(migratorPassword);
    expect(text).not.toContain(bootstrap.password);
    // Assumption: advice names the bootstrap superuser and ALTER ... OWNER only
    // when the test superuser is oid 10; otherwise REASSIGN OWNED advice applies.
    if (oid.rows[0].oid === 10) {
      expect(text).toMatch(/bootstrap superuser/);
      expect(text).toMatch(/ALTER .*OWNER/);
    }
  }, 60_000);
});

describe("legend-jtnd contrast: a plain table owner without BYPASSRLS", () => {
  const database = `migrator_plain_${hex(6)}`;
  const ownerRole = `plain_owner_${hex(6)}`;
  const ownerPassword = hex(24);
  let admin: Pool;
  let owner: Pool;
  let ownerUrl: string;

  beforeAll(async () => {
    assertDisposableServer();
    ownerUrl = urlFor(database, ownerRole, ownerPassword);
    admin = new Pool({ connectionString: adminUrl, max: 1 });
    // Role name and hex password are generated here; DDL takes no bind
    // parameters, so interpolation is safe.
    await admin.query(
      `CREATE ROLE "${ownerRole}" LOGIN PASSWORD '${ownerPassword}' NOSUPERUSER NOBYPASSRLS CREATEROLE NOCREATEDB`,
    );
    await admin.query(`CREATE DATABASE "${database}" OWNER "${ownerRole}"`);
    owner = new Pool({ connectionString: ownerUrl, max: 1 });
  }, 60_000);

  afterAll(async () => {
    if (owner) await endTestPool(owner);
    if (admin) {
      try {
        await dropTestDatabase(admin, database);
        await dropRoles(admin, [ownerRole]);
      } finally {
        await endTestPool(admin);
      }
    }
  });

  it("is rejected by the pre-deploy check with legend-jtnd", async () => {
    await expect(runPredeployCheck(ownerUrl)).rejects.toThrow(/legend-jtnd/);
  });

  it("cannot run the migrations from zero: tenant context is required", async () => {
    const text = await failureText(
      migrate(drizzle(owner), { migrationsFolder: drizzleFolder }),
    );
    expect(text).toMatch(/tenant context is required/);
  }, 180_000);
});
