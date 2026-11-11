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
  { apiStatus = 0, rootStatus = 0, exitCode } = {},
) {
  const calls = [];
  const messages = [];
  const cleanup = [];
  const fakeProcess = {
    argv: ["node", "scripts/test.mjs", "unit"],
    env,
    platform: "darwin",
    execPath: "/test/node",
    once() {},
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
    legacySweepMinutes: () => 30,
    ownerLabelValue: () => "test-owner",
    removeProject: () => true,
    sweepStaleTestResources: () => ({ removed: [] }),
  };
  await new AsyncFunction(...Object.keys(dependencies), source)(
    ...Object.values(dependencies),
  );
  assert.equal(fakeProcess.exitCode, exitCode, "Runner exit status");
  return Object.assign(calls, { messages, cleanup });
}

const apiCall = (calls) =>
  calls.find(
    (call) =>
      call.args.slice(0, 4).join(" ") === "--filter @starter/api run test",
  );
const rootCall = (calls) => calls.find((call) => call.command === "/test/node");

test("API success and node:test failure are reported as separate steps", async () => {
  const calls = await dispatch(
    { LEGEND_TEST_FILES: "src/test/example.test.ts tests/one.test.mjs" },
    { rootStatus: 1, exitCode: 1 },
  );
  assert.ok(apiCall(calls));
  assert.ok(rootCall(calls));
  assert.ok(calls.messages.includes("[vitest] Passed."));
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

test("Empty and whitespace-only selections preserve the default suites", async () => {
  for (const selection of ["", " ", "\t\n"]) {
    const calls = await dispatch({ LEGEND_TEST_FILES: selection });
    assert.ok(apiCall(calls));
    assert.deepEqual(rootCall(calls)?.args, [
      "--test",
      "tests/one.test.mjs",
      "tests/two.test.mjs",
    ]);
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
