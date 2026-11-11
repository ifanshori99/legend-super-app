import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import base from "../../playwright.mock.config.ts";

// Axe check for the WhatsApp login confirm card (bead kmndq). Same mock web
// server as playwright.mock.config.ts; only the test folder differs, so this
// stays out of e2e/ (and out of the mock suite's testMatch).
//
//   LEGEND_MOCK_PORT=3235 heavy pnpm exec playwright test \
//     -c scripts/ui-check-kmndq/playwright.config.ts
//
// Paths are absolute: the base config's relative paths resolve against the
// folder of the config file Playwright loads, which is this one.

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

export default defineConfig({
  ...base,
  testDir: here,
  testMatch: ["axe.spec.ts"],
  globalSetup: resolve(root, "e2e/mock-global-setup.ts"),
  webServer: {
    ...(base.webServer as object),
    cwd: root,
  } as NonNullable<typeof base.webServer>,
});
