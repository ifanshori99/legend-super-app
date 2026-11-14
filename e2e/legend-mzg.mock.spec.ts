// WS-07 accounting back office (bead legend-mzg; PRD v1.7 §3.19 "Chart of
// Accounts", "Jurnal Otomatis", "Jurnal Manual & Berulang"; ACC-01 "Setiap
// jurnal selalu seimbang; jurnal final tidak dapat dihapus dan koreksi
// dilakukan melalui jurnal pembalik", ACC-03 "…dapat diturunkan sampai ke
// transaksi sumber").
//
// Mock-mode spec: it runs against the web dev server with VITE_API_MOCK=true
// that `pnpm test:e2e:mock` starts (playwright.mock.config.ts) — no API, no
// database. Without LEGEND_MOCK_WEB_URL every test skips, so `pnpm test:e2e`
// (production build, mock compiled out) never fails on it.
import { expect, test, type Page } from "@playwright/test";
import { cafeLegendAccountingFixtures } from "../packages/shared/src/accounting/fixtures.ts";

const base = process.env.LEGEND_MOCK_WEB_URL;

// The scenario retries a failing query a few times before the error state.
test.describe.configure({ timeout: 60_000 });

test.skip(
  !base,
  "Set LEGEND_MOCK_WEB_URL to a web server running VITE_API_MOCK.",
);

/** Named fixture entries stay stable when another seed journal is inserted. */
const INTERNET_ENTRY = cafeLegendAccountingFixtures.entries.internet.id;
const CASH_SALE_ENTRY = cafeLegendAccountingFixtures.entries.cashSale.id;
const PENDING_MANUAL = "e3000000-0000-4000-8000-000000000004";

async function open(page: Page, path: string, heading: string) {
  await page.goto(`${base}${path}`);
  // Hydration settles after load; a fill before React attaches would be wiped
  // by the first client render.
  await page.waitForLoadState("networkidle");
  // v3 (legend-vvth): the management topbar owns the page h1; the page body
  // no longer repeats it (DESIGN.md v3 §5).
  await expect(
    page.getByRole("heading", { name: heading, level: 1 }),
  ).toBeVisible();
}

/** Picks an option in a Radix select trigger by accessible option name. */
async function choose(page: Page, line: number, optionPattern: RegExp) {
  await page.getByLabel(`Akun baris ${line}`).click();
  await page.getByRole("option", { name: optionPattern }).click();
}

test.describe("accounting back office", () => {
  test("ACC-01: a manual journal must balance and is posted only after approval", async ({
    page,
  }) => {
    await open(page, "/kelola/akuntansi/jurnal-manual/baru", "Akuntansi");
    await expect(
      page.getByRole("heading", { name: "Jurnal manual baru" }),
    ).toBeVisible();

    await page.getByLabel("Keterangan").fill("Uji ACC-01 jurnal manual");
    // Row 1: an expense debit; row 2: the bank credit.
    await choose(page, 1, /6109/);
    await page.getByLabel("Debit baris 1").fill("100000");
    await choose(page, 2, /1103/);
    await page.getByLabel("Kredit baris 2").fill("50000");

    // ACC-01: saving an unbalanced journal explains the problem without saving.
    await expect(
      page.locator("form").getByText("Selisih", { exact: true }).locator(".."),
    ).toContainText(/Rp\s*50\.000/);
    await page.getByRole("button", { name: "Simpan draf" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "Jurnal belum seimbang",
    );
    await expect(page).toHaveURL(/jurnal-manual\/baru/);

    // The mock transport runs in memory, so inspect its list through the SPA
    // to prove the invalid submission did not create a draft.
    await page.getByRole("link", { name: "Kembali ke jurnal manual" }).click();
    await expect(
      page.getByRole("link", {
        name: "Akrual sewa gedung November 2026",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByText("Uji ACC-01 jurnal manual")).toHaveCount(0);
    await page.goBack();
    await page.getByLabel("Keterangan").fill("Uji ACC-01 jurnal manual");
    await choose(page, 1, /6109/);
    await page.getByLabel("Debit baris 1").fill("100000");
    await choose(page, 2, /1103/);

    await page.getByLabel("Kredit baris 2").fill("100000");
    await expect(
      page.getByText("Seimbang", { exact: true }).first(),
    ).toBeVisible();
    await page.getByRole("button", { name: "Simpan draf" }).click();

    // The draft exists but nothing is posted yet.
    await page.waitForURL(/jurnal-manual\/[0-9a-f-]{36}/);
    await expect(page.getByText("Draf", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Buka jurnal" })).toHaveCount(
      0,
    );

    await page.getByRole("button", { name: "Kirim untuk persetujuan" }).click();
    await expect(
      page.getByText("Menunggu persetujuan", { exact: true }).first(),
    ).toBeVisible();
    // AUTH-06: approval is a different person than the requester.
    await expect(
      page.getByText(/Penyetuju harus orang yang berbeda dari pemohon/),
    ).toBeVisible();

    await page.getByRole("button", { name: "Setujui dan bukukan" }).click();
    await expect(page.getByText("Terbit", { exact: true }).first()).toBeVisible(
      { timeout: 15_000 },
    );
    await expect(page.getByRole("link", { name: "Buka jurnal" })).toBeVisible();

    // The posted entry is balanced and final.
    await page.getByRole("link", { name: "Buka jurnal" }).click();
    await page.waitForURL(/jurnal\/[0-9a-f-]{36}/);
    await expect(
      page.getByText("Seimbang", { exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByText("Buka dokumen sumber")).toBeVisible();
  });

  test("ACC-03: the journal detail drills down to its source document", async ({
    page,
  }) => {
    await open(page, `/kelola/akuntansi/jurnal/${INTERNET_ENTRY}`, "Akuntansi");
    await expect(
      page.getByRole("heading", {
        name: "Tagihan internet November 2026 (koreksi)",
      }),
    ).toBeVisible();
    await expect(page.getByText("Sumber transaksi")).toBeVisible();
    await expect(page.getByText("Jurnal manual").first()).toBeVisible();
    await expect(
      page.getByText("e3000000-0000-4000-8000-000000000003"),
    ).toBeVisible();

    await page.getByRole("link", { name: "Buka dokumen sumber" }).click();
    await page.waitForURL(
      /jurnal-manual\/e3000000-0000-4000-8000-000000000003/,
    );
    await expect(
      page.getByRole("heading", {
        name: "Tagihan internet November 2026 (koreksi)",
      }),
    ).toBeVisible();
  });

  test("ACC-03: the journal list opens a journal and keeps the source type", async ({
    page,
  }) => {
    await open(page, "/kelola/akuntansi/jurnal", "Akuntansi");
    await expect(
      page.getByRole("heading", { name: "Jurnal umum" }),
    ).toBeVisible();
    await expect(page.getByText(/jurnal dimuat/)).toBeVisible();

    await page.getByRole("combobox").nth(0).click();
    await page.getByRole("option", { name: "Jurnal manual" }).click();
    const correctionLink = page.getByRole("link", {
      name: "Tagihan internet November 2026 (koreksi)",
      exact: true,
    });
    await expect(correctionLink).toBeVisible();
    await correctionLink.click();
    await page.waitForURL(/jurnal\/[0-9a-f-]{36}/);
    await expect(
      page.getByText("Seimbang", { exact: true }).first(),
    ).toBeVisible();
  });

  test("ACC-01: a posted journal is corrected with a reversing journal", async ({
    page,
  }) => {
    await open(
      page,
      `/kelola/akuntansi/jurnal/${CASH_SALE_ENTRY}`,
      "Akuntansi",
    );
    await page.getByRole("button", { name: "Balik jurnal" }).click();
    await page.getByLabel("Alasan").fill("Uji koreksi lewat jurnal pembalik");
    await page.getByRole("button", { name: "Buat jurnal pembalik" }).click();

    await expect(
      page.getByText("Pembalik", { exact: true }).first(),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText(/Jurnal pembalik tidak dapat dibalik lagi/),
    ).toBeVisible();
    // No edit or delete on a posted entry: only the reversal path.
    await expect(
      page.getByRole("button", { name: /Hapus|Ubah jurnal/ }),
    ).toHaveCount(0);
  });

  test("chart of accounts: per-entity tree, search and create", async ({
    page,
  }) => {
    await open(page, "/kelola/akuntansi", "Akuntansi");
    await expect(
      page.getByRole("heading", { name: "Bagan akun" }),
    ).toBeVisible();
    const table = page.getByRole("table");
    await expect(table.getByText("1100", { exact: true })).toBeVisible();
    await expect(table.getByText("Kas Outlet")).toBeVisible();

    await page.getByRole("searchbox").fill("6105");
    await expect(table.getByText("Beban Sewa")).toBeVisible();
    await expect(table.getByText("Kas Outlet")).toHaveCount(0);
    await page.getByRole("searchbox").fill("");

    await page.getByRole("button", { name: "Tambah akun" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Kode akun").fill("6199");
    await dialog.getByLabel("Nama akun").fill("Beban Uji E2E");
    await dialog.getByRole("button", { name: "Simpan akun" }).click();

    // The toast confirms the write; the row itself is the durable evidence.
    await expect(
      page.getByText("Akun tersimpan.", { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("table").getByText("Beban Uji E2E"),
    ).toBeVisible();
  });

  test("recurring templates: submit then approve activates the template", async ({
    page,
  }) => {
    await open(page, "/kelola/akuntansi/jurnal-berulang", "Akuntansi");
    await expect(
      page.getByRole("heading", { name: "Jurnal berulang" }),
    ).toBeVisible();
    await expect(
      page.getByRole("table").getByText("Akrual sewa kios bulanan"),
    ).toBeVisible();

    await page.getByRole("button", { name: "Tambah templat" }).click();
    await page.getByLabel("Keterangan").fill("Uji templat E2E");
    // Each line also has an outlet select; choose the account by its label.
    await choose(page, 1, /6105/);
    await page.getByLabel("Debit baris 1").fill("1000000");
    await choose(page, 2, /2101/);
    await page.getByLabel("Kredit baris 2").fill("1000000");
    await page.getByRole("button", { name: "Simpan templat" }).click();
    await expect(
      page.getByRole("table").getByText("Uji templat E2E"),
    ).toBeVisible({ timeout: 15_000 });

    await page
      .getByRole("button", { name: /Aksi templat Uji templat E2E/ })
      .click();
    await page
      .getByRole("menuitem", { name: "Kirim untuk persetujuan" })
      .click();
    await page
      .getByRole("button", { name: /Aksi templat Uji templat E2E/ })
      .click();
    await page.getByRole("menuitem", { name: "Setujui" }).click();

    const row = page.getByRole("row", { name: /Uji templat E2E/ });
    await expect(row.getByText("Aktif")).toBeVisible({ timeout: 15_000 });
  });

  test("every list has empty and error states", async ({ page }) => {
    await page.goto(`${base}/kelola/akuntansi/jurnal?mock=empty`);
    await expect(page.getByText("Belum ada jurnal")).toBeVisible();

    await page.goto(`${base}/kelola/akuntansi/jurnal?mock=error`);
    await expect(page.getByText("Data tidak dapat dimuat")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();
  });

  test("the manual journal list stacks into readable rows at 390px", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, "/kelola/akuntansi/jurnal-manual", "Akuntansi");
    await expect(
      page.getByRole("heading", { name: "Jurnal manual", exact: true }),
    ).toBeVisible();
    // The mobile row shows the status badge and the total, not a clipped table.
    await expect(page.getByText("Menunggu persetujuan").first()).toBeVisible();
    await expect(page.getByText("Rp 15.000.000").first()).toBeVisible();
    await page
      .getByRole("link", { name: /Akrual sewa gedung November 2026/ })
      .click();
    await page.waitForURL(/jurnal-manual\/[0-9a-f-]{36}/);
    await expect(
      page.getByRole("button", { name: "Setujui dan bukukan" }),
    ).toBeVisible();
  });

  test("the seeded pending journal can be approved from its detail screen", async ({
    page,
  }) => {
    await open(
      page,
      `/kelola/akuntansi/jurnal-manual/${PENDING_MANUAL}`,
      "Akuntansi",
    );
    await page.getByRole("button", { name: "Setujui dan bukukan" }).click();
    await expect(page.getByText("Terbit", { exact: true }).first()).toBeVisible(
      { timeout: 15_000 },
    );
    await expect(page.getByRole("link", { name: "Buka jurnal" })).toBeVisible();
  });
});
