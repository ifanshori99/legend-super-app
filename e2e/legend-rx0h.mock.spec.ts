// WS-07 financial statements and period close (bead legend-rx0h; PRD v1.7
// §3.19 "Laporan Keuangan" and "Tutup Periode"; ACC-02 "Transaksi di periode
// yang sudah ditutup ditolak kecuali periode dibuka ulang dengan approval",
// ACC-03 "Laba rugi per outlet dan per badan usaha dapat diturunkan sampai ke
// transaksi sumber").
//
// Mock-mode spec: it runs against the web dev server with VITE_API_MOCK=true
// that `pnpm test:e2e:mock` starts (playwright.mock.config.ts) — no API, no
// database. Without LEGEND_MOCK_WEB_URL every test skips, so `pnpm test:e2e`
// (production build, mock compiled out) never fails on it.
import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";

const base = process.env.LEGEND_MOCK_WEB_URL;

// The error scenario retries a failing query a few times before the error state.
test.describe.configure({ timeout: 60_000 });

test.skip(
  !base,
  "Set LEGEND_MOCK_WEB_URL to a web server running VITE_API_MOCK.",
);

/**
 * The fixture ledger is November 2026 and its business date is
 * `cafeLegendAccountingFixtures.asOf` = 2026-11-30 (the date the mock close
 * checks against); September and October are closed, November is open. The
 * browser clock is pinned there so the screens' default "current month"
 * range is November in any wall-clock month (pattern: legend-nv3y).
 */
const FIXTURE_NOW = new Date("2026-11-30T12:00:00.000+07:00");
const RANGE = { from: "2026-11-01", to: "2026-11-30" } as const;
const CLOSED_OCTOBER = { from: "2026-10-01", to: "2026-10-31" } as const;
const MOCK_ACTOR_KEY = "legend-mock-accounting-actor";
/** The corrections in the fixture: the final internet bill lands on 6106. */
const INTERNET_CORRECTION = "e1000000-0000-4000-8000-00000000000d";

async function open(page: Page, path: string) {
  await page.clock.setFixedTime(FIXTURE_NOW);
  await page.goto(`${base}${path}`);
  // Hydration settles after load; a fill before React attaches would be wiped
  // by the first client render.
  await page.waitForLoadState("networkidle");
  // v3 (legend-vvth): the management topbar owns the page h1.
  await expect(
    page.getByRole("heading", { name: "Akuntansi", level: 1 }),
  ).toBeVisible({ timeout: 30_000 });
}

/**
 * The statement screens default to the month of the business date (pinned to
 * the fixture by `open`); the explicit range keeps the assertions readable.
 */
async function pinRange(page: Page, range: { from: string; to: string }) {
  // The range clamps itself: widen with "to" first when moving later, and
  // with "from" first when moving earlier.
  if (range.from < (await page.getByLabel("Dari tanggal").inputValue())) {
    await page.getByLabel("Dari tanggal").fill(range.from);
    await page.getByLabel("Sampai tanggal").fill(range.to);
  } else {
    await page.getByLabel("Sampai tanggal").fill(range.to);
    await page.getByLabel("Dari tanggal").fill(range.from);
  }
}

async function pinNovember(page: Page) {
  await pinRange(page, RANGE);
}

const basisBadge = (page: Page, region: string, basis: string) =>
  page
    .getByRole("region", { name: region })
    .locator(`[data-slot="badge"][data-basis="${basis}"]`);

test.describe("financial statements and period close", () => {
  test("ACC-03: statement types switch and a P&L row drills down to its journal", async ({
    page,
  }) => {
    await open(page, "/kelola/akuntansi/laporan?mock=normal");
    await pinNovember(page);

    const typeControl = page.getByRole("radiogroup", {
      name: "Jenis laporan",
    });
    await expect(typeControl).toBeVisible();

    const switchTo = async (label: string) => {
      await typeControl.getByRole("radio", { name: label }).click();
      await expect(
        page.getByRole("heading", { name: label, level: 2 }),
      ).toBeVisible();
    };

    // The default statement is the P&L.
    await expect(
      page.getByRole("heading", { name: "Laba rugi", level: 2 }),
    ).toBeVisible();
    await expect(page.getByText("Laba bersih", { exact: true })).toBeVisible();

    await switchTo("Neraca");
    await expect(page.getByText("Total aset", { exact: true })).toBeVisible();

    await switchTo("Laba rugi");
    await expect(page.getByText("Laba bersih", { exact: true })).toBeVisible();

    await switchTo("Arus kas");
    await expect(
      page.getByText("Aktivitas operasi", { exact: true }),
    ).toBeVisible();

    await switchTo("Perubahan ekuitas");
    await expect(
      page.getByRole("table").getByText("Modal Disetor"),
    ).toBeVisible();

    await switchTo("Multi-entitas");
    await expect(
      page.getByRole("table").getByText("Gabungan", { exact: true }),
    ).toBeVisible();

    await switchTo("Laba rugi");

    // ACC-03: a P&L row drills down to the journal lines behind its amount.
    const statement = page.getByRole("region", { name: "Laba rugi" });
    await statement
      .getByRole("button", {
        name: "Telusuri 6106 Beban Listrik, Air dan Internet",
      })
      .click();

    const sheet = page.getByRole("dialog", {
      name: /Beban Listrik, Air dan Internet/,
    });
    await expect(sheet.getByText("Total baris")).toBeVisible();
    await expect(sheet.getByText("3 baris dimuat")).toBeVisible();
    await expect(
      sheet.getByText("Pembalik: nominal salah ketik"),
    ).toBeVisible();

    // The line links to the posted journal, where the source document is one
    // step away.
    await sheet
      .getByRole("link")
      .filter({ hasText: "Tagihan internet November 2026 (koreksi)" })
      .click();
    await page.waitForURL(
      new RegExp(`/kelola/akuntansi/jurnal/${INTERNET_CORRECTION}`),
    );
    await expect(
      page.getByRole("heading", {
        name: "Tagihan internet November 2026 (koreksi)",
      }),
    ).toBeVisible();
  });

  test("ACC-02: a closed period's snapshot is read-only and a reopen needs a reason and another approver", async ({
    page,
  }) => {
    await open(page, "/kelola/akuntansi/tutup-periode?mock=normal");

    const periods = page.getByRole("region", { name: "Periode fiskal" });
    const requests = page.getByRole("region", {
      name: "Permintaan buka ulang",
    });
    const octoberRow = periods
      .getByRole("row")
      // Anchor at the period cell: the closed-on column also holds "Okt 2026".
      .filter({ hasText: /^Okt 2026/ })
      .filter({ visible: true });
    await expect(octoberRow).toBeVisible();

    // A closed period exposes its frozen snapshot, with no editable control.
    await octoberRow.getByRole("button", { name: "Lihat snapshot" }).click();
    const snapshot = page.getByRole("dialog", {
      name: /Snapshot periode Okt 2026/,
    });
    await expect(snapshot.getByText("Saldo per akun")).toBeVisible();
    await expect(
      snapshot.getByText(/Snapshot tidak berubah selama periode tertutup/),
    ).toBeVisible();
    await expect(snapshot.getByRole("table")).toBeVisible();
    await expect(snapshot.getByRole("textbox")).toHaveCount(0);
    await expect(
      snapshot.getByRole("button", { name: /Simpan|Kirim|Ubah/ }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(snapshot).toBeHidden();

    // The open November period opens the close checklist (not submitted: a
    // close would change the fixtures the assertions above depend on).
    await periods.getByRole("button", { name: "Tutup periode" }).click();
    const closeDialog = page.getByRole("dialog", {
      name: /Tutup periode Nov 2026/,
    });
    await expect(
      closeDialog.getByText("Daftar periksa", { exact: true }),
    ).toBeVisible();
    for (const check of [
      "Periode sudah berakhir",
      "Periode sebelumnya sudah ditutup",
      "Tidak ada jurnal draf",
      "Tidak ada jurnal menunggu persetujuan",
      "Neraca saldo seimbang",
      "Snapshot saldo",
    ]) {
      await expect(closeDialog.getByText(check, { exact: true })).toBeVisible();
    }
    await expect(closeDialog.getByText(/Neraca saldo per/)).toBeVisible();
    await closeDialog.getByRole("button", { name: "Batal" }).click();
    await expect(closeDialog).toBeHidden();

    // ACC-02: the reopen request carries a reason...
    const reason = "Uji ACC-02: faktur listrik Oktober tertinggal.";
    await octoberRow.getByRole("button", { name: "Ajukan buka ulang" }).click();
    const requestDialog = page.getByRole("dialog", {
      name: "Ajukan buka ulang Okt 2026",
    });
    await requestDialog.getByLabel("Alasan buka ulang").fill(reason);
    await requestDialog
      .getByRole("button", { name: "Kirim permintaan" })
      .click();
    await expect(
      page.getByText("Permintaan buka ulang dikirim.", { exact: true }),
    ).toBeVisible({ timeout: 15_000 });

    const requestRow = requests.getByRole("row").filter({ hasText: reason });
    await expect(requestRow).toBeVisible();
    await expect(requestRow.getByText("Menunggu persetujuan")).toBeVisible();

    // ... and is approved by someone other than the requester (AUTH-06).
    await expect(
      requests.getByText(/Penyetuju harus orang yang berbeda dari pemohon/),
    ).toBeVisible();
    await requestRow.getByRole("button", { name: "Setujui" }).click();
    const approveDialog = page.getByRole("dialog", {
      name: /Setujui buka ulang Okt 2026/,
    });
    await expect(
      approveDialog.getByText(/harus berbeda dari pemohon \(AUTH-06\)/),
    ).toBeVisible();
    await approveDialog.getByRole("button", { name: "Ya, buka ulang" }).click();
    await expect(
      page.getByText("Periode Okt 2026 dibuka ulang.", { exact: true }),
    ).toBeVisible({ timeout: 15_000 });

    await expect(
      requestRow.getByText("Disetujui", { exact: true }),
    ).toBeVisible();
    await expect(
      octoberRow.getByText("Terbuka", { exact: true }),
    ).toBeVisible();
  });

  test("closed periods are labelled official, open or mixed ranges estimate", async ({
    page,
  }) => {
    await open(page, "/kelola/akuntansi/laporan?mock=normal");
    // The default range is the pinned fixture month: November, still open.
    await expect(page.getByLabel("Dari tanggal")).toHaveValue(RANGE.from);
    await expect(basisBadge(page, "Laba rugi", "estimate")).toBeVisible();
    await expect(
      page.getByRole("note").filter({ hasText: "Angka sementara (estimasi)" }),
    ).toContainText("Nov 2026");

    // October is closed: official, from the close snapshot.
    await pinRange(page, CLOSED_OCTOBER);
    await expect(basisBadge(page, "Laba rugi", "official")).toBeVisible();
    await expect(
      page
        .getByRole("note")
        .filter({ hasText: "Angka resmi dari periode tertutup" }),
    ).toContainText("Okt 2026");

    // A range spanning closed October and open November is an estimate.
    await pinRange(page, { from: "2026-10-15", to: "2026-11-15" });
    await expect(basisBadge(page, "Laba rugi", "estimate")).toBeVisible();
    await expect(
      page.getByRole("note").filter({ hasText: "Angka sementara (estimasi)" }),
    ).toContainText("Okt 2026");

    const typeControl = page.getByRole("radiogroup", { name: "Jenis laporan" });

    // Multi-entity carries the label too (every entity must be closed).
    await typeControl.getByRole("radio", { name: "Multi-entitas" }).click();
    await expect(basisBadge(page, "Multi-entitas", "estimate")).toBeVisible();
    await pinRange(page, CLOSED_OCTOBER);
    await expect(basisBadge(page, "Multi-entitas", "official")).toBeVisible();

    // Balance sheet as of the end of closed October: official and balanced.
    await typeControl.getByRole("radio", { name: "Neraca" }).click();
    await expect(basisBadge(page, "Neraca", "official")).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Neraca" })
        .getByText("Seimbang", { exact: true }),
    ).toBeVisible();
  });

  test("AUTH-06: the API refuses a reopen approval by the requester and the screen says so", async ({
    page,
  }) => {
    // Mock mode acts as one user for every write (finance), like one session.
    await page.addInitScript(
      (key) => localStorage.setItem(key, "finance"),
      MOCK_ACTOR_KEY,
    );
    await open(page, "/kelola/akuntansi/tutup-periode?mock=normal");
    const periods = page.getByRole("region", { name: "Periode fiskal" });
    const requests = page.getByRole("region", {
      name: "Permintaan buka ulang",
    });
    const octoberRow = periods
      .getByRole("row")
      .filter({ hasText: /^Okt 2026/ })
      .filter({ visible: true });

    const reason = "Uji AUTH-06: pemohon mencoba menyetujui sendiri.";
    await octoberRow.getByRole("button", { name: "Ajukan buka ulang" }).click();
    const requestDialog = page.getByRole("dialog", {
      name: "Ajukan buka ulang Okt 2026",
    });
    await requestDialog.getByLabel("Alasan buka ulang").fill(reason);
    await requestDialog
      .getByRole("button", { name: "Kirim permintaan" })
      .click();
    const requestRow = requests.getByRole("row").filter({ hasText: reason });
    await expect(requestRow).toBeVisible({ timeout: 15_000 });

    // The button is not hidden: the server is the check, not the screen.
    await requestRow.getByRole("button", { name: "Setujui" }).click();
    await page
      .getByRole("dialog", { name: /Setujui buka ulang Okt 2026/ })
      .getByRole("button", { name: "Ya, buka ulang" })
      .click();
    await expect(
      page.getByText(/tidak dapat menyetujuinya sendiri/).first(),
    ).toBeVisible({ timeout: 15_000 });
    await expect(requestRow.getByText("Menunggu persetujuan")).toBeVisible();
    await expect(
      octoberRow.getByText("Tertutup", { exact: true }),
    ).toBeVisible();
  });

  test("every statement has empty and error states", async ({ page }) => {
    await page.clock.setFixedTime(FIXTURE_NOW);
    await page.setViewportSize({ width: 390, height: 900 });

    await page.goto(`${base}/kelola/akuntansi/laporan?mock=empty`, {
      waitUntil: "networkidle",
    });
    await expect(page.getByText("Belum ada baris laporan")).toBeVisible({
      timeout: 20_000,
    });
    await captureScreenshot(page, "legend-rx0h/390-empty.png");

    await page.goto(`${base}/kelola/akuntansi/laporan?mock=error`, {
      waitUntil: "networkidle",
    });
    await expect(page.getByText("Data tidak dapat dimuat").first()).toBeVisible(
      { timeout: 20_000 },
    );
    await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();
    await captureScreenshot(page, "legend-rx0h/390-error.png");
  });
});

for (const width of [390, 1440]) {
  for (const theme of ["light", "dark"]) {
    test(`legend-rx0h visual ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (value) => localStorage.setItem("legend-theme", value),
        theme,
      );
      await open(page, "/kelola/akuntansi/laporan?mock=normal");
      await pinNovember(page);
      await expect(
        page.getByRole("heading", { name: "Laba rugi", level: 2 }),
      ).toBeVisible();
      await expect(
        page.getByText("Laba bersih", { exact: true }),
      ).toBeVisible();
      await captureScreenshot(page, `legend-rx0h/${width}-${theme}.png`);
    });
  }
}
