// WS-03 menu bulk import and printable menu (bead legend-b6r; PRD v1.7 §3 F8,
// §8 "Impor Massal" / "Menu Cetak Otomatis"). Runs against the mock-mode web
// server: `pnpm test:e2e:mock e2e/legend-b6r.mock.spec.ts`.
//
// Every navigation after the first import MUST be a client-side link: the mock
// store lives in the page runtime, so `page.goto` would reseed it and hide the
// rows the test just created.
import { readFile } from "node:fs/promises";
import { expect, test, type Download, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";

// Mock mode only (playwright.mock.config.ts sets both env names); a normal
// `pnpm test:e2e` run has no mock server and skips this spec.
const baseURL =
  process.env.LEGEND_MOCK_WEB_URL ?? process.env.E2E_MOCK_BASE_URL;

test.skip(
  !baseURL,
  "Mock runner not started: use pnpm test:e2e:mock (playwright.mock.config.ts).",
);
test.use({ baseURL });

const HEADER =
  "category,name,description,type,priceIdr,station,course,labels,allergens";

function csv(...rows: string[]): string {
  return [HEADER, ...rows].join("\r\n");
}

async function openImport(page: Page) {
  await page.goto("/kelola/menu/impor", { waitUntil: "networkidle" });
  // v3: the management topbar owns the h1 (nav label "Menu").
  await expect(
    page.getByRole("heading", { level: 1, name: "Menu" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Impor massal menu" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Pilih file CSV" }),
  ).toBeVisible();
  // XLSX is deferred (legend-az32): the picker offers CSV only.
  await expect(page.locator('input[type="file"]')).toHaveAttribute(
    "accept",
    ".csv,text/csv",
  );
}

async function uploadCsv(page: Page, name: string, content: string) {
  // A change event that lands before hydration is lost; retry until the
  // preview heading proves React processed the file.
  await retry(async () => {
    await page.locator('input[type="file"]').setInputFiles({
      name,
      mimeType: "text/csv",
      buffer: Buffer.from(content, "utf8"),
    });
    await expect(
      page.getByRole("heading", { name: "Pratinjau validasi" }),
    ).toBeVisible({ timeout: 1000 });
  });
}

/**
 * Server-rendered controls drop a click that lands before hydration; retry
 * until React owns the control (same pattern as e2e/legend-vxj.mock.spec.ts).
 */
async function retry(action: () => Promise<void>) {
  await expect(action).toPass({ timeout: 15_000 });
}

test("F8 import template downloads the nine-column CSV and preview lists per-row validation errors", async ({
  page,
}) => {
  await openImport(page);

  let downloaded: Download | undefined;
  await retry(async () => {
    const pending = page.waitForEvent("download", { timeout: 2000 });
    await page.getByRole("button", { name: "Unduh template CSV" }).click();
    downloaded = await pending;
  });
  expect(downloaded).toBeDefined();
  if (downloaded === undefined) throw new Error("download was not started");
  const download = downloaded;
  expect(download.suggestedFilename()).toBe("template-impor-menu.csv");
  const path = await download.path();
  expect(path).not.toBeNull();
  if (path) {
    const content = (await readFile(path, "utf8")).replace(/^\uFEFF/, "");
    expect(content.split(/\r?\n/)[0]).toBe(
      "category,name,description,type,priceIdr,station,course,labels,allergens",
    );
  }

  await uploadCsv(
    page,
    "pratinjau-impor.csv",
    csv(
      // 1 valid, 3 invalid rows: every field rule surfaces under its row.
      "Kopi,Latte Uji Valid,,single,25000,Kopi,drink,baru,Susu",
      "Kopi,Latte Uji Tipe,,c,25000,Kopi,drink,,",
      "Kopi,,Tanpa Nama,single,25000,Kopi,drink,,",
      "Tidak Ada,Teh Uji,,single,dua puluh,Kopi,drink,,",
      // A decimal is never silently read as thousands dots (12.5 ≠ 125).
      "Kopi,Latte Uji Desimal,,single,12.5,Kopi,drink,,",
    ),
  );

  const strip = page.getByRole("region", { name: "Ringkasan pratinjau" });
  await expect(strip).toBeVisible();
  await expect(strip.getByText("Total baris")).toBeVisible();
  await expect(strip.getByText("5", { exact: true })).toBeVisible();
  await expect(strip.getByText("1", { exact: true })).toBeVisible();
  await expect(strip.getByText("4", { exact: true })).toBeVisible();

  await expect(
    page.getByText("Tipe harus single atau combo (Item tunggal atau Paket)."),
  ).toBeVisible();
  await expect(page.getByText("Nama wajib diisi.")).toBeVisible();
  await expect(
    page.getByText(/Kategori "Tidak Ada" tidak ditemukan/),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Harga harus bilangan bulat rupiah tanpa tanda baca, misalnya 25000.",
    ),
  ).toHaveCount(2);

  // Only the one valid row is offered to the commit.
  await expect(
    page.getByRole("button", { name: "Impor 1 baris" }),
  ).toBeVisible();

  for (const width of [390, 1440] as const) {
    await page.setViewportSize({ width, height: 900 });
    await captureScreenshot(
      page,
      `legend-b6r/import-preview-errors-${width}.png`,
    );
  }
});

test("F8 import commits valid rows as drafts and appends their prices", async ({
  page,
}) => {
  await openImport(page);
  await uploadCsv(
    page,
    "impor-dua-baris.csv",
    csv(
      "Kopi,Latte Impor Uji A,Latte impor uji,single,27500,Kopi,drink,baru,Susu",
      "Nonkopi,Teh Impor Uji B,,single,22500,Nonkopi,drink,,",
    ),
  );

  // The preview proves React owns the file input, so a single click is safe.
  await page.getByRole("button", { name: "Impor 2 baris" }).click();
  await expect(page.getByRole("heading", { name: "Hasil impor" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByText("2 dari 2 baris dibuat sebagai draf, 0 gagal."),
  ).toBeVisible();
  const resultsCard = page
    .locator('[data-slot="card"]')
    .filter({ hasText: "Hasil impor" });
  await expect(resultsCard.getByText("Latte Impor Uji A")).toBeVisible();
  await expect(resultsCard.getByText("Teh Impor Uji B")).toBeVisible();

  // Q23: imported items are drafts — the item list shows them hidden and
  // without a photo. Client-side link keeps the mock store alive.
  await page.getByRole("link", { name: "Lihat daftar item" }).click();
  await expect(
    page.getByRole("heading", { name: "Daftar item" }),
  ).toBeVisible();
  const search = page.getByRole("searchbox", { name: "Cari nama item…" });
  await search.fill("Latte Impor Uji A");
  const row = page.getByRole("row").filter({ hasText: "Latte Impor Uji A" });
  await expect(row.first()).toBeVisible();
  await expect(row.first().getByText("Disembunyikan")).toBeVisible();
  await expect(row.first().getByText("Foto wajib")).toBeVisible();

  // The price grid holds the imported price AND every existing entry: the
  // commit sent the union, not just the new rows.
  await page.getByRole("link", { name: "Harga", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Harga per kanal" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Atur harga" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const dialog = page.getByRole("dialog");
  const priceSearch = dialog.getByRole("searchbox", { name: "Cari item…" });
  await priceSearch.fill("Latte Impor Uji A");
  await expect(
    dialog.getByRole("spinbutton", { name: "Latte Impor Uji A" }),
  ).toHaveValue("27500");
  await priceSearch.fill("Espresso");
  await expect(
    dialog.getByRole("spinbutton", { name: "Espresso" }),
  ).toHaveValue("20000");
  await dialog.getByRole("button", { name: "Batal" }).click();

  // Drafts never reach the guest-facing printable menu.
  await page.getByRole("link", { name: "Cetak", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Menu cetak" })).toBeVisible();
  await expect(page.getByText("Latte Impor Uji A")).toHaveCount(0);
  await expect(page.getByText("Teh Impor Uji B")).toHaveCount(0);
  await expect(
    page.getByText("Espresso", { exact: true }).first(),
  ).toBeVisible();
});

test("F8 printable menu renders categories, prices and large print", async ({
  page,
}) => {
  await page.goto("/kelola/menu/cetak", { waitUntil: "networkidle" });
  await expect(
    page.getByRole("heading", { level: 1, name: "Menu" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Menu cetak" })).toBeVisible();

  // Active items only, grouped in display order, price from the dine-in list.
  await expect(
    page.getByRole("heading", { level: 3, name: "Kopi", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 3, name: "Nonkopi", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 3, name: "Dapur" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 3, name: "Pastry" }),
  ).toBeVisible();
  await expect(
    page.locator('.menu-print-sheet data[value="20000"]').first(),
  ).toBeVisible();
  // Owner note 12: menu prices exclude tax and service; the sheet says so.
  await expect(
    page
      .locator("article[data-print-size]")
      .getByText("Harga belum termasuk pajak dan service charge."),
  ).toBeVisible();
  // Q23: every printed item carries its photo.
  await expect(
    page.locator('article [data-slot="media-plate"] img').first(),
  ).toBeVisible();

  // The button opens the browser print dialog; no server PDF is involved.
  await page.evaluate(() => {
    window.print = () => {
      document.body.dataset.printCalled = "1";
    };
  });
  await page.getByRole("button", { name: "Cetak / Simpan PDF" }).click();
  await expect
    .poll(() => page.evaluate(() => document.body.dataset.printCalled))
    .toBe("1");

  for (const width of [390, 1440] as const) {
    await page.setViewportSize({ width, height: 900 });
    await retry(async () => {
      await page.getByRole("radio", { name: "Normal" }).click();
      await expect(
        page.locator('article[data-print-size="normal"]'),
      ).toBeVisible({ timeout: 1000 });
    });
    await captureScreenshot(page, `legend-b6r/print-normal-${width}.png`);
    await retry(async () => {
      await page.getByRole("radio", { name: "Besar" }).click();
      await expect(
        page.locator('article[data-print-size="large"]'),
      ).toBeVisible({ timeout: 1000 });
    });
    await captureScreenshot(page, `legend-b6r/print-large-${width}.png`);
  }

  // Empty menu: the sheet is replaced by an honest empty state.
  await page.goto("/kelola/menu/cetak?mock=empty", {
    waitUntil: "networkidle",
  });
  await expect(page.getByText("Belum ada item aktif")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Cetak / Simpan PDF" }),
  ).toBeDisabled();
});

test("F8 XLSX upload asks for a CSV instead of faking a preview", async ({
  page,
}) => {
  await openImport(page);
  await retry(async () => {
    await page.locator('input[type="file"]').setInputFiles({
      name: "menu.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: Buffer.from("PK\u0003\u0004", "utf8"),
    });
    await expect(
      page.getByText(/File XLSX belum bisa dibaca langsung/),
    ).toBeVisible({ timeout: 1000 });
  });
  await expect(
    page.getByText(/File XLSX belum bisa dibaca langsung/),
  ).toBeVisible();
  await expect(
    page.getByText(/Simpan sebagai \/ Unduh sebagai CSV/),
  ).toBeVisible();
  // No preview or commit is offered for an unparsed file.
  await expect(
    page.getByRole("button", { name: /Impor \d+ baris/ }),
  ).toHaveCount(0);
});

// Dark mode evidence (DESIGN.md §1 warm dark): a dark-mode preview must stay
// legible, and the print stylesheet forces the light paper palette.
for (const width of [390, 1440]) {
  test(`F8 printables capture in dark mode at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() =>
      localStorage.setItem("legend-theme", "dark"),
    );
    await page.goto("/kelola/menu/cetak", { waitUntil: "networkidle" });
    await expect(
      page.getByRole("heading", { name: "Menu cetak" }),
    ).toBeVisible();
    await captureScreenshot(page, `legend-b6r/print-normal-${width}-dark.png`);
  });
}
