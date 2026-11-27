// Facility & WFC report hub and the eleven facility report screens (WS-09 FE, bead
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

/** The four floor-zone rows of the RevPASH report (owner board fixture). */
async function expectRevpashZoneRows(page: Page) {
  await expect(page.getByRole("table")).toHaveCount(1);
  for (const zone of [
    "Indoor Reguler",
    "Taman Outdoor",
    "Private Room Nusantara",
    "WFC Corner",
  ]) {
    await expect(page.getByRole("cell", { name: zone })).toBeVisible();
  }
  await expect(page.getByText("Belum ada data untuk periode ini")).toHaveCount(
    0,
  );
}

const FACILITY_REPORTS = [
  "Pendapatan fasilitas",
  "RevPASH",
  "Utilisasi shower room",
  "Langganan fasilitas",
  "Wi-Fi tamu",
  "Konversi fasilitas ke F&B",
  "Kelebihan waktu fasilitas",
  "Waktu pembersihan",
  "Insiden fasilitas",
  "Pendapatan per produk fasilitas",
  "Utilisasi unit per jam",
] as const;

test("ZX8K-01 the facility report hub lists the eleven facility and WFC reports", async ({
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
  // Opens split by facility (bead legend-vhgt): booths sit under the unit split.
  await expect(
    page.getByRole("cell", { name: "Shower Room Legend" }),
  ).toBeVisible();
  await expect(page.getByRole("list", { name: /Grafik batang/ })).toBeVisible();
  // The API source is unavailable: never invent shower revenue or show Rp0.
  const shower = page.getByRole("row").filter({
    has: page.getByRole("cell", { name: "Shower Room Legend", exact: true }),
  });
  await expect(shower.getByRole("cell").nth(1)).toHaveText("—");
  await expect(page.getByText(/1\.350\.000|Rp\s*0(?:\D|$)/)).toHaveCount(0);
});

test("ZX8K-03 splitting the revenue report by facility, unit and outlet works", async ({
  page,
}) => {
  await openReport(
    page,
    "/reports/facility/revenue?mock=normal",
    "Pendapatan fasilitas",
  );
  // The report opens split by facility: the shower room and the WFC zone.
  for (const facility of ["Shower Room Legend", "Zona WFC Legend"])
    await expect(page.getByRole("cell", { name: facility })).toBeVisible();

  // Switch to unit (bead legend-vhgt): the four booths across two areas.
  await page.getByRole("combobox", { name: "Pecah menurut" }).click();
  await page.getByRole("option", { name: "Unit", exact: true }).click();
  await expect(page).toHaveURL(/groupBy=unit/);
  await expect(page.getByRole("columnheader", { name: "Unit" })).toBeVisible();
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

  // Back to facility: the two facility rows return.
  await page.getByRole("combobox", { name: "Pecah menurut" }).click();
  await page.getByRole("option", { name: "Fasilitas", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "Shower Room Legend" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/groupBy=facility/);
});

test("ZX8K-04 the RevPASH and shower utilization routes render", async ({
  page,
}) => {
  await openReport(page, "/reports/facility/revpash?mock=normal", "RevPASH");
  // RevPASH is available (legend-p4q10): the report shows one row per floor zone.
  await expectRevpashZoneRows(page);

  await openReport(
    page,
    "/reports/facility/occupancy?mock=normal",
    "Utilisasi shower room",
  );
  await expect(
    page.getByRole("columnheader", { name: "Utilisasi shower room" }),
  ).toBeVisible();
  // Opens split by facility; the booth rows sit under the unit split.
  await expect(
    page.getByRole("cell", { name: "Shower Room Legend" }),
  ).toBeVisible();
  await openReport(
    page,
    "/reports/facility/occupancy?mock=normal&groupBy=unit",
    "Utilisasi shower room",
  );
  await expect(
    page.getByRole("cell", { name: "Area Wanita · W2" }),
  ).toBeVisible();
});

test("ZX8K-06 the five operations reports render their default split", async ({
  page,
}) => {
  // [route, heading, a cell of the default split]: overtime, cleaning,
  // incidents and product revenue open by facility, unit utilization by unit.
  const reports = [
    ["overtime", "Kelebihan waktu fasilitas", "Shower Room Legend"],
    ["cleaning-time", "Waktu pembersihan", "Zona WFC Legend"],
    ["incidents", "Insiden fasilitas", "Shower Room Legend"],
    ["product-revenue", "Pendapatan per produk fasilitas", "Zona WFC Legend"],
    ["unit-utilization", "Utilisasi unit per jam", "Area Pria · P1"],
  ] as const;
  for (const [route, heading, cell] of reports) {
    await openReport(page, `/reports/facility/${route}?mock=normal`, heading);
    if (route === "cleaning-time" || route === "product-revenue") {
      // These sources are not built: no mock rows may fabricate their values,
      // and the viewer says the source is not connected (6bfca4094).
      await expect(
        page.getByText("Sumber data belum tersambung"),
      ).toBeVisible();
      await expect(page.getByRole("table")).toHaveCount(0);
    } else {
      await expect(page.getByRole("cell", { name: cell })).toBeVisible();
    }
  }

  // The unit split lists all six units, WFC seats included (bead legend-vhgt).
  await openReport(
    page,
    "/reports/facility/overtime?mock=normal&groupBy=unit",
    "Kelebihan waktu fasilitas",
  );
  await expect(page.getByRole("cell", { name: "Zona WFC · S2" })).toBeVisible();
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
        "/reports/facility/revenue?mock=normal&groupBy=unit",
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
      await expectRevpashZoneRows(page);
      await page.waitForTimeout(250);
      await captureScreenshot(
        page,
        `legend-zx8k/revpash-${width}-${theme}.png`,
      );
    });
  }
}
