// Food safety on the ops screens (bead legend-d983): OPS-02 temperature log,
// OPS-03 prep labels and the daily prep list (PRD v1.7 §3 F41).
//
// Mock-mode spec: it runs against the web dev server with VITE_API_MOCK=true
// that `pnpm test:e2e:mock` starts — no API, no database. Without
// LEGEND_MOCK_WEB_URL every test skips, so the production e2e run never fails
// on it. The mock store rebases the shared fixtures onto today's business day,
// so "today's checks" and the expired prep label are stable on any date.
import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";

const base = process.env.LEGEND_MOCK_WEB_URL;

test.describe.configure({ timeout: 60_000 });

test.skip(
  !base,
  "Set LEGEND_MOCK_WEB_URL to a web server running VITE_API_MOCK.",
);

test.use({ baseURL: base ?? "http://localhost:3320" });

async function open(page: Page, path: string) {
  await page.goto(`${path}?mock=normal`);
  await page.waitForLoadState("networkidle");
}

/** `window.print` is a no-op in headless Chromium; stub it so the flow is fast. */
async function stubPrint(page: Page) {
  await page.addInitScript(() => {
    window.print = () => {};
  });
}

test("OPS-02 an out-of-range reading cannot be saved without a corrective action", async ({
  page,
}) => {
  await stubPrint(page);
  await open(page, "/operasional/suhu");
  await expect(
    page.getByRole("heading", { name: "Log keamanan pangan", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Jadwal pengecekan hari ini" }),
  ).toBeVisible();

  const chiller = page
    .locator('[data-slot="temperature-equipment"]')
    .filter({ hasText: "Chiller Bar" });
  await expect(chiller).toBeVisible();
  await expect(chiller).toContainText("1 °C hingga 4 °C");
  await chiller.getByRole("button", { name: "Catat suhu" }).click();

  await page.getByLabel("Suhu terukur (°C)").fill("9,2");
  await expect(
    page.getByText(
      "Di luar ambang 1 °C hingga 4 °C. Isi tindakan korektif untuk dapat menyimpan.",
    ),
  ).toBeVisible();

  const rows = page.locator('[data-slot="temperature-log"]');
  const before = await rows.count();
  await page.getByRole("button", { name: "Simpan pembacaan" }).click();
  await expect(
    page.getByText("Tindakan korektif wajib diisi untuk suhu di luar ambang."),
  ).toBeVisible();
  await expect(rows).toHaveCount(before);
  await expect(page.getByLabel("Tindakan korektif")).toHaveAttribute(
    "aria-invalid",
    "true",
  );

  const corrective = "Es batu ditambahkan dan chiller disetel ulang.";
  await page.getByLabel("Tindakan korektif").fill(corrective);
  await page.getByRole("button", { name: "Simpan pembacaan" }).click();

  const saved = page
    .locator('[data-slot="temperature-log"]')
    .filter({ hasText: corrective });
  await expect(saved).toHaveCount(1, { timeout: 15_000 });
  await expect(saved).toContainText("9,2 °C");
  await expect(saved).toContainText("Di luar ambang");
  // Urgent row treatment: stored verdict is out of range (solid pill + rule).
  await expect(saved).toHaveAttribute("data-in-range", "false");
  await expect(rows).toHaveCount(before + 1);
});

test("legend-do1o OPS-03 a saved prep shelf life derives use-by across midnight and the label prints with its batch", async ({
  page,
}) => {
  await stubPrint(page);
  await open(page, "/operasional/label-prep");
  await expect(
    page.getByRole("heading", { name: "Label prep", level: 1 }),
  ).toBeVisible();

  const expired = page.locator('[data-slot="prep-label-expired"]');
  await expect(expired).toBeVisible();
  await expect(expired).toContainText("Lewat batas pakai");
  await expect(expired).toContainText("SUSU-1101-B");

  const form = page.locator('[data-slot="prep-label-form"]');
  await form.getByRole("combobox", { name: "Bahan", exact: true }).click();
  await page.getByRole("option", { name: "Keju Cheddar", exact: true }).click();
  await form
    .getByRole("combobox", { name: "Batch inventori", exact: true })
    .click();
  await page.getByRole("option", { name: "KEJU-1101", exact: true }).click();

  const shelfLife = form.getByLabel("Masa simpan bahan prep (menit)", {
    exact: true,
  });
  await expect(shelfLife).toBeEnabled();
  await shelfLife.fill("90");
  await form
    .getByRole("button", { name: "Simpan masa simpan", exact: true })
    .click();
  await expect(
    page.getByText("Masa simpan bahan prep disimpan.", { exact: true }),
  ).toBeVisible();
  const production = form.getByLabel("Waktu produksi", { exact: true });
  const day = (await production.inputValue()).slice(0, 10);
  const nextDay = new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
  await production.fill(`${day}T23:30`);
  const useBy = form.getByLabel("Batas pakai", { exact: true });
  await expect(useBy).toHaveJSProperty("readOnly", true);
  await expect(useBy).toHaveValue(`${nextDay}T01:00`);
  await expect(form).toContainText("Dihitung 90 menit setelah waktu produksi");

  await form.getByRole("button", { name: "Buat label", exact: true }).click();
  const preview = page.locator('[data-slot="prep-label-preview"]');
  await expect(preview).toContainText("Keju Cheddar");
  await expect(
    preview.locator('[data-slot="prep-label-use-by"]'),
  ).not.toBeEmpty();
  await expect(preview.locator('[data-slot="prep-label-batch"]')).toHaveText(
    "KEJU-1101",
  );
  await expect(preview).toContainText("Penanggung jawab");

  await preview
    .getByRole("button", { name: "Cetak label", exact: true })
    .click();
  await expect(preview.getByText(/Sudah dicetak/)).toBeVisible({
    timeout: 15_000,
  });
});

test("daily prep list records a new list and advances its status", async ({
  page,
}) => {
  await open(page, "/operasional/prep");
  await expect(
    page.getByRole("heading", { name: "Daftar prep harian", level: 1 }),
  ).toBeVisible();

  const seeded = page.locator('[data-slot="prep-list"]').first();
  await expect(seeded).toContainText("Sedang berjalan");
  await expect(
    seeded.locator('[data-slot="prep-list-batch"]').first(),
  ).toContainText("Batch #");
  await seeded.getByRole("button", { name: "Tandai selesai" }).click();
  await expect(seeded).toContainText("Selesai", { timeout: 15_000 });

  await page.getByRole("button", { name: "Buat daftar prep" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox", { name: "Bahan", exact: true }).click();
  await page.getByRole("option", { name: "Susu UHT Full Cream" }).click();
  await dialog.getByLabel("Jumlah rencana").fill("2");
  await dialog.getByRole("button", { name: "Simpan daftar" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });

  const created = page
    .locator('[data-slot="prep-list"]')
    .filter({ hasText: "Susu UHT Full Cream" });
  await expect(created).toHaveCount(1);
  await expect(created).toContainText("Menunggu");
  await created.getByRole("button", { name: "Mulai persiapan" }).click();
  await expect(created).toContainText("Sedang berjalan", { timeout: 15_000 });
});

test("empty and error states keep the ops screens honest", async ({ page }) => {
  await page.goto("/operasional/suhu?mock=empty");
  await expect(page.getByText("Belum ada pembacaan")).toBeVisible();
  await page.goto("/operasional/label-prep?mock=empty");
  await expect(page.getByText("Belum ada label prep")).toBeVisible();
  await page.goto("/operasional/prep?mock=empty");
  await expect(page.getByText("Belum ada daftar prep")).toBeVisible();

  await page.goto("/operasional/suhu?mock=error");
  await expect(page.getByText("Log suhu tidak dapat dimuat")).toBeVisible();
  await page.getByRole("button", { name: "Coba lagi" }).click();
  await expect(page.getByText("Log suhu tidak dapat dimuat")).toBeVisible();
});

async function captureOpsScreen(
  page: Page,
  width: number,
  relativePath: string,
) {
  const contentHeight = await page.evaluate(() => {
    const scroller = document.querySelector("#main-content > div");
    return scroller instanceof HTMLElement ? scroller.scrollHeight : 900;
  });
  await page.setViewportSize({
    width,
    height: Math.min(4200, Math.max(900, contentHeight + 80)),
  });
  await page.waitForTimeout(200);
  await captureScreenshot(page, relativePath, { fullPage: false });
  await page.setViewportSize({ width, height: 900 });
}

for (const width of [390, 1440] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`legend-d983 visual ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (value) => localStorage.setItem("legend-theme", value),
        theme,
      );
      await open(page, "/operasional/suhu");
      await expect(
        page.getByRole("heading", { name: "Jadwal pengecekan hari ini" }),
      ).toBeVisible();
      await captureOpsScreen(
        page,
        width,
        `legend-d983/suhu-${width}-${theme}.png`,
      );

      await open(page, "/operasional/label-prep");
      await expect(
        page.locator('[data-slot="prep-label-expired"]'),
      ).toBeVisible();
      await captureOpsScreen(
        page,
        width,
        `legend-d983/label-prep-${width}-${theme}.png`,
      );

      await open(page, "/operasional/prep");
      await expect(
        page.locator('[data-slot="prep-list"]').first(),
      ).toBeVisible();
      await captureOpsScreen(
        page,
        width,
        `legend-d983/prep-${width}-${theme}.png`,
      );
    });
  }
}

test("legend-d983 empty and error state screenshots", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.addInitScript(() => localStorage.setItem("legend-theme", "light"));
  await page.goto("/operasional/suhu?mock=empty");
  await expect(page.getByText("Belum ada pembacaan")).toBeVisible();
  await waitForSettled(page);
  await captureScreenshot(page, "legend-d983/suhu-empty-390-light.png");

  await page.goto("/operasional/label-prep?mock=error");
  await expect(page.getByText("Label prep tidak dapat dimuat")).toBeVisible();
  await waitForSettled(page);
  await captureScreenshot(page, "legend-d983/label-prep-error-390-light.png");

  await page.goto("/operasional/prep?mock=empty");
  await expect(page.getByText("Belum ada daftar prep")).toBeVisible();
  await waitForSettled(page);
  await captureScreenshot(page, "legend-d983/prep-empty-390-light.png");
});

async function waitForSettled(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(300);
}
