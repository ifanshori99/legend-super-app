// Report builder (WS-11 FE, bead legend-x9r2; PRD v1.7 §3 F36, DASH-01,
// DASH-04). Runs against the FE mock runtime (VITE_API_MOCK=true): the metric
// catalog, preview, saved reports and schedules come from @starter/shared and
// features/ws11-report-builder/mock.ts — no API, no database. Screenshots go
// through e2e/screenshots.ts and only reach the tracked evidence folder when
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

/** A cold Vite dev server paints server HTML before React hydrates. */
async function waitForHydration(page: Page) {
  await page.waitForFunction(
    () => {
      const input = document.querySelector('input[type="search"]');
      return (
        input !== null &&
        Object.keys(input).some((key) => key.startsWith("__reactFiber$"))
      );
    },
    undefined,
    { timeout: 60_000 },
  );
}

async function openBuilder(page: Page) {
  await page.goto("/reports/builder", { waitUntil: "networkidle" });
  await waitForHydration(page);
  await expect(
    // The step number is read out ("Langkah 1: Metrik").
    page.getByRole("heading", { name: "Langkah 1: Metrik", exact: true }),
  ).toBeVisible();
}

/** A saved-report row in the page body (the confirmation toast is a listitem too). */
function savedRow(page: Page, name: string) {
  return page
    .locator("#main-content")
    .getByRole("listitem")
    .filter({ hasText: name })
    .first();
}

async function pickMetric(page: Page, name: string) {
  await page.getByLabel("Cari metrik").fill(name);
  await page
    .getByRole("checkbox", { name: new RegExp(`^${name}`) })
    .first()
    .click();
  await page.getByLabel("Cari metrik").fill("");
}

test("F36: pick a metric and a split, see the live preview table and chart", async ({
  page,
}) => {
  await openBuilder(page);
  await expect(
    page.getByText("Pratinjau belum bisa ditampilkan"),
  ).toBeVisible();

  await pickMetric(page, "Penjualan bersih");
  await page.getByRole("checkbox", { name: "Jam", exact: true }).click();

  const table = page.getByRole("table");
  await expect(table).toBeVisible({ timeout: 15_000 });
  await expect(
    table.getByRole("columnheader", { name: "Penjualan bersih" }),
  ).toBeVisible();
  await expect(
    table.getByRole("columnheader", { name: "Jam", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("img", { name: /Grafik batang/ })).toBeVisible();
});

test("DASH-01: a split the chosen metrics do not share cannot be picked", async ({
  page,
}) => {
  await openBuilder(page);
  await pickMetric(page, "Penjualan bersih");
  await pickMetric(page, "Jumlah tamu");
  // Menu is offered by net sales only, so it is disabled with the reason.
  const menu = page.getByRole("checkbox", { name: /^Menu Tidak dimiliki/ });
  await expect(menu).toBeDisabled();
  await expect(
    page.getByText("Tidak dimiliki semua metrik yang dipilih").first(),
  ).toBeVisible();
});

test("F36: save a report, schedule an email and pause the schedule", async ({
  page,
}) => {
  await openBuilder(page);
  await pickMetric(page, "Penjualan bersih");
  await page.getByRole("checkbox", { name: "Kanal", exact: true }).click();
  await expect(page.getByRole("table")).toBeVisible({ timeout: 15_000 });

  await page.getByLabel(/Nama laporan/).fill("Omzet per kanal");
  await page.getByRole("button", { name: "Simpan laporan" }).click();
  await expect(savedRow(page, "Omzet per kanal")).toBeVisible();

  const row = savedRow(page, "Omzet per kanal");
  await row.getByRole("button", { name: "Jadwalkan" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox", { name: /Dewi Anggraini/ }).check();
  await dialog.getByRole("button", { name: "Buat jadwal" }).click();
  await expect(dialog).toBeHidden();

  const schedule = page.getByRole("switch", { name: "Aktifkan jadwal" });
  await expect(schedule.first()).toBeVisible();
  await expect(page.getByText(/Setiap Senin pukul 07:00/)).toBeVisible();
  await schedule.first().click();
  await expect(page.getByText("Dijeda").first()).toBeVisible();
});

test("DASH-04: a report split by person is not mailed; the approval requirement shows", async ({
  page,
}) => {
  await openBuilder(page);
  await pickMetric(page, "Penjualan bersih");
  await page.getByRole("checkbox", { name: /^Karyawan Data pribadi/ }).click();
  await expect(
    page.getByText(/memecah atau menyaring per orang/),
  ).toBeVisible();
  await page.getByLabel(/Nama laporan/).fill("Omzet per karyawan");
  await page.getByRole("button", { name: "Simpan laporan" }).click();

  const row = savedRow(page, "Omzet per karyawan");
  await row.getByRole("button", { name: "Jadwalkan" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("Laporan ini tidak bisa dijadwalkan"),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Buat jadwal" })).toHaveCount(
    0,
  );
  // The saved row says why before the dialog opens.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(row.getByText("Data pribadi", { exact: true })).toBeVisible();
});

for (const width of [390, 1440]) {
  for (const theme of ["light", "dark"]) {
    test(`legend-x9r2 visual ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (value) => localStorage.setItem("legend-theme", value),
        theme,
      );
      await openBuilder(page);
      await pickMetric(page, "Penjualan bersih");
      await pickMetric(page, "Jumlah tamu");
      await page.getByRole("checkbox", { name: "Jam", exact: true }).click();
      await expect(page.getByRole("table")).toBeVisible({ timeout: 15_000 });
      await page.getByLabel(/Nama laporan/).fill("Omzet dan tamu per jam");
      await page.getByRole("button", { name: "Simpan laporan" }).click();
      await expect(savedRow(page, "Omzet dan tamu per jam")).toBeVisible();

      const contentHeight = await page.evaluate(
        () => document.querySelector("#main-content")?.scrollHeight ?? 900,
      );
      await page.setViewportSize({
        width,
        height: Math.min(6000, Math.max(900, contentHeight + 32)),
      });
      await page.waitForTimeout(250);
      await captureScreenshot(
        page,
        `legend-x9r2/builder-${width}-${theme}.png`,
      );
    });
  }
}

for (const width of [390, 1440]) {
  test(`empty and error states are honest at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });

    // Empty: no saved reports, and a preview without rows.
    await page.addInitScript(() =>
      localStorage.setItem("legend-mock-scenario", "empty"),
    );
    await openBuilder(page);
    await pickMetric(page, "Penjualan bersih");
    await expect(page.getByText("Belum ada laporan tersimpan")).toBeVisible();
    await expect(page.getByText("Belum ada data").first()).toBeVisible({
      timeout: 15_000,
    });
    await captureScreenshot(page, `legend-x9r2/builder-${width}-empty.png`);

    // Error: the preview and the saved list fail, each with its own retry.
    await page.evaluate(() => window.__legendMock?.setScenario("error"));
    await page.getByRole("checkbox", { name: "Jam", exact: true }).click();
    await expect(page.getByText("Pratinjau gagal dimuat")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByRole("button", { name: "Coba lagi" }).first(),
    ).toBeVisible();
    // The preview sits below the steps on a phone: show the failure itself.
    await page.getByText("Pratinjau gagal dimuat").scrollIntoViewIfNeeded();
    await captureScreenshot(page, `legend-x9r2/builder-${width}-error.png`);

    await page.evaluate(() => window.__legendMock?.setScenario("normal"));
  });
}
