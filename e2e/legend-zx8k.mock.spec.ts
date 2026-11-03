// Facility & WFC report hub and the six facility report screens (WS-09 FE, bead
// legend-zx8k; PRD v1.7 §3 F25 "Laporan" and "Pengukuran WFC"). Runs against
// the FE mock runtime (VITE_API_MOCK=true): catalog definitions, dense tables
// and charts come from the shared fixtures through the generic report viewer —
// no API and no database.
//
// Run: pnpm test:e2e:mock e2e/legend-zx8k.mock.spec.ts
//
// Screenshots go through e2e/screenshots.ts and only reach the tracked evidence
// folder when LEGEND_CAPTURE_SCREENSHOTS=1.
import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";

// The mock server address is injected by playwright.mock.config.ts (default
// 3320); a spec started without it skips instead of failing, so the real-API
// suite never runs this file.
const mockWebUrl = process.env.LEGEND_MOCK_WEB_URL;
test.skip(!mockWebUrl, "Requires the mock-mode web server");
test.use({ baseURL: mockWebUrl ?? "http://localhost:3320" });

/** The first assertion of the first test pays Vite's cold compile. */
const COLD_START_TIMEOUT_MS = 30_000;

async function waitForHydration(page: Page) {
  // The hub is a catalog page: links only, no button (management shell keeps
  // actions in the topbar). Accept any React-owned element inside main.
  await page.waitForFunction(
    () => {
      const control = document.querySelector(
        "main button, #main-content button, main a[href], #main-content a[href]",
      );
      return (
        control !== null &&
        Object.keys(control).some((key) => key.startsWith("__reactFiber$"))
      );
    },
    undefined,
    { timeout: 60_000 },
  );
}

async function openRoute(page: Page, path: string) {
  // A cold Vite dev server compiles this route's module graph on the first
  // visit; give the navigation itself the same budget as the hydration wait.
  page.setDefaultNavigationTimeout(60_000);
  await page.goto(path, { waitUntil: "networkidle" });
  await waitForHydration(page);
}

async function openReport(page: Page, path: string, name: string) {
  await openRoute(page, path);
  await expect(page.getByRole("heading", { name, level: 2 })).toBeVisible();
}

const FACILITY_REPORTS = [
  "Pendapatan fasilitas",
  "RevPASH",
  "Utilisasi shower room",
  "Langganan fasilitas",
  "Wi-Fi tamu",
  "Konversi fasilitas ke F&B",
] as const;

test("ZX8K-01 the facility report hub lists the six facility and WFC reports", async ({
  page,
}) => {
  await openRoute(page, "/kelola/fasilitas/laporan?mock=normal");
  const hub = page.locator('[data-slot="facility-report-hub"]');
  await expect(hub).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await expect(page.locator('[data-slot="facility-report-card"]')).toHaveCount(
    FACILITY_REPORTS.length,
  );
  for (const name of FACILITY_REPORTS) {
    await expect(
      page.getByRole("link", { name: new RegExp(name) }),
    ).toBeVisible();
  }
  // Static catalog: no loading skeleton and no retry action on the page.
  await expect(page.getByRole("button", { name: "Coba lagi" })).toHaveCount(0);
  await expect(
    page.locator('[data-slot="facility-report-reading"]'),
  ).toContainText("RevPASH dan okupansi zona");
});

test("ZX8K-02 the revenue report renders its dense table and a chart", async ({
  page,
}) => {
  await openReport(
    page,
    "/reports/facility/revenue?mock=normal",
    "Pendapatan fasilitas",
  );
  await expect(
    page.getByRole("columnheader", { name: "Fasilitas" }),
  ).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: "Pendapatan shower room" }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "Area Pria · P1" }),
  ).toBeVisible();
  await expect(page.getByRole("list", { name: /Grafik batang/ })).toBeVisible();
  await expect(page.getByText(/1\.350\.000/).first()).toBeVisible();
});

test("ZX8K-03 splitting the revenue report by facility and outlet works", async ({
  page,
}) => {
  await openReport(
    page,
    "/reports/facility/revenue?mock=normal",
    "Pendapatan fasilitas",
  );
  // The report opens split by facility: four booths across two areas.
  for (const booth of [
    "Area Pria · P1",
    "Area Pria · P2",
    "Area Wanita · W1",
    "Area Wanita · W2",
  ])
    await expect(page.getByRole("cell", { name: booth })).toBeVisible();

  // Switch to outlet: one total row for the active outlet (DASH-02).
  await page.getByRole("combobox", { name: "Pecah menurut" }).click();
  await page.getByRole("option", { name: "Outlet", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "Cafe Legend Bandung" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/groupBy=outlet/);

  // Back to facility: the four booth rows return.
  await page.getByRole("combobox", { name: "Pecah menurut" }).click();
  await page.getByRole("option", { name: "Fasilitas", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "Area Pria · P1" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/groupBy=facility/);
});

test("ZX8K-04 the RevPASH and shower utilization routes render", async ({
  page,
}) => {
  await openReport(page, "/reports/facility/revpash?mock=normal", "RevPASH");
  // Opens split by zone; the four floor zones come from the owner fixtures.
  await expect(
    page.getByRole("columnheader", { name: "Zona", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "Indoor Reguler" }),
  ).toBeVisible();
  await expect(page.getByRole("cell", { name: "WFC Corner" })).toBeVisible();
  await expect(page.getByRole("list", { name: /Grafik batang/ })).toBeVisible();

  await openReport(
    page,
    "/reports/facility/occupancy?mock=normal",
    "Utilisasi shower room",
  );
  await expect(
    page.getByRole("columnheader", { name: "Utilisasi shower room" }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "Area Wanita · W2" }),
  ).toBeVisible();
});

test("ZX8K-05 one facility report shows its empty and error states", async ({
  page,
}) => {
  await openReport(
    page,
    "/reports/facility/revenue?mock=empty",
    "Pendapatan fasilitas",
  );
  await expect(
    page.getByText("Belum ada data untuk periode ini"),
  ).toBeVisible();

  await openRoute(page, "/reports/facility/revenue?mock=error");
  await expect(page.getByText("Laporan gagal dimuat")).toBeVisible();
  await expect(page.getByRole("alert")).toBeVisible();
});

for (const width of [390, 1440]) {
  for (const theme of ["light", "dark"]) {
    test(`ZX8K visual hub and revenue ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (value) => localStorage.setItem("legend-theme", value),
        theme,
      );

      await openRoute(page, "/kelola/fasilitas/laporan?mock=normal");
      await expect(
        page.locator('[data-slot="facility-report-card"]'),
      ).toHaveCount(FACILITY_REPORTS.length);
      await page.waitForTimeout(250);
      await captureScreenshot(page, `legend-zx8k/hub-${width}-${theme}.png`);

      await openReport(
        page,
        "/reports/facility/revenue?mock=normal",
        "Pendapatan fasilitas",
      );
      await expect(
        page.getByRole("cell", { name: "Area Pria · P1" }),
      ).toBeVisible();
      await page.waitForTimeout(250);
      await captureScreenshot(
        page,
        `legend-zx8k/revenue-${width}-${theme}.png`,
      );

      await openReport(
        page,
        "/reports/facility/revpash?mock=normal",
        "RevPASH",
      );
      await expect(
        page.getByRole("cell", { name: "Indoor Reguler" }),
      ).toBeVisible();
      await page.waitForTimeout(250);
      await captureScreenshot(
        page,
        `legend-zx8k/revpash-${width}-${theme}.png`,
      );
    });
  }
}
