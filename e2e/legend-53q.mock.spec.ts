// WS-07 cash & bank and gateway reconciliation (bead legend-53q; PRD v1.7
// §3.19 "Kas & Bank [P0]" and "Rekonsiliasi Gateway [P0]"; ACC-04 "rekonsiliasi
// bank dan gateway mencapai ≥ 99% kecocokan otomatis; setiap selisih menjadi
// kasus dengan PIC", ACC-05 "setiap setoran kas tercatat dan dicocokkan dengan
// mutasi; kas yang belum disetor melewati batas hari memicu peringatan").
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

/**
 * The Cafe Legend banking fixtures (@starter/shared/accounting fixtures.ts)
 * live in November 2026: the last cash collection and the unmatched
 * "SETORAN TUNAI BDG-02" line are on 3 November, and the mock's 30 October
 * cash is past the two-day deposit policy on that day. Every screen defaults
 * to "today" / "this month" (deposits list, ACC-05 alerts, match window), so
 * the browser clock is pinned to midday of that business date (WIB) and the
 * spec passes on any wall-clock month. setFixedTime only fixes Date; timers
 * keep running.
 */
const FIXTURE_DATE = "2026-11-03";
const FIXTURE_NOW = new Date(`${FIXTURE_DATE}T12:00:00.000+07:00`);
const PERIOD_FROM = `${FIXTURE_DATE.slice(0, 7)}-01`;
const PERIOD_TO = `${FIXTURE_DATE.slice(0, 7)}-30`;

/**
 * Opens the cash & bank screen at the fixture instant and pins the match
 * workspace to the fixture month.
 */
async function openCashBank(page: Page) {
  await page.clock.setFixedTime(FIXTURE_NOW);
  await page.goto("/kelola/akuntansi/kas-bank?mock=normal");
  await page.waitForLoadState("networkidle");
  // v3 (legend-vvth): the management topbar owns the page h1.
  await expect(
    page.getByRole("heading", { name: "Akuntansi", level: 1 }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole("heading", { name: "Ruang cocok mutasi" }),
  ).toBeVisible();
  await page.getByLabel("Dari tanggal").fill(PERIOD_FROM);
  await page.getByLabel("Sampai tanggal").fill(PERIOD_TO);
  await expect(
    page
      .getByRole("row")
      .filter({ hasText: "TRSF E-BANKING CR DOIT SETTLEMENT" }),
  ).toBeVisible();
}

/**
 * Drives the CSV wizard to the preview step: choose the file, keep the
 * detected mapping, and stop before importing.
 */
async function previewCsv(page: Page, csv: string, fileName: string) {
  await page.getByRole("button", { name: "Impor mutasi" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Impor mutasi rekening (CSV)" }),
  ).toBeVisible();
  await dialog.getByLabel("Berkas CSV").setInputFiles({
    name: fileName,
    mimeType: "text/csv",
    buffer: Buffer.from(csv),
  });
  await expect(dialog.getByText(`Berkas dipilih: ${fileName}`)).toBeVisible();
  // The file is read asynchronously; wait until its text reached the textarea
  // before asking the wizard to detect the mapping.
  await expect(dialog.getByLabel("Atau tempel isi CSV")).toHaveValue(csv);
  await dialog.getByRole("button", { name: "Lanjut" }).click();
  await expect(dialog.getByText(/Petakan kolom CSV/)).toBeVisible();
  await dialog.getByRole("button", { name: "Lanjut" }).click();
  await expect(dialog.getByText("1 baris siap diimpor")).toBeVisible();
  return dialog;
}

async function importCsv(page: Page, csv: string, fileName: string) {
  const dialog = await previewCsv(page, csv, fileName);
  await dialog.getByRole("button", { name: "Impor 1 baris" }).click();
}

test.describe("cash & bank", () => {
  test("ACC-04: the CSV import wizard maps, previews and imports an auto-matched line", async ({
    page,
  }) => {
    await openCashBank(page);

    // A transfer out of the bank for the October electricity bill: the open
    // journal of the same amount one day earlier is the single candidate.
    const csv = [
      "Tanggal,Keterangan,Referensi,Debit,Kredit",
      '01/11/2026,TRANSFER LISTRIK OKTOBER,TRF-OKT-1,"2.350.000,00",',
    ].join("\n");
    await importCsv(page, csv, "mutasi-e2e.csv");

    await expect(
      page
        .getByText(/Impor selesai: 1 baris, 0 duplikat, 1 cocok otomatis\./)
        .first(),
    ).toBeVisible({ timeout: 15_000 });

    const imported = page
      .getByRole("row")
      .filter({ hasText: "TRANSFER LISTRIK OKTOBER" });
    await expect(imported).toBeVisible({ timeout: 15_000 });
    await expect(imported.getByText("Cocok otomatis")).toBeVisible();
  });

  test("ACC-04: a statement line is matched by suggestion and unmatched again", async ({
    page,
  }) => {
    await openCashBank(page);

    // The deposit journal of 2 November is the single candidate, so the import
    // matches automatically; the test then unmatches and matches it by hand.
    const csv = [
      "Tanggal,Keterangan,Referensi,Debit,Kredit",
      '02/11/2026,TRANSFER MASUK UJI,TRF-UJI-2,,"137.500,00"',
    ].join("\n");
    await importCsv(page, csv, "mutasi-cocok.csv");
    await expect(page.getByText(/Impor selesai: 1 baris/).first()).toBeVisible({
      timeout: 15_000,
    });

    const imported = page
      .getByRole("row")
      .filter({ hasText: "TRANSFER MASUK UJI" });
    await expect(imported).toBeVisible();
    await expect(imported.getByText("Cocok otomatis")).toBeVisible();

    // Unmatch: the line returns to "Belum cocok" and suggests the same journal.
    await imported.getByRole("button", { name: "Lepas" }).click();
    const confirm = page.getByRole("dialog");
    await expect(
      confirm.getByRole("heading", { name: "Lepas pencocokan?" }),
    ).toBeVisible();
    await confirm.getByRole("button", { name: "Lepas" }).click();
    await expect(page.getByText("Pencocokan dilepas.").first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(imported.getByText("Belum cocok")).toBeVisible();

    // The suggestion is the contract matcher, not a guess: one candidate.
    await expect(
      imported.getByText(/Saran: Jurnal · 2 Nov 2026/),
    ).toBeVisible();
    await imported.getByRole("button", { name: "Cocokkan" }).click();
    await expect(page.getByText("Pencocokan tersimpan.").first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(imported.getByText("Cocok manual")).toBeVisible();

    // A second unmatch leaves the line ready to be matched again.
    await imported.getByRole("button", { name: "Lepas" }).click();
    const unmatch = page.getByRole("dialog");
    await expect(
      unmatch.getByRole("heading", { name: "Lepas pencocokan?" }),
    ).toBeVisible();
    await unmatch.getByRole("button", { name: "Lepas" }).click();
    await expect(imported.getByText("Belum cocok")).toBeVisible({
      timeout: 15_000,
    });
  });

  test("ACC-05: a cash deposit is recorded and matched with the bank statement", async ({
    page,
  }) => {
    await openCashBank(page);

    // The toolbar action and the empty-state action share the same label.
    await page.getByRole("button", { name: "Catat setoran" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Catat setoran kas" }),
    ).toBeVisible();
    await dialog.getByLabel("Nominal setoran").fill("250000");
    await dialog.getByLabel("Kas mulai tanggal").fill(FIXTURE_DATE);
    await dialog.getByLabel("Kas sampai tanggal").fill(FIXTURE_DATE);
    await dialog.getByLabel("Waktu setor").fill(`${FIXTURE_DATE}T10:30`);
    await dialog.getByLabel("Nomor bukti setor").fill("SLIP-E2E-1");
    await dialog.getByRole("button", { name: "Simpan setoran" }).click();

    await expect(page.getByText("Setoran kas tercatat.").first()).toBeVisible({
      timeout: 15_000,
    });
    const deposit = page.getByRole("row").filter({ hasText: "SLIP-E2E-1" });
    await expect(deposit).toBeVisible({ timeout: 15_000 });
    await expect(deposit.getByText("Cocok dengan mutasi")).toBeVisible();
  });

  test("ACC-04: an unmatched statement line opens a reconciliation case with a PIC", async ({
    page,
  }) => {
    await openCashBank(page);

    const feeLine = page
      .getByRole("row")
      .filter({ hasText: "BIAYA MATERAI KARTU" });
    await expect(feeLine.getByText("Belum cocok")).toBeVisible();
    await feeLine.getByRole("button", { name: "Buat kasus" }).click();

    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Buat kasus rekonsiliasi" }),
    ).toBeVisible();
    await expect(dialog.getByLabel("PIC")).toBeVisible();
    await dialog.getByRole("button", { name: "Buka kasus" }).click();

    await expect(
      page.getByText("Kasus rekonsiliasi dibuka.").first(),
    ).toBeVisible({ timeout: 15_000 });
    await expect(feeLine.getByText("Dalam kasus")).toBeVisible({
      timeout: 15_000,
    });
  });

  test("ACC-05: cash undeposited past the tenant day limit shows the warning band", async ({
    page,
  }) => {
    await openCashBank(page);

    await expect(
      page.getByText("Kas belum disetor melewati batas").first(),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Setorkan kas berikut ke bank. Peringatan muncul setelah kas melewati batas hari yang ditetapkan.",
      ),
    ).toBeVisible();
    // The mock seeds 30 October cash with no deposit for the outlet.
    await expect(
      page.getByText(/Cafe Legend Bandung · kas .* hari/),
    ).toBeVisible();
    await expect(
      page.getByText("Kas belum disetor", { exact: true }).first(),
    ).toBeVisible();
  });
});

for (const width of [390, 1440]) {
  for (const theme of ["light", "dark"]) {
    test(`legend-53q visual ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (value) => localStorage.setItem("legend-theme", value),
        theme,
      );
      await openCashBank(page);
      await captureScreenshot(page, `legend-53q/${width}-${theme}.png`);
    });
  }
}

for (const scenario of ["empty", "error"]) {
  test(`legend-53q visual ${scenario}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.clock.setFixedTime(FIXTURE_NOW);
    await page.goto(`/kelola/akuntansi/kas-bank?mock=${scenario}`, {
      waitUntil: "networkidle",
    });
    await expect(
      page
        .getByText(
          scenario === "error"
            ? "Data tidak dapat dimuat"
            : "Belum ada rekening bank",
        )
        .first(),
    ).toBeVisible({ timeout: 30_000 });
    await captureScreenshot(page, `legend-53q/390-${scenario}.png`);
  });
}
