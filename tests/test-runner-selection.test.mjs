import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(
  new URL("../scripts/test.mjs", import.meta.url),
  "utf8",
)
  .replace(/import[\s\S]*?from "[^"]+";/g, "")
  .replace(/^export /gm, "");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Execute the real runner while replacing process/Docker boundaries. No database
// or child test process is started by these dispatch tests.
async function dispatch(
  env = {},
  { apiStatus = 0, rootStatus = 0, exitCode, mode = "unit" } = {},
) {
  const calls = [];
  const messages = [];
  const cleanup = [];
  const provisioned = [];
  const fakeProcess = {
    argv: ["node", "scripts/test.mjs", mode],
    env,
    platform: "darwin",
    execPath: "/test/node",
    once() {},
    exit(code) {
      this.exitCode = code;
      throw new Error(`exit:${code}`);
    },
  };
  const dependencies = {
    process: fakeProcess,
    console: {
      log: (...parts) => messages.push(parts.join(" ")),
      error: (...parts) => messages.push(parts.join(" ")),
    },
    URL,
    spawn(command, args, options) {
      calls.push({ command, args, env: options.env });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      queueMicrotask(() => {
        if (command === "docker" && args.includes("port"))
          child.stdout.emit("data", "127.0.0.1:55432\n");
        const status =
          command === "/test/node"
            ? rootStatus
            : args.slice(0, 4).join(" ") === "--filter @starter/api run test"
              ? apiStatus
              : 0;
        child.emit("close", status);
      });
      return child;
    },
    spawnSync: (command, args) => {
      cleanup.push({ command, args });
      return { status: 0 };
    },
    randomBytes: (length) => Buffer.alloc(length, 1),
    readdirSync: () => ["one.test.mjs", "two.test.mjs", "ignored.txt"],
    resolve,
    pnpmCommand: () => "pnpm",
    root: "/test/project",
    provisionAppRole: async () => {},
    provisionRoles: async (options) => provisioned.push(options),
    legacySweepMinutes: () => 30,
    ownerLabelValue: () => "test-owner",
    removeProject: () => true,
    sweepStaleTestResources: () => ({ removed: [] }),
  };
  await new AsyncFunction(...Object.keys(dependencies), source)(
    ...Object.values(dependencies),
  );
  assert.equal(fakeProcess.exitCode, exitCode, "Runner exit status");
  return Object.assign(calls, { messages, cleanup, provisioned });
}

const apiCall = (calls) =>
  calls.find(
    (call) =>
      call.args.slice(0, 4).join(" ") === "--filter @starter/api run test",
  );
const rootCall = (calls) => calls.find((call) => call.command === "/test/node");
const postgresCall = (calls) =>
  calls.find((call) => call.command === "docker" && call.args.includes("up"));

test("node:test failure runs first and stops before the API vitest run", async () => {
  const calls = await dispatch(
    { LEGEND_TEST_FILES: "src/test/example.test.ts tests/one.test.mjs" },
    { rootStatus: 1, exitCode: 1 },
  );
  assert.ok(rootCall(calls));
  assert.equal(
    apiCall(calls),
    undefined,
    "root tests run first (legend-x778h)",
  );
  assert.equal(calls.messages.includes("[vitest] Passed."), false);
  assert.ok(
    calls.messages.some((message) => message.startsWith("[node:test] Failed:")),
  );
  assert.equal(
    calls.messages.some((message) => message.includes("Start Docker Desktop")),
    false,
  );
  assert.ok(
    calls.cleanup.some(
      (call) => call.command === "docker" && call.args.includes("down"),
    ),
  );
});

test("Successful mixed selection reports both completed test steps", async () => {
  const calls = await dispatch({
    LEGEND_TEST_FILES: "src/test/example.test.ts tests/one.test.mjs",
  });
  assert.ok(calls.messages.includes("[vitest] Passed."));
  assert.ok(calls.messages.includes("[node:test] Passed."));
});

test("API failure remains nonzero and is attributed to vitest", async () => {
  const calls = await dispatch(
    { LEGEND_TEST_FILES: "src/test/example.test.ts tests/one.test.mjs" },
    { apiStatus: 1, exitCode: 1 },
  );
  assert.ok(
    calls.messages.some((message) => message.startsWith("[vitest] Failed:")),
  );
  assert.equal(
    calls.messages.some((message) => message.includes("[vitest] Passed.")),
    false,
  );
  assert.ok(calls.cleanup.some((call) => call.args.includes("down")));
});

test("Root-only selection executes the selected root suite without API tests", async () => {
  const calls = await dispatch({ LEGEND_TEST_FILES: "tests/one.test.mjs" });
  assert.equal(apiCall(calls), undefined);
  assert.deepEqual(rootCall(calls)?.args, ["--test", "tests/one.test.mjs"]);
});

test("Mixed selection routes each suite to its own runner", async () => {
  const calls = await dispatch({
    LEGEND_TEST_FILES:
      "tests/one.test.mjs src/test/example.test.ts --fileParallelism",
  });
  assert.deepEqual(apiCall(calls)?.args.slice(4), [
    "src/test/example.test.ts",
    "--fileParallelism",
  ]);
  assert.deepEqual(rootCall(calls)?.args, ["--test", "tests/one.test.mjs"]);
});

test("API-only selection keeps API flags and skips root suites", async () => {
  const calls = await dispatch({
    LEGEND_TEST_FILES:
      "src/test/example.test.ts --fileParallelism --maxWorkers=2",
  });
  assert.deepEqual(apiCall(calls)?.args.slice(4), [
    "src/test/example.test.ts",
    "--fileParallelism",
    "--maxWorkers=2",
  ]);
  assert.equal(rootCall(calls), undefined);
});

test("Default selection still runs API and every root suite", async () => {
  const calls = await dispatch({ LEGEND_TEST_CONCURRENCY: "2" });
  assert.ok(apiCall(calls));
  assert.deepEqual(rootCall(calls)?.args, [
    "--test",
    "--test-concurrency=2",
    "tests/one.test.mjs",
    "tests/two.test.mjs",
  ]);
});

test("An absent selection preserves the default suites", async () => {
  const calls = await dispatch({});
  assert.ok(apiCall(calls));
  assert.deepEqual(rootCall(calls)?.args, [
    "--test",
    "tests/one.test.mjs",
    "tests/two.test.mjs",
  ]);
});

test("Full unit suites keep the 1536m PostgreSQL budget for an absent selection", async () => {
  const calls = await dispatch({});
  assert.equal(postgresCall(calls).env.STARTER_TEST_PG_MEM, "1536m");
});

test("A blank LEGEND_TEST_FILES is refused instead of running the full suite", async () => {
  for (const selection of ["", " ", "\t\n"]) {
    await assert.rejects(
      () => dispatch({ LEGEND_TEST_FILES: selection }),
      /exit:1/,
    );
  }
});

test("Unit selections with flags keep the full-suite PostgreSQL budget", async () => {
  for (const selection of [
    "--coverage",
    "--maxWorkers=2",
    "--outputFile=report.test.ts",
    "--exclude src/test/example.test.ts",
    "--reporter=json --outputFile report.test.ts",
    "tests/one.test.mjs --exclude src/test/example.test.ts",
    "src/test/example.test.ts --maxWorkers=2",
  ]) {
    const calls = await dispatch({ LEGEND_TEST_FILES: selection });
    assert.equal(postgresCall(calls).env.STARTER_TEST_PG_MEM, "1536m");
  }
});

test("Targeted unit suites use the 1024m PostgreSQL budget", async () => {
  for (const selection of [
    "src/test/example.test.ts",
    "tests/one.test.mjs",
    "apps/web/test/example.test.ts",
    " \tsrc/test/example.test.ts tests/one.test.mjs\n",
  ]) {
    const calls = await dispatch({ LEGEND_TEST_FILES: selection });
    assert.equal(postgresCall(calls).env.STARTER_TEST_PG_MEM, "1024m");
  }
});

test("Production browser suites keep the 1536m PostgreSQL budget even with unit selections", async () => {
  for (const env of [{}, { LEGEND_TEST_FILES: "src/test/example.test.ts" }]) {
    const calls = await dispatch(env, { mode: "e2e" });
    assert.equal(postgresCall(calls).env.STARTER_TEST_PG_MEM, "1536m");
  }
});

test("Explicit PostgreSQL memory budgets are preserved for full, targeted, and browser suites", async () => {
  for (const { mode, selection } of [
    { mode: "unit" },
    { mode: "unit", selection: "src/test/example.test.ts" },
    { mode: "e2e" },
    { mode: "e2e", selection: "src/test/example.test.ts" },
  ]) {
    const calls = await dispatch(
      { STARTER_TEST_PG_MEM: "2048m", LEGEND_TEST_FILES: selection },
      { mode },
    );
    assert.equal(postgresCall(calls).env.STARTER_TEST_PG_MEM, "2048m");
  }
});

test("An empty PostgreSQL memory override restores the default for each suite", async () => {
  for (const { mode, selection, expected } of [
    { mode: "unit", expected: "1536m" },
    { mode: "unit", selection: "--coverage", expected: "1536m" },
    {
      mode: "unit",
      selection: "src/test/example.test.ts",
      expected: "1024m",
    },
    { mode: "e2e", expected: "1536m" },
  ]) {
    const calls = await dispatch(
      { STARTER_TEST_PG_MEM: "", LEGEND_TEST_FILES: selection },
      { mode },
    );
    assert.equal(postgresCall(calls).env.STARTER_TEST_PG_MEM, expected);
  }
});

test("Worktree database name reaches Compose and every database connection", async () => {
  const calls = await dispatch({ LEGEND_TEST_DB_NAME: "legend_infra_qa_509" });
  const setup = calls.find((call) => call.command === "docker");
  assert.equal(setup.env.LEGEND_TEST_DB_NAME, "legend_infra_qa_509");
  for (const key of [
    "DATABASE_URL",
    "APP_DATABASE_URL",
    "MIGRATION_DATABASE_URL",
    "STARTER_TEST_DATABASE_URL",
  ]) {
    assert.equal(
      new URL(apiCall(calls).env[key]).pathname,
      "/legend_infra_qa_509",
    );
  }
});

test("Default database name remains starter_test", async () => {
  const calls = await dispatch();
  assert.equal(
    new URL(apiCall(calls).env.DATABASE_URL).pathname,
    "/starter_test",
  );
});

test("Unsafe database names are rejected before Docker starts", async () => {
  await assert.rejects(
    dispatch({ LEGEND_TEST_DB_NAME: "bad/name" }),
    /LEGEND_TEST_DB_NAME/,
  );
});

test("Compose creates and health-checks the configured database name", () => {
  const compose = readFileSync(
    new URL("../compose.test.yaml", import.meta.url),
    "utf8",
  );
  assert.match(compose, /POSTGRES_DB: \$\{LEGEND_TEST_DB_NAME:-starter_test\}/);
  assert.match(
    compose,
    /pg_isready -U starter_test -d \$\{LEGEND_TEST_DB_NAME:-starter_test\}/,
  );
});

test("Compose preserves the full-suite PostgreSQL fallback and conservative tuning", () => {
  const compose = readFileSync(
    new URL("../compose.test.yaml", import.meta.url),
    "utf8",
  );
  assert.match(compose, /mem_limit: \$\{STARTER_TEST_PG_MEM:-1536m\}/);
  assert.match(compose, /memswap_limit: \$\{STARTER_TEST_PG_MEM:-1536m\}/);
  for (const setting of [
    "shared_buffers=64MB",
    "work_mem=2MB",
    "max_connections=50",
  ]) {
    assert.ok(compose.includes(setting), `PostgreSQL must set ${setting}`);
  }
});

test("Worktree removal command uses the database cleanup launcher", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(
    packageJson.scripts["worktree:remove"],
    "node scripts/worktree-remove.mjs",
  );
});

test("Unit and production browser runs provision an isolated payout grantor", async () => {
  const external =
    "postgresql://legend_grant_ffffffffffffffff:external@outside.invalid/production";
  for (const mode of ["unit", "e2e"]) {
    const calls = await dispatch(
      { PAYOUT_GRANTOR_DATABASE_URL: external },
      { mode },
    );
    const seeded = calls.find((call) =>
      call.args.includes("src/db/seed-dev-tenant.ts"),
    );
    const grantor = new URL(seeded.env.PAYOUT_GRANTOR_DATABASE_URL);
    const application = new URL(seeded.env.APP_DATABASE_URL);
    assert.match(grantor.username, /^legend_grant_[a-f0-9]{16}$/);
    assert.equal(grantor.host, application.host);
    assert.equal(grantor.pathname, application.pathname);
    assert.notEqual(grantor.username, application.username);
    assert.notEqual(grantor.href, external);
    assert.equal(calls.provisioned.length, 1);
    assert.equal(calls.provisioned[0].grantorUrl, grantor.href);
    assert.equal(calls.provisioned[0].appUrl, application.href);
    assert.equal(
      calls.provisioned[0].adminUrl,
      seeded.env.MIGRATION_DATABASE_URL,
    );
    if (mode === "e2e") {
      const browser = calls.find((call) =>
        call.args.some((arg) => arg.endsWith("playwright/test/cli.js")),
      );
      assert.equal(browser.env.PAYOUT_GRANTOR_DATABASE_URL, grantor.href);
      const build = calls.find((call) => call.args.join(" ") === "run build");
      assert.equal(build.env.PAYOUT_GRANTOR_DATABASE_URL, grantor.href);
      assert.equal(build.env.NODE_ENV, "production");
    }
  }
});
