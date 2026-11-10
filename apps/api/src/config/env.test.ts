import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "vitest";

const base: NodeJS.ProcessEnv = {
  ...process.env,
  DATABASE_URL: "postgresql://example:example@localhost:5432/example",
  BETTER_AUTH_SECRET: "x".repeat(32),
  NODE_ENV: "test",
  DEPLOYMENT_MODE: "development",
  EDGE_MODE: "false",
  DATA_CLASSIFICATION: "synthetic",
};
// The test runner exports APP_DATABASE_URL; each case sets it explicitly.
delete base.APP_DATABASE_URL;
const appUrl = "postgresql://app:app@localhost:5432/example";
function run(overrides: Record<string, string>, expression = "") {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { env, assertDataImportAllowed } from './src/config/env.ts'; ${expression}`,
    ],
    {
      cwd: new URL("../..", import.meta.url),
      env: { ...base, ...overrides },
      encoding: "utf8",
    },
  );
}

test("validates deployment, edge, and data classification settings at startup", () => {
  const invalidSettings: Record<string, string>[] = [
    { DEPLOYMENT_MODE: "unknown" },
    { EDGE_MODE: "yes" },
    { DATA_CLASSIFICATION: "unknown" },
    { DEPLOYMENT_MODE: "staging", DATA_CLASSIFICATION: "real" },
  ];
  for (const settings of invalidSettings) assert.equal(run(settings).status, 1);
  // An edge node refuses to start without its cloud link settings, with a
  // plain ws:// link outside development, or a malformed credential
  // (legend-2pi, edge/config.ts).
  const edgeProduction = {
    DEPLOYMENT_MODE: "production",
    DATA_CLASSIFICATION: "real",
    EDGE_MODE: "true",
    APP_DATABASE_URL: appUrl,
  };
  const credential = `edg1.${randomUUID()}.${randomUUID()}.${randomUUID()}.${"a".repeat(43)}`;
  const incompleteEdge: Record<string, string>[] = [
    {},
    { EDGE_CLOUD_URL: "wss://cloud.example.test/api/edge-link" },
    {
      EDGE_CLOUD_URL: "ws://cloud.example.test/api/edge-link",
      EDGE_NODE_CREDENTIAL: credential,
    },
    {
      EDGE_CLOUD_URL: "wss://cloud.example.test/api/edge-link",
      EDGE_NODE_CREDENTIAL: "not-a-credential",
    },
  ];
  for (const settings of incompleteEdge)
    assert.equal(run({ ...edgeProduction, ...settings }).status, 1);
  assert.equal(
    run({
      ...edgeProduction,
      EDGE_CLOUD_URL: "wss://cloud.example.test/api/edge-link",
      EDGE_NODE_CREDENTIAL: credential,
    }).status,
    0,
  );
});

test("TEN-02 requires the restricted application login outside development", () => {
  for (const mode of ["staging", "production"])
    assert.equal(run({ DEPLOYMENT_MODE: mode }).status, 1);
});

test("production requires its own staff pin pepper secret (legend-dxb)", () => {
  // Not derived from BETTER_AUTH_SECRET: rotating the auth secret must not
  // invalidate every stored staff pin.
  assert.equal(run({ NODE_ENV: "production" }).status, 1);
  assert.equal(
    run({ NODE_ENV: "production", STAFF_PIN_PEPPER: "short" }).status,
    1,
  );
  assert.equal(
    run({
      NODE_ENV: "production",
      STAFF_PIN_PEPPER: "p".repeat(32),
    }).status,
    0,
  );
  // Reusing the auth secret as the pepper is refused in every mode.
  assert.equal(run({ STAFF_PIN_PEPPER: "x".repeat(32) }).status, 1);
  // Development and tests work without it (fixed non-secret fallback).
  assert.equal(run({}).status, 0);
});

// legend-ideif: an edge node never holds the root staff pin pepper.
const edgeNode = {
  DEPLOYMENT_MODE: "production",
  DATA_CLASSIFICATION: "real",
  EDGE_MODE: "true",
  APP_DATABASE_URL: appUrl,
  EDGE_CLOUD_URL: "wss://cloud.example.test/api/edge-link",
  EDGE_NODE_CREDENTIAL: `edg1.${randomUUID()}.${randomUUID()}.${randomUUID()}.${"a".repeat(43)}`,
};

test("an edge node refuses to boot with the root STAFF_PIN_PEPPER (legend-ideif)", () => {
  const rootValue = "Zq9Lm4".repeat(6);
  for (const NODE_ENV of ["production", "test"]) {
    const result = run({ ...edgeNode, NODE_ENV, STAFF_PIN_PEPPER: rootValue });
    assert.equal(result.status, 1);
    // Names the key, never echoes the value.
    assert.match(result.stderr, /STAFF_PIN_PEPPER/);
    assert.ok(!result.stderr.includes(rootValue));
    assert.ok(!result.stdout.includes(rootValue));
  }
});

test("an edge node in production needs no root pepper (legend-ideif)", () => {
  assert.equal(run({ ...edgeNode, NODE_ENV: "production" }).status, 0);
  // The cloud still requires it in production.
  assert.equal(run({ NODE_ENV: "production" }).status, 1);
});

test("STAFF_PIN_PEPPER_CURRENT_VERSION is a positive integer, default 1 (legend-ideif)", () => {
  const show = "console.log(env.STAFF_PIN_PEPPER_CURRENT_VERSION)";
  assert.equal(run({ STAFF_PIN_PEPPER_CURRENT_VERSION: "0" }).status, 1);
  assert.equal(run({ STAFF_PIN_PEPPER_CURRENT_VERSION: "-1" }).status, 1);
  assert.equal(run({ STAFF_PIN_PEPPER_CURRENT_VERSION: "1.5" }).status, 1);
  const two = run({ STAFF_PIN_PEPPER_CURRENT_VERSION: "2" }, show);
  assert.equal(two.status, 0);
  assert.equal(two.stdout.trim(), "2");
  const unset = run({}, show);
  assert.equal(unset.status, 0);
  assert.equal(unset.stdout.trim(), "1");
});

test("rejects real or unclassified imports outside production", () => {
  for (const mode of ["development", "staging"]) {
    for (const classification of ["real", "unknown"]) {
      assert.notEqual(
        run(
          { DEPLOYMENT_MODE: mode, APP_DATABASE_URL: appUrl },
          `assertDataImportAllowed('${classification}')`,
        ).status,
        0,
      );
    }
    assert.equal(
      run(
        { DEPLOYMENT_MODE: mode, APP_DATABASE_URL: appUrl },
        "assertDataImportAllowed('synthetic')",
      ).status,
      0,
    );
  }
  assert.equal(
    run(
      { DEPLOYMENT_MODE: "production", APP_DATABASE_URL: appUrl },
      "assertDataImportAllowed('real')",
    ).status,
    0,
  );
});
