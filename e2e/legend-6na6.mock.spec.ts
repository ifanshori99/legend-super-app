// Management home per role (WS-11 FE, bead legend-6na6; PRD v1.7 §3.36
// "Beranda per Role"). Runs against the FE mock runtime: the dashboard layout
// comes from @starter/shared/dashboard fixtures through VITE_API_MOCK=true, no
// API and no database (docs/frontend.md, "Typed endpoints and mock mode").
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

test("F36: the management home composes the GM work queue from the layout", async ({
  page,
}) => {
  await page.goto("/kelola");
  await expect(
    page.getByRole("heading", { name: "Beranda manajemen" }),
  ).toBeVisible();

  // The role switcher lists the roles the layout offers, GM first.
  await expect(page.getByRole("tab", { name: "GM" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("tab", { name: "Keuangan" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Kepala dapur" })).toBeVisible();

  // The GM queue: one KPI card that cites its metric definitions, one queue
  // card, and the approval box every role shares.
  await expect(
    page.getByRole("heading", { name: "Kinerja outlet hari ini" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Approval menunggu" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Kotak approval", exact: true }),
  ).toBeVisible();
  // DASH-01: the KPI card names its source report and links to it.
  await expect(
    page.getByRole("link", { name: /Penjualan per kanal/ }).first(),
  ).toHaveAttribute("href", /^\/reports\/sales\/per-channel/);
});

test("F36: switching the role tab swaps the work queue", async ({ page }) => {
  await page.goto("/kelola");
  await waitForHydration(page);

  await page.getByRole("tab", { name: "Keuangan" }).click();
  await expect(page).toHaveURL(/role=finance/);
  await expect(
    page.getByRole("heading", { name: "Posisi kas dan bank" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Approval keuangan" }),
  ).toBeVisible();
  // The GM's KPI is gone from this role's queue.
  await expect(
    page.getByRole("heading", { name: "Kinerja outlet hari ini" }),
  ).toHaveCount(0);
});

test("F36: an empty queue renders the honest empty state, not a blank page", async ({
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
    page.getByRole("heading", { name: "Beranda manajemen" }),
  ).toBeVisible({ timeout: 15_000 });
});

test("F36: the home fits 390px without horizontal scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/kelola");
  await expect(
    page.getByRole("heading", { name: "Beranda manajemen" }),
  ).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});
