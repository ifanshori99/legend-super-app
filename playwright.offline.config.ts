import { defineConfig, devices } from "@playwright/test";

// O5 (legend-wasr7.9): the offline cashier in a real browser, reached the way
// production is reached: a tenant host (`o5-offline.legend.test`, registered in
// tenant_domains by the spec), the API on its own host under one cookie domain
// (`.legend.test`), both on production builds. Run it with
// `node scripts/test.mjs e2e-offline`, which builds with VITE_API_URL and
// COOKIE_DOMAIN set for these origins and creates the disposable database.
//
// Only this config relaxes anything, and only for the test API process:
// - NODE_ENV=development there, because production refuses an http API origin
//   that is not localhost (env.ts, 1209); the web server still runs as
//   production. Nothing in the production rules changes.
// - TRUST_PROXY=loopback so the API honors the web server's X-Forwarded-Host
//   (the SSR hop), as behind the real proxy.
// Chromium maps every `*.legend.test` name to this machine; Node never
// resolves them (the servers are checked on 127.0.0.1).
const testUrl = process.env.STARTER_TEST_DATABASE_URL;
if (!testUrl || !process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-")) {
  throw new Error(
    "Use node scripts/test.mjs e2e-offline so Playwright runs against its own disposable PostgreSQL server.",
  );
}

export const OFFLINE_SLUG = "o5-offline";
export const OFFLINE_API_URL = "http://api.legend.test:4101";
export const OFFLINE_WEB_URL = `http://${OFFLINE_SLUG}.legend.test:3101`;

export default defineConfig({
  testDir: "./e2e-offline",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: OFFLINE_WEB_URL,
    trace: "retain-on-failure",
    serviceWorkers: "allow",
    launchOptions: {
      args: ["--host-resolver-rules=MAP *.legend.test 127.0.0.1"],
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node apps/api/dist/server.js",
      url: "http://127.0.0.1:4101/api/health",
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: "development",
        PORT: "4101",
        BETTER_AUTH_URL: OFFLINE_API_URL,
        WEB_URL: OFFLINE_WEB_URL,
        COOKIE_DOMAIN: ".legend.test",
        TRUST_PROXY: "loopback",
        DATABASE_URL: testUrl,
        BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "",
        STAFF_PIN_PEPPER:
          process.env.STAFF_PIN_PEPPER ??
          "e2e-only-staff-pin-pepper-not-a-secret-000",
        LOG_LEVEL: "warn",
      },
      gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
    },
    {
      command: "node apps/web/.output/server/index.mjs",
      url: "http://127.0.0.1:3101/sign-in",
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: "production",
        PORT: "3101",
        API_INTERNAL_URL: "http://127.0.0.1:4101",
        LOG_LEVEL: "warn",
      },
      gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
    },
  ],
});
