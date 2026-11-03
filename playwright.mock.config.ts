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
//   pnpm test:e2e:mock e2e/legend-g9r3.mock.spec.ts  one spec
//   pnpm test:e2e:mock --shard=1/2              one shard (CI, bead legend-x5be)
//   pnpm test:e2e:mock:shard 1/4                one shard with a checked argument
//   LEGEND_MOCK_PORT=3235 pnpm test:e2e:mock    another port (parallel worktree)
//
// Never point this config at a real deployment: mock mode serves fixtures for
// every request.

// The mock config owns both address env vars, so a spec that self-skips without
// one still runs here and a spec that navigates with an absolute URL lands on
// the server this config started. MOCK_WEB_URL honors LEGEND_MOCK_PORT.
process.env[MOCK_WEB_URL_ENV] = MOCK_WEB_URL;
process.env[LEGACY_MOCK_WEB_URL_ENV] = MOCK_WEB_URL;

export default defineConfig({
  testDir: "./e2e",
  testMatch: MOCK_SPEC_PATTERNS,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  // CI shards this suite over two parallel jobs (bead legend-x5be) and merges
  // the per-shard blob reports with `playwright merge-reports`; the list output
  // still shows in each job log. A local run keeps plain list output.
  // `workers: 1` stays even when sharded: a shard is one worker, so a shared
  // 16 GB machine never gets more than the shard count it asked for.
  reporter: process.env.CI
    ? [["blob", { outputDir: "blob-report" }], ["list"]]
    : "list",
  // Compile every route area before the first test: a cold Vite dev server
  // needs 20-35 s for the first SSR + client module graph (beads legend-1336,
  // legend-b0kq), which is longer than Playwright's 5 s first assertion.
  globalSetup: "./e2e/mock-global-setup.ts",
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
