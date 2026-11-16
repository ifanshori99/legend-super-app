import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../scripts/ci/lighthouse.mjs", import.meta.url),
  "utf8",
);
const prepareSource = source.slice(
  source.indexOf("async function prepareDatabase("),
  source.indexOf("async function startChrome("),
);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Exercise the real database preparation with Docker/process boundaries stubbed.
// All connection strings here are synthetic and must stay out of harness output.
async function prepare(env = {}) {
  const calls = [];
  const provisioned = [];
  let randomCall = 0;
  const dependencies = {
    process: { env },
    URL,
    reuseDatabase: Boolean(env.STARTER_TEST_DATABASE_URL),
    randomBytes: (length) => Buffer.alloc(length, ++randomCall),
    ownerLabelValue: () => "test-owner",
    cleanups: [],
    pnpmCommand: () => "pnpm",
    async run(command, args, childEnv) {
      calls.push({ command, args, env: childEnv });
      if (command === "docker" && args.includes("port"))
        return "127.0.0.1:55432\n";
    },
    async provisionAppRole() {},
    async provisionRoles(options) {
      provisioned.push(options);
      calls.push({ command: "provisionRoles", options });
    },
  };
  const result = await new AsyncFunction(
    ...Object.keys(dependencies),
    `${prepareSource}\nreturn prepareDatabase(process.env);`,
  )(...Object.values(dependencies));
  return { env: result, calls, provisioned };
}

test("Lighthouse provisions its own payout grantor before seeding", async () => {
  const external =
    "postgresql://legend_grant_ffffffffffffffff:external@outside.invalid/production";
  const result = await prepare({ PAYOUT_GRANTOR_DATABASE_URL: external });
  const grantor = new URL(result.env.PAYOUT_GRANTOR_DATABASE_URL);
  const app = new URL(result.env.APP_DATABASE_URL);
  assert.match(grantor.username, /^legend_grant_[a-f0-9]{16}$/);
  assert.equal(grantor.host, app.host);
  assert.equal(grantor.pathname, app.pathname);
  assert.notEqual(grantor.username, app.username);
  assert.notEqual(grantor.password, app.password);
  assert.notEqual(
    grantor.password,
    new URL(result.env.MIGRATION_DATABASE_URL).password,
  );
  assert.notEqual(grantor.href, external);
  assert.deepEqual(result.provisioned, [
    {
      adminUrl: result.env.MIGRATION_DATABASE_URL,
      appUrl: app.href,
      grantorUrl: grantor.href,
    },
  ]);
  const seed = result.calls.find((call) =>
    call.args?.includes("src/db/seed-dev-tenant.ts"),
  );
  assert.equal(seed.env.PAYOUT_GRANTOR_DATABASE_URL, grantor.href);
  const provisionIndex = result.calls.findIndex(
    (call) => call.command === "provisionRoles",
  );
  const migrationIndex = result.calls.findIndex((call) =>
    call.args?.includes("db:migrate"),
  );
  assert.ok(migrationIndex >= 0 && migrationIndex < provisionIndex);
  assert.ok(provisionIndex < result.calls.indexOf(seed));
});

test("Lighthouse reuses the explicit grantor of a prepared test database", async () => {
  const grantor =
    "postgresql://legend_grant_1111111111111111:grantor@127.0.0.1:55432/starter_test";
  const result = await prepare({
    STARTER_TEST_DATABASE_URL:
      "postgresql://starter_test:owner@127.0.0.1:55432/starter_test",
    STARTER_TEST_RUN: "starter-pg-test-existing",
    PAYOUT_GRANTOR_DATABASE_URL: grantor,
  });
  assert.equal(result.env.PAYOUT_GRANTOR_DATABASE_URL, grantor);
  assert.deepEqual(result.calls, []);
  assert.deepEqual(result.provisioned, []);
});

test("Lighthouse refuses a reused test database without its payout grantor", async () => {
  for (const missing of [undefined, "", " "]) {
    await assert.rejects(
      prepare({
        STARTER_TEST_DATABASE_URL:
          "postgresql://starter_test:owner@127.0.0.1:55432/starter_test",
        STARTER_TEST_RUN: "starter-pg-test-existing",
        PAYOUT_GRANTOR_DATABASE_URL: missing,
      }),
      /PAYOUT_GRANTOR_DATABASE_URL is required/,
    );
  }
});
