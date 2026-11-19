// legend-2ywn: the role audit compares what PUBLIC (and so the application and
// queue logins) may EXECUTE against the trusted built-in baseline of a stock
// PostgreSQL, not against a denylist of known-dangerous functions. A built-in
// administrative function that a stock server keeps away from PUBLIC (for
// example pg_switch_wal) must fail both the provisioning job and `--audit` the
// moment PUBLIC gets EXECUTE on it, even though no list names it.
//
// Assumption: the message wording is not fixed by the card, so the tests
// assert the exit status (1), a "Role audit failed" prefix for --audit, and
// that the offending function name is reported.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { pnpmCommand, root } from "../scripts/lib.mjs";
import { useRoleAuditLock } from "./helpers/role-audit-lock.mjs";
import {
  dropTestDatabase,
  endTestPool,
} from "../apps/api/src/test/helpers/database-cleanup.ts";

useRoleAuditLock();

const hex = (bytes) => randomBytes(bytes).toString("hex");

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

const jobCommand = [
  "--filter",
  "@starter/api",
  "exec",
  "tsx",
  "src/provision-roles.ts",
];

function runJob(env, args = []) {
  return spawnSync(pnpmCommand(), [...jobCommand, ...args], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    encoding: "utf8",
    shell: process.platform === "win32",
  });
}

// Stock PostgreSQL does not give PUBLIC EXECUTE on any of these. Signatures are
// the same on every supported major version.
const ADMIN_FUNCTIONS = [
  "pg_switch_wal()",
  "pg_reload_conf()",
  "pg_rotate_logfile()",
];

test("legend-2ywn role audit refuses PUBLIC EXECUTE on administrative built-ins outside the trusted baseline", async (t) => {
  const shared = process.env.STARTER_TEST_DATABASE_URL;
  assert.ok(
    shared && process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"),
    "Run pnpm test to create an isolated database.",
  );
  const database = `legend_2ywn_${hex(6)}`;
  const adminUrl = withDatabase(shared, database).toString();
  const appName = `legend_runtime_${hex(8)}`;
  const workerName = `legend_worker_${hex(8)}`;
  const grantorName = `legend_grant_${hex(8)}`;
  const appUrl = login(adminUrl, appName);
  const workerUrl = login(adminUrl, workerName);
  const cluster = new Pool({ connectionString: shared, max: 1 });
  await cluster.query(`CREATE DATABASE ${database}`);
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  t.after(async () => {
    await endTestPool(admin);
    await dropTestDatabase(cluster, database);
    for (const role of [appName, workerName, grantorName])
      await cluster.query(`DROP ROLE IF EXISTS "${role}"`);
    await endTestPool(cluster);
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

  const env = {
    MIGRATION_DATABASE_URL: adminUrl,
    APP_DATABASE_URL: appUrl,
    WORKER_DATABASE_URL: workerUrl,
    PAYOUT_GRANTOR_DATABASE_URL: login(adminUrl, grantorName),
  };
  const provisioned = runJob(env);
  assert.equal(provisioned.status, 0, provisioned.stderr);

  await t.test("a stock server passes the audit (control)", () => {
    const audit = runJob(env, ["--audit"]);
    assert.equal(audit.status, 0, audit.stderr);
    assert.match(audit.stdout, /Audit passed/);
  });

  for (const fn of ADMIN_FUNCTIONS) {
    const name = fn.replace("()", "");
    await t.test(`--audit fails when PUBLIC may EXECUTE ${fn}`, async () => {
      await admin.query(`GRANT EXECUTE ON FUNCTION pg_catalog.${fn} TO PUBLIC`);
      try {
        const audit = runJob(env, ["--audit"]);
        assert.equal(
          audit.status,
          1,
          `${fn} granted to PUBLIC passed the audit`,
        );
        assert.match(audit.stderr, /Role audit failed/);
        assert.ok(
          audit.stderr.includes(name),
          `the audit does not name ${name}: ${audit.stderr}`,
        );
      } finally {
        await admin.query(
          `REVOKE EXECUTE ON FUNCTION pg_catalog.${fn} FROM PUBLIC`,
        );
      }
      const clean = runJob(env, ["--audit"]);
      assert.equal(clean.status, 0, clean.stderr);
    });
  }

  await t.test(
    "the provisioning job refuses PUBLIC EXECUTE on pg_switch_wal()",
    async () => {
      await admin.query(
        "GRANT EXECUTE ON FUNCTION pg_catalog.pg_switch_wal() TO PUBLIC",
      );
      try {
        const refused = runJob(env);
        assert.equal(
          refused.status,
          1,
          "the job accepted PUBLIC EXECUTE on pg_switch_wal",
        );
        assert.ok(
          refused.stderr.includes("pg_switch_wal"),
          `the job does not name pg_switch_wal: ${refused.stderr}`,
        );
      } finally {
        await admin.query(
          "REVOKE EXECUTE ON FUNCTION pg_catalog.pg_switch_wal() FROM PUBLIC",
        );
      }
      const clean = runJob(env);
      assert.equal(clean.status, 0, clean.stderr);
    },
  );

  // The baseline is per signature: granting PUBLIC EXECUTE on one overload
  // must not hide behind the other overloads of the same function name.
  await t.test(
    "--audit and the job fail when PUBLIC may EXECUTE only the pg_read_file(text, bigint, bigint) overload",
    async () => {
      const overload = "pg_catalog.pg_read_file(text, bigint, bigint)";
      await admin.query(`GRANT EXECUTE ON FUNCTION ${overload} TO PUBLIC`);
      try {
        const audit = runJob(env, ["--audit"]);
        assert.equal(
          audit.status,
          1,
          "one overload granted to PUBLIC passed the audit",
        );
        assert.match(audit.stderr, /Role audit failed/);
        assert.ok(
          audit.stderr.includes("pg_read_file"),
          `the audit does not name pg_read_file: ${audit.stderr}`,
        );
        const refused = runJob(env);
        assert.equal(
          refused.status,
          1,
          "the job accepted one overload granted to PUBLIC",
        );
        assert.ok(
          refused.stderr.includes("pg_read_file"),
          `the job does not name pg_read_file: ${refused.stderr}`,
        );
      } finally {
        await admin.query(`REVOKE EXECUTE ON FUNCTION ${overload} FROM PUBLIC`);
      }
      const clean = runJob(env, ["--audit"]);
      assert.equal(clean.status, 0, clean.stderr);
    },
  );

  // A direct grant to a login (not via PUBLIC and not via the group role) is
  // outside the baseline too. Assumption: the message names the function.
  for (const [label, loginName] of [
    ["application login", appName],
    ["queue login", workerName],
  ]) {
    await t.test(
      `--audit fails when EXECUTE on pg_switch_wal() is granted directly to the ${label}`,
      async () => {
        await admin.query(
          `GRANT EXECUTE ON FUNCTION pg_catalog.pg_switch_wal() TO "${loginName}"`,
        );
        try {
          const audit = runJob(env, ["--audit"]);
          assert.equal(
            audit.status,
            1,
            `a direct grant to the ${label} passed the audit`,
          );
          assert.match(audit.stderr, /Role audit failed/);
          assert.ok(
            audit.stderr.includes("pg_switch_wal"),
            `the audit does not name pg_switch_wal: ${audit.stderr}`,
          );
        } finally {
          await admin.query(
            `REVOKE EXECUTE ON FUNCTION pg_catalog.pg_switch_wal() FROM "${loginName}"`,
          );
        }
        const clean = runJob(env, ["--audit"]);
        assert.equal(clean.status, 0, clean.stderr);
      },
    );
  }

  // Assumption: pg_monitor is refused like the other predefined roles
  // (current behavior: "inherits predefined roles: <name>"). Only the exit
  // status and the role name are asserted, not the full sentence.
  await t.test(
    "--audit fails when a login is a member of pg_monitor",
    async () => {
      await admin.query(`GRANT pg_monitor TO "${appName}"`);
      try {
        const audit = runJob(env, ["--audit"]);
        assert.equal(audit.status, 1, "pg_monitor membership passed the audit");
        assert.match(audit.stderr, /Role audit failed/);
        assert.ok(
          audit.stderr.includes("pg_monitor"),
          `the audit does not name pg_monitor: ${audit.stderr}`,
        );
      } finally {
        await admin.query(`REVOKE pg_monitor FROM "${appName}"`);
      }
      const clean = runJob(env, ["--audit"]);
      assert.equal(clean.status, 0, clean.stderr);
    },
  );
});

// The trusted baseline is read from pg_init_privs. If that catalog is empty
// the baseline is gone, and "nothing differs from an empty baseline" must not
// read as "all clear": both entry points must fail closed with a clean
// ProvisionError (exit 1, readable message, no stack trace).
//
// Assumptions: the exact wording is not fixed by the card, so the message is
// matched loosely on "pg_init_privs" or "baseline". pg_init_privs is a
// per-database catalog, so emptying it only touches this scratch database,
// which is dropped at the end; the shared test database is never touched.
test("legend-2ywn an empty pg_init_privs baseline fails closed", async (t) => {
  const shared = process.env.STARTER_TEST_DATABASE_URL;
  assert.ok(
    shared && process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"),
    "Run pnpm test to create an isolated database.",
  );
  const database = `legend_2ywn_anchor_${hex(6)}`;
  const adminUrl = withDatabase(shared, database).toString();
  const appName = `legend_runtime_${hex(8)}`;
  const workerName = `legend_worker_${hex(8)}`;
  const grantorName = `legend_grant_${hex(8)}`;
  const env = {
    MIGRATION_DATABASE_URL: adminUrl,
    APP_DATABASE_URL: login(adminUrl, appName),
    WORKER_DATABASE_URL: login(adminUrl, workerName),
    PAYOUT_GRANTOR_DATABASE_URL: login(adminUrl, grantorName),
  };
  const cluster = new Pool({ connectionString: shared, max: 1 });
  await cluster.query(`CREATE DATABASE ${database}`);
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  t.after(async () => {
    await endTestPool(admin);
    await dropTestDatabase(cluster, database);
    for (const role of [appName, workerName, grantorName])
      await cluster.query(`DROP ROLE IF EXISTS "${role}"`);
    await endTestPool(cluster);
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

  const provisioned = runJob(env);
  assert.equal(provisioned.status, 0, provisioned.stderr);
  const control = runJob(env, ["--audit"]);
  assert.equal(control.status, 0, control.stderr);

  // Simulate a server whose init privileges were lost or never recorded.
  const before = await admin.query(
    "SELECT count(*)::int AS n FROM pg_catalog.pg_init_privs",
  );
  assert.ok(
    before.rows[0].n > 0,
    "a stock database has a pg_init_privs baseline",
  );
  await admin.query("DELETE FROM pg_catalog.pg_init_privs");
  const after = await admin.query(
    "SELECT count(*)::int AS n FROM pg_catalog.pg_init_privs",
  );
  assert.equal(after.rows[0].n, 0);

  const stackFrame = /\n\s+at .+:\d+:\d+/;

  await t.test("--audit refuses an empty baseline", () => {
    const audit = runJob(env, ["--audit"]);
    assert.equal(
      audit.status,
      1,
      "an empty pg_init_privs baseline passed the audit",
    );
    assert.match(audit.stderr, /Role audit failed/);
    assert.match(audit.stderr, /pg_init_privs|baseline/i);
    assert.doesNotMatch(audit.stderr, stackFrame);
  });

  await t.test("the provisioning job refuses an empty baseline", () => {
    const refused = runJob(env);
    assert.equal(
      refused.status,
      1,
      "the job accepted an empty pg_init_privs baseline",
    );
    assert.match(refused.stderr, /pg_init_privs|baseline/i);
    assert.doesNotMatch(refused.stderr, stackFrame);
  });
});
