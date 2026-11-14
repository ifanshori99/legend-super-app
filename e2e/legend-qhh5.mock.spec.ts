import { expect, test, type Page } from "@playwright/test";

// WS-01 sign-in return path for external entry points (bead legend-qhh5): the
// Wi-Fi captive portal hands a signed-out guest to /masuk with the portal's own
// path and query (zone/table context) in `?redirect=`, and the completed
// WhatsApp login returns there instead of the member home. A `?redirect=` that
// points outside this app is ignored (open-redirect safety).
//
// Runs against the mock web server (no API, no database):
//   pnpm test:e2e:mock e2e/legend-qhh5.mock.spec.ts

const baseURL =
  process.env.LEGEND_MOCK_WEB_URL ?? process.env.E2E_MOCK_BASE_URL;

test.skip(
  !baseURL,
  "Mock runner not started: use pnpm test:e2e:mock (playwright.mock.config.ts).",
);
test.use({ baseURL });

const ZONE = "00000000-0000-4000-8000-000000009401";
const FACILITY = "00000000-0000-4000-8000-000000009002";
const TABLE = "st_01JC0QRD4M5N6P7Q8R9S0T1V2W";
const PORTAL = `/wifi?zone=${ZONE}&facility=${FACILITY}&table=${TABLE}`;
const ROLE_COOKIE = "legend-mock-role";
const CODE = /^[0-9A-Z]{4}-[0-9A-Z]{4}$/;

/**
 * The first hit on a cold Vite dev server paints the server HTML before React
 * hydrates; a click in that window is lost. React attests a hydrated node with
 * an internal `__reactFiber$…` property, so wait for that on `selector`.
 */
async function waitForHydration(page: Page, selector: string) {
  await page.waitForFunction(
    (target) => {
      const node = document.querySelector(target);
      return (
        node !== null &&
        Object.keys(node).some((key) => key.startsWith("__reactFiber$"))
      );
    },
    selector,
    { timeout: 60_000 },
  );
}

/** The mock role cookie "none" is this runner's signed-out visitor. */
async function signOut(page: Page) {
  await page.goto("/");
  await page.context().addCookies([
    {
      name: ROLE_COOKIE,
      value: "none",
      url: new URL(page.url()).origin,
    },
  ]);
}

test("legend-qhh5: a Wi-Fi guest returns to the same portal path after WhatsApp sign-in", async ({
  page,
}) => {
  test.slow();
  await signOut(page);
  await page.goto(PORTAL);

  const signIn = page.getByRole("link", { name: "Masuk dengan WhatsApp" });
  await waitForHydration(page, "#main-content a[href^='/masuk']");
  await expect(signIn).toHaveAttribute(
    "href",
    `/masuk?redirect=${encodeURIComponent(PORTAL)}`,
  );

  await signIn.click();
  await expect(page).toHaveURL(/\/masuk\?redirect=/);

  await waitForHydration(page, "#main-content button");
  await page.getByRole("button", { name: "Masuk dengan WhatsApp" }).click();
  await expect(page.getByText(CODE)).toBeVisible();

  // The role cookie pins this browser signed out for review; clearing it is
  // the mock's stand-in for the session cookie the API sets on success, so the
  // portal paints its signed-in stage when we land back.
  await page.context().clearCookies({ name: ROLE_COOKIE });
  await page.getByRole("button", { name: "Ya, masuk" }).click();

  await expect(page).toHaveURL(/\/wifi\?/, { timeout: 20_000 });
  const landed = new URL(page.url());
  expect(landed.pathname).toBe("/wifi");
  expect(landed.searchParams.get("zone")).toBe(ZONE);
  expect(landed.searchParams.get("facility")).toBe(FACILITY);
  expect(landed.searchParams.get("table")).toBe(TABLE);

  await expect(
    page.getByRole("heading", { name: "Sisa kuota hari ini" }),
  ).toBeVisible({ timeout: 20_000 });
});

test("legend-qhh5: an external ?redirect= is ignored and sign-in lands on the member home", async ({
  page,
}) => {
  test.slow();
  await page.goto("/masuk?redirect=https%3A%2F%2Fevil.example");

  await waitForHydration(page, "#main-content button");
  await page.getByRole("button", { name: "Masuk dengan WhatsApp" }).click();
  await expect(page.getByText(CODE)).toBeVisible();
  await page.getByRole("button", { name: "Ya, masuk" }).click();

  // The unsafe value is dropped before render, so the flow keeps its default
  // destination and never navigates to evil.example.
  await expect(
    page.getByRole("link", { name: "Ke halaman member" }),
  ).toHaveAttribute("href", "/member", { timeout: 20_000 });
  const stayed = new URL(page.url());
  expect(stayed.pathname).toBe("/masuk");
  expect(stayed.host).not.toBe("evil.example");
});
