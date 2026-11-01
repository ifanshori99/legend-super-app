import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  assert.equal(
    run({
      DEPLOYMENT_MODE: "production",
      DATA_CLASSIFICATION: "real",
      EDGE_MODE: "true",
      APP_DATABASE_URL: appUrl,
    }).status,
    0,
  );
});

test("TEN-02 requires the restricted application login outside development", () => {
  for (const mode of ["staging", "production"])
    assert.equal(run({ DEPLOYMENT_MODE: mode }).status, 1);
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
