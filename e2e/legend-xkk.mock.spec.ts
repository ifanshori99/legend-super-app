// WS-06 receiving, supplier invoice/three-way match, returns and petty cash
// (bead legend-xkk; PRD v1.7 §3 F18 "Alur Pengadaan, Pembelian Sederhana,
// Retur Pembelian", INV-05). Runs against the mock-mode web server only:
// `pnpm test:e2e:mock e2e/legend-xkk.mock.spec.ts` — no API, no database.
// Screenshots go through e2e/screenshots.ts and land in test-results unless
// LEGEND_CAPTURE_SCREENSHOTS=1.
import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";

const baseURL =
  process.env.LEGEND_MOCK_WEB_URL ?? process.env.E2E_MOCK_BASE_URL;

test.skip(
  !baseURL,
  "Mock runner not started: use pnpm test:e2e:mock (playwright.mock.config.ts).",
);
test.use({ baseURL });

async function open(page: Page, path: string) {
  await page.goto(path, { waitUntil: "networkidle" });
  // v3: the management topbar owns the area h1; the body shows the section.
  await expect(
    page.getByRole("heading", { level: 1, name: "Pengadaan" }),
  ).toBeVisible();
}

/** Server-rendered controls drop a click that lands before hydration. */
async function retry(action: () => Promise<void>) {
  await expect(action).toPass({ timeout: 15_000 });
}

async function captureBoth(
  page: Page,
  name: string,
  options: { fullPage?: boolean } = {},
) {
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, `legend-xkk/${name}-390.png`, options);
  await page.setViewportSize({ width: 1440, height: 900 });
  await captureScreenshot(page, `legend-xkk/${name}-1440.png`, options);
}

test("INV-05 penerimaan menampilkan QC dan hanya jumlah lolos yang masuk stok", async ({
  page,
}) => {
  await open(page, "/kelola/pengadaan/penerimaan");
  await expect(
    page.getByRole("heading", { name: "Penerimaan barang" }),
  ).toBeVisible();
  const table = page.getByRole("table");
  await expect(table.getByText("GR/BDG/2026/11/0019")).toBeVisible();
  await expect(table.getByText("PT Kemasan Nusantara").first()).toBeVisible();

  await captureBoth(page, "receiving-list");

  // INV-05: the receipt stores received and QC-rejected; the accepted
  // quantity (received − rejected) is what entered stock.
  await retry(async () => {
    await page
      .getByRole("row", { name: /GR\/BDG\/2026\/11\/0019/ })
      .getByRole("button", { name: "Lihat rincian" })
      .click();
    await expect(
      page.getByRole("heading", { name: /Rincian penerimaan/ }),
    ).toBeVisible({ timeout: 1000 });
  });
  const dialog = page.getByRole("dialog");
  const cupRow = dialog.getByRole("row", { name: /Cup 16oz/ });
  await expect(cupRow).toContainText("4 pcs");
  await expect(cupRow).toContainText("1 pcs");
  await expect(cupRow).toContainText("3 pcs");
});

test("INV-05 form penerimaan menolak jumlah di atas sisa PO lalu menyimpan", async ({
  page,
}) => {
  await open(page, "/kelola/pengadaan/penerimaan");
  await retry(async () => {
    await page.getByRole("link", { name: "Terima barang" }).click();
    await expect(
      page.getByRole("heading", { name: "Terima barang" }),
    ).toBeVisible({ timeout: 1000 });
  });
  await expect(
    page.getByText("Ringkasan penerimaan", { exact: true }),
  ).toBeVisible();
  // The PO detail drives the line cards; capture them, not the skeleton.
  await expect(page.getByLabel("Diterima sekarang").first()).toBeVisible();

  const received = page.getByLabel("Diterima sekarang").first();
  const submitted = page.getByRole("button", { name: "Simpan penerimaan" });
  // The default PO line has 8 kg remaining; 9 is rejected before the API.
  await received.fill("9");
  await captureBoth(page, "receiving-form", { fullPage: false });
  await submitted.click();
  await expect(
    page.getByText("Jumlah diterima baik melebihi sisa pesanan."),
  ).toBeVisible();

  await received.fill("1");
  await page
    .locator('input[type="file"]')
    .setInputFiles("apps/web/demo/sample/menu/croissant-mentega.jpg");
  const photo = page.getByRole("img", { name: /Pratinjau foto/ });
  await expect(photo).toBeVisible();
  await expect(photo).toHaveAttribute("src", /^blob:/);
  await expect(submitted).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await photo.scrollIntoViewIfNeeded();
  await captureScreenshot(page, "legend-uaoli/receiving-uploaded-390.png");
  await page.setViewportSize({ width: 1280, height: 900 });
  await photo.scrollIntoViewIfNeeded();
  await captureScreenshot(page, "legend-uaoli/receiving-uploaded-1280.png");
  await submitted.click();
  await expect(page).toHaveURL(/\/kelola\/pengadaan\/penerimaan$/);
  // Inline notice plus a toast carry the same sentence; either is proof.
  await expect(page.getByText("Penerimaan tersimpan.").first()).toBeVisible();
  await expect(page.getByText(/GR\/MOCK\//)).toBeVisible();
});

test("INV-05 3-way match menampilkan selisih per baris sebelum dicatat", async ({
  page,
}) => {
  await open(page, "/kelola/pengadaan/faktur");
  await expect(
    page.getByRole("heading", { name: "Faktur supplier" }),
  ).toBeVisible();

  await retry(async () => {
    await page
      .getByRole("row", { name: /KN\/2026\/11\/0031/ })
      .getByRole("button", { name: "Lihat rincian" })
      .click();
    await expect(
      page.getByRole("heading", { name: /Faktur KN\/2026\/11\/0031/ }),
    ).toBeVisible({ timeout: 1000 });
  });
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "3-way match" }),
  ).toBeVisible();
  // PRD §3.18: both discrepancies are visible before the match is recorded.
  await expect(
    dialog.getByText("Qty faktur melebihi penerimaan").first(),
  ).toBeVisible();
  await expect(
    dialog.getByText("Harga di luar toleransi").first(),
  ).toBeVisible();
  await expect(dialog.getByText(/200 basis poin/).first()).toBeVisible();
  await expect(
    dialog.getByText("Pembayaran hanya bisa diajukan setelah faktur cocok"),
  ).toBeVisible();

  await captureBoth(page, "invoice-match");

  const note = dialog.getByLabel("Catatan match");
  await note.fill("Harga cup naik dan qty menyusul penerimaan berikutnya.");
  await dialog.getByRole("button", { name: "Jalankan match" }).click();
  await expect(
    page.getByText("Hasil 3-way match dicatat.", { exact: true }),
  ).toBeVisible();
});

test("F18 pembayaran supplier memakai approver lain dan pembelian kecil dibatasi policy", async ({
  page,
}) => {
  await open(page, "/kelola/pengadaan/faktur");
  await retry(async () => {
    await page
      .getByRole("row", { name: /INV\/KP\/2026\/0914/ })
      .getByRole("button", { name: "Lihat rincian" })
      .click();
    await expect(
      page.getByRole("heading", { name: /Faktur INV\/KP\/2026\/0914/ }),
    ).toBeVisible({ timeout: 1000 });
  });
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Menunggu persetujuan")).toBeVisible();
  await retry(async () => {
    await dialog.getByRole("button", { name: "Setujui" }).click();
    await expect(page.getByText("Pembayaran disetujui.").first()).toBeVisible({
      timeout: 2000,
    });
  });
  await expect(dialog.getByText("Disetujui").first()).toBeVisible();
  await page.keyboard.press("Escape");

  await open(page, "/kelola/pengadaan/kecil");
  await expect(
    page.getByRole("heading", { name: "Pembelian kecil", exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText(/500\.000/).first()).toBeVisible();
  const form = page.getByRole("dialog");
  await retry(async () => {
    await page.getByRole("button", { name: "Pembelian kecil" }).click();
    // The modal hides the page from the accessibility tree, so this heading
    // is the form's title, not the list's.
    await expect(
      form.getByRole("heading", { name: "Pembelian kecil", exact: true }),
    ).toBeVisible({ timeout: 1000 });
  });
  const amount = form.getByLabel("Nominal (Rp)");
  await amount.fill("600000");
  await expect(
    form.getByText(/Nominal melebihi batas Rp\s?500\.000 per transaksi/),
  ).toBeVisible();
  await expect(
    form.getByRole("button", { name: "Simpan pembelian" }),
  ).toBeDisabled();

  await amount.fill("285000");
  await form.getByLabel("Vendor / pasar").fill("Pasar Cihapit");
  await form
    .getByLabel("Deskripsi belanja")
    .fill("Daun pandan dan jeruk nipis");
  await form
    .locator('input[type="file"]')
    .setInputFiles("apps/web/demo/sample/menu/croissant-mentega.jpg");
  await expect(form.getByRole("img", { name: /Pratinjau foto/ })).toBeVisible();
  await expect(
    form.getByRole("img", { name: /Pratinjau foto/ }),
  ).toHaveAttribute("src", /^blob:/);
  await expect(
    form.getByRole("button", { name: "Simpan pembelian" }),
  ).toBeEnabled();
  await captureBoth(page, "petty-form");
  await form.getByRole("button", { name: "Simpan pembelian" }).click();
  await expect(page.getByText("Pembelian kecil tersimpan.")).toBeVisible();
  await expect(page.getByText("Pasar Cihapit").first()).toBeVisible();
});

test("F18 retur pembelian tidak melebihi jumlah diterima baik", async ({
  page,
}) => {
  await open(page, "/kelola/pengadaan/retur");
  await expect(
    page.getByRole("heading", { name: "Retur pembelian" }),
  ).toBeVisible();
  await retry(async () => {
    await page.getByRole("button", { name: "Buat retur" }).click();
    await expect(
      page.getByRole("heading", { name: "Buat retur pembelian" }),
    ).toBeVisible({ timeout: 1000 });
  });
  const dialog = page.getByRole("dialog");
  const quantity = dialog.getByLabel("Jumlah retur").first();
  // A complete form: the reason is required before the quantity is checked.
  await dialog.getByRole("combobox", { name: "Alasan retur" }).click();
  await page.getByRole("option", { name: "Rusak" }).click();
  await quantity.fill("13");
  await dialog.getByRole("button", { name: "Simpan retur" }).click();
  await expect(
    dialog.getByText("Jumlah retur melebihi jumlah diterima baik."),
  ).toBeVisible();

  await quantity.fill("1");
  await dialog.getByRole("button", { name: "Simpan retur" }).click();
  await expect(
    page.getByText("Retur tersimpan.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/RET\/MOCK\//)).toBeVisible();
});

test("F18 penerimaan dan faktur punya state kosong dan error", async ({
  page,
}) => {
  await page.goto("/kelola/pengadaan/penerimaan?mock=empty");
  await expect(page.getByText("Belum ada penerimaan barang")).toBeVisible();

  await page.goto("/kelola/pengadaan/faktur?mock=error");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Coba lagi" }).first(),
  ).toBeVisible();
});

// Dark mode evidence (DESIGN.md §1 warm dark) for the phone-first form.
for (const width of [390, 1440]) {
  test(`INV-05 receiving form captures in dark mode at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.addInitScript(() =>
      localStorage.setItem("legend-theme", "dark"),
    );
    await open(page, "/kelola/pengadaan/penerimaan/baru");
    await expect(
      page.getByRole("heading", { name: "Terima barang" }),
    ).toBeVisible();
    await expect(page.getByLabel("Diterima sekarang").first()).toBeVisible();
    // Viewport only: the sticky summary would otherwise paint over the lines.
    await captureScreenshot(
      page,
      `legend-xkk/receiving-form-${width}-dark.png`,
      {
        fullPage: false,
      },
    );
  });
}
