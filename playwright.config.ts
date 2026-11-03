import { defineConfig, devices } from "@playwright/test";
import { MOCK_SPEC_PATTERNS } from "./e2e/mock-server.ts";

// Both apps run from their production builds against the disposable database
// that `pnpm test:e2e` creates. Never point this at a real database.
const testUrl = process.env.STARTER_TEST_DATABASE_URL;
if (!testUrl || !process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-")) {
  throw new Error(
    "Use pnpm test:e2e so Playwright runs against its own disposable PostgreSQL server.",
  );
}

export const API_URL = "http://localhost:4101";
export const WEB_URL = "http://localhost:3101";

export default defineConfig({
  testDir: "./e2e",
  // Mock-mode specs need a dev server with VITE_API_MOCK=true; a production
  // build compiles mock mode out, so they belong to `pnpm test:e2e:mock`
  // (playwright.mock.config.ts) instead.
  testIgnore: MOCK_SPEC_PATTERNS,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: "list",
  use: { baseURL: WEB_URL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node apps/api/dist/server.js",
      url: `${API_URL}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: "production",
        PORT: "4101",
        BETTER_AUTH_URL: API_URL,
        WEB_URL,
        DATABASE_URL: testUrl,
        BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "",
        // NODE_ENV=production requires its own pin pepper (legend-dxb).
        STAFF_PIN_PEPPER:
          process.env.STAFF_PIN_PEPPER ??
          "e2e-only-staff-pin-pepper-not-a-secret-000",
        LOG_LEVEL: "warn",
      },
      gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
    },
    {
      command: "node apps/web/.output/server/index.mjs",
      url: `${WEB_URL}/sign-in`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: "production",
        PORT: "3101",
        API_INTERNAL_URL: API_URL,
        LOG_LEVEL: "warn",
      },
      gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
    },
  ],
});
