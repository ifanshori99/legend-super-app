// First-boot database role provisioning (legend-zoqc, PRD §3 F3, TEN-02).
// Empty database → migrations → job (twice) → the application login reads and
// writes only through RLS and cannot run DDL or bypass RLS; the queue login
// touches only its own schema and the active tenant registry. The operator
// wrapper is exercised with a stubbed docker so no secret leaves the process.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
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

const hex = (bytes) => randomBytes(bytes).toString("hex");
const tenantA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const tenantB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function runJob(env) {
  // A clean environment: only what an operator would pass to the job.
  const base = { PATH: process.env.PATH, HOME: process.env.HOME };
  return spawnSync(
    pnpmCommand(),
    ["--filter", "@starter/api", "exec", "tsx", "src/provision-roles.ts"],
    {
      cwd: root,
      env: { ...base, ...env },
      encoding: "utf8",
      shell: process.platform === "win32",
    },
  );
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
  return next.toString();
}

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
  const unsafeUser = `legend_runtime_${hex(8)}`;
  const grantor = `zoqc_grantor_${hex(6)}`;
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
    for (const role of [...roles, unsafeUser, grantor])
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

  const secrets = [appUrl, workerUrl, adminUrl].map((url) =>
    decodeURIComponent(new URL(url).password),
  );
  const assertNoSecrets = (result) => {
    for (const secret of secrets) {
      assert.ok(!result.stdout.includes(secret), "stdout leaks a password");
      assert.ok(!result.stderr.includes(secret), "stderr leaks a password");
    }
  };

  const first = runJob({
    MIGRATION_DATABASE_URL: adminUrl,
    APP_DATABASE_URL: appUrl,
    WORKER_DATABASE_URL: workerUrl,
  });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, new RegExp(`${roles[0]} created`));
  assert.match(first.stdout, new RegExp(`${roles[1]} created`));
  assertNoSecrets(first);

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
  assertNoSecrets(second);

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
    "application login reads and writes only within its tenant (RLS)",
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
      const worker = open(workerUrl);
      await assert.rejects(worker.query("SELECT * FROM zoqc_fixture"), {
        code: "42501",
      });
      await worker.query("SELECT id FROM app.active_tenant_registry LIMIT 1");
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

  await t.test(
    "the job refuses unsafe inputs and drifted privileges",
    async () => {
      const job = (overrides) =>
        runJob({
          MIGRATION_DATABASE_URL: adminUrl,
          APP_DATABASE_URL: appUrl,
          WORKER_DATABASE_URL: workerUrl,
          ...overrides,
        });
      // The migration (administrator) login can never be handed out as the app login.
      const reused = job({ APP_DATABASE_URL: adminUrl });
      assert.equal(reused.status, 1);
      assert.match(reused.stderr, /uses the migration login/);
      assertNoSecrets(reused);
      // A same-named role created with extra powers is not adopted.
      await admin.query(
        `CREATE ROLE "${unsafeUser}" LOGIN CREATEDB PASSWORD NULL`,
      );
      const unsafe = job({ APP_DATABASE_URL: login(adminUrl, unsafeUser) });
      assert.equal(unsafe.status, 1);
      assert.match(unsafe.stderr, /already exists with unsafe privileges/);
      // A later grant of DDL to the app group is caught on the next run and
      // rolled back with the rest of the transaction.
      await admin.query("GRANT CREATE ON SCHEMA app TO legend_app");
      try {
        const drifted = job({});
        assert.equal(drifted.status, 1);
        assert.match(drifted.stderr, /can create objects \(schema app\)/);
      } finally {
        await admin.query("REVOKE CREATE ON SCHEMA app FROM legend_app");
      }
      // Rights that skip RLS or reach beyond the login's lane are refused.
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
        [
          `ALTER FUNCTION app.require_tenant_id() OWNER TO "${roles[0]}"`,
          `ALTER FUNCTION app.require_tenant_id() OWNER TO CURRENT_USER`,
          /owns tables, functions, types or schemas/,
        ],
      ];
      drifts.push([
        "CREATE VIEW public.zoqc_public AS SELECT 1 AS x; GRANT SELECT ON public.zoqc_public TO PUBLIC",
        "DROP VIEW public.zoqc_public",
        /queue role has table rights it must not have: SELECT on public\.zoqc_public/,
      ]);
      for (const [grant, revoke, message] of drifts) {
        await admin.query(grant);
        try {
          const drifted = job({});
          assert.equal(drifted.status, 1, grant);
          assert.match(drifted.stderr, message);
        } finally {
          await admin.query(revoke);
        }
      }
      // Extension views readable by PUBLIC (pg_stat_statements) are not a
      // right of the login and must not block provisioning.
      await admin.query("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
      const extension = job({});
      assert.equal(extension.status, 0, extension.stderr);
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
          "SELECT rolinherit, rolvaliduntil = 'infinity'::timestamptz AS forever, rolconnlimit, (SELECT count(*)::int FROM pg_db_role_setting WHERE setrole = r.oid) AS settings FROM pg_roles r WHERE rolname = $1",
          [roles[0]],
        )
      ).rows[0];
      assert.equal(role.rolinherit, true);
      assert.equal(role.forever, true);
      assert.equal(role.rolconnlimit, -1);
      assert.equal(role.settings, 0);
      const missing = job({ WORKER_DATABASE_URL: "" });
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /WORKER_DATABASE_URL is required/);
      const again = job({});
      assert.equal(again.status, 0, again.stderr);
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
  const database = `legend_zoqc_${hex(6)}`;
  const owner = `zoqc_owner_${hex(6)}`;
  const ownerPassword = hex(24);
  const ownerUrl = withDatabase(shared, database);
  ownerUrl.username = owner;
  ownerUrl.password = ownerPassword;
  const adminUrl = ownerUrl.toString();
  const appUrl = login(adminUrl, `legend_runtime_${hex(8)}`);
  const workerUrl = login(adminUrl, `legend_worker_${hex(8)}`);
  const roles = [appUrl, workerUrl].map((url) =>
    decodeURIComponent(new URL(url).username),
  );
  const cluster = quietPool({ connectionString: shared, max: 1 });
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

test("legend-zoqc operator wrapper passes restricted URLs via env and refuses admin credentials", () => {
  const dir = mkdtempSync(join(tmpdir(), "legend-zoqc-wrapper-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "log");
    writeFileSync(
      join(bin, "docker"),
      '#!/bin/sh\nprintf \'%s|%s|%s\\n\' "$*" "${APP_DATABASE_URL:-}" "${WORKER_DATABASE_URL:-}" >> "$TEST_LOG"\n',
      { mode: 0o755 },
    );
    const app = `postgresql://legend_runtime_${hex(8)}:${hex(24)}@postgres:5432/legend`;
    const worker = `postgresql://legend_worker_${hex(8)}:${hex(24)}@postgres:5432/legend`;
    const files = {
      api: `APP_DATABASE_URL=${app}\nDATABASE_URL="${app}"\n`,
      web: "WEB_URL=https://app.example.invalid\n",
      worker: `DATABASE_URL=${app}\nAPP_DATABASE_URL=${app}\nWORKER_DATABASE_URL=${worker}\n`,
    };
    const write = (overrides = {}) => {
      for (const [name, body] of Object.entries({ ...files, ...overrides }))
        writeFileSync(join(dir, `${name}.env`), body, { mode: 0o600 });
      writeFileSync(
        join(dir, "compose.env"),
        ["API", "WEB", "WORKER"]
          .map(
            (name) =>
              `${name}_ENV_FILE=${join(dir, `${name.toLowerCase()}.env`)}`,
          )
          .join("\n"),
      );
    };
    const run = (...args) => {
      writeFileSync(log, "");
      const result = spawnSync(
        resolve(root, "deploy/single-vm/provision-roles.sh"),
        ["--env-file", join(dir, "compose.env"), ...args],
        {
          env: { PATH: `${bin}:${process.env.PATH}`, TEST_LOG: log },
          encoding: "utf8",
        },
      );
      for (const url of [app, worker]) {
        const password = decodeURIComponent(new URL(url).password);
        assert.ok(!result.stdout.includes(password));
        assert.ok(!result.stderr.includes(password));
      }
      return {
        ...result,
        calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean),
      };
    };

    write();
    const dry = run("--dry-run");
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(dry.calls.length, 1);
    assert.match(dry.calls[0], /config --quiet\|\|$/);

    const real = run();
    assert.equal(real.status, 0, real.stderr);
    assert.equal(real.calls.length, 4);
    assert.match(real.calls[1], /up -d --wait postgres\|/);
    assert.match(real.calls[2], /--profile migration run --rm migrate\|/);
    // Secrets reach docker only through the environment, never as arguments.
    const [args, appEnv, workerEnv] = real.calls[3].split("|");
    assert.match(args, /--profile provisioning run --rm provision-roles$/);
    assert.equal(appEnv, app);
    assert.equal(workerEnv, worker);
    for (const call of real.calls) {
      const argv = call.split("|")[0];
      assert.ok(!argv.includes(app) && !argv.includes(worker));
    }

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
    ];
    for (const [overrides, message] of refusals) {
      write(overrides);
      const refused = run();
      assert.equal(refused.status, 1, String(message));
      assert.match(refused.stderr, message);
      assert.equal(refused.calls.length, 0, "docker must not run");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
