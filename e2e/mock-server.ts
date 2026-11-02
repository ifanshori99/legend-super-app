// The mock-mode web server both Playwright configs agree on (bead legend-n2sp).
//
// `pnpm test:e2e:mock` (playwright.mock.config.ts) starts a Vite dev server
// with VITE_API_MOCK=true on MOCK_WEB_URL and runs the mock specs there; no API
// and no database. `pnpm test:e2e` (playwright.config.ts) runs the production
// builds and ignores those files, because a production build compiles mock mode
// out (docs/frontend.md).
//
// A mock spec is named `<name>.mock.spec.ts` (the convention for new work) or
// `legend-<bead>.spec.ts` (what earlier beads used before this runner existed).
// Any other `*.spec.ts` belongs to the production e2e project.

// Parallel worktrees each run their own mock server, so the port is
// overridable: `LEGEND_MOCK_PORT=3235 pnpm test:e2e:mock`. Everything else
// (baseURL, the addresses exported to specs, the Vite port) derives from this
// one URL.
const DEFAULT_MOCK_PORT = 3225;
const rawPort = process.env.LEGEND_MOCK_PORT;
const port = rawPort === undefined ? DEFAULT_MOCK_PORT : Number(rawPort);
if (!Number.isInteger(port) || port < 1 || port > 65_535)
  throw new Error(
    `LEGEND_MOCK_PORT must be a TCP port (1-65535), got "${rawPort ?? ""}".`,
  );

export const MOCK_WEB_URL = `http://localhost:${port}`;

export const MOCK_SPEC_PATTERNS = ["**/*.mock.spec.ts", "**/legend-*.spec.ts"];

// Specs written before this runner self-skip unless a mock server address is
// set, so a stray `playwright test` never fails on a server nobody started.
// `LEGEND_MOCK_WEB_URL` is the name to use in new specs; `E2E_MOCK_BASE_URL` is
// the legacy alias e2e/legend-g9r3.spec.ts reads. The mock config sets both to
// the server it started.
export const MOCK_WEB_URL_ENV = "LEGEND_MOCK_WEB_URL";
export const LEGACY_MOCK_WEB_URL_ENV = "E2E_MOCK_BASE_URL";
