import { defineConfig, devices } from "@playwright/test";

// The shared mock runner currently hardcodes 3225; keep this bead isolated on
// the coordinator-assigned free port until the runner accepts LEGEND_MOCK_PORT.
const port = process.env.LEGEND_MOCK_PORT ?? "3247";
const baseURL = `http://localhost:${port}`;
process.env.LEGEND_MOCK_WEB_URL = baseURL;
process.env.E2E_MOCK_BASE_URL = baseURL;

export default defineConfig({
  testDir: ".",
  testMatch: ["legend-10n.spec.ts", "legend-10n.mock.spec.ts"],
  workers: 1,
  reporter: "list",
  use: { baseURL, ...devices["Desktop Chrome"] },
  webServer: {
    command: "pnpm --filter @starter/web dev",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      WEB_URL: baseURL,
      VITE_API_MOCK: "true",
      DEPLOYMENT_MODE: "development",
      DATA_CLASSIFICATION: "synthetic",
      VITE_API_MOCK_LATENCY_MS: "0",
      LOG_LEVEL: "warn",
    },
    gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
  },
});
