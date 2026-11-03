// WS-06 supplier screens (bead legend-xjb; PRD v1.7 §3 F18 "Supplier").
// Runs against the mock-mode web server (no API, no database):
// `pnpm test:e2e:mock`. Screenshots go through e2e/screenshots.ts and only
// reach docs/design/screenshots when LEGEND_CAPTURE_SCREENSHOTS=1.
import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";

const baseURL =
  process.env.LEGEND_MOCK_WEB_URL ?? process.env.E2E_MOCK_BASE_URL;

test.skip(
  !baseURL,
  "Mock runner not started: use pnpm test:e2e:mock (playwright.mock.config.ts).",
);
test.use({ baseURL });

// CV Kopi Priangan (packages/shared/src/inventory/purchasing/fixtures.ts).
const SUPPLIER_ID = "00000000-0000-4000-8000-000000008101";
const LIST_PATH = "/kelola/pengadaan/supplier";
const DETAIL_PATH = `${LIST_PATH}/${SUPPLIER_ID}`;

async function open(page: Page, path: string) {
  await page.goto(path, { waitUntil: "networkidle" });
  // v3: the management topbar owns the area h1; the body shows sections as h2.
  await expect(
    page.getByRole("heading", { level: 1, name: "Pengadaan" }),
  ).toBeVisible();
}

/** A server-rendered control drops a click that lands before hydration. */
async function retry(action: () => Promise<void>) {
  await expect(action).toPass({ timeout: 15_000 });
}

test("F18 supplier list shows contact, terms, catalog count, rating and state", async ({
  page,
}) => {
  await open(page, LIST_PATH);
  await expect(
    page.getByRole("heading", { name: "Daftar supplier" }),
  ).toBeVisible();

  const row = page
    .getByRole("row")
    .filter({ hasText: "CV Kopi Priangan" })
    .first();
  await expect(row).toContainText("Asep Hidayat");
  await expect(row).toContainText("628112233445");
  await expect(row).toContainText("14 hari");
  // Two unique inventory items in the catalog (three price rows, one per
  // effective date): the count is items, not history rows.
  await expect(row.getByText("2", { exact: true })).toBeVisible();
  // The rating is a manual 1-5 label, never a colour-only badge.
  await expect(row).toContainText("Baik · 4 dari 5");
  await expect(row).toContainText("Aktif");
});

test("F18 search narrows the list and a row opens the supplier detail", async ({
  page,
}) => {
  await open(page, LIST_PATH);
  const search = page.getByRole("searchbox", { name: "Cari supplier" });
  await retry(async () => {
    await search.fill("kemasan");
    await expect(page.getByText("PT Kemasan Nusantara")).toBeVisible({
      timeout: 1000,
    });
  });
  await expect(page.getByText("CV Kopi Priangan")).toHaveCount(0);

  await retry(async () => {
    await search.fill("");
    await expect(page.getByText("CV Kopi Priangan")).toBeVisible({
      timeout: 1000,
    });
  });
  await page.getByRole("link", { name: "Buka CV Kopi Priangan" }).click();
  await expect(page).toHaveURL(new RegExp(SUPPLIER_ID));
  await expect(
    page.getByRole("heading", { name: "CV Kopi Priangan", level: 2 }),
  ).toBeVisible();
});

test("F18 detail shows profile, contacts, terms, catalog, price history and performance", async ({
  page,
}) => {
  await open(page, DETAIL_PATH);
  await expect(
    page.getByRole("heading", { name: "CV Kopi Priangan", level: 2 }),
  ).toBeVisible();

  const profile = page.getByRole("region", { name: "Profil" });
  await expect(profile).toContainText("Jl. Braga No. 42, Bandung");
  await expect(profile).toContainText("14 hari");
  await expect(profile).toContainText("Baik · 4 dari 5");

  const contacts = page.getByRole("region", { name: "Kontak" });
  await expect(contacts).toContainText("Asep Hidayat");
  await expect(contacts).toContainText("Dewi Rosdiana");
  await expect(contacts).toContainText("Utama");

  const terms = page.getByRole("region", { name: "Syarat pembayaran" });
  await expect(terms).toContainText("14 hari");

  // One row per inventory item: the latest price supersedes the older one.
  const catalog = page.getByRole("region", { name: "Katalog harga" });
  await expect(catalog).toContainText("Kopi Arabika Gayo");
  await expect(catalog).toContainText("Gula Aren");
  await expect(catalog).toContainText(/185\.000/);
  await expect(catalog).toContainText(/24\.000/);

  const history = page.getByRole("region", { name: "Riwayat harga" });
  await expect(history).toContainText("Naik 7,56%");
  await expect(history).toContainText("Harga awal");

  const performance = page.getByRole("region", { name: "Performa" });
  await expect(performance).toContainText("100%");
  await expect(performance).toContainText("2 dari 2 penerimaan");
  await expect(performance).toContainText("0%");
});

test("F18 creates a supplier from the list dialog", async ({ page }) => {
  await open(page, LIST_PATH);
  const dialog = page.getByRole("dialog");
  await retry(async () => {
    await page.getByRole("button", { name: "Tambah supplier" }).first().click();
    await expect(
      dialog.getByRole("heading", { name: "Tambah supplier" }),
    ).toBeVisible({ timeout: 1000 });
  });

  await dialog.getByLabel("Nama supplier").fill("CV Uji Coba");
  await dialog.getByLabel("Nomor telepon").fill("628120000001");
  await dialog.getByLabel("Termin pembayaran (hari)").fill("10");
  await dialog.getByRole("button", { name: "Simpan supplier" }).click();

  await expect(page.getByText("Supplier ditambahkan").first()).toBeVisible();
  // Mock-only gap: listSuppliers is owned by features/ws06-purchasing/mock.ts
  // and reads the fixtures, so the new supplier is not in the table until the
  // real API arrives. The dialog success is the contract evidence here.
  await expect(dialog).toHaveCount(0);
});

test("F18 adds a contact and a catalog price from the detail", async ({
  page,
}) => {
  await open(page, DETAIL_PATH);

  const contactDialog = page.getByRole("dialog");
  await retry(async () => {
    await page.getByRole("button", { name: "Tambah kontak" }).click();
    await expect(
      contactDialog.getByRole("heading", { name: "Tambah kontak" }),
    ).toBeVisible({ timeout: 1000 });
  });
  await contactDialog.getByLabel("Nama kontak").fill("Budi Santoso");
  await contactDialog.getByLabel("Nomor telepon").fill("628120000002");
  await contactDialog.getByRole("button", { name: "Simpan kontak" }).click();
  await expect(page.getByText("Kontak ditambahkan").first()).toBeVisible();
  // getSupplier is store-backed, so the new contact shows after invalidation.
  await expect(
    page.getByRole("region", { name: "Kontak" }).getByText("Budi Santoso"),
  ).toBeVisible();

  const catalogDialog = page.getByRole("dialog");
  await retry(async () => {
    await page.getByRole("button", { name: "Tambah item katalog" }).click();
    await expect(
      catalogDialog.getByRole("heading", { name: "Tambah item katalog" }),
    ).toBeVisible({ timeout: 1000 });
  });
  await catalogDialog.getByRole("combobox", { name: "Item inventori" }).click();
  await page.getByRole("option", { name: "Kopi Arabika Gayo" }).click();
  await catalogDialog.getByLabel("Harga per satuan (Rp)").fill("190000");
  await catalogDialog.getByRole("button", { name: "Simpan harga" }).click();
  await expect(
    page.getByText("Item katalog ditambahkan").first(),
  ).toBeVisible();
  // The create response is appended to the catalog cache, so the new price is
  // visible immediately (today's effective date supersedes the fixture price).
  await expect(
    page.getByRole("region", { name: "Katalog harga" }).getByText(/190\.000/),
  ).toBeVisible();
  // Mock-only gap (reported): listSupplierCatalog is owned by
  // features/ws06-purchasing/mock.ts and stays fixture-backed, so a reload
  // drops the created row again; only the real API persists it.
});

test("F18 empty and error states are reachable in mock mode", async ({
  page,
}) => {
  await page.goto(`${LIST_PATH}?mock=empty`, { waitUntil: "networkidle" });
  await expect(page.getByText("Belum ada supplier")).toBeVisible();

  await page.goto(`${LIST_PATH}?mock=error`, { waitUntil: "networkidle" });
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Coba lagi" }).first(),
  ).toBeVisible();

  await page.goto(`${DETAIL_PATH}?mock=empty`, { waitUntil: "networkidle" });
  await expect(page.getByText("Supplier tidak ditemukan")).toBeVisible();

  await page.goto(`${DETAIL_PATH}?mock=error`, { waitUntil: "networkidle" });
  await expect(
    page.getByText("Data supplier tidak dapat dimuat"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Coba lagi" }).first(),
  ).toBeVisible();
});

for (const width of [390, 1440]) {
  for (const theme of ["light", "dark"]) {
    test(`F18 supplier screens visual ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (value) => localStorage.setItem("legend-theme", value),
        theme,
      );
      await open(page, LIST_PATH);
      await expect(
        page.getByRole("heading", { name: "Daftar supplier" }),
      ).toBeVisible();
      await captureScreenshot(
        page,
        theme === "light"
          ? `legend-xjb/suppliers-${width}.png`
          : `legend-xjb/suppliers-${width}-dark.png`,
      );

      await open(page, DETAIL_PATH);
      await expect(
        page.getByRole("heading", { name: "CV Kopi Priangan", level: 2 }),
      ).toBeVisible();
      await captureScreenshot(
        page,
        theme === "light"
          ? `legend-xjb/supplier-detail-${width}.png`
          : `legend-xjb/supplier-detail-${width}-dark.png`,
      );
    });
  }
}
