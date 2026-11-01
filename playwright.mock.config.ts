import { defineConfig, devices } from "@playwright/test";
import {
  LEGACY_MOCK_WEB_URL_ENV,
  MOCK_SPEC_PATTERNS,
  MOCK_WEB_URL,
  MOCK_WEB_URL_ENV,
} from "./e2e/mock-server.ts";

// Mock-mode FE specs (bead legend-n2sp; PRD v1.7 §3 "Prinsip Pengembangan
// Paralel"). These specs exercise screens built against @starter/shared
// fixtures, so they need neither the API nor a database: this config starts the
// web dev server with VITE_API_MOCK=true and nothing else.
//
//   pnpm test:e2e:mock                          every mock spec
//   pnpm test:e2e:mock e2e/legend-g9r3.spec.ts  one spec
//
// Never point this config at a real deployment: mock mode serves fixtures for
// every request.

// The mock config owns both address env vars, so a spec that self-skips without
// one still runs here and a spec that navigates with an absolute URL lands on
// the server this config started.
process.env[MOCK_WEB_URL_ENV] = MOCK_WEB_URL;
process.env[LEGACY_MOCK_WEB_URL_ENV] = MOCK_WEB_URL;

export default defineConfig({
  testDir: "./e2e",
  testMatch: MOCK_SPEC_PATTERNS,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: "list",
  use: { baseURL: MOCK_WEB_URL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // `vite dev` reads WEB_URL for its port, so the origin the API would trust
    // and the address Playwright opens always match.
    command: "pnpm --filter @starter/web dev",
    url: `${MOCK_WEB_URL}/`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      WEB_URL: MOCK_WEB_URL,
      VITE_API_MOCK: "true",
      // Mock mode refuses to boot outside development (lib/env.server.ts).
      DEPLOYMENT_MODE: "development",
      DATA_CLASSIFICATION: "synthetic",
      // Fixtures answer instantly: specs that want the slow path ask for it
      // with ?mock=slow (lib/mock/control.ts).
      VITE_API_MOCK_LATENCY_MS: "0",
      LOG_LEVEL: "warn",
    },
    gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
  },
});
