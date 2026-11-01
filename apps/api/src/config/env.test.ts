import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "vitest";

const base = {
  ...process.env,
  DATABASE_URL: "postgresql://example:example@localhost:5432/example",
  BETTER_AUTH_SECRET: "x".repeat(32),
  NODE_ENV: "test",
  DEPLOYMENT_MODE: "development",
  EDGE_MODE: "false",
  DATA_CLASSIFICATION: "synthetic",
};
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
    }).status,
    0,
  );
});

test("rejects real or unclassified imports outside production", () => {
  for (const mode of ["development", "staging"]) {
    for (const classification of ["real", "unknown"]) {
      assert.notEqual(
        run(
          { DEPLOYMENT_MODE: mode },
          `assertDataImportAllowed('${classification}')`,
        ).status,
        0,
      );
    }
    assert.equal(
      run({ DEPLOYMENT_MODE: mode }, "assertDataImportAllowed('synthetic')")
        .status,
      0,
    );
  }
  assert.equal(
    run({ DEPLOYMENT_MODE: "production" }, "assertDataImportAllowed('real')")
      .status,
    0,
  );
});
