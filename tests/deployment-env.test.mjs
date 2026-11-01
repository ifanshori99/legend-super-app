// Deployment environment contract (WS-00 INT, legend-vukf): the validator every
// runtime shares, and the web server's startup check. PRD v1.7 §3 (Environment
// & Deployment) and §7 (synthetic data policy) set the rule: development and
// staging hold synthetic data only, real data is production-only.
// Loads the TypeScript sources directly through Node type stripping.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const {
  DEPLOYMENT_POLICY_MESSAGE,
  assertDataImportAllowed,
  assertDeploymentEnv,
  parseDeploymentEnv,
} = await import("../packages/shared/src/env/index.ts");

test("defaults an unset deployment mode, edge topology, and classification", () => {
  const result = parseDeploymentEnv({});
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, {
    DEPLOYMENT_MODE: "development",
    EDGE_MODE: false,
    DATA_CLASSIFICATION: "synthetic",
  });
  assert.deepEqual(
    parseDeploymentEnv({
      DEPLOYMENT_MODE: "production",
      EDGE_MODE: "true",
      DATA_CLASSIFICATION: "real",
    }).data,
    {
      DEPLOYMENT_MODE: "production",
      EDGE_MODE: true,
      DATA_CLASSIFICATION: "real",
    },
  );
});

test("reports every invalid setting by name without echoing its value", () => {
  const result = parseDeploymentEnv({
    DEPLOYMENT_MODE: "not-a-mode",
    EDGE_MODE: "not-a-boolean",
    DATA_CLASSIFICATION: "not-a-classification",
  });
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 3);
  for (const field of ["DEPLOYMENT_MODE", "EDGE_MODE", "DATA_CLASSIFICATION"])
    assert.ok(
      result.problems.some((problem) => problem.startsWith(`${field}: `)),
      `${field} is reported`,
    );
  // A mistyped variable name can hold a secret, so the value itself is never
  // printed back in a startup failure.
  for (const value of ["not-a-mode", "not-a-boolean", "not-a-classification"])
    assert.ok(
      result.problems.every((problem) => !problem.includes(value)),
      `${value} is not echoed`,
    );
});

test("permits real data in production only", () => {
  for (const mode of ["development", "staging"]) {
    const result = parseDeploymentEnv({
      DEPLOYMENT_MODE: mode,
      DATA_CLASSIFICATION: "real",
    });
    assert.equal(result.ok, false, `${mode} rejects real data`);
    assert.deepEqual(
      result.problems,
      [`DATA_CLASSIFICATION: ${DEPLOYMENT_POLICY_MESSAGE}`],
      `${mode} blames the classification`,
    );
    assert.equal(
      parseDeploymentEnv({ DEPLOYMENT_MODE: mode }).ok,
      true,
      `${mode} accepts synthetic data`,
    );
  }
  assert.equal(
    parseDeploymentEnv({
      DEPLOYMENT_MODE: "production",
      DATA_CLASSIFICATION: "real",
    }).ok,
    true,
  );
  // An edge node keeps its environment's data policy; it is not an exception.
  assert.equal(
    parseDeploymentEnv({
      DEPLOYMENT_MODE: "staging",
      EDGE_MODE: "true",
      DATA_CLASSIFICATION: "real",
    }).ok,
    false,
  );
});

test("assertDeploymentEnv fails one startup error listing every problem", () => {
  assert.throws(
    () =>
      assertDeploymentEnv({
        DEPLOYMENT_MODE: "not-a-mode",
        EDGE_MODE: "not-a-boolean",
      }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^Invalid deployment environment:\n/);
      // One indented line per problem, so the operator sees all of them at once.
      assert.match(error.message, /\n {2}DEPLOYMENT_MODE: /);
      assert.match(error.message, /\n {2}EDGE_MODE: /);
      return true;
    },
  );
  assert.deepEqual(assertDeploymentEnv({ DEPLOYMENT_MODE: "production" }), {
    DEPLOYMENT_MODE: "production",
    EDGE_MODE: false,
    DATA_CLASSIFICATION: "synthetic",
  });
});

test("imports require an explicit classification and never leak real data early", () => {
  for (const mode of ["development", "staging"]) {
    const settings = { DEPLOYMENT_MODE: mode };
    assert.doesNotThrow(() => assertDataImportAllowed(settings, "synthetic"));
    for (const classification of ["real", "unknown", undefined, null, ""])
      assert.throws(
        () => assertDataImportAllowed(settings, classification),
        undefined,
        `${mode} refuses a ${String(classification)} import`,
      );
  }
  const production = { DEPLOYMENT_MODE: "production" };
  assert.doesNotThrow(() => assertDataImportAllowed(production, "real"));
  assert.doesNotThrow(() => assertDataImportAllowed(production, "synthetic"));
  assert.throws(() => assertDataImportAllowed(production, "unknown"));
});

// The web server keeps its check in one server-only module so the built server
// and the dev server cannot drift apart. See docs/deployment.md ("Startup
// validation") for why it has two entry points.
const web = resolve(root, "apps/web");
// The check must not see the developer's own deployment settings.
const shellEnv = { ...process.env };
for (const key of ["DEPLOYMENT_MODE", "EDGE_MODE", "DATA_CLASSIFICATION"])
  delete shellEnv[key];

function loadWebEnv(overrides) {
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import('./src/lib/env.server.ts').then((m) => process.stdout.write(JSON.stringify(m.webEnv)))",
    ],
    { cwd: web, env: { ...shellEnv, ...overrides }, encoding: "utf8" },
  );
}

test("the web server refuses to start with an invalid deployment environment", () => {
  const invalidSettings = [
    [{ DEPLOYMENT_MODE: "not-a-mode" }, "DEPLOYMENT_MODE"],
    [{ EDGE_MODE: "not-a-boolean" }, "EDGE_MODE"],
    [{ DATA_CLASSIFICATION: "not-a-classification" }, "DATA_CLASSIFICATION"],
    [
      { DEPLOYMENT_MODE: "staging", DATA_CLASSIFICATION: "real" },
      "DATA_CLASSIFICATION",
    ],
  ];
  for (const [settings, field] of invalidSettings) {
    const result = loadWebEnv(settings);
    assert.equal(result.status, 1, `${JSON.stringify(settings)} exits`);
    assert.match(result.stderr, /Invalid web environment:/);
    assert.match(result.stderr, new RegExp(`${field}: `));
    assert.equal(result.stdout, "", "the entry serves nothing");
  }
});

test("the web server starts with the settings it reports", () => {
  const result = loadWebEnv({
    DEPLOYMENT_MODE: "production",
    EDGE_MODE: "true",
    DATA_CLASSIFICATION: "real",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    DEPLOYMENT_MODE: "production",
    EDGE_MODE: true,
    DATA_CLASSIFICATION: "real",
  });
  const defaults = loadWebEnv({});
  assert.equal(defaults.status, 0, defaults.stderr);
  assert.deepEqual(JSON.parse(defaults.stdout), {
    DEPLOYMENT_MODE: "development",
    EDGE_MODE: false,
    DATA_CLASSIFICATION: "synthetic",
  });
});

test("both web entry points import the startup validation", () => {
  // Guard for the wiring itself, which no unit run can reach: the built server
  // (Nitro plugin, registered through vite.config.ts) and the dev server
  // (TanStack Start entry) each import the validator before serving anything.
  assert.match(
    readFileSync(resolve(web, "src/server.ts"), "utf8"),
    /^import "@\/lib\/env\.server";$/m,
  );
  assert.match(
    readFileSync(resolve(web, "server/plugins/deployment-env.ts"), "utf8"),
    /^import "\.\.\/\.\.\/src\/lib\/env\.server";$/m,
  );
  assert.match(
    readFileSync(resolve(web, "vite.config.ts"), "utf8"),
    /plugins: \["\.\/server\/plugins\/deployment-env\.ts"\]/,
  );
});

test("a mock-mode web build refuses to start outside development", () => {
  for (const mode of ["staging", "production"]) {
    const result = loadWebEnv({ DEPLOYMENT_MODE: mode, VITE_API_MOCK: "true" });
    assert.equal(result.status, 1, mode);
    assert.match(result.stderr, /VITE_API_MOCK: mock mode is only allowed/);
  }
  const dev = loadWebEnv({
    DEPLOYMENT_MODE: "development",
    VITE_API_MOCK: "true",
  });
  assert.equal(dev.status, 0, dev.stderr);
});

test("every web page defaults to Cache-Control private, no-store", () => {
  const start = readFileSync(resolve(root, "apps/web/src/start.ts"), "utf8");
  assert.match(start, /"Cache-Control": "private, no-store"/);
});
