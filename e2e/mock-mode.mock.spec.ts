// The mock-mode runner's own smoke test (bead legend-n2sp). It proves what
// `pnpm test:e2e:mock` promises: a Vite dev server with VITE_API_MOCK=true, no
// API and no database, answering contract-backed endpoints from @starter/shared
// fixtures. Feature specs (e2e/*.mock.spec.ts) ride on
// the same project.
import { expect, test } from "@playwright/test";
import { waitForHydration } from "./hydration.ts";
import {
  LEGACY_MOCK_WEB_URL_ENV,
  MOCK_WEB_URL,
  MOCK_WEB_URL_ENV,
} from "./mock-server.ts";

// The shape listExampleOutlets answers with (cursorPageSchema(outletRefSchema)).
type OutletPage = {
  data: { code: string }[];
  meta: { limit: number; nextCursor: string | null };
};

test("legend-n2sp · mock project serves the web app without an API", async ({
  page,
}) => {
  const response = await page.goto("/design-system");
  expect(response?.status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: "Design System Platform" }),
  ).toBeVisible();
});

test("legend-n2sp · mock runtime answers a registered endpoint from fixtures, not the network", async ({
  page,
}) => {
  await page.goto("/design-system");
  // The text catalog registers when the app hydrates; the mock fixtures check
  // their keys against it as soon as the client module loads.
  await waitForHydration(page);

  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));

  const result = await page.evaluate(async (): Promise<OutletPage> => {
    // The app's own client, loaded through the dev server, so this exercises
    // the path a screen takes: apiFetch → mock transport → registered handler.
    const clientPath = "/src/lib/api/client.ts";
    const { apiFetch } = (await import(clientPath)) as {
      apiFetch: (path: string, init: unknown) => Promise<OutletPage>;
    };
    return apiFetch("/api/example/outlets", { query: { limit: 10 } });
  });

  expect(result.data.map((outlet) => outlet.code)).toEqual([
    "BDG-01",
    "BDG-02",
  ]);
  expect(result.meta).toEqual({ limit: 10, nextCursor: null });
  // Mock mode never touches the network: the fixtures above came from the
  // runtime in the browser.
  expect(
    requested.filter((url) => url.includes("/api/example/outlets")),
  ).toEqual([]);
});

test("legend-n2sp · both mock server env names point at this project's server", () => {
  // Specs written before this runner self-skip unless a mock address is set;
  // the config sets both names so they run here (docs/frontend.md).
  expect(process.env[MOCK_WEB_URL_ENV]).toBe(MOCK_WEB_URL);
  expect(process.env[LEGACY_MOCK_WEB_URL_ENV]).toBe(MOCK_WEB_URL);
});
