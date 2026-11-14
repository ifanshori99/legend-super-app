// WS-06 supplier invoice entry (bead legend-0xnm; PRD v1.7 §3.18 three-way
// match, §4 Alur I step 4, §3.19 PPN masukan / PPh 23). Mock-mode web server
// only: `pnpm test:e2e:mock e2e/legend-0xnm.mock.spec.ts`, no API, no database.
//
// Money rule under test: the user types PPN / PPh 23 exactly as printed; the
// web shows NO total before saving. After saving, every figure in the match
// preview is the API's own (mock = contract helpers), shown as returned.
//
// Assumptions (spec silent): PO/BDG/2026/10/0042 (kopi, 12 + 5 accepted, one
// earlier invoice already bills those 12 kg + 5 kg) is the fixture used. A
// second invoice for the same goods is therefore a "Qty faktur melebihi
// penerimaan" discrepancy, and goods = 12 x 185.000 + 5 x 24.000 = 2.340.000.
// Screenshots land in test-results unless LEGEND_CAPTURE_SCREENSHOTS=1.
import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";

const baseURL =
  process.env.LEGEND_MOCK_WEB_URL ?? process.env.E2E_MOCK_BASE_URL;

test.skip(
  !baseURL,
  "Mock runner not started: use pnpm test:e2e:mock (playwright.mock.config.ts).",
);
test.use({ baseURL });

const NEW_INVOICE = "/kelola/pengadaan/faktur/baru";
const PO_KOPI = "PO/BDG/2026/10/0042";

async function open(page: Page, path: string) {
  await page.goto(path, { waitUntil: "networkidle" });
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
  await captureScreenshot(page, `legend-0xnm/${name}-390.png`, options);
  await page.setViewportSize({ width: 1280, height: 900 });
  await captureScreenshot(page, `legend-0xnm/${name}-1280.png`, options);
}

/** The form is ready once the PO's lines (with their quantities) have loaded. */
async function openForm(page: Page) {
  await open(page, NEW_INVOICE);
  await expect(
    page.getByRole("heading", { name: "Catat faktur supplier" }),
  ).toBeVisible();
  await expect(page.getByLabel("Jumlah ditagih").first()).toBeVisible();
}

async function choosePurchaseOrder(page: Page) {
  const trigger = page.getByRole("combobox", { name: "Purchase order" });
  const option = page.getByRole("option", {
    name: new RegExp(PO_KOPI.replaceAll("/", "\\/")),
  });
  // Open the list only while it is closed: a click on an open trigger would
  // close it again and make the retry flip-flop.
  await retry(async () => {
    if (!(await option.isVisible())) await trigger.click();
    await option.click({ timeout: 1000 });
  });
  await expect(page.getByLabel("Jumlah ditagih").first()).toBeVisible();
}

async function fillHeader(page: Page, number: string) {
  await page.getByLabel("Nomor faktur").fill(number);
  await page.getByLabel("Tanggal faktur").fill("2026-11-10");
  // Invoice date drives the default due date; set the due date last.
  await page.getByLabel("Jatuh tempo").fill("2026-11-24");
}

test("legend-0xnm F18 catat faktur dari PO, simpan sekali, lalu pratinjau 3-way match memakai angka API", async ({
  page,
}) => {
  await openForm(page);
  await choosePurchaseOrder(page);

  // Defaults come from the PO and the QC-accepted receipt, as editable text.
  await expect(page.getByLabel("Jumlah ditagih")).toHaveCount(2);
  await expect(page.getByLabel("Jumlah ditagih").first()).toHaveValue("12");
  await expect(page.getByLabel("Jumlah ditagih").nth(1)).toHaveValue("5");
  await expect(page.getByText("Kopi Arabika Gayo").first()).toBeVisible();
  await expect(page.getByText("Gula Aren").first()).toBeVisible();

  await fillHeader(page, "FK-0XNM-001");
  await page.getByLabel("PPN masukan (Rp)").fill("257400");
  await page.getByLabel("PPh 23 (Rp)").fill("0");

  // The web must not show a total, tax base or payable before the API did.
  await expect(page.getByText("Pratinjau 3-way match")).toHaveCount(0);
  await expect(page.getByText(/2\.597\.400/)).toHaveCount(0);
  await expect(page.getByText(/2\.340\.000/)).toHaveCount(0);
  await captureBoth(page, "form-filled", { fullPage: false });

  // A double click must book one invoice: the button is busy / the request
  // carries one idempotency key.
  await page.getByRole("button", { name: "Simpan faktur" }).dblclick();

  await expect(
    page.getByRole("heading", { name: "Pratinjau 3-way match" }),
  ).toBeVisible();
  await expect(page.getByText("Angka dari server")).toBeVisible();
  // Figures are the API's: goods at PO price, the typed PPN, and the total.
  await expect(page.getByText(/2\.340\.000/).first()).toBeVisible();
  await expect(page.getByText(/257\.400/).first()).toBeVisible();
  await expect(page.getByText(/2\.597\.400/).first()).toBeVisible();
  // The earlier invoice already bills the whole accepted receipt.
  await expect(
    page.getByText("Qty faktur melebihi penerimaan").first(),
  ).toBeVisible();
  // Next steps: an unpaid invoice waits for its match in the list.
  await expect(
    page.getByRole("heading", { name: /menunggu match/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Catat faktur lain" }),
  ).toBeVisible();
  await captureBoth(page, "match-preview");

  await page.getByRole("link", { name: "Lihat daftar faktur" }).click();
  await expect(page).toHaveURL(/\/kelola\/pengadaan\/faktur$/);
  await expect(
    page.getByRole("heading", { name: "Faktur supplier" }),
  ).toBeVisible();
  // Exactly one invoice was booked.
  await expect(page.getByRole("row", { name: /FK-0XNM-001/ })).toHaveCount(1);
});

test("legend-0xnm F18 'Catat faktur lain' mulai form kosong", async ({
  page,
}) => {
  await openForm(page);
  await choosePurchaseOrder(page);
  await fillHeader(page, "FK-0XNM-002");
  await page.getByLabel("PPN masukan (Rp)").fill("0");
  await page.getByRole("button", { name: "Simpan faktur" }).click();
  await expect(
    page.getByRole("heading", { name: "Pratinjau 3-way match" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Catat faktur lain" }).click();
  await expect(
    page.getByRole("heading", { name: "Catat faktur supplier" }),
  ).toBeVisible();
  await expect(page.getByLabel("Nomor faktur")).toHaveValue("");
  await expect(page.getByText("Pratinjau 3-way match")).toHaveCount(0);
});

test("legend-0xnm F18 isian tidak valid ditolak di kolomnya dan tidak menyimpan faktur", async ({
  page,
}) => {
  await openForm(page);

  // Empty invoice number: the field says so, nothing is saved.
  await page.getByRole("button", { name: "Simpan faktur" }).click();
  await expect(
    page.getByText("Nomor faktur wajib diisi.").first(),
  ).toBeVisible();
  await expect(page.getByText("Pratinjau 3-way match")).toHaveCount(0);

  // Due date before the invoice date.
  await page.getByLabel("Nomor faktur").fill("FK-0XNM-003");
  await page.getByLabel("Tanggal faktur").fill("2026-11-10");
  await page.getByLabel("Jatuh tempo").fill("2026-11-09");
  await page.getByRole("button", { name: "Simpan faktur" }).click();
  await expect(
    page.getByText("Jatuh tempo tidak boleh sebelum tanggal faktur."),
  ).toBeVisible();

  // Tax typed as text with decimals is refused, not rounded.
  await page.getByLabel("Jatuh tempo").fill("2026-11-24");
  await page.getByLabel("PPN masukan (Rp)").fill("1,5");
  await page.getByRole("button", { name: "Simpan faktur" }).click();
  await expect(
    page.getByText("Isi angka rupiah bulat, tanpa desimal."),
  ).toBeVisible();
  await captureBoth(page, "form-errors", { fullPage: false });
  await expect(page.getByText("Pratinjau 3-way match")).toHaveCount(0);

  // A line left out of the invoice is not sent; with none left it is refused.
  await page.getByLabel("PPN masukan (Rp)").fill("0");
  for (const checkbox of await page.getByRole("checkbox").all())
    await checkbox.uncheck();
  await page.getByRole("button", { name: "Simpan faktur" }).click();
  await expect(
    page.getByText("Pilih minimal satu baris untuk faktur.").first(),
  ).toBeVisible();
});

test("legend-0xnm F18 daftar faktur punya tombol 'Catat faktur' menuju form", async ({
  page,
}) => {
  await open(page, "/kelola/pengadaan/faktur");
  await retry(async () => {
    await page.getByRole("link", { name: "Catat faktur", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Catat faktur supplier" }),
    ).toBeVisible({ timeout: 1000 });
  });
  await expect(page).toHaveURL(/\/kelola\/pengadaan\/faktur\/baru$/);
});

test("legend-0xnm F18 form faktur punya state kosong dan error", async ({
  page,
}) => {
  await page.goto(`${NEW_INVOICE}?mock=empty`);
  await expect(
    page.getByText("Belum ada PO yang bisa difakturkan"),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Ke penerimaan barang" }),
  ).toBeVisible();

  await page.goto(`${NEW_INVOICE}?mock=error`);
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Coba lagi" }).first(),
  ).toBeVisible();
});
