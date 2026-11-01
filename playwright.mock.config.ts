import { defineConfig, devices } from "@playwright/test";

// FE beads run their happy path against mock mode (VITE_API_MOCK=true): the
// web dev server serves the domain fixtures, so no API or database is needed.
// `pnpm exec playwright test -c playwright.mock.config.ts`.
const MOCK_WEB_URL = process.env.MOCK_WEB_URL ?? "http://localhost:3211";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /\.mock\.spec\.ts$/,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: "list",
  use: { baseURL: MOCK_WEB_URL, trace: "retain-on-failure" },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Pixel 7"] },
    },
  ],
  webServer: {
    command: "pnpm --filter @starter/web exec vite dev",
    url: MOCK_WEB_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      WEB_URL: MOCK_WEB_URL,
      VITE_API_MOCK: "true",
      DEPLOYMENT_MODE: "development",
      DATA_CLASSIFICATION: "synthetic",
    },
  },
});
