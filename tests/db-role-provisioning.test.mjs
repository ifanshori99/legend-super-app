// First-boot database role provisioning (legend-zoqc, PRD §3 F3, TEN-02).
// Empty database → migrations → job (twice) → the application login reads and
// writes only through RLS and cannot run DDL or bypass RLS; the queue login
// touches only its own schema and the active tenant registry. The operator
// wrapper is exercised with a stubbed docker so no secret leaves the process.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import { pnpmCommand, root } from "../scripts/lib.mjs";
import { useRoleAuditLock } from "./helpers/role-audit-lock.mjs";

useRoleAuditLock();

const hex = (bytes) => randomBytes(bytes).toString("hex");
const tenantA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const tenantB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// Every password a test hands out. Every job run, failed or not, is checked
// against all of them.
const secrets = new Set();
function remember(url) {
  const password = decodeURIComponent(new URL(url).password);
  if (password) secrets.add(password);
  return url;
}
function leaks(output) {
  return [...secrets].filter((secret) => output.includes(secret));
}
function assertNoSecrets(result, context = "") {
  assert.deepEqual(
    leaks(result.stdout),
    [],
    `stdout leaks a password ${context}`,
  );
  assert.deepEqual(
    leaks(result.stderr),
    [],
    `stderr leaks a password ${context}`,
  );
}

const jobCommand = [
  "--filter",
  "@starter/api",
  "exec",
  "tsx",
  "src/provision-roles.ts",
];
// A clean environment: only what an operator would pass to the job.
const jobEnv = (env) => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  ...env,
});

function runJob(env, args = []) {
  const result = spawnSync(pnpmCommand(), [...jobCommand, ...args], {
    cwd: root,
    env: jobEnv(env),
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  assertNoSecrets(result);
  return result;
}

function runJobAsync(env) {
  return new Promise((done, fail) => {
    const child = spawn(pnpmCommand(), jobCommand, {
      cwd: root,
      env: jobEnv(env),
      shell: process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", fail);
    child.on("close", (status) => {
      const result = { status, stdout, stderr };
      try {
        assertNoSecrets(result);
        done(result);
      } catch (error) {
        fail(error);
      }
    });
  });
}

// Catalog state the job controls, without password verifiers (re-salted on
// every run): a second run must leave it exactly as the first did.
// Keep all grants to these logins and legend_app, and all members of these
// logins. Other legend_app members belong to parallel tests in this cluster.
async function snapshot(pool, roles) {
  const { rows } = await pool.query(
    `WITH r AS (SELECT oid FROM pg_roles WHERE rolname = ANY($1) OR rolname = 'legend_app')
     SELECT json_build_object(
       'roles', (SELECT json_agg(json_build_object('name', rolname, 'super', rolsuper, 'inherit', rolinherit,
                   'createrole', rolcreaterole, 'createdb', rolcreatedb, 'login', rolcanlogin,
                   'replication', rolreplication, 'bypassrls', rolbypassrls, 'connlimit', rolconnlimit,
                   'valid', rolvaliduntil::text) ORDER BY rolname)
                 FROM pg_roles WHERE oid IN (SELECT oid FROM r)),
       'members', (SELECT json_agg(json_build_object('role', roleid::regrole::text, 'member', member::regrole::text,
                     'grantor', grantor::regrole::text, 'admin', admin_option, 'inherit', inherit_option,
                     'set', set_option) ORDER BY roleid::regrole::text, member::regrole::text, grantor::regrole::text)
                   FROM pg_auth_members WHERE member IN (SELECT oid FROM r) OR roleid IN (SELECT oid FROM pg_roles WHERE rolname = ANY($1))),
       'settings', (SELECT count(*) FROM pg_db_role_setting WHERE setrole IN (SELECT oid FROM r)),
       'schemas', (SELECT json_agg(json_build_object('name', nspname, 'owner', nspowner::regrole::text,
                     'acl', nspacl::text) ORDER BY nspname)
                   FROM pg_namespace WHERE nspname IN ('app', 'public', 'pgboss')),
       'registry', (SELECT relacl::text FROM pg_class WHERE oid = 'app.active_tenant_registry'::regclass),
       'defaults', (SELECT json_agg(defaclacl::text ORDER BY defaclacl::text) FROM pg_default_acl)
     ) AS snapshot`,
    [roles],
  );
  return rows[0].snapshot;
}

// DROP DATABASE ... WITH (FORCE) in teardown terminates any idle connection
// still open to the scratch database; without a listener that surfaces as
// an unhandled "error" event and fails the test after it already passed.
function quietPool(options) {
  const pool = new Pool(options);
  pool.on("error", () => undefined);
  return pool;
}

function withDatabase(url, database) {
  const next = new URL(url);
  next.pathname = `/${database}`;
  return next;
}

function login(url, user) {
  const next = new URL(url);
  next.username = user;
  next.password = hex(24);
  return remember(next.toString());
}

const serverVersion = async (pool) =>
  (await pool.query("SELECT current_setting('server_version_num')::int AS v"))
    .rows[0].v;

test("role provisioning runs on the PostgreSQL major requested by CI", async (t) => {
  const expected = process.env.LEGEND_EXPECT_POSTGRES_MAJOR;
  if (!expected) return t.skip("No PostgreSQL major requested.");
  const shared = process.env.STARTER_TEST_DATABASE_URL;
  assert.ok(
    shared && process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"),
    "Run pnpm test to create an isolated database.",
  );
  const pool = new Pool({ connectionString: shared });
  try {
    assert.equal(
      Math.floor((await serverVersion(pool)) / 10000),
      Number(expected),
    );
  } finally {
    await pool.end();
  }
});

test("legend-zoqc job provisions restricted roles on a fresh database, idempotently", async (t) => {
  const shared = process.env.STARTER_TEST_DATABASE_URL;
  assert.ok(
    shared && process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"),
    "Run pnpm test to create an isolated database.",
  );
  const database = `legend_zoqc_${hex(6)}`;
  const adminUrl = withDatabase(shared, database).toString();
  const appUrl = login(adminUrl, `legend_runtime_${hex(8)}`);
  const workerUrl = login(adminUrl, `legend_worker_${hex(8)}`);
  remember(shared);
  const unsafeUser = `legend_runtime_${hex(8)}`;
  const grantor = `zoqc_grantor_${hex(6)}`;
  // Cluster-wide roles a drift case creates; dropped in teardown.
  const extraRoles = [];
  const roles = [appUrl, workerUrl].map((url) =>
    decodeURIComponent(new URL(url).username),
  );
  const cluster = quietPool({ connectionString: shared, max: 1 });
  await cluster.query(`CREATE DATABASE ${database}`);
  const admin = quietPool({ connectionString: adminUrl, max: 1 });
  const pools = [];
  const open = (url) => {
    const pool = quietPool({ connectionString: url, max: 1 });
    pools.push(pool);
    return pool;
  };
  t.after(async () => {
    for (const pool of pools) await pool.end();
    await admin.end();
    await cluster.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    for (const role of [...roles, unsafeUser, grantor, ...extraRoles])
      await cluster.query(`DROP ROLE IF EXISTS "${role}"`);
    await cluster.end();
  });

  const migrated = spawnSync(pnpmCommand(), ["run", "db:migrate"], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: adminUrl,
      MIGRATION_DATABASE_URL: adminUrl,
    },
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  assert.equal(migrated.status, 0, migrated.stderr);
  // A server-side hash would use this iteration count; only a verifier
  // computed by the job keeps 4096, which proves the plaintext never left it.
  await admin.query(`ALTER DATABASE ${database} SET scram_iterations = 5000`);

  const first = runJob({
    MIGRATION_DATABASE_URL: adminUrl,
    APP_DATABASE_URL: appUrl,
    WORKER_DATABASE_URL: workerUrl,
  });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, new RegExp(`${roles[0]} created`));
  assert.match(first.stdout, new RegExp(`${roles[1]} created`));
  const afterFirst = await snapshot(admin, roles);

  // Second run, URLs from secret files this time: still succeeds.
  const dir = mkdtempSync(join(tmpdir(), "legend-zoqc-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "app"), `${appUrl}\n`, { mode: 0o600 });
  writeFileSync(join(dir, "worker"), workerUrl, { mode: 0o600 });
  const second = runJob({
    MIGRATION_DATABASE_URL: adminUrl,
    APP_DATABASE_URL_FILE: join(dir, "app"),
    WORKER_DATABASE_URL_FILE: join(dir, "worker"),
  });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, new RegExp(`${roles[0]} updated`));
  assert.match(second.stdout, new RegExp(`${roles[1]} updated`));
  assert.deepEqual(await snapshot(admin, roles), afterFirst);

  // The stored secret is a SCRAM verifier; the plaintext never reached the server.
  const stored = await admin.query(
    "SELECT rolname, rolpassword FROM pg_authid WHERE rolname = ANY($1)",
    [roles],
  );
  assert.equal(stored.rows.length, 2);
  for (const row of stored.rows)
    assert.match(row.rolpassword, /^SCRAM-SHA-256\$4096:/);

  await t.test(
    "application login: no BYPASSRLS, not an owner, only legend_app",
    async () => {
      const role = (
        await admin.query(
          "SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin FROM pg_roles WHERE rolname = $1",
          [roles[0]],
        )
      ).rows[0];
      assert.deepEqual(role, {
        rolsuper: false,
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolcanlogin: true,
      });
      const groups = await admin.query(
        "SELECT g.rolname FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member WHERE u.rolname = $1",
        [roles[0]],
      );
      assert.deepEqual(
        groups.rows.map((row) => row.rolname),
        ["legend_app"],
      );
      const owned = await admin.query(
        "SELECT count(*)::int AS count FROM pg_class WHERE pg_has_role($1, relowner, 'MEMBER') AND relnamespace NOT IN (SELECT oid FROM pg_namespace WHERE nspname IN ('pg_catalog','information_schema'))",
        [roles[0]],
      );
      assert.equal(owned.rows[0].count, 0);
    },
  );

  await t.test(
    "a tenant table set up by the migration helper (app.enforce_tenant_rls) is reachable by the login only within its tenant",
    async () => {
      await admin.query(
        "CREATE TABLE zoqc_fixture (id integer PRIMARY KEY, tenant_id uuid NOT NULL, value text NOT NULL)",
      );
      await admin.query(
        "SELECT app.enforce_tenant_rls('public.zoqc_fixture'::regclass)",
      );
      await admin.query(
        "INSERT INTO zoqc_fixture VALUES (1, $1, 'a'), (2, $2, 'b')",
        [tenantA, tenantB],
      );
      const app = open(appUrl);
      // No tenant context: refused outright (TEN-02).
      await assert.rejects(app.query("SELECT * FROM zoqc_fixture"), {
        code: "42501",
      });
      const client = await app.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [
          tenantA,
        ]);
        const rows = await client.query(
          "SELECT id FROM zoqc_fixture ORDER BY id",
        );
        assert.deepEqual(
          rows.rows.map((row) => row.id),
          [1],
        );
        await client.query("INSERT INTO zoqc_fixture VALUES (3, $1, 'a2')", [
          tenantA,
        ]);
        await client.query("UPDATE zoqc_fixture SET value = 'a3' WHERE id = 3");
        // Another tenant's row is invisible to UPDATE/DELETE and refused on INSERT.
        const touched = await client.query(
          "UPDATE zoqc_fixture SET value = 'x' WHERE id = 2",
        );
        assert.equal(touched.rowCount, 0);
        await client.query("SAVEPOINT cross_tenant");
        await assert.rejects(
          client.query("INSERT INTO zoqc_fixture VALUES (4, $1, 'b2')", [
            tenantB,
          ]),
          { code: "42501" },
        );
        await client.query("ROLLBACK TO SAVEPOINT cross_tenant");
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      // row_security=off cannot be used to skip the policies either.
      const off = await app.connect();
      try {
        await off.query("SET row_security = off");
        await assert.rejects(off.query("SELECT * FROM zoqc_fixture"), {
          code: "42501",
        });
      } finally {
        off.release();
      }
    },
  );

  await t.test(
    "application login cannot run DDL or assume another role",
    async () => {
      const app = open(appUrl);
      const adminUser = decodeURIComponent(new URL(adminUrl).username);
      for (const statement of [
        "CREATE TABLE public.zoqc_ddl (id integer)",
        "CREATE TABLE app.zoqc_ddl (id integer)",
        "CREATE SCHEMA zoqc_ddl",
        "ALTER TABLE zoqc_fixture ADD COLUMN extra text",
        "ALTER TABLE zoqc_fixture DISABLE ROW LEVEL SECURITY",
        "ALTER TABLE zoqc_fixture NO FORCE ROW LEVEL SECURITY",
        "DROP POLICY tenant_isolation ON zoqc_fixture",
        "DROP TABLE zoqc_fixture",
        "TRUNCATE zoqc_fixture",
        `SET ROLE "${adminUser}"`,
      ])
        await assert.rejects(
          app.query(statement),
          { code: "42501" },
          statement,
        );
    },
  );

  await t.test(
    "queue login sees only the tenant registry and its own schema",
    async () => {
      const role = (
        await admin.query(
          "SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin, rolinherit FROM pg_roles WHERE rolname = $1",
          [roles[1]],
        )
      ).rows[0];
      assert.deepEqual(role, {
        rolsuper: false,
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolcanlogin: true,
        rolinherit: true,
      });
      const worker = open(workerUrl);
      await assert.rejects(worker.query("SELECT * FROM zoqc_fixture"), {
        code: "42501",
      });
      // The registry lists active tenants only.
      const active = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      const suspended = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
      await admin.query(
        `INSERT INTO public.tenants (id, slug, name, plan, status, deployment_mode, limits, created_by)
         VALUES ($1, 'zoqc-active', 'Active', 'basic', 'active', 'shared', '{}', 'zoqc'),
                ($2, 'zoqc-suspended', 'Suspended', 'basic', 'suspended', 'shared', '{}', 'zoqc')`,
        [active, suspended],
      );
      const listed = (
        await worker.query(
          "SELECT id FROM app.active_tenant_registry WHERE id = ANY($1)",
          [[active, suspended]],
        )
      ).rows.map((row) => row.id);
      assert.deepEqual(listed, [active]);
      await worker.query("CREATE TABLE pgboss.zoqc_probe (id integer)");
      await worker.query("DROP TABLE pgboss.zoqc_probe");
      await assert.rejects(
        worker.query("CREATE TABLE public.zoqc_probe (id integer)"),
        {
          code: "42501",
        },
      );
      const owner = await admin.query(
        "SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'pgboss'",
      );
      assert.equal(owner.rows[0].owner, roles[1]);
    },
  );

  // The application URL currently provisioned (rotation replaces it).
  let liveAppUrl = appUrl;
  const job = (overrides) =>
    runJob({
      MIGRATION_DATABASE_URL: adminUrl,
      APP_DATABASE_URL: liveAppUrl,
      WORKER_DATABASE_URL: workerUrl,
      ...overrides,
    });
  const adminUser = decodeURIComponent(new URL(adminUrl).username);
  const adminPassword = decodeURIComponent(new URL(adminUrl).password);
  // Runs `grant`, expects the job to refuse with `message`, always undoes it.
  const refuses = async (grant, revoke, message) => {
    await admin.query(grant);
    try {
      const drifted = job({});
      assert.equal(drifted.status, 1, grant);
      assert.match(drifted.stderr, message, grant);
    } finally {
      await admin.query(revoke);
    }
  };

  await t.test(
    "the job refuses URLs that would sign in as someone else",
    () => {
      // pg lets ?user= and ?password= override the URL's authority: the queue
      // URL below would really connect as the migration superuser.
      const swapped = new URL(workerUrl);
      swapped.searchParams.set("user", adminUser);
      swapped.searchParams.set("password", adminPassword);
      for (const [name, url] of [
        ["WORKER_DATABASE_URL", swapped.toString()],
        ["APP_DATABASE_URL", `${appUrl}?host=elsewhere.invalid`],
        ["APP_DATABASE_URL", `${appUrl}?options=-c%20role%3Dlegend_app`],
      ]) {
        const refused = job({ [name]: url });
        assert.equal(refused.status, 1, `${name} with a query override`);
        assert.match(refused.stderr, /query parameter that is not allowed/);
      }
      const tls = job({ APP_DATABASE_URL: `${appUrl}?sslmode=disable` });
      assert.equal(tls.status, 0, tls.stderr);
      // The admin URL itself may not carry overrides either.
      const adminSwap = job({
        MIGRATION_DATABASE_URL: `${adminUrl}?dbname=postgres`,
      });
      assert.equal(adminSwap.status, 1);
      assert.match(
        adminSwap.stderr,
        /migration connection URL has a query parameter/,
      );
    },
  );

  await t.test(
    "the job refuses unsafe inputs and drifted privileges",
    async () => {
      // The migration (administrator) login can never be handed out as the app login.
      const reused = job({ APP_DATABASE_URL: adminUrl });
      assert.equal(reused.status, 1);
      assert.match(reused.stderr, /uses the migration login/);
      // A same-named role created with extra powers is not adopted.
      await admin.query(
        `CREATE ROLE "${unsafeUser}" LOGIN CREATEDB PASSWORD NULL`,
      );
      const unsafe = job({ APP_DATABASE_URL: login(adminUrl, unsafeUser) });
      assert.equal(unsafe.status, 1);
      assert.match(unsafe.stderr, /already exists with unsafe privileges/);
      for (const attributes of [
        "LOGIN BYPASSRLS",
        "LOGIN CREATEROLE",
        "LOGIN REPLICATION",
        "LOGIN SUPERUSER",
        "NOLOGIN",
      ]) {
        const name = `legend_runtime_${hex(8)}`;
        extraRoles.push(name);
        await admin.query(`CREATE ROLE "${name}" ${attributes}`);
        const refused = job({ APP_DATABASE_URL: login(adminUrl, name) });
        assert.equal(refused.status, 1, attributes);
        assert.match(refused.stderr, /already exists with unsafe privileges/);
      }
      // A later grant of DDL to the app group is caught on the next run and
      // rolled back with the rest of the transaction: the stored verifier of
      // the login does not change.
      const stored = async () =>
        (
          await admin.query(
            "SELECT rolpassword FROM pg_authid WHERE rolname = $1",
            [roles[0]],
          )
        ).rows[0].rolpassword;
      const before = await stored();
      await admin.query("GRANT CREATE ON SCHEMA app TO legend_app");
      try {
        const drifted = job({});
        assert.equal(drifted.status, 1);
        assert.match(drifted.stderr, /can create objects \(schema app\)/);
        assert.equal(
          await stored(),
          before,
          "a failed run changed the password",
        );
      } finally {
        await admin.query("REVOKE CREATE ON SCHEMA app FROM legend_app");
      }
      // Rights that skip RLS or reach beyond the login's lane are refused.
      const aux = `zoqc_aux_${hex(6)}`;
      const bypass = `zoqc_bypass_${hex(6)}`;
      extraRoles.push(aux, bypass);
      await admin.query(`CREATE ROLE ${aux} NOLOGIN`);
      await admin.query(`CREATE ROLE ${bypass} NOLOGIN BYPASSRLS`);
      const drifts = [
        [
          "GRANT TRUNCATE ON zoqc_fixture TO legend_app",
          "REVOKE TRUNCATE ON zoqc_fixture FROM legend_app",
          /table rights it must not have: TRUNCATE on public\.zoqc_fixture/,
        ],
        [
          `GRANT pg_read_server_files TO "${roles[0]}"`,
          `REVOKE pg_read_server_files FROM "${roles[0]}"`,
          /inherits predefined roles: pg_read_server_files/,
        ],
        [
          `GRANT SELECT ON zoqc_fixture TO "${roles[1]}"`,
          `REVOKE SELECT ON zoqc_fixture FROM "${roles[1]}"`,
          /queue role has table rights it must not have: SELECT on public\.zoqc_fixture/,
        ],
        // Column grants count as table rights.
        [
          `GRANT SELECT (value) ON zoqc_fixture TO "${roles[1]}"`,
          `REVOKE SELECT (value) ON zoqc_fixture FROM "${roles[1]}"`,
          /queue role has table rights it must not have: SELECT on public\.zoqc_fixture/,
        ],
        [
          "GRANT REFERENCES (id) ON zoqc_fixture TO legend_app",
          "REVOKE REFERENCES (id) ON zoqc_fixture FROM legend_app",
          /application role has table rights it must not have: REFERENCES on public\.zoqc_fixture/,
        ],
        [
          `ALTER FUNCTION app.require_tenant_id() OWNER TO "${roles[0]}"`,
          `ALTER FUNCTION app.require_tenant_id() OWNER TO CURRENT_USER`,
          /owns tables, functions, types, schemas or other objects/,
        ],
        [
          "CREATE VIEW public.zoqc_public AS SELECT 1 AS x; GRANT SELECT ON public.zoqc_public TO PUBLIC",
          "DROP VIEW public.zoqc_public",
          /queue role has table rights it must not have: SELECT on public\.zoqc_public/,
        ],
        [
          'CREATE COLLATION public.zoqc_coll FROM "C"; ALTER COLLATION public.zoqc_coll OWNER TO "' +
            roles[0] +
            '"',
          "DROP COLLATION public.zoqc_coll",
          /owns tables, functions, types, schemas or other objects/,
        ],
        // System catalogs and built-in functions beyond what PUBLIC has.
        [
          "GRANT SELECT ON pg_catalog.pg_authid TO legend_app",
          "REVOKE SELECT ON pg_catalog.pg_authid FROM legend_app",
          /application role has table rights it must not have: SELECT on pg_catalog\.pg_authid/,
        ],
        [
          `GRANT SELECT (rolpassword) ON pg_catalog.pg_authid TO "${roles[1]}"`,
          `REVOKE SELECT (rolpassword) ON pg_catalog.pg_authid FROM "${roles[1]}"`,
          /queue role has table rights it must not have: SELECT on pg_catalog\.pg_authid/,
        ],
        [
          "GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) TO legend_app",
          "REVOKE EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) FROM legend_app",
          /may run built-in functions PUBLIC cannot: pg_read_file/,
        ],
        // Sensitive objects are refused even when granted to PUBLIC.
        [
          "GRANT SELECT ON pg_catalog.pg_authid TO PUBLIC",
          "REVOKE SELECT ON pg_catalog.pg_authid FROM PUBLIC",
          /application role can reach sensitive server objects \(directly or through PUBLIC\): SELECT on pg_catalog\.pg_authid/,
        ],
        [
          "GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) TO PUBLIC",
          "REVOKE EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) FROM PUBLIC",
          /application role can reach sensitive server objects \(directly or through PUBLIC\): EXECUTE on pg_catalog\.pg_read_file/,
        ],
        // Tenant tables keep forced RLS and the restrictive tenant policy.
        [
          "ALTER TABLE zoqc_fixture DISABLE ROW LEVEL SECURITY",
          "ALTER TABLE zoqc_fixture ENABLE ROW LEVEL SECURITY",
          /TEN-02.*public\.zoqc_fixture \(row-level security disabled\)/,
        ],
        [
          "ALTER TABLE zoqc_fixture NO FORCE ROW LEVEL SECURITY",
          "ALTER TABLE zoqc_fixture FORCE ROW LEVEL SECURITY",
          /TEN-02.*public\.zoqc_fixture \(not forced\)/,
        ],
        [
          "DROP POLICY tenant_isolation ON zoqc_fixture",
          "CREATE POLICY tenant_isolation ON zoqc_fixture AS RESTRICTIVE FOR ALL USING (tenant_id = app.require_tenant_id()) WITH CHECK (tenant_id = app.require_tenant_id())",
          /TEN-02.*public\.zoqc_fixture \(no restrictive tenant_isolation policy\)/,
        ],
        [
          "ALTER POLICY tenant_isolation ON zoqc_fixture USING (true)",
          "ALTER POLICY tenant_isolation ON zoqc_fixture USING (tenant_id = app.require_tenant_id())",
          /TEN-02.*public\.zoqc_fixture \(no restrictive tenant_isolation policy\)/,
        ],
        [
          "ALTER TABLE public.tenant_domains DISABLE ROW LEVEL SECURITY",
          "ALTER TABLE public.tenant_domains ENABLE ROW LEVEL SECURITY",
          /TEN-02.*public\.tenant_domains \(row-level security disabled\)/,
        ],
        // Sequences: setval() is refused, and so are such defaults.
        [
          `GRANT UPDATE ON SEQUENCE public.consents_seq_seq TO "${roles[1]}"`,
          `REVOKE UPDATE ON SEQUENCE public.consents_seq_seq FROM "${roles[1]}"`,
          /queue role has sequence rights it must not have: UPDATE on public\.consents_seq_seq/,
        ],
        [
          "GRANT UPDATE ON SEQUENCE public.consents_seq_seq TO legend_app",
          "REVOKE UPDATE ON SEQUENCE public.consents_seq_seq FROM legend_app",
          /application role has sequence rights it must not have: UPDATE on public\.consents_seq_seq/,
        ],
        [
          "ALTER DEFAULT PRIVILEGES GRANT UPDATE ON SEQUENCES TO legend_app",
          "ALTER DEFAULT PRIVILEGES REVOKE UPDATE ON SEQUENCES FROM legend_app",
          /application role would get default privileges it must not have: UPDATE on new sequences created by/,
        ],
        [
          `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO "${roles[1]}"`,
          `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE USAGE ON SEQUENCES FROM "${roles[1]}"`,
          /queue role would get default privileges it must not have: USAGE on new sequences/,
        ],
        // Roles reached directly or through legend_app, with or without ADMIN.
        [
          `GRANT ${aux} TO "${roles[0]}"`,
          `REVOKE ${aux} FROM "${roles[0]}"`,
          new RegExp(
            `member of unexpected roles \\(directly or through a group\\): ${aux}`,
          ),
        ],
        [
          `GRANT ${aux} TO legend_app WITH ADMIN TRUE`,
          `REVOKE ${aux} FROM legend_app`,
          new RegExp(
            `member of unexpected roles \\(directly or through a group\\): ${aux}`,
          ),
        ],
        [
          `GRANT ${bypass} TO legend_app`,
          `REVOKE ${bypass} FROM legend_app`,
          /has or inherits superuser, BYPASSRLS/,
        ],
        [
          "ALTER ROLE legend_app CREATEROLE",
          "ALTER ROLE legend_app NOCREATEROLE",
          /legend_app group role must be NOLOGIN without elevated attributes/,
        ],
        // Default privileges reach every table a later migration creates.
        [
          "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT TRUNCATE ON TABLES TO legend_app",
          "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE TRUNCATE ON TABLES FROM legend_app",
          /application role would get default privileges it must not have: TRUNCATE on new tables created by .* in public \(granted to legend_app\)/,
        ],
        [
          "ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC",
          "ALTER DEFAULT PRIVILEGES REVOKE SELECT ON TABLES FROM PUBLIC",
          /would get default privileges it must not have: SELECT on new tables created by .* \(granted to PUBLIC\)/,
        ],
        [
          `ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT ON TABLES TO "${roles[1]}"`,
          `ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE SELECT ON TABLES FROM "${roles[1]}"`,
          /queue role would get default privileges it must not have: SELECT on new tables/,
        ],
        [
          "ALTER DEFAULT PRIVILEGES GRANT CREATE ON SCHEMAS TO legend_app",
          "ALTER DEFAULT PRIVILEGES REVOKE CREATE ON SCHEMAS FROM legend_app",
          /default privileges it must not have: CREATE on new schemas/,
        ],
      ];
      if ((await serverVersion(admin)) >= 170000)
        drifts.push(
          [
            "GRANT MAINTAIN ON zoqc_fixture TO legend_app",
            "REVOKE MAINTAIN ON zoqc_fixture FROM legend_app",
            /table rights it must not have: MAINTAIN on public\.zoqc_fixture/,
          ],
          [
            "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT MAINTAIN ON TABLES TO legend_app",
            "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE MAINTAIN ON TABLES FROM legend_app",
            /default privileges it must not have: MAINTAIN on new tables/,
          ],
        );
      for (const [grant, revoke, message] of drifts)
        await refuses(grant, revoke, message);
      // Extension views readable by PUBLIC (pg_stat_statements) are not a
      // right of the login and must not block provisioning.
      await admin.query("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
      const extension = job({});
      assert.equal(extension.status, 0, extension.stderr);
      // The TEN-02 check compares policy text; an admin search_path that
      // includes app must not make healthy tables fail it.
      await admin.query(
        `ALTER ROLE "${adminUser}" IN DATABASE ${database} SET search_path = app, public`,
      );
      try {
        const pathed = job({});
        assert.equal(pathed.status, 0, pathed.stderr);
      } finally {
        await admin.query(
          `ALTER ROLE "${adminUser}" IN DATABASE ${database} RESET search_path`,
        );
      }
      // A membership without INHERIT (no privileges at all on 16+) or with
      // ADMIN OPTION is normalised, not reported as fine.
      await admin.query(`REVOKE legend_app FROM "${roles[0]}"`);
      await admin.query(
        `GRANT legend_app TO "${roles[0]}" WITH INHERIT FALSE, ADMIN TRUE`,
      );
      const membership = job({});
      assert.equal(membership.status, 0, membership.stderr);
      const grant = (
        await admin.query(
          "SELECT m.inherit_option, m.admin_option FROM pg_auth_members m WHERE m.roleid = 'legend_app'::regrole AND m.member = $1::regrole",
          [roles[0]],
        )
      ).rows;
      assert.deepEqual(grant, [{ inherit_option: true, admin_option: false }]);
      // A flawed grant recorded under another grantor is revoked by name.
      await admin.query(`CREATE ROLE ${grantor} NOLOGIN`);
      await admin.query(`GRANT legend_app TO ${grantor} WITH ADMIN OPTION`);
      await admin.query(
        `GRANT legend_app TO "${roles[0]}" WITH INHERIT FALSE, ADMIN TRUE GRANTED BY ${grantor}`,
      );
      const otherGrantor = job({});
      assert.equal(otherGrantor.status, 0, otherGrantor.stderr);
      const grants = (
        await admin.query(
          "SELECT pg_get_userbyid(m.grantor) AS grantor, m.inherit_option, m.admin_option FROM pg_auth_members m WHERE m.roleid = 'legend_app'::regrole AND m.member = $1::regrole",
          [roles[0]],
        )
      ).rows;
      assert.equal(grants.length, 1);
      assert.notEqual(grants[0].grantor, grantor);
      assert.equal(grants[0].inherit_option, true);
      assert.equal(grants[0].admin_option, false);
      // Drift that only breaks or bends the login is normalised on re-run.
      await admin.query(
        `ALTER ROLE "${roles[0]}" NOINHERIT VALID UNTIL '2000-01-01' CONNECTION LIMIT 0`,
      );
      await admin.query(`ALTER ROLE "${roles[0]}" SET search_path = pg_temp`);
      await admin.query(
        `ALTER ROLE "${roles[0]}" IN DATABASE ${database} SET row_security = off`,
      );
      const normalised = job({});
      assert.equal(normalised.status, 0, normalised.stderr);
      const role = (
        await admin.query(
          "SELECT rolinherit, rolvaliduntil = 'infinity'::timestamptz AS forever, rolconnlimit, (SELECT coalesce(array_agg(c ORDER BY c), '{}') FROM pg_db_role_setting s, unnest(s.setconfig) AS c WHERE s.setrole = r.oid) AS settings FROM pg_roles r WHERE rolname = $1",
          [roles[0]],
        )
      ).rows[0];
      assert.equal(role.rolinherit, true);
      assert.equal(role.forever, true);
      assert.equal(role.rolconnlimit, -1);
      // Only the idle-transaction timeout provisioning sets itself survives;
      // the drifted search_path and row_security are gone (legend-9h0kg).
      assert.deepEqual(role.settings, [
        "idle_in_transaction_session_timeout=5min",
      ]);
      const missing = job({ WORKER_DATABASE_URL: "" });
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /WORKER_DATABASE_URL is required/);
      // Connection failures get hints for the VM and never print a URL.
      const wrongPassword = new URL(adminUrl);
      wrongPassword.password = hex(24);
      const rejected = job({
        MIGRATION_DATABASE_URL: remember(wrongPassword.toString()),
      });
      assert.equal(rejected.status, 1);
      assert.match(rejected.stderr, /rejected the migration login/);
      const deadPort = new URL(adminUrl);
      deadPort.hostname = "127.0.0.1";
      deadPort.port = "1";
      const unreachable = job({
        MIGRATION_DATABASE_URL: deadPort.toString(),
        APP_DATABASE_URL: Object.assign(new URL(appUrl), {
          hostname: "127.0.0.1",
          port: "1",
        }).toString(),
        WORKER_DATABASE_URL: Object.assign(new URL(workerUrl), {
          hostname: "127.0.0.1",
          port: "1",
        }).toString(),
      });
      assert.equal(unreachable.status, 1);
      assert.match(unreachable.stderr, /PostgreSQL refused the connection/);
      assert.doesNotMatch(unreachable.stderr, /pnpm db:up/);
      const again = job({});
      assert.equal(again.status, 0, again.stderr);
    },
  );

  await t.test(
    "a tenant table in the queue schema reached by a column grant needs RLS",
    async () => {
      await refuses(
        "CREATE TABLE pgboss.zoqc_tenant (id integer, tenant_id uuid); GRANT SELECT (tenant_id) ON pgboss.zoqc_tenant TO legend_app",
        "DROP TABLE pgboss.zoqc_tenant",
        /TEN-02.*pgboss\.zoqc_tenant \(row-level security disabled, not forced, no restrictive tenant_isolation policy\)/,
      );
    },
  );

  await t.test(
    "exception tables refuse write policies not tied to the tenant",
    async () => {
      for (const [grant, revoke, message] of [
        [
          "CREATE POLICY zoqc_loose ON public.tenant_domains FOR UPDATE USING (true)",
          "DROP POLICY zoqc_loose ON public.tenant_domains",
          /TEN-02.*public\.tenant_domains \(write policy zoqc_loose is not limited to the tenant\).*DROP POLICY/,
        ],
        [
          "CREATE POLICY zoqc_loose ON public.payment_link_tokens FOR ALL TO legend_app USING (true) WITH CHECK (true)",
          "DROP POLICY zoqc_loose ON public.payment_link_tokens",
          /TEN-02.*public\.payment_link_tokens \(write policy zoqc_loose is not limited to the tenant\)/,
        ],
        [
          "CREATE POLICY zoqc_loose ON public.tenant_domains FOR INSERT WITH CHECK (true)",
          "DROP POLICY zoqc_loose ON public.tenant_domains",
          /TEN-02.*public\.tenant_domains \(write policy zoqc_loose is not limited to the tenant\)/,
        ],
        [
          "ALTER POLICY tenant_domain_delete ON public.tenant_domains USING (true)",
          "ALTER POLICY tenant_domain_delete ON public.tenant_domains USING (tenant_id = app.require_tenant_id())",
          /TEN-02.*public\.tenant_domains \(write policy tenant_domain_delete is not limited to the tenant\)/,
        ],
      ])
        await refuses(grant, revoke, message);
      // A policy for a role the login cannot use, or a read policy, is fine.
      await admin.query(
        "CREATE POLICY zoqc_other ON public.tenant_domains FOR UPDATE TO pg_monitor USING (true); CREATE POLICY zoqc_read ON public.payment_link_tokens FOR SELECT USING (true)",
      );
      try {
        const unrelated = job({});
        assert.equal(unrelated.status, 0, unrelated.stderr);
      } finally {
        await admin.query(
          "DROP POLICY zoqc_other ON public.tenant_domains; DROP POLICY zoqc_read ON public.payment_link_tokens",
        );
      }
    },
  );

  await t.test(
    "the job refuses SET or ALTER SYSTEM grants on privileged parameters",
    async () => {
      for (const [grant, revoke, message] of [
        [
          "GRANT SET ON PARAMETER session_replication_role TO PUBLIC",
          "REVOKE SET ON PARAMETER session_replication_role FROM PUBLIC",
          /application role may change server settings it must not: SET on session_replication_role \(granted to PUBLIC\).*REVOKE SET ON PARAMETER/,
        ],
        [
          "GRANT SET ON PARAMETER log_statement TO legend_app",
          "REVOKE SET ON PARAMETER log_statement FROM legend_app",
          /application role may change server settings it must not: SET on log_statement \(granted to legend_app\)/,
        ],
        [
          `GRANT ALTER SYSTEM ON PARAMETER work_mem TO "${roles[1]}"`,
          `REVOKE ALTER SYSTEM ON PARAMETER work_mem FROM "${roles[1]}"`,
          new RegExp(
            `queue role may change server settings it must not: ALTER SYSTEM on work_mem \\(granted to ${roles[1]}\\)`,
          ),
        ],
        // A parameter no loaded module defines yet may become superuser-only.
        [
          `GRANT SET ON PARAMETER zoqc.flag TO "${roles[1]}"`,
          `REVOKE SET ON PARAMETER zoqc.flag FROM "${roles[1]}"`,
          /queue role may change server settings it must not: SET on zoqc\.flag/,
        ],
        // A placeholder with a value (ALTER DATABASE ... SET) shows in the
        // admin session's pg_settings as a plain user setting; still refused.
        [
          `DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET zoqc.valued = %L', current_database(), 'x'); END $$; GRANT SET ON PARAMETER zoqc.valued TO "${roles[1]}"`,
          `REVOKE SET ON PARAMETER zoqc.valued FROM "${roles[1]}"; DO $$ BEGIN EXECUTE format('ALTER DATABASE %I RESET zoqc.valued', current_database()); END $$`,
          /queue role may change server settings it must not: SET on zoqc\.valued/,
        ],
      ])
        await refuses(grant, revoke, message);
      // SET on a setting every session may change anyway grants nothing.
      await admin.query("GRANT SET ON PARAMETER work_mem TO legend_app");
      try {
        const harmless = job({});
        assert.equal(harmless.status, 0, harmless.stderr);
      } finally {
        await admin.query("REVOKE SET ON PARAMETER work_mem FROM legend_app");
      }
    },
  );

  await t.test(
    "a table created after the job gets only the group's rights",
    async () => {
      await admin.query(
        "CREATE TABLE zoqc_later (id integer PRIMARY KEY, tenant_id uuid NOT NULL)",
      );
      await admin.query(
        "SELECT app.enforce_tenant_rls('public.zoqc_later'::regclass)",
      );
      const rights = (
        await admin.query(
          `SELECT array_agg(p ORDER BY p) AS rights FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
         WHERE has_table_privilege($1, 'public.zoqc_later', p)`,
          [roles[0]],
        )
      ).rows[0].rights;
      assert.deepEqual(rights, ["DELETE", "INSERT", "SELECT", "UPDATE"]);
      const audit = job({});
      assert.equal(audit.status, 0, audit.stderr);
      // With a TRUNCATE default in place, the next table really would carry
      // it: exactly what the default-privilege audit refuses.
      await admin.query(
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT TRUNCATE ON TABLES TO legend_app",
      );
      try {
        await admin.query("CREATE TABLE zoqc_later2 (id integer)");
        const granted = (
          await admin.query(
            "SELECT has_table_privilege($1, 'public.zoqc_later2', 'TRUNCATE') AS granted",
            [roles[0]],
          )
        ).rows[0].granted;
        assert.equal(granted, true);
        const refused = job({});
        assert.equal(refused.status, 1);
        assert.match(refused.stderr, /TRUNCATE/);
      } finally {
        await admin.query(
          "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE TRUNCATE ON TABLES FROM legend_app",
        );
        await admin.query("DROP TABLE zoqc_later2");
      }
    },
  );

  await t.test("audit mode verifies without changing anything", async () => {
    const before = await snapshot(admin, roles);
    const verifiers = async () =>
      (
        await admin.query(
          "SELECT rolname, rolpassword FROM pg_authid WHERE rolname = ANY($1) ORDER BY 1",
          [roles],
        )
      ).rows;
    const stored = await verifiers();
    const audit = runJob(
      {
        MIGRATION_DATABASE_URL: adminUrl,
        APP_DATABASE_URL: appUrl,
        WORKER_DATABASE_URL: workerUrl,
      },
      ["--audit"],
    );
    assert.equal(audit.status, 0, audit.stderr);
    assert.match(audit.stdout, /Audit passed/);
    assert.deepEqual(await snapshot(admin, roles), before);
    assert.deepEqual(await verifiers(), stored);
    // A login that was never provisioned, or a password that no longer
    // matches the env file, fails the audit.
    const fresh = login(adminUrl, `legend_runtime_${hex(8)}`);
    const unprovisioned = runJob(
      {
        MIGRATION_DATABASE_URL: adminUrl,
        APP_DATABASE_URL: fresh,
        WORKER_DATABASE_URL: workerUrl,
      },
      ["--audit"],
    );
    assert.equal(unprovisioned.status, 1);
    assert.match(
      unprovisioned.stderr,
      /does not exist yet; run deploy\/single-vm\/provision-roles\.sh/,
    );
    const stale = runJob(
      {
        MIGRATION_DATABASE_URL: adminUrl,
        APP_DATABASE_URL: login(adminUrl, roles[0]),
        WORKER_DATABASE_URL: workerUrl,
      },
      ["--audit"],
    );
    assert.equal(stale.status, 1);
    assert.match(
      stale.stderr,
      /Could not sign in with the application URL .*28P01/,
    );
    // A connection limit would only show under load; the audit refuses it.
    await admin.query(`ALTER ROLE "${roles[0]}" CONNECTION LIMIT 1`);
    try {
      const limited = runJob(
        {
          MIGRATION_DATABASE_URL: adminUrl,
          APP_DATABASE_URL: appUrl,
          WORKER_DATABASE_URL: workerUrl,
        },
        ["--audit"],
      );
      assert.equal(limited.status, 1);
      assert.match(limited.stderr, /has a connection limit or expiry/);
    } finally {
      await admin.query(`ALTER ROLE "${roles[0]}" CONNECTION LIMIT -1`);
    }
    await admin.query("GRANT TRUNCATE ON zoqc_fixture TO legend_app");
    try {
      const drifted = runJob(
        {
          MIGRATION_DATABASE_URL: adminUrl,
          APP_DATABASE_URL: appUrl,
          WORKER_DATABASE_URL: workerUrl,
        },
        ["--audit"],
      );
      assert.equal(drifted.status, 1);
      assert.match(
        drifted.stderr,
        /Role audit failed: .*TRUNCATE on public\.zoqc_fixture/,
      );
    } finally {
      await admin.query("REVOKE TRUNCATE ON zoqc_fixture FROM legend_app");
    }
    // The audit (what deploy.sh runs after every migration) catches the same
    // sensitive grants to PUBLIC and tenant tables without RLS.
    for (const [grant, revoke, message] of [
      [
        "GRANT SELECT ON pg_catalog.pg_authid TO PUBLIC",
        "REVOKE SELECT ON pg_catalog.pg_authid FROM PUBLIC",
        /Role audit failed: .*sensitive server objects .*SELECT on pg_catalog\.pg_authid/,
      ],
      [
        "GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) TO PUBLIC",
        "REVOKE EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) FROM PUBLIC",
        /Role audit failed: .*sensitive server objects .*EXECUTE on pg_catalog\.pg_read_file/,
      ],
      [
        "ALTER TABLE zoqc_fixture DISABLE ROW LEVEL SECURITY",
        "ALTER TABLE zoqc_fixture ENABLE ROW LEVEL SECURITY",
        /Role audit failed: .*TEN-02.*public\.zoqc_fixture \(row-level security disabled\)/,
      ],
      [
        `GRANT UPDATE ON SEQUENCE public.consents_seq_seq TO "${roles[1]}"`,
        `REVOKE UPDATE ON SEQUENCE public.consents_seq_seq FROM "${roles[1]}"`,
        /Role audit failed: .*sequence rights .*UPDATE on public\.consents_seq_seq/,
      ],
      [
        "CREATE POLICY zoqc_loose ON public.tenant_domains FOR UPDATE USING (true)",
        "DROP POLICY zoqc_loose ON public.tenant_domains",
        /Role audit failed: .*TEN-02.*public\.tenant_domains \(write policy zoqc_loose is not limited to the tenant\)/,
      ],
      [
        "GRANT SET ON PARAMETER session_replication_role TO PUBLIC",
        "REVOKE SET ON PARAMETER session_replication_role FROM PUBLIC",
        /Role audit failed: .*server settings .*SET on session_replication_role \(granted to PUBLIC\)/,
      ],
    ]) {
      await admin.query(grant);
      try {
        const drifted = runJob(
          {
            MIGRATION_DATABASE_URL: adminUrl,
            APP_DATABASE_URL: appUrl,
            WORKER_DATABASE_URL: workerUrl,
          },
          ["--audit"],
        );
        assert.equal(drifted.status, 1, grant);
        assert.match(drifted.stderr, message, grant);
      } finally {
        await admin.query(revoke);
      }
    }
  });

  await t.test("rotation and concurrent runs", async () => {
    // Re-running with a new password rotates it: the old one stops working.
    const rotated = login(adminUrl, roles[0]);
    const result = job({ APP_DATABASE_URL: rotated });
    assert.equal(result.status, 0, result.stderr);
    liveAppUrl = rotated;
    const old = quietPool({ connectionString: appUrl, max: 1 });
    try {
      await assert.rejects(old.query("SELECT 1"), { code: "28P01" });
    } finally {
      await old.end();
    }
    const fresh = open(rotated);
    assert.equal(
      (await fresh.query("SELECT current_user AS u")).rows[0].u,
      roles[0],
    );
    // Two operators running the job at once: the advisory lock serialises
    // them and both succeed.
    const env = {
      MIGRATION_DATABASE_URL: adminUrl,
      APP_DATABASE_URL: rotated,
      WORKER_DATABASE_URL: workerUrl,
    };
    const [one, two] = await Promise.all([runJobAsync(env), runJobAsync(env)]);
    assert.equal(one.status, 0, one.stderr);
    assert.equal(two.status, 0, two.stderr);
  });

  await t.test("the bundled job (dist/provision-roles.js) runs", async () => {
    // What the migrator image ships: a self-contained bundle, run outside
    // the repository so nothing resolves from node_modules.
    const out = mkdtempSync(join(tmpdir(), "legend-zoqc-dist-"));
    t.after(() => rmSync(out, { recursive: true, force: true }));
    const built = spawnSync(
      pnpmCommand(),
      [
        "--filter",
        "@starter/api",
        "exec",
        "tsup",
        "src/provision-roles.ts",
        "--out-dir",
        out,
      ],
      { cwd: root, encoding: "utf8", shell: process.platform === "win32" },
    );
    assert.equal(built.status, 0, built.stderr || built.stdout);
    const env = jobEnv({
      MIGRATION_DATABASE_URL: adminUrl,
      APP_DATABASE_URL: liveAppUrl,
      WORKER_DATABASE_URL: workerUrl,
    });
    for (const args of [[], ["--audit"]]) {
      const result = spawnSync(
        process.execPath,
        [join(out, "provision-roles.js"), ...args],
        { cwd: out, env, encoding: "utf8" },
      );
      assertNoSecrets(result);
      assert.equal(result.status, 0, result.stderr);
      assert.match(
        result.stdout,
        args.length ? /Audit passed/ : new RegExp(`${roles[0]} updated`),
      );
    }
  });

  await t.test(
    "changing the queue login: the documented rename keeps the queue's tables",
    async () => {
      // pg-boss state lives in tables the queue login owns.
      const old = quietPool({ connectionString: workerUrl, max: 1 });
      try {
        await old.query("CREATE TABLE pgboss.zoqc_queue (id integer)");
        await old.query("INSERT INTO pgboss.zoqc_queue VALUES (1)");
      } finally {
        await old.end();
      }
      const renamed = `legend_worker_${hex(8)}`;
      extraRoles.push(renamed);
      const renamedUrl = login(adminUrl, renamed);
      // A new name alone is refused, rolled back, with the rename to run.
      const refused = job({ WORKER_DATABASE_URL: renamedUrl });
      assert.equal(refused.status, 1);
      assert.match(
        refused.stderr,
        new RegExp(`ALTER ROLE "${roles[1]}" RENAME TO "${renamed}"`),
      );
      const created = await admin.query(
        "SELECT count(*)::int AS n FROM pg_roles WHERE rolname = $1",
        [renamed],
      );
      assert.equal(created.rows[0].n, 0, "the refused run left a login behind");
      // Following the hint, then re-running, works; the new login reads the
      // old login's queue table and passes the audit.
      await admin.query(`ALTER ROLE "${roles[1]}" RENAME TO "${renamed}"`);
      const moved = job({ WORKER_DATABASE_URL: renamedUrl });
      assert.equal(moved.status, 0, moved.stderr);
      assert.match(moved.stdout, new RegExp(`${renamed} updated`));
      const queue = open(renamedUrl);
      assert.equal(
        (await queue.query("SELECT count(*)::int AS n FROM pgboss.zoqc_queue"))
          .rows[0].n,
        1,
      );
      const audit = runJob(
        {
          MIGRATION_DATABASE_URL: adminUrl,
          APP_DATABASE_URL: liveAppUrl,
          WORKER_DATABASE_URL: renamedUrl,
        },
        ["--audit"],
      );
      assert.equal(audit.status, 0, audit.stderr);
    },
  );
});

test("legend-zoqc job works with a non-superuser CREATEROLE migration owner", async (t) => {
  // Managed PostgreSQL rarely grants superuser: the owner then has only
  // CREATEROLE and ADMIN on legend_app (it created that role on a fresh
  // cluster; simulated here with an explicit grant). Existing data
  // migrations run under forced RLS, so the owner needs BYPASSRLS (or
  // superuser); the logins it provisions never inherit that.
  const shared = process.env.STARTER_TEST_DATABASE_URL;
  assert.ok(shared, "Run pnpm test to create an isolated database.");
  remember(shared);
  const database = `legend_zoqc_${hex(6)}`;
  const owner = `zoqc_owner_${hex(6)}`;
  const ownerPassword = hex(24);
  const ownerUrl = withDatabase(shared, database);
  ownerUrl.username = owner;
  ownerUrl.password = ownerPassword;
  const adminUrl = remember(ownerUrl.toString());
  const appUrl = login(adminUrl, `legend_runtime_${hex(8)}`);
  const workerUrl = login(adminUrl, `legend_worker_${hex(8)}`);
  const roles = [appUrl, workerUrl].map((url) =>
    decodeURIComponent(new URL(url).username),
  );
  const cluster = quietPool({ connectionString: shared, max: 1 });
  // legend_app is cluster-wide; pnpm test migrates the shared database (and
  // so creates it) before any test file runs.
  const group = await cluster.query(
    "SELECT 1 FROM pg_roles WHERE rolname = 'legend_app'",
  );
  if (!group.rows.length) {
    await cluster.end();
    assert.fail(
      "legend_app does not exist: run this file through pnpm test, which migrates the shared test database first.",
    );
  }
  await cluster.query(
    `CREATE ROLE ${owner} LOGIN CREATEROLE BYPASSRLS PASSWORD '${ownerPassword}'`,
  );
  await cluster.query(
    `GRANT legend_app TO ${owner} WITH ADMIN OPTION, INHERIT FALSE, SET FALSE`,
  );
  await cluster.query(`CREATE DATABASE ${database} OWNER ${owner}`);
  t.after(async () => {
    await cluster.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    for (const role of [...roles, owner])
      await cluster.query(`DROP ROLE IF EXISTS "${role}"`);
    await cluster.end();
  });
  const migrated = spawnSync(pnpmCommand(), ["run", "db:migrate"], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: adminUrl,
      MIGRATION_DATABASE_URL: adminUrl,
    },
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  assert.equal(migrated.status, 0, migrated.stderr || migrated.stdout);
  for (const outcome of ["created", "updated"]) {
    const result = runJob({
      MIGRATION_DATABASE_URL: adminUrl,
      APP_DATABASE_URL: appUrl,
      WORKER_DATABASE_URL: workerUrl,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`${roles[1]} ${outcome}`));
  }
  // A flawed grant made by another grantor cannot be revoked by this owner:
  // the job refuses and names the grantor instead of reporting success.
  const superuser = decodeURIComponent(new URL(shared).username);
  await cluster.query(
    `GRANT legend_app TO "${roles[0]}" WITH ADMIN TRUE GRANTED BY "${superuser}"`,
  );
  const foreign = runJob({
    MIGRATION_DATABASE_URL: adminUrl,
    APP_DATABASE_URL: appUrl,
    WORKER_DATABASE_URL: workerUrl,
  });
  assert.equal(foreign.status, 1);
  assert.match(
    foreign.stderr,
    new RegExp(`legend_app \\(granted by ${superuser}\\) must have INHERIT`),
  );
  await cluster.query(
    `REVOKE legend_app FROM "${roles[0]}" GRANTED BY "${superuser}"`,
  );
  // Superuser-only role settings survive a non-superuser RESET ALL; the job
  // must refuse rather than report the login as clean.
  await cluster.query(
    `ALTER ROLE "${roles[0]}" SET session_replication_role = replica`,
  );
  const stuck = runJob({
    MIGRATION_DATABASE_URL: adminUrl,
    APP_DATABASE_URL: appUrl,
    WORKER_DATABASE_URL: workerUrl,
  });
  assert.equal(stuck.status, 1);
  assert.match(stuck.stderr, /settings this login cannot reset/);
  await cluster.query(`ALTER ROLE "${roles[0]}" RESET ALL`);
  const worker = quietPool({ connectionString: workerUrl, max: 1 });
  try {
    await worker.query("CREATE TABLE pgboss.zoqc_probe (id integer)");
  } finally {
    await worker.end();
  }
  // The owner may act as the queue login (SET) but never inherits its rights.
  const membership = await cluster.query(
    "SELECT m.inherit_option, m.set_option FROM pg_auth_members m WHERE m.roleid = (SELECT oid FROM pg_roles WHERE rolname = $1) AND m.member = (SELECT oid FROM pg_roles WHERE rolname = $2) AND m.set_option",
    [roles[1], owner],
  );
  assert.equal(membership.rows.length, 1);
  assert.equal(membership.rows[0].inherit_option, false);
});

// A complete single-VM env layout with valid placeholder values, so real
// `docker compose config` accepts it. Returns paths and the URLs used.
function wrapperFixture(
  dir,
  { migratorImage = "example.invalid/migrator:1" } = {},
) {
  const app = remember(
    `postgresql://legend_runtime_${hex(8)}:${hex(24)}@postgres:5432/legend`,
  );
  const worker = remember(
    `postgresql://legend_worker_${hex(8)}:${hex(24)}@postgres:5432/legend`,
  );
  const migration = remember(
    `postgresql://owner:${hex(24)}@postgres:5432/legend`,
  );
  const files = {
    migrator: `MIGRATION_DATABASE_URL=${migration}\n`,
    api: `APP_DATABASE_URL=${app}\nDATABASE_URL="${app}"\n`,
    web: "WEB_URL=https://app.example.invalid\n",
    worker: `DATABASE_URL=${app}\nAPP_DATABASE_URL=${app}\nWORKER_DATABASE_URL=${worker}\n`,
  };
  writeFileSync(join(dir, "pgbackrest.conf"), "");
  const write = (overrides = {}) => {
    for (const [name, body] of Object.entries({ ...files, ...overrides }))
      writeFileSync(join(dir, `${name}.env`), body, { mode: 0o600 });
    writeFileSync(
      join(dir, "compose.env"),
      [
        "POSTGRES_IMAGE=postgres:16-alpine",
        "POSTGRES_DB=legend",
        "POSTGRES_USER=owner",
        `POSTGRES_PASSWORD=${hex(8)}`,
        `PGBACKREST_CONFIG=${join(dir, "pgbackrest.conf")}`,
        `MIGRATOR_IMAGE=${migratorImage}`,
        "API_IMAGE=example.invalid/api:1",
        "WEB_IMAGE=example.invalid/web:1",
        "WORKER_IMAGE=example.invalid/worker:1",
        "TLS_ASK_TOKEN=token",
        "ACME_EMAIL=ops@example.invalid",
        ...["MIGRATOR", "API", "WEB", "WORKER"].map(
          (name) =>
            `${name}_ENV_FILE=${join(dir, `${name.toLowerCase()}.env`)}`,
        ),
      ].join("\n"),
    );
  };
  return { app, worker, files, write };
}

const wrapper = resolve(root, "deploy/single-vm/provision-roles.sh");

test("legend-zoqc operator wrapper passes restricted URLs via env and refuses admin credentials", () => {
  const dir = mkdtempSync(join(tmpdir(), "legend-zoqc-wrapper-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "log");
    const stub = (extra = "") =>
      writeFileSync(
        join(bin, "docker"),
        `#!/bin/sh\nprintf '%s|%s|%s|%s\\n' "$*" "\${APP_DATABASE_URL:-}" "\${WORKER_DATABASE_URL:-}" "\${API_ENV_FILE:-}" >> "$TEST_LOG"\n${extra}`,
        { mode: 0o755 },
      );
    const { app, worker, files, write } = wrapperFixture(dir);
    const run = (args = [], env = {}) => {
      writeFileSync(log, "");
      const result = spawnSync(
        wrapper,
        ["--env-file", join(dir, "compose.env"), ...args],
        {
          env: { PATH: `${bin}:${process.env.PATH}`, TEST_LOG: log, ...env },
          encoding: "utf8",
        },
      );
      const calls = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean);
      // Passwords may reach docker only through its environment, never argv.
      for (const call of calls)
        assert.deepEqual(
          leaks(call.split("|")[0]),
          [],
          "argv leaks a password",
        );
      return { ...result, calls };
    };

    // Control: a docker that prints its environment is caught by the same
    // leak check, so the check can fail.
    write();
    stub('printf "%s\\n" "$APP_DATABASE_URL"\n');
    const leaky = run();
    assert.equal(leaky.status, 0, leaky.stderr);
    assert.notDeepEqual(leaks(leaky.stdout), []);
    stub();

    const dry = run(["--dry-run"]);
    assert.equal(dry.status, 0, dry.stderr);
    assertNoSecrets(dry);
    assert.equal(dry.calls.length, 1);
    assert.match(dry.calls[0], /config --quiet\|\|\|/);

    // After the static checks, the effective configuration goes from
    // `config --format json` straight into check-compose-env.mjs (a pipe, so
    // the two calls may log in either order).
    const checkedEffective = (calls) => {
      const piped = calls.slice(1, 3);
      const config = piped.find((call) => /config --format json\|/.test(call));
      assert.ok(config, "config --format json did not run");
      // Compose fills ${VAR} in env files from its shell, so the config it
      // prints must come from the same environment as the later calls: the
      // checked URLs reach the checker only.
      assert.deepEqual(config.split("|").slice(1, 3), ["", ""]);
      const check = piped.find((call) => /check-compose-env\.mjs/.test(call));
      assert.ok(check, "check-compose-env.mjs did not run");
      assert.match(
        check,
        /^run --rm -i --network none -e APP_DATABASE_URL -e WORKER_DATABASE_URL -v .*check-compose-env\.mjs:\/tmp\/check-compose-env\.mjs:ro --entrypoint node example\.invalid\/migrator:1 \/tmp\/check-compose-env\.mjs\|/,
      );
      assert.deepEqual(check.split("|").slice(1, 3), [app, worker]);
    };
    const real = run();
    assert.equal(real.status, 0, real.stderr);
    assertNoSecrets(real);
    assert.equal(real.calls.length, 7);
    checkedEffective(real.calls);
    assert.match(real.calls[3], /up -d --wait postgres\|/);
    // legend-jtnd, legend-k1np: the pre-deploy check runs before migrate.
    assert.match(
      real.calls[4],
      /--profile migration run --rm migrate node dist\/predeploy-check\.js\|/,
    );
    assert.match(real.calls[5], /--profile migration run --rm migrate\|/);
    const [args, appEnv, workerEnv, apiFile] = real.calls[6].split("|");
    assert.match(args, /--profile provisioning run --rm provision-roles$/);
    assert.equal(appEnv, app);
    assert.equal(workerEnv, worker);
    // Compose gets the env file paths this script checked, pinned.
    assert.equal(apiFile, join(dir, "api.env"));

    const audit = run(["--audit"]);
    assert.equal(audit.status, 0, audit.stderr);
    assertNoSecrets(audit);
    assert.equal(audit.calls.length, 4);
    checkedEffective(audit.calls);
    assert.match(
      audit.calls[3],
      /--profile provisioning run --rm provision-roles node dist\/provision-roles\.js --audit\|/,
    );

    // A mismatch found in the effective configuration stops the wrapper
    // before any migration, provisioning or audit job runs.
    stub(
      'case "$*" in *check-compose-env*) echo "Effective Compose configuration refused: worker receives X" >&2; exit 1 ;; esac\n',
    );
    for (const args of [[], ["--audit"]]) {
      const mismatch = run(args);
      assert.equal(mismatch.status, 1, `${args}`);
      assert.match(
        mismatch.stderr,
        /Effective Compose configuration refused: worker receives X\n.*configuration docker compose would apply does not match/s,
      );
      assertNoSecrets(mismatch);
      assert.equal(mismatch.calls.length, 3, `${args}: a job ran anyway`);
    }
    // A checker that cannot start (image missing, no node) is a different
    // failure from a mismatch, and still stops everything.
    stub('case "$*" in *check-compose-env*) exit 125 ;; esac\n');
    const broken = run(["--audit"]);
    assert.equal(broken.status, 1);
    assert.match(
      broken.stderr,
      /could not run the configuration check \(docker exit 125\)/,
    );
    assert.doesNotMatch(broken.stderr, /does not match/);
    assert.equal(broken.calls.length, 3, "a job ran without the check");
    stub();
    // MIGRATOR_IMAGE (an exported one wins, as in Compose) must be a plain
    // image reference before it reaches docker run.
    const badImage = run(["--audit"], { MIGRATOR_IMAGE: "--privileged" });
    assert.equal(badImage.status, 1);
    assert.match(
      badImage.stderr,
      /MIGRATOR_IMAGE must be a plain image reference/,
    );
    assert.equal(badImage.calls.length, 1, "docker ran with a bad image");

    // An exported path the script did not check is refused, not followed.
    writeFileSync(
      join(dir, "evil.env"),
      `${files.api}MIGRATION_DATABASE_URL=postgresql://x:y@postgres/legend\n`,
    );
    const override = run(["--dry-run"], {
      API_ENV_FILE: join(dir, "evil.env"),
    });
    assert.equal(override.status, 1);
    assert.match(
      override.stderr,
      /shell exports API_ENV_FILE with a different value/,
    );
    assert.equal(override.calls.length, 0, "docker must not run");
    const same = run(["--dry-run"], { API_ENV_FILE: join(dir, "api.env") });
    assert.equal(same.status, 0, same.stderr);

    const short = app.replace(/:([a-f0-9]{48})@/, ":abc@");
    const refusals = [
      [
        {
          api: `${files.api}MIGRATION_DATABASE_URL=postgresql://x:y@postgres/legend\n`,
        },
        /contains MIGRATION_DATABASE_URL/,
      ],
      [
        { worker: `export MIGRATION_DATABASE_URL=x\n${files.worker}` },
        /contains MIGRATION_DATABASE_URL/,
      ],
      [
        {
          api: `${files.api}MIGRATION_DATABASE_URL: postgresql://x:y@postgres/legend\n`,
        },
        /contains MIGRATION_DATABASE_URL/,
      ],
      [
        { worker: `${files.worker}  MIGRATION_DATABASE_URL = x\n` },
        /contains MIGRATION_DATABASE_URL/,
      ],
      [
        { web: `${files.web}MIGRATION_DATABASE_URL\n` },
        /contains MIGRATION_DATABASE_URL/,
      ],
      [
        { web: `DATABASE_URL=${app}\n` },
        /web\.env must not contain DATABASE_URL/,
      ],
      [
        { worker: files.worker.replaceAll(app, app.replace("5432", "6432")) },
        /same restricted application login/,
      ],
      [
        {
          api: `APP_DATABASE_URL=${app}\nDATABASE_URL=postgresql://owner:pw@postgres:5432/legend\n`,
        },
        /DATABASE_URL in api\.env must equal/,
      ],
      [{ worker: `APP_DATABASE_URL=${app}\n` }, /must set WORKER_DATABASE_URL/],
      // Format problems surface before anything runs.
      [
        {
          api: `APP_DATABASE_URL=${short}\n`,
          worker: `APP_DATABASE_URL=${short}\nWORKER_DATABASE_URL=${worker}\n`,
        },
        /APP_DATABASE_URL must look like/,
      ],
      [
        {
          api: `APP_DATABASE_URL=${app}?user=owner\n`,
          worker: `APP_DATABASE_URL=${app}?user=owner\nWORKER_DATABASE_URL=${worker}\n`,
        },
        /APP_DATABASE_URL must look like/,
      ],
      [
        {
          worker: `APP_DATABASE_URL=${app}\nWORKER_DATABASE_URL=${worker.replace(/\/legend$/, "/other")}\n`,
        },
        /must name the same host, port and database\.$/m,
      ],
      [
        {
          migrator:
            "MIGRATION_DATABASE_URL=postgresql://owner:pw@db2:5432/legend\n",
        },
        /same host, port and database as MIGRATION_DATABASE_URL/,
      ],
      [
        { migrator: "OTHER=1\n" },
        /migrator\.env must set MIGRATION_DATABASE_URL/,
      ],
      // Compose reads a key behind a byte-order mark or no-break space; the
      // wrapper refuses such lines instead of missing them.
      [
        {
          api: `\uFEFFMIGRATION_DATABASE_URL=postgresql://x:y@postgres/legend\n${files.api}`,
        },
        /api\.env has a non-ASCII character .* before a key on line 1;/,
      ],
      [
        {
          worker: `${files.worker}\u00A0MIGRATION_DATABASE_URL=postgresql://x:y@postgres/legend\n`,
        },
        /worker\.env has a non-ASCII character .* before a key on line 4;/,
      ],
      [
        {
          worker: `${files.worker}NOTE="a\nb"\n\u00A0MIGRATION_DATABASE_URL=postgresql://x:y@postgres/legend\n`,
        },
        /worker\.env has a non-ASCII character .* before a key on line 6;/,
      ],
      [
        {
          worker: `${files.worker}NOTE='a\nb'\n\u00A0MIGRATION_DATABASE_URL=postgresql://x:y@postgres/legend\n`,
        },
        /worker\.env has a non-ASCII character .* before a key on line 6;/,
      ],
    ];
    for (const [overrides, message] of refusals) {
      write(overrides);
      const refused = run();
      assert.equal(refused.status, 1, String(message));
      assert.match(refused.stderr, message);
      assertNoSecrets(refused);
      assert.equal(refused.calls.length, 0, "docker must not run");
    }
    write({ migrator: "MIGRATION_DATABASE_URL_FILE=/run/secrets/migration\n" });
    const fromFile = run(["--dry-run"]);
    assert.equal(fromFile.status, 0, fromFile.stderr);
    // Non-ASCII in a value (also one spanning lines) or a comment is fine.
    write({
      web: `${files.web}# caf\u00E9\nBRAND=Caf\u00E9\nWELCOME="Halo\nSelamat datang \u2014 \\" ok"\nBYE='Sampai\njumpa \u2014 lagi'\n`,
    });
    const accented = run(["--dry-run"]);
    assert.equal(accented.status, 0, accented.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legend-jtnd wrapper --migrator refuses a bad migrator login before docker and keeps passwords off argv", () => {
  const dir = mkdtempSync(join(tmpdir(), "legend-jtnd-wrapper-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "log");
    // Logs argv, the two bootstrap variables and the two restricted URLs the
    // job must receive.
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/sh\nprintf '%s|%s|%s|%s|%s\\n' "$*" "\${BOOTSTRAP_DATABASE_USER:-}" "\${BOOTSTRAP_DATABASE_PASSWORD:-}" "\${APP_DATABASE_URL:-}" "\${WORKER_DATABASE_URL:-}" >> "$TEST_LOG"\n`,
      { mode: 0o755 },
    );
    const { write } = wrapperFixture(dir);
    const bootstrapPassword = hex(16);
    secrets.add(bootstrapPassword);
    const run = (args = ["--migrator"]) => {
      writeFileSync(log, "");
      const result = spawnSync(
        wrapper,
        ["--env-file", join(dir, "compose.env"), ...args],
        {
          env: { PATH: `${bin}:${process.env.PATH}`, TEST_LOG: log },
          encoding: "utf8",
        },
      );
      const calls = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean);
      for (const call of calls)
        assert.deepEqual(
          leaks(call.split("|")[0]),
          [],
          "argv leaks a password",
        );
      return { ...result, calls };
    };
    const setCompose = (extra) => {
      const path = join(dir, "compose.env");
      writeFileSync(
        path,
        readFileSync(path, "utf8")
          .split("\n")
          .filter((line) => !/^POSTGRES_(USER|PASSWORD)=/.test(line))
          .concat(extra)
          .join("\n"),
      );
    };
    const migrator = `legend_migrator_${hex(8)}`;
    const migratorUrl = remember(
      `postgresql://${migrator}:${hex(24)}@postgres:5432/legend`,
    );

    // Refused before any docker call.
    const refusals = [
      [
        "postgresql://owner:" + hex(24) + "@postgres:5432/legend",
        /MIGRATION_DATABASE_URL must look like postgresql:\/\/legend_migrator_<16 hex>/,
      ],
      [
        `postgresql://legend_migrator_${hex(7)}:${hex(24)}@postgres:5432/legend`,
        /MIGRATION_DATABASE_URL must look like/,
      ],
      [
        `postgresql://${migrator}:${hex(8)}@postgres:5432/legend`,
        /MIGRATION_DATABASE_URL must look like/,
      ],
    ];
    for (const [url, message] of refusals) {
      remember(url);
      write({ migrator: `MIGRATION_DATABASE_URL=${url}\n` });
      setCompose([
        "POSTGRES_USER=postgres",
        `POSTGRES_PASSWORD=${bootstrapPassword}`,
      ]);
      const refused = run();
      assert.equal(refused.status, 1, refused.stderr);
      assert.match(refused.stderr, message);
      assertNoSecrets(refused);
      assert.equal(refused.calls.length, 0, "docker must not run");
    }
    // A value Compose would resolve differently from the wrapper is refused,
    // naming the key only.
    write({ migrator: `MIGRATION_DATABASE_URL=${migratorUrl}\n` });
    const hostile = [
      ["POSTGRES_PASSWORD", `pa$$${hex(4)}`],
      ["POSTGRES_PASSWORD", `pa\\${hex(4)}`],
      ["POSTGRES_PASSWORD", `pa"${hex(4)}`],
      ["POSTGRES_PASSWORD", `pa'${hex(4)}`],
      ["POSTGRES_USER", `post$gres`],
    ];
    for (const [key, value] of hostile) {
      secrets.add(value);
      setCompose(
        key === "POSTGRES_USER"
          ? [`POSTGRES_USER=${value}`, `POSTGRES_PASSWORD=${bootstrapPassword}`]
          : ["POSTGRES_USER=postgres", `POSTGRES_PASSWORD=${value}`],
      );
      const refused = run();
      assert.equal(refused.status, 1, refused.stderr);
      assert.match(
        refused.stderr,
        new RegExp(`${key} in compose\\.env must not contain`),
      );
      assertNoSecrets(refused);
      assert.equal(refused.calls.length, 0, "docker must not run");
    }
    // The bootstrap superuser is required.
    setCompose([]);
    const noBootstrap = run();
    assert.equal(noBootstrap.status, 1);
    assert.match(
      noBootstrap.stderr,
      /compose\.env must set POSTGRES_USER and POSTGRES_PASSWORD/,
    );
    assert.equal(noBootstrap.calls.length, 0, "docker must not run");
    // Exclusive with the other modes.
    for (const args of [
      ["--migrator", "--audit"],
      ["--dry-run", "--migrator"],
    ]) {
      const both = run(args);
      assert.equal(both.status, 2, `${args}`);
      assert.equal(both.calls.length, 0, "docker must not run");
    }

    // Success: start postgres, then the --migrator job; the bootstrap
    // credentials arrive by environment only.
    setCompose([
      "POSTGRES_USER=postgres",
      `POSTGRES_PASSWORD=${bootstrapPassword}`,
    ]);
    const ok = run();
    assert.equal(ok.status, 0, ok.stderr);
    assertNoSecrets(ok);
    assert.equal(ok.calls.length, 5);
    assert.match(ok.calls[3], /up -d --wait postgres\|/);
    const [args, user, password] = ok.calls[4].split("|");
    assert.match(
      args,
      /--profile provisioning run --rm -e BOOTSTRAP_DATABASE_USER -e BOOTSTRAP_DATABASE_PASSWORD provision-roles node dist\/provision-roles\.js --migrator$/,
    );
    assert.equal(user, "postgres");
    assert.equal(password, bootstrapPassword);
    // The validated restricted URLs reach the job by environment too.
    const [, , , appUrl, workerUrl] = ok.calls[4].split("|");
    assert.match(appUrl, /^postgresql:\/\/legend_runtime_[a-f0-9]{16}:/);
    assert.match(workerUrl, /^postgresql:\/\/legend_worker_[a-f0-9]{16}:/);
    // No migration, pre-deploy check or audit in this mode.
    assert.doesNotMatch(
      ok.calls.join("\n"),
      /run --rm migrate|predeploy-check|--audit/,
    );
    for (const call of ok.calls.slice(0, 4))
      assert.deepEqual(call.split("|").slice(1, 3), ["", ""]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legend-zoqc wrapper hides docker compose output that can contain secrets", (t) => {
  // Real docker compose: it echoes an unparsable env line, password included.
  const probe = spawnSync("docker", ["compose", "version"], {
    encoding: "utf8",
  });
  if (probe.status !== 0) {
    t.skip("docker compose is not installed");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "legend-zoqc-compose-"));
  try {
    const { app, files, write } = wrapperFixture(dir);
    write();
    const env = { PATH: process.env.PATH, HOME: process.env.HOME };
    const ok = spawnSync(
      wrapper,
      ["--env-file", join(dir, "compose.env"), "--dry-run"],
      {
        env,
        encoding: "utf8",
      },
    );
    assert.equal(ok.status, 0, ok.stderr);
    write({ worker: `${files.worker}QUEUE_NOTE="${app}\n` });
    const broken = spawnSync(
      wrapper,
      ["--env-file", join(dir, "compose.env"), "--dry-run"],
      {
        env,
        encoding: "utf8",
      },
    );
    assert.equal(broken.status, 1);
    assert.match(
      broken.stderr,
      /docker compose could not read the configuration/,
    );
    assertNoSecrets(broken);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legend-zoqc wrapper refuses a key Compose would read behind a BOM or no-break space", (t) => {
  const probe = spawnSync("docker", ["compose", "version"], {
    encoding: "utf8",
  });
  if (probe.status !== 0) {
    t.skip("docker compose is not installed");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "legend-zoqc-bom-"));
  try {
    const { files, write } = wrapperFixture(dir);
    const admin = remember(
      `postgresql://owner:${hex(24)}@postgres:5432/legend`,
    );
    const env = { PATH: process.env.PATH, HOME: process.env.HOME };
    for (const [name, api] of [
      ["BOM", `\uFEFFMIGRATION_DATABASE_URL=${admin}\n${files.api}`],
      ["NBSP", `${files.api}\u00A0MIGRATION_DATABASE_URL=${admin}\n`],
    ]) {
      write({ api });
      // Real Compose really hands this key to the API service (the output
      // holds secrets: parsed here, never printed).
      const config = spawnSync(
        "docker",
        [
          "compose",
          "--env-file",
          join(dir, "compose.env"),
          "-f",
          resolve(root, "deploy/single-vm/compose.yaml"),
          "config",
          "--format",
          "json",
        ],
        { env, encoding: "utf8" },
      );
      assert.equal(config.status, 0, `${name}: docker compose config failed`);
      const environment = JSON.parse(config.stdout).services.api.environment;
      assert.ok(
        Object.keys(environment).some((key) =>
          key.endsWith("MIGRATION_DATABASE_URL"),
        ),
        `${name}: Compose no longer reads the hidden key`,
      );
      const refused = spawnSync(
        wrapper,
        ["--env-file", join(dir, "compose.env"), "--dry-run"],
        { env, encoding: "utf8" },
      );
      assert.equal(refused.status, 1, `${name}: the wrapper accepted it`);
      assert.match(refused.stderr, /api\.env has a non-ASCII character/);
      assertNoSecrets(refused);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legend-zoqc Compose check catches keys the line-based checks cannot see", (t) => {
  const probe = spawnSync("docker", ["compose", "version"], {
    encoding: "utf8",
  });
  if (probe.status !== 0) {
    t.skip("docker compose is not installed");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "legend-zoqc-effective-"));
  try {
    const image = "node:22-slim";
    const { app, worker, files, write } = wrapperFixture(dir, {
      migratorImage: image,
    });
    const admin = remember(
      `postgresql://owner:${hex(24)}@postgres:5432/legend`,
    );
    const env = { PATH: process.env.PATH, HOME: process.env.HOME };
    const composeArgs = [
      "compose",
      "--env-file",
      join(dir, "compose.env"),
      "-f",
      resolve(root, "deploy/single-vm/compose.yaml"),
    ];
    // Real `docker compose config --format json` piped into the checker, the
    // way provision-roles.sh does (here with the host's node).
    const check = () => {
      const config = spawnSync(
        "docker",
        [...composeArgs, "config", "--format", "json"],
        {
          env,
          encoding: "utf8",
        },
      );
      assert.equal(config.status, 0, "docker compose config failed");
      const result = spawnSync(
        process.execPath,
        [resolve(root, "deploy/single-vm/check-compose-env.mjs")],
        {
          input: config.stdout,
          env: { ...env, APP_DATABASE_URL: app, WORKER_DATABASE_URL: worker },
          encoding: "utf8",
        },
      );
      assertNoSecrets(result);
      return result;
    };
    const dryRun = () =>
      spawnSync(
        wrapper,
        ["--env-file", join(dir, "compose.env"), "--dry-run"],
        {
          env,
          encoding: "utf8",
        },
      );
    write();
    const clean = check();
    assert.equal(clean.status, 0, clean.stderr);
    const cases = [
      [
        "text after a closing double quote",
        { api: `${files.api}A="x" MIGRATION_DATABASE_URL=${admin}\n` },
        /api receives MIGRATION_DATABASE_URL/,
      ],
      [
        "text after a closing single quote",
        { api: `${files.api}A='x' MIGRATION_DATABASE_URL=${admin}\n` },
        /api receives MIGRATION_DATABASE_URL/,
      ],
      [
        "an empty quoted value, then the API URL",
        { api: `${files.api}NOTE="" APP_DATABASE_URL=${admin}\n` },
        /api receives an APP_DATABASE_URL other than the checked one/,
      ],
      [
        "an empty quoted value, then the queue URL",
        { worker: `${files.worker}X="" WORKER_DATABASE_URL=${admin}\n` },
        /worker receives a WORKER_DATABASE_URL other than the checked one/,
      ],
      [
        "a double-quoted value spanning lines hides the real queue URL",
        {
          worker: `APP_DATABASE_URL=${app}\nWORKER_DATABASE_URL=${admin}\nNOTE="\nWORKER_DATABASE_URL=${worker}\n"\n`,
        },
        /worker receives a WORKER_DATABASE_URL other than the checked one/,
      ],
      [
        "a single-quoted value spanning lines hides the real queue URL",
        {
          worker: `APP_DATABASE_URL=${app}\nWORKER_DATABASE_URL=${admin}\nNOTE='\nWORKER_DATABASE_URL=${worker}\n'\n`,
        },
        /worker receives a WORKER_DATABASE_URL other than the checked one/,
      ],
    ];
    for (const [name, overrides, message] of cases) {
      write(overrides);
      // The line-based checks really miss it: only the Compose check sees it.
      const lexical = dryRun();
      assert.equal(lexical.status, 0, `${name}: ${lexical.stderr}`);
      const refused = check();
      assert.equal(refused.status, 1, `${name}: the check accepted it`);
      assert.match(refused.stderr, message, name);
    }
    // The wrapper's own pipeline, end to end: Compose pipes the JSON into
    // node in the migrator image (no network) with the checker mounted
    // read-only. An accepted configuration exits 0; a refused one stops the
    // audit before the audit job runs (no postgres is started).
    const local = spawnSync("docker", ["image", "inspect", image], {
      encoding: "utf8",
    });
    if (local.status !== 0) {
      t.diagnostic(`${image} is not pulled; skipped the in-image run`);
      return;
    }
    write();
    const pipeline = spawnSync(
      "sh",
      [
        "-c",
        'docker "$@" config --format json 2>/dev/null | docker run --rm -i --network none -e APP_DATABASE_URL -e WORKER_DATABASE_URL -v "$CHECK:/tmp/check-compose-env.mjs:ro" --entrypoint node "$IMAGE" /tmp/check-compose-env.mjs',
        "sh",
        ...composeArgs,
      ],
      {
        env: {
          ...env,
          CHECK: resolve(root, "deploy/single-vm/check-compose-env.mjs"),
          IMAGE: image,
          APP_DATABASE_URL: app,
          WORKER_DATABASE_URL: worker,
        },
        encoding: "utf8",
      },
    );
    assertNoSecrets(pipeline);
    assert.equal(pipeline.status, 0, pipeline.stderr);
    write(cases[3][1]);
    const audit = spawnSync(
      wrapper,
      ["--env-file", join(dir, "compose.env"), "--audit"],
      { env, encoding: "utf8" },
    );
    assertNoSecrets(audit);
    assert.equal(audit.status, 1);
    assert.match(
      audit.stderr,
      /Effective Compose configuration refused: worker receives a WORKER_DATABASE_URL other than the checked one/,
    );
    assert.doesNotMatch(
      audit.stderr + audit.stdout,
      /provision-roles\.js|Role audit/,
    );

    // Compose fills ${VAR} in env files from its shell and compose.env. The
    // wrapper must read the configuration with the environment the later
    // Compose calls get, not with the checked URLs exported: otherwise
    // `${WORKER_DATABASE_URL}` would look right to the check and resolve to
    // compose.env's value in production. A docker shim passes only the
    // config and checker calls to the real docker and logs the rest.
    const realDocker = spawnSync("sh", ["-c", "command -v docker"], {
      encoding: "utf8",
    }).stdout.trim();
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    const jobs = join(dir, "jobs");
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/sh\ncase "$*" in *"config --format json"*|*check-compose-env*) exec "$REAL_DOCKER" "$@" ;; esac\nprintf '%s\\n' "$*" >> "$JOBS"\n`,
      { mode: 0o755 },
    );
    write({
      worker: `${files.worker}X="" WORKER_DATABASE_URL=\${WORKER_DATABASE_URL}\n`,
    });
    appendFileSync(
      join(dir, "compose.env"),
      `\nWORKER_DATABASE_URL=${admin}\n`,
    );
    writeFileSync(jobs, "");
    const interpolated = spawnSync(
      wrapper,
      ["--env-file", join(dir, "compose.env"), "--audit"],
      {
        env: {
          ...env,
          PATH: `${bin}:${env.PATH}`,
          REAL_DOCKER: realDocker,
          JOBS: jobs,
        },
        encoding: "utf8",
      },
    );
    assertNoSecrets(interpolated);
    assert.equal(interpolated.status, 1, interpolated.stderr);
    assert.match(
      interpolated.stderr,
      /Effective Compose configuration refused: worker receives a WORKER_DATABASE_URL other than the checked one/,
    );
    // Only the static `config --quiet` call reached the shim; no job ran.
    assert.doesNotMatch(readFileSync(jobs, "utf8"), /provision-roles|up -d/);
    assert.match(readFileSync(jobs, "utf8"), /config --quiet/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legend-zoqc deploy.sh audits roles after migrating and before starting services", () => {
  const result = spawnSync(resolve(root, "deploy/single-vm/test-deploy.sh"), {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("legend-usyi job provisions the audit retention login: group only, no table rights, two functions", async (t) => {
  const shared = process.env.STARTER_TEST_DATABASE_URL;
  assert.ok(
    shared && process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"),
    "Run pnpm test to create an isolated database.",
  );
  const database = `legend_usyi_${hex(6)}`;
  const adminUrl = withDatabase(shared, database).toString();
  const appUrl = login(adminUrl, `legend_runtime_${hex(8)}`);
  const workerUrl = login(adminUrl, `legend_worker_${hex(8)}`);
  const maintUrl = login(adminUrl, `legend_maint_${hex(8)}`);
  remember(shared);
  const roles = [appUrl, workerUrl, maintUrl].map((url) =>
    decodeURIComponent(new URL(url).username),
  );
  const maintUser = roles[2];
  const cluster = quietPool({ connectionString: shared, max: 1 });
  await cluster.query(`CREATE DATABASE ${database}`);
  const admin = quietPool({ connectionString: adminUrl, max: 1 });
  const pools = [];
  t.after(async () => {
    for (const pool of pools) await pool.end();
    await admin.end();
    await cluster.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    for (const role of roles)
      await cluster.query(`DROP ROLE IF EXISTS "${role}"`);
    await cluster.end();
  });
  const migrated = spawnSync(pnpmCommand(), ["run", "db:migrate"], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: adminUrl,
      MIGRATION_DATABASE_URL: adminUrl,
    },
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  assert.equal(migrated.status, 0, migrated.stderr);

  const env = (overrides = {}) => ({
    MIGRATION_DATABASE_URL: adminUrl,
    APP_DATABASE_URL: appUrl,
    WORKER_DATABASE_URL: workerUrl,
    MAINTENANCE_DATABASE_URL: maintUrl,
    ...overrides,
  });
  const first = runJob(env());
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, new RegExp(`${maintUser} created`));
  const second = runJob(env());
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, new RegExp(`${maintUser} updated`));

  await t.test(
    "the login is a plain member of legend_maintenance and nothing else",
    async () => {
      const role = (
        await admin.query(
          "SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin FROM pg_roles WHERE rolname = $1",
          [maintUser],
        )
      ).rows[0];
      assert.deepEqual(role, {
        rolsuper: false,
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolcanlogin: true,
      });
      const groups = await admin.query(
        "SELECT g.rolname, m.inherit_option, m.admin_option FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member WHERE u.rolname = $1",
        [maintUser],
      );
      assert.deepEqual(groups.rows, [
        {
          rolname: "legend_maintenance",
          inherit_option: true,
          admin_option: false,
        },
      ]);
    },
  );

  await t.test(
    "the login reads no table but can run the retention functions",
    async () => {
      const pool = quietPool({ connectionString: maintUrl, max: 1 });
      pools.push(pool);
      for (const table of ["audit_logs", "tenants"])
        await assert.rejects(pool.query(`SELECT 1 FROM public.${table}`), {
          code: "42501",
        });
      const due = await pool.query(
        "SELECT * FROM app.audit_retention_due_tenants()",
      );
      assert.deepEqual(due.rows, []);
    },
  );

  await t.test("audit mode passes with the maintenance login", () => {
    const audit = runJob(env(), ["--audit"]);
    assert.equal(audit.status, 0, audit.stderr);
    assert.match(audit.stdout, new RegExp(`Audit passed.*${maintUser}`));
  });

  const drift = [
    [
      "a table right on audit_logs for the group",
      ["GRANT SELECT ON public.audit_logs TO legend_maintenance"],
      ["REVOKE SELECT ON public.audit_logs FROM legend_maintenance"],
      /table rights it must not have/,
    ],
    [
      "membership in legend_app",
      [`GRANT legend_app TO "${maintUser}"`],
      [`REVOKE legend_app FROM "${maintUser}"`],
      /unexpected roles/,
    ],
    [
      "a retention function open to PUBLIC",
      ["GRANT EXECUTE ON FUNCTION app.audit_retention_due_tenants() TO PUBLIC"],
      [
        "REVOKE EXECUTE ON FUNCTION app.audit_retention_due_tenants() FROM PUBLIC",
      ],
      /PUBLIC or legend_app/,
    ],
    [
      "a retention function open to legend_app",
      [
        "GRANT EXECUTE ON FUNCTION app.audit_retention_due_tenants() TO legend_app",
      ],
      [
        "REVOKE EXECUTE ON FUNCTION app.audit_retention_due_tenants() FROM legend_app",
      ],
      /PUBLIC or legend_app/,
    ],
    [
      "a retention function that is not SECURITY DEFINER",
      ["ALTER FUNCTION app.audit_retention_due_tenants() SECURITY INVOKER"],
      ["ALTER FUNCTION app.audit_retention_due_tenants() SECURITY DEFINER"],
      /not SECURITY DEFINER/,
    ],
    [
      "a retention function without a pinned search_path",
      ["ALTER FUNCTION app.audit_retention_due_tenants() RESET search_path"],
      [
        "ALTER FUNCTION app.audit_retention_due_tenants() SET search_path = pg_catalog, pg_temp",
      ],
      /no pinned search_path/,
    ],
    [
      "a retention function owned by someone else",
      [
        `CREATE ROLE usyi_other_owner NOLOGIN`,
        "ALTER FUNCTION app.audit_retention_due_tenants() OWNER TO usyi_other_owner",
      ],
      [
        "ALTER FUNCTION app.audit_retention_due_tenants() OWNER TO CURRENT_USER",
        "DROP ROLE usyi_other_owner",
      ],
      /not owned by the owner of audit_logs/,
    ],
    [
      "an extra function in schema app",
      [
        "CREATE FUNCTION app.usyi_extra() RETURNS int LANGUAGE sql AS 'SELECT 1'",
        "REVOKE ALL ON FUNCTION app.usyi_extra() FROM PUBLIC",
        "GRANT EXECUTE ON FUNCTION app.usyi_extra() TO legend_maintenance",
      ],
      ["DROP FUNCTION app.usyi_extra()"],
      /functions beyond its two/,
    ],
    [
      "a SECURITY DEFINER function in schema app left open to PUBLIC",
      [
        "CREATE FUNCTION app.usyi_secdef() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS 'SELECT 1'",
      ],
      ["DROP FUNCTION app.usyi_secdef()"],
      /may run SECURITY DEFINER functions beyond its two/,
    ],
    [
      "a SECURITY DEFINER function in schema public left open to PUBLIC",
      [
        "CREATE FUNCTION public.usyi_secdef() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS 'SELECT 1'",
      ],
      ["DROP FUNCTION public.usyi_secdef()"],
      /may run SECURITY DEFINER functions beyond its two/,
    ],
  ];
  for (const [name, breakIt, fix, message] of drift)
    await t.test(`provisioning and audit refuse ${name}`, async () => {
      for (const sql of breakIt) await admin.query(sql);
      try {
        for (const args of [[], ["--audit"]]) {
          const result = runJob(env(), args);
          assert.equal(result.status, 1, `${name} ${args}`);
          assert.match(result.stderr, message);
        }
      } finally {
        for (const sql of fix) await admin.query(sql);
      }
      const healed = runJob(env(), ["--audit"]);
      assert.equal(healed.status, 0, healed.stderr);
    });

  await t.test(
    "a queue-style login name is refused for the maintenance URL",
    () => {
      const bad = login(adminUrl, `legend_worker_${hex(8)}`);
      const result = runJob(env({ MAINTENANCE_DATABASE_URL: bad }));
      assert.equal(result.status, 1);
      assert.match(result.stderr, /maintenance login has an invalid name/);
    },
  );

  await t.test(
    "without the maintenance URL nothing about it is provisioned or audited",
    () => {
      const result = runJob(env({ MAINTENANCE_DATABASE_URL: "" }), ["--audit"]);
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, new RegExp(maintUser));
    },
  );
});

test("legend-usyi Compose check: MAINTENANCE_DATABASE_URL reaches the worker only", () => {
  const app = "postgresql://app:secret-a@postgres:5432/legend";
  const worker = "postgresql://worker:secret-w@postgres:5432/legend";
  const maint = "postgresql://maint:secret-m@postgres:5432/legend";
  const config = (overrides = {}) => ({
    services: {
      api: { environment: { APP_DATABASE_URL: app } },
      web: { environment: {} },
      worker: {
        environment: {
          APP_DATABASE_URL: app,
          WORKER_DATABASE_URL: worker,
          MAINTENANCE_DATABASE_URL: maint,
        },
      },
      ...overrides,
    },
  });
  const check = (input, expectedMaintenance = maint) => {
    const result = spawnSync(
      process.execPath,
      [resolve(root, "deploy/single-vm/check-compose-env.mjs")],
      {
        input: JSON.stringify(input),
        env: {
          PATH: process.env.PATH,
          APP_DATABASE_URL: app,
          WORKER_DATABASE_URL: worker,
          ...(expectedMaintenance
            ? { MAINTENANCE_DATABASE_URL: expectedMaintenance }
            : {}),
        },
        encoding: "utf8",
      },
    );
    for (const secret of ["secret-a", "secret-w", "secret-m"])
      assert.ok(!result.stderr.includes(secret), "stderr leaks a password");
    return result;
  };
  const ok = check(config());
  assert.equal(ok.status, 0, ok.stderr);
  for (const service of ["api", "web"]) {
    const refused = check(
      config({
        [service]: {
          environment: {
            APP_DATABASE_URL: app,
            MAINTENANCE_DATABASE_URL: maint,
          },
        },
      }),
    );
    assert.equal(refused.status, 1);
    assert.match(
      refused.stderr,
      new RegExp(`${service} receives MAINTENANCE_DATABASE_URL`),
    );
  }
  const other = check(
    config({
      worker: {
        environment: {
          APP_DATABASE_URL: app,
          WORKER_DATABASE_URL: worker,
          MAINTENANCE_DATABASE_URL: app,
        },
      },
    }),
  );
  assert.equal(other.status, 1);
  assert.match(
    other.stderr,
    /worker receives a MAINTENANCE_DATABASE_URL other than the checked one/,
  );
  // Checked URL absent (worker.env does not set it), yet the worker gets one.
  const unchecked = check(config(), "");
  assert.equal(unchecked.status, 1);
  assert.match(unchecked.stderr, /MAINTENANCE_DATABASE_URL not checked/);
});

test("legend-usyi wrapper validates MAINTENANCE_DATABASE_URL and hands it to the job through env only", () => {
  const dir = mkdtempSync(join(tmpdir(), "legend-usyi-wrapper-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "log");
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/sh\nprintf '%s|%s\\n' "$*" "\${MAINTENANCE_DATABASE_URL:-}" >> "$TEST_LOG"\n`,
      { mode: 0o755 },
    );
    const { worker, files, write } = wrapperFixture(dir);
    const maint = remember(
      `postgresql://legend_maint_${hex(8)}:${hex(24)}@postgres:5432/legend`,
    );
    const run = (args = []) => {
      writeFileSync(log, "");
      const result = spawnSync(
        wrapper,
        ["--env-file", join(dir, "compose.env"), ...args],
        {
          env: { PATH: `${bin}:${process.env.PATH}`, TEST_LOG: log },
          encoding: "utf8",
        },
      );
      const calls = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean);
      for (const call of calls)
        assert.deepEqual(
          leaks(call.split("|")[0]),
          [],
          "argv leaks a password",
        );
      assertNoSecrets(result);
      return { ...result, calls };
    };
    const workerWith = (url) =>
      `${files.worker}MAINTENANCE_DATABASE_URL=${url}\n`;

    write({ worker: workerWith(maint) });
    const real = run();
    assert.equal(real.status, 0, real.stderr);
    // The checker and the provisioning job both receive it, by environment.
    const check = real.calls.find((call) =>
      /check-compose-env\.mjs/.test(call),
    );
    assert.match(
      check,
      /-e WORKER_DATABASE_URL -e MAINTENANCE_DATABASE_URL -v /,
    );
    assert.equal(check.split("|")[1], maint);
    assert.equal(real.calls.at(-1).split("|")[1], maint);

    const refusals = [
      [
        "api.env carries it",
        {
          worker: workerWith(maint),
          api: `${files.api}MAINTENANCE_DATABASE_URL=${maint}\n`,
        },
        /api\.env must not contain MAINTENANCE_DATABASE_URL/,
      ],
      [
        "web.env carries it",
        {
          worker: workerWith(maint),
          web: `${files.web}MAINTENANCE_DATABASE_URL=${maint}\n`,
        },
        /web\.env must not contain MAINTENANCE_DATABASE_URL/,
      ],
      [
        "it uses a queue login name",
        {
          worker: workerWith(
            worker.replace(
              /legend_worker_[a-f0-9]{16}/,
              `legend_worker_${hex(8)}`,
            ),
          ),
        },
        /MAINTENANCE_DATABASE_URL must look like/,
      ],
      [
        "it names another database",
        { worker: workerWith(maint.replace(/\/legend$/, "/other")) },
        /same host, port and database/,
      ],
      [
        "it is empty",
        { worker: workerWith("") },
        /MAINTENANCE_DATABASE_URL in worker\.env is empty/,
      ],
    ];
    for (const [name, overrides, message] of refusals) {
      write(overrides);
      const refused = run(["--dry-run"]);
      assert.equal(refused.status, 1, name);
      assert.match(refused.stderr, message, name);
      assert.equal(refused.calls.length, 0, `${name}: docker ran`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
