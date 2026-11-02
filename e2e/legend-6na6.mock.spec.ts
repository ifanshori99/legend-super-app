// Management home per role (WS-11 FE, bead legend-6na6; PRD v1.7 §3.36
// "Beranda per Role", DASH-01/DASH-02). Runs against the FE mock runtime: the
// management layout and each role's KPI report run come from
// @starter/shared/dashboard fixtures through VITE_API_MOCK=true, no API and no
// database (frontend standard, "Typed endpoints and mock mode").
//
// How to run: `pnpm test:e2e:mock` starts a VITE_API_MOCK web server and names
// it in `LEGEND_MOCK_WEB_URL`. With no variable set every test skips, so the
// production-build runner stays green.
import { expect, test } from "@playwright/test";

const MOCK_URL =
  process.env.LEGEND_MOCK_WEB_URL ??
  process.env.E2E_MOCK_BASE_URL ??
  process.env.LEGEND_MOCK_URL;

test.skip(
  !MOCK_URL,
  "Needs a VITE_API_MOCK=true server (pnpm test:e2e:mock); see the header of this file.",
);

/**
 * The first hit on a cold Vite dev server paints the server HTML before React
 * hydrates; a click in that window is lost. React attests a hydrated node with
 * an internal `__reactFiber$…` property, so wait for that on the role tabs.
 */
async function waitForHydration(page: import("@playwright/test").Page) {
  await page.waitForFunction(
    () => {
      const tab = document.querySelector('[role="tab"]');
      return (
        tab !== null &&
        Object.keys(tab).some((key) => key.startsWith("__reactFiber$"))
      );
    },
    undefined,
    { timeout: 60_000 },
  );
}

test("F36: the management home composes the GM home from the layout and its report", async ({
  page,
}) => {
  await page.goto("/kelola");

  // DESIGN.md v3: the ManagementShell topbar owns the title; the body starts
  // with the role toolbar and the work queue.
  await expect(page.getByRole("heading", { name: "Kelola" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Antrean kerja" }),
  ).toBeVisible();
  await expect(page.getByRole("tab", { name: "GM" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("tab", { name: "Keuangan" })).toBeVisible();

  // One StatStrip for the role's KPIs (DASH-01: registry labels), with the
  // numbers of the source report run (DASH-02).
  await expect(
    page.getByRole("region", { name: "Angka kunci peran GM" }),
  ).toBeVisible();
  await expect(
    page.getByText("Penjualan bersih", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/44\.750\.000/)).toBeVisible();
  await expect(page.getByText(/182/).first()).toBeVisible();

  // The GM work queue and the shared approval box.
  await expect(
    page.getByRole("heading", { name: "Approval menunggu" }),
  ).toBeVisible();
  // The approval inbox renders once: the GM's queue card is the inbox, so the
  // shared box is not repeated below.
  await expect(
    page.getByRole("heading", { name: "Kotak approval", exact: true }),
  ).toHaveCount(0);

  // DASH-01: the strip links to the report that produced the numbers, with the
  // same period and outlet the run used.
  const source = page
    .getByRole("link", { name: /Penjualan per kanal/ })
    .first();
  await expect(source).toHaveAttribute(
    "href",
    /^\/reports\/sales\/per-channel\?.*startDate=2026-11-01.*endDate=2026-11-01/,
  );
});

test("F36: switching the role tab swaps the targets, the numbers and the queue", async ({
  page,
}) => {
  await page.goto("/kelola");
  await waitForHydration(page);

  await page.getByRole("tab", { name: "Keuangan" }).click();
  await expect(page).toHaveURL(/role=finance/);
  await expect(
    page.getByRole("region", { name: "Angka kunci peran Keuangan" }),
  ).toBeVisible();
  await expect(page.getByText(/8\.250\.000/)).toBeVisible();
  await expect(page.getByText(/96\.500\.000/)).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Approval keuangan" }),
  ).toBeVisible();
  // The GM's figures are gone from this role's home.
  await expect(page.getByText(/44\.750\.000/)).toHaveCount(0);

  // A role whose queue is not an approval queue gets the shared inbox section.
  await page.getByRole("tab", { name: "Manajer outlet" }).click();
  await expect(page).toHaveURL(/role=outlet_manager/);
  await expect(
    page.getByRole("heading", { name: "Stok kritis outlet" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Kotak approval", exact: true }),
  ).toBeVisible();
});

test("F36: an empty layout renders the honest empty state, not a blank page", async ({
  page,
}) => {
  await page.goto("/kelola?mock=empty");
  await expect(
    page.getByText("Belum ada peran yang memiliki antrean"),
  ).toBeVisible();
  // The shared sections survive an empty role queue.
  await expect(
    page.getByRole("heading", { name: "Kotak approval", exact: true }),
  ).toBeVisible();
});

test("F36: the error state explains the failure and offers a retry", async ({
  page,
}) => {
  await page.goto("/kelola?mock=error");
  await expect(page.getByText("Data tidak dapat dimuat")).toBeVisible();
  await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();
});

test("F36: the offline state says so and offers a retry", async ({ page }) => {
  await page.goto("/kelola?mock=offline");
  await expect(page.getByText("Anda sedang offline")).toBeVisible();
  await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();
});

test("F36: a slow layout announces loading before the queue appears", async ({
  page,
}) => {
  await page.goto("/kelola?mock=slow");
  await expect(page.locator('[aria-busy="true"]')).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Antrean kerja" }),
  ).toBeVisible({ timeout: 20_000 });
});

test("F36: the home fits 390px without horizontal scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/kelola");
  await expect(
    page.getByRole("heading", { name: "Antrean kerja" }),
  ).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});
