import { defineConfig, devices } from "@playwright/test";

// Mock-mode e2e for the screens built on fixtures (docs/frontend.md "Typed
// endpoints and mock mode"). No database and no API: the web dev server runs
// with VITE_API_MOCK=true. Used until the production-build e2e runner serves
// mock mode (bead legend-y8n9):
//   pnpm exec playwright test -c playwright.mock.config.ts
// An already running mock dev server on MOCK_E2E_PORT is reused.
const port = Number(process.env.MOCK_E2E_PORT ?? 3202);
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /legend-[a-z0-9]+\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { baseURL, trace: "retain-on-failure" },
  projects: [
    { name: "mobile", use: { ...devices["Pixel 7"] } },
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: `pnpm --filter @starter/web exec vite dev --port ${port} --strictPort`,
    url: `${baseURL}/sign-in`,
    reuseExistingServer: true,
    timeout: 90_000,
    env: {
      VITE_API_MOCK: "true",
      VITE_API_MOCK_LATENCY_MS: "20",
      DEPLOYMENT_MODE: "development",
      WEB_URL: baseURL,
    },
  },
});
