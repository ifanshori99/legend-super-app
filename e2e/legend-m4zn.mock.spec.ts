// WS-07 AP/AR, fixed assets and budgets (bead legend-m4zn; PRD v1.7 §3.19
// "Utang & Piutang", "Aset Tetap", "Anggaran").
//
// Mock-mode spec: it runs against the web dev server with VITE_API_MOCK=true
// that `pnpm test:e2e:mock` starts (playwright.mock.config.ts) — no API, no
// database. Without LEGEND_MOCK_WEB_URL every test skips, so `pnpm test:e2e`
// (production build, mock compiled out) never fails on it.
import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";

const base = process.env.LEGEND_MOCK_WEB_URL;

test.describe.configure({ timeout: 60_000 });

test.skip(
  !base,
  "Set LEGEND_MOCK_WEB_URL to a web server running VITE_API_MOCK.",
);

async function open(page: Page, path: string) {
  await page.goto(`${base}${path}?mock=normal`, { waitUntil: "networkidle" });
  // v3 (legend-vvth): the management topbar owns the page h1.
  await expect(
    page.getByRole("heading", { name: "Akuntansi", level: 1 }),
  ).toBeVisible({ timeout: 30_000 });
}

test.describe("F19 utang, aset and anggaran", () => {
  test("F19-Utang: the aging screen switches payable to receivable and expands a counterparty", async ({
    page,
  }) => {
    await open(page, "/kelola/akuntansi/piutang-utang");
    await expect(
      page.getByRole("heading", { name: "Kartu utang" }),
    ).toBeVisible();
    await expect(page.getByText(/8\.725\.000/).first()).toBeVisible();

    await page.getByRole("radio", { name: "Piutang" }).click();
    await expect(
      page.getByRole("heading", { name: "Kartu piutang" }),
    ).toBeVisible();
    await expect(page.getByText(/6\.500\.000/).first()).toBeVisible();

    await page
      .getByRole("button", { name: /Rincian Komunitas Lari Bandung/ })
      .filter({ visible: true })
      .click();
    await expect(
      page.getByText("Rincian kelompok umur").filter({ visible: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByText("Belum jatuh tempo").filter({ visible: true }).first(),
    ).toBeVisible();
  });

  test("F19-Aset: register an asset, then dispose it and see the gain", async ({
    page,
  }) => {
    await open(page, "/kelola/akuntansi/aset-tetap");
    await expect(
      page.getByRole("heading", { name: "Aset tetap" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Daftarkan aset" }).first().click();
    const form = page.getByRole("dialog");
    await form.getByLabel("Nama aset").fill("Mesin uji E2E F19");
    await form.getByLabel("Tanggal perolehan").fill("2026-11-03");
    await form.getByLabel("Harga perolehan").fill("12.000.000");
    await form.getByLabel("Nilai residu").fill("0");
    await form.getByLabel("Masa manfaat (bulan)").fill("12");
    await form.getByLabel("Mulai disusutkan").fill("2026-11");
    await form.getByRole("button", { name: "Simpan aset" }).click();

    await expect(
      page.getByText("Aset tersimpan.", { exact: true }).first(),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("row").filter({ hasText: "Mesin uji E2E F19" }),
    ).toBeVisible();

    await page
      .getByRole("button", { name: "Buka detail Mesin uji E2E F19" })
      .click();
    const detail = page.getByRole("dialog");
    await expect(
      detail.getByRole("heading", { name: "Mesin uji E2E F19" }),
    ).toBeVisible();
    await detail.getByRole("button", { name: "Jual/Lepas" }).click();
    await detail.getByLabel("Tanggal pelepasan").fill("2026-11-05");
    await detail.getByLabel("Hasil penjualan").fill("15000000");
    await detail.getByLabel("Alasan pelepasan").fill("Uji pelepasan E2E F19");
    // 15.000.000 proceeds − 12.000.000 carrying amount.
    await expect(
      detail.getByText("Hasil pelepasan", { exact: true }),
    ).toBeVisible();
    await expect(detail.getByText(/3\.000\.000/)).toBeVisible();
    await detail.getByRole("button", { name: "Lepas aset" }).click();

    await expect(
      page.getByText("Aset dilepas.", { exact: true }).first(),
    ).toBeVisible({ timeout: 15_000 });
    await expect(detail.getByText("Dilepas").first()).toBeVisible();
    await expect(detail.getByText("Laba pelepasan")).toBeVisible();
    await expect(detail.getByText(/3\.000\.000/)).toBeVisible();
  });

  test("F19-Anggaran: set a budget and see the variance against posted actuals", async ({
    page,
  }) => {
    await open(page, "/kelola/akuntansi/anggaran");
    await expect(page.getByRole("heading", { name: "Anggaran" })).toBeVisible();

    await page.getByRole("button", { name: "Atur anggaran" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("6109 · Beban Pemasaran").fill("5000000");
    await dialog.getByRole("button", { name: "Simpan anggaran" }).click();

    await expect(
      page.getByText("Anggaran tersimpan.", { exact: true }).first(),
    ).toBeVisible({ timeout: 15_000 });
    const row = page.getByRole("row").filter({ hasText: "Beban Pemasaran" });
    await expect(row).toBeVisible();
    await expect(row.getByText("Di bawah anggaran")).toBeVisible();
    await expect(row.getByText(/5\.000\.000/).first()).toBeVisible();
  });

  test("F19: empty and error states offer a way forward", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(`${base}/kelola/akuntansi/anggaran?mock=empty`, {
      waitUntil: "networkidle",
    });
    await expect(
      page.getByText("Belum ada anggaran untuk periode ini"),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByRole("button", { name: "Atur anggaran" }),
    ).toBeVisible();
    await captureScreenshot(page, "legend-m4zn/anggaran-390-empty.png");

    await page.goto(`${base}/kelola/akuntansi/anggaran?mock=error`, {
      waitUntil: "networkidle",
    });
    await expect(page.getByText("Data tidak dapat dimuat")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();
    await captureScreenshot(page, "legend-m4zn/anggaran-390-error.png");
  });
});

const SCREENS = [
  {
    path: "/kelola/akuntansi/piutang-utang",
    name: "aging",
    heading: "Kartu utang",
  },
  {
    path: "/kelola/akuntansi/aset-tetap",
    name: "assets",
    heading: "Aset tetap",
  },
  { path: "/kelola/akuntansi/anggaran", name: "anggaran", heading: "Anggaran" },
] as const;

for (const width of [390, 1440]) {
  for (const theme of ["light", "dark"]) {
    test(`F19 visual ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (value) => localStorage.setItem("legend-theme", value),
        theme,
      );
      for (const screen of SCREENS) {
        await page.goto(`${base}${screen.path}?mock=normal`, {
          waitUntil: "networkidle",
        });
        await expect(
          page.getByRole("heading", { name: screen.heading }),
        ).toBeVisible({ timeout: 30_000 });
        await captureScreenshot(
          page,
          `legend-m4zn/${screen.name}-${width}-${theme}.png`,
        );
      }
    });
  }
}
