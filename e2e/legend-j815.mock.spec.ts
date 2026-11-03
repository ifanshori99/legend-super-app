// Report viewer, sales family and exports (WS-11 FE, bead legend-j815; PRD v1.7
// §3 F36; DASH-02, DASH-04). Runs against the FE mock runtime: definitions,
// runs and export jobs come from @starter/shared fixtures through
// VITE_API_MOCK=true — no API, no database. Screenshots go through
// e2e/screenshots.ts and only reach the tracked evidence folder when
// LEGEND_CAPTURE_SCREENSHOTS=1.
import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";

const MOCK_URL =
  process.env.LEGEND_MOCK_WEB_URL ??
  process.env.E2E_MOCK_BASE_URL ??
  process.env.LEGEND_MOCK_URL;

test.skip(
  !MOCK_URL,
  "Needs a VITE_API_MOCK=true server (pnpm test:e2e:mock); see the header of this file.",
);

declare global {
  interface Window {
    __legendMock?: { setScenario: (scenario: string) => void };
  }
}

const OUTLET_ID = "6a2d4f80-1c3e-4b5a-9d7f-8e0c2b4a6d13";

/** A cold Vite dev server paints server HTML before React hydrates. */
async function waitForHydration(page: Page) {
  await page.waitForFunction(
    () => {
      const button = document.querySelector(
        "main button, #main-content button",
      );
      return (
        button !== null &&
        Object.keys(button).some((key) => key.startsWith("__reactFiber$"))
      );
    },
    undefined,
    { timeout: 60_000 },
  );
}

async function openReport(page: Page, path: string, name: string) {
  await page.goto(path, { waitUntil: "networkidle" });
  await waitForHydration(page);
  await expect(page.getByRole("heading", { name, level: 2 })).toBeVisible();
}

test("DASH-02: the per-hour report renders its table, summary and chart from a run", async ({
  page,
}) => {
  await openReport(page, "/reports/sales/per-hour", "Penjualan per jam");

  // Open business day: an estimate, labelled as such.
  await expect(page.getByText("Estimasi", { exact: true })).toBeVisible();
  const summary = page.getByRole("region", { name: "Ringkasan laporan" });
  await expect(summary.getByText("Penjualan bersih")).toBeVisible();
  await expect(summary.getByText(/7\.420\.000/)).toBeVisible();

  // Split by hour (the report is "per jam"): one row per served hour.
  await expect(page.getByRole("columnheader", { name: "Jam" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "11.00" })).toBeVisible();
  await expect(page.getByRole("list", { name: /Grafik batang/ })).toBeVisible();
});

test("DASH-02: a dashboard tile link opens the same period, outlet and split", async ({
  page,
}) => {
  await openReport(
    page,
    `/reports/sales/per-channel?startDate=2026-11-01&endDate=2026-11-01&outletId=${OUTLET_ID}&groupBy=channel`,
    "Penjualan per kanal",
  );
  await expect(page.getByRole("cell", { name: "QR meja" })).toBeVisible();
  await expect(page.getByText(/4\.150\.000/).first()).toBeVisible();
  await expect(page.getByRole("combobox", { name: /Periode/ })).toContainText(
    "Hari ini",
  );
});

test("DASH-02: the period filter reruns the report and closed periods read as final", async ({
  page,
}) => {
  await openReport(page, "/reports/sales/daily", "Penjualan harian");
  await page.getByRole("combobox", { name: /Periode/ }).click();
  await page.getByRole("option", { name: "Bulan lalu" }).click();
  await expect(page.getByText("Final", { exact: true })).toBeVisible();
  await expect(page.getByText(/Periode sudah ditutup/)).toBeVisible();
});

test("DASH-02: the catalog lists the sales reports and links to them", async ({
  page,
}) => {
  await page.goto("/reports", { waitUntil: "networkidle" });
  await waitForHydration(page);
  await expect(
    page.getByRole("heading", { name: "Katalog laporan" }),
  ).toBeVisible();
  // The catalog pages 25 rows at a time; search narrows to the sales report.
  await page.getByRole("searchbox", { name: "Cari laporan" }).fill("per jam");
  const link = page.getByRole("link", { name: /Penjualan per jam/ });
  await expect(link).toHaveAttribute("href", "/reports/sales/per-hour");
});

test("DASH-04: a personal-data report is labelled and its export asks for approval", async ({
  page,
}) => {
  await openReport(
    page,
    "/reports/sales/per-employee",
    "Penjualan per karyawan",
  );
  await expect(page.getByText("Data pribadi").first()).toBeVisible();
  await page.getByRole("button", { name: "Ekspor" }).click();
  const notice = page.getByTestId("export-pii-notice");
  await expect(notice).toContainText("perlu persetujuan atasan");
  await page.getByRole("button", { name: "Minta persetujuan" }).click();
  const job = page.getByTestId("export-job");
  await expect(job).toContainText("Menunggu persetujuan");
  await expect(job.getByRole("link", { name: "Unduh file" })).toHaveCount(0);
});

test("DASH-04: an aggregate export needs no approval and ends with a download link", async ({
  page,
}) => {
  await openReport(page, "/reports/sales/per-hour", "Penjualan per jam");
  await page.getByRole("button", { name: "Ekspor" }).click();
  await expect(page.getByTestId("export-pii-notice")).toHaveCount(0);
  await page.getByRole("button", { name: "Buat ekspor" }).click();
  const job = page.getByTestId("export-job");
  await expect(job).toContainText(/Antre|Sedang dibuat|Siap diunduh/);
  await expect(job.getByRole("link", { name: "Unduh file" })).toBeVisible({
    timeout: 15_000,
  });
});

test("DASH-02: empty, error and offline states are honest and recoverable", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("legend-mock-scenario", "empty"),
  );
  await openReport(page, "/reports/sales/per-hour", "Penjualan per jam");
  await expect(
    page.getByText("Belum ada data untuk periode ini"),
  ).toBeVisible();
  await captureScreenshot(page, "legend-j815/viewer-empty-1440.png");

  await page.evaluate(() => window.__legendMock?.setScenario("error"));
  await page.getByRole("button", { name: "Muat ulang" }).click();
  await expect(page.getByText("Data tidak dapat dimuat").first()).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Coba lagi" }).first(),
  ).toBeVisible();
  await captureScreenshot(page, "legend-j815/viewer-error-1440.png");

  await page.evaluate(() => window.__legendMock?.setScenario("offline"));
  await page.getByRole("button", { name: "Muat ulang" }).click();
  await expect(page.getByText("Anda sedang offline").first()).toBeVisible();
  await captureScreenshot(page, "legend-j815/viewer-offline-1440.png");

  await page.evaluate(() => window.__legendMock?.setScenario("normal"));
  await page.getByRole("button", { name: "Coba lagi" }).click();
  await expect(page.getByRole("cell", { name: "11.00" })).toBeVisible();
});

test("DASH-02: the viewer is usable at 390px with no page scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await openReport(page, "/reports/sales/per-menu", "Penjualan per menu");
  const overflow = await page.evaluate(() => {
    const main = document.querySelector("#main-content");
    return {
      page: document.documentElement.scrollWidth - window.innerWidth,
      shell: main === null ? 0 : main.scrollWidth - main.clientWidth,
    };
  });
  expect(overflow.page).toBeLessThanOrEqual(0);
  expect(overflow.shell).toBeLessThanOrEqual(0);
});

for (const width of [390, 1440]) {
  for (const theme of ["light", "dark"]) {
    test(`legend-j815 visual ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (value) => localStorage.setItem("legend-theme", value),
        theme,
      );
      await openReport(page, "/reports/sales/per-hour", "Penjualan per jam");
      await expect(page.getByRole("cell", { name: "11.00" })).toBeVisible();
      const height = await page.evaluate(
        () => document.querySelector("#main-content")?.scrollHeight ?? 900,
      );
      await page.setViewportSize({
        width,
        height: Math.min(4000, Math.max(900, height + 32)),
      });
      await page.waitForTimeout(250);
      await captureScreenshot(page, `legend-j815/viewer-${width}-${theme}.png`);

      await page.setViewportSize({ width, height: 900 });
      await page.getByRole("button", { name: "Ekspor" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.waitForTimeout(250);
      await captureScreenshot(
        page,
        `legend-j815/export-${width}-${theme}.png`,
        { fullPage: false },
      );

      await page.keyboard.press("Escape");
      await page.goto("/reports", { waitUntil: "networkidle" });
      await waitForHydration(page);
      await page
        .getByRole("searchbox", { name: "Cari laporan" })
        .fill("per jam");
      await expect(
        page.getByRole("link", { name: /Penjualan per jam/ }),
      ).toBeVisible();
      await page.waitForTimeout(250);
      await captureScreenshot(
        page,
        `legend-j815/catalog-${width}-${theme}.png`,
      );
    });
  }
}
