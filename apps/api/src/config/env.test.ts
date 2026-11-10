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

test("object storage settings are all-or-none (legend-33im6)", () => {
  const storage = {
    OBJECT_STORAGE_REGION: "ap-southeast-3",
    OBJECT_STORAGE_ACCESS_KEY_ID: "access",
    OBJECT_STORAGE_SECRET_ACCESS_KEY: "secret",
    OBJECT_STORAGE_PRIVATE_BUCKET: "legend-private",
    OBJECT_STORAGE_PUBLIC_BUCKET: "legend-public",
    OBJECT_STORAGE_PUBLIC_BASE_URL: "https://files.example.test",
  };
  // Not configured: valid, the statement issuer simply stays off.
  assert.equal(run({}).status, 0);
  assert.equal(run(storage).status, 0);
  assert.equal(
    run({ ...storage, OBJECT_STORAGE_ENDPOINT: "https://s3.example.test" })
      .status,
    0,
  );
  // Partial, same buckets, or a non-https public URL: refused at boot.
  const partial: Record<string, string | undefined> = { ...storage };
  delete partial.OBJECT_STORAGE_SECRET_ACCESS_KEY;
  for (const settings of [
    partial,
    { OBJECT_STORAGE_PRIVATE_BUCKET: "only-this" },
    { ...storage, OBJECT_STORAGE_PUBLIC_BUCKET: "legend-private" },
    { ...storage, OBJECT_STORAGE_PUBLIC_BASE_URL: "http://files.example.test" },
  ])
    assert.equal(run(settings).status, 1);
  // The failure names keys, never values.
  assert.doesNotMatch(run(partial).stderr, /access|legend-private/);
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
