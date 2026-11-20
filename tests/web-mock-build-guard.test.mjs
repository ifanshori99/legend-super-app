// Build guard (legend-x73li, sizing X7-1): a web production build made with
// VITE_API_MOCK=true fails at build time unless DEPLOYMENT_MODE=development,
// the same rule the server enforces at startup (lib/env.server.ts). Loads the
// TypeScript source through Node type stripping.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const web = resolve(import.meta.dirname, "../apps/web");
const { assertNoMockInDeployedBuild } =
  await import("../apps/web/vite-mock-guard.ts");

test("a mock build fails unless DEPLOYMENT_MODE=development is set explicitly", () => {
  for (const mode of ["staging", "production", "not-a-mode", "", undefined]) {
    assert.throws(
      () =>
        assertNoMockInDeployedBuild({
          command: "build",
          mock: "true",
          deploymentMode: mode,
        }),
      /VITE_API_MOCK: mock mode is only allowed with DEPLOYMENT_MODE=development/,
      mode,
    );
  }
});

test("mock mode stays allowed for a development build and for the dev server", () => {
  assert.doesNotThrow(() =>
    assertNoMockInDeployedBuild({
      command: "build",
      mock: "true",
      deploymentMode: "development",
    }),
  );
  assert.doesNotThrow(() =>
    assertNoMockInDeployedBuild({
      command: "serve",
      mock: "true",
      deploymentMode: "production",
    }),
  );
});

test("a build without mock mode is never blocked", () => {
  for (const mock of [undefined, "", "false"]) {
    assert.doesNotThrow(() =>
      assertNoMockInDeployedBuild({
        command: "build",
        mock,
        deploymentMode: "production",
      }),
    );
  }
});

test("vite.config.ts runs the guard before building", () => {
  assert.match(
    readFileSync(resolve(web, "vite.config.ts"), "utf8"),
    /assertNoMockInDeployedBuild\(/,
  );
});
