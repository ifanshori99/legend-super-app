// WS-06 recipes and production batches (bead legend-w0v; PRD v1.7 §3 F17
// "Resep Bertingkat, Produksi Batch", §17, §6.E; owner Q19/Q20). Runs against
// the mock-mode web server (no API, no database): `pnpm test:e2e:mock`.
import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";

const baseURL =
  process.env.LEGEND_MOCK_WEB_URL ?? process.env.E2E_MOCK_BASE_URL;

test.skip(
  !baseURL,
  "Mock runner not started: use pnpm test:e2e:mock (playwright.mock.config.ts).",
);
test.use({ baseURL });

/** Fixture ids (packages/shared/src/inventory/fixtures.ts). */
const COLD_BREW_RECIPE_ID = "00000000-0000-4000-8000-000000007602";
const NASI_GORENG_RECIPE_ID = "00000000-0000-4000-8000-000000007603";

async function open(page: Page, path: string) {
  await page.goto(path, { waitUntil: "networkidle" });
  // v3 (legend-tqnd/legend-vvth): the management topbar owns the area h1, so
  // it sits outside #main-content; the body shows the section as an h2.
  await expect(
    page.getByRole("heading", { level: 1, name: "Inventori" }),
  ).toBeVisible();
}

/**
 * Server-rendered controls drop a click that lands before hydration. Every
 * interaction below is idempotent, so retry it until React owns the control
 * (same pattern as e2e/legend-cxj.mock.spec.ts and e2e/legend-c3lm.mock.spec.ts).
 */
async function retry(action: () => Promise<void>) {
  await expect(action).toPass({ timeout: 15_000 });
}

test("F17 recipe list shows nested recipes with yield, version and theoretical HPP", async ({
  page,
}) => {
  await open(page, "/kelola/inventori/resep");
  await expect(
    page.getByRole("heading", { name: "Daftar resep", exact: true }),
  ).toBeVisible();

  const table = page.getByRole("table");
  await expect(table.getByText("Cold Brew Legendaris")).toBeVisible();
  await expect(table.getByText("Nasi Goreng Kampung")).toBeVisible();
  // A menu recipe has no output item; a semi-finished recipe names its item.
  await expect(table.getByText("Menu", { exact: true }).first()).toBeVisible();
  await expect(
    table.getByText("Cold Brew Concentrate", { exact: true }).first(),
  ).toBeVisible();
  await expect(table.getByText("v2", { exact: true }).first()).toBeVisible();
  await expect(table.getByText(/^Rp/).first()).toBeVisible();
  await expect(table.getByText("Aktif").first()).toBeVisible();

  // The active filter narrows the list; nothing is inactive in the fixtures.
  await page.getByRole("combobox", { name: "Saring status resep" }).click();
  await page.getByRole("option", { name: "Nonaktif" }).click();
  await expect(page.getByText(/Tidak ada hasil untuk/)).toBeVisible();
});

test("F17 editor nests a semi-finished recipe and shows the converted base quantity", async ({
  page,
}) => {
  await open(page, `/kelola/inventori/resep/${COLD_BREW_RECIPE_ID}`);
  await expect(
    page.getByRole("heading", { name: "Cold Brew Legendaris" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Komponen BOM" }),
  ).toBeVisible();

  // The 60 ml of Cold Brew Concentrate converts through the output item's
  // conversions to the nested recipe's 5 l yield: 60 ml = 0,06 l.
  await expect(page.getByText("Cold Brew Concentrate").first()).toBeVisible();
  await expect(page.getByText(/0,06 l pada satuan dasar/)).toBeVisible();

  // The live total is computed from the contract line costs, not a fake zero.
  await expect(page.getByRole("heading", { name: "Total HPP" })).toBeVisible();
  await expect(page.getByText(/^Rp/).first()).toBeVisible();
});

test("F17 gross = net / (1 - waste), so 150 g net at 10% waste draws 166,6667 g", async ({
  page,
}) => {
  await open(page, `/kelola/inventori/resep/${NASI_GORENG_RECIPE_ID}`);
  await expect(page.getByText(/bruto = net ÷ \(1 − susut\)/)).toBeVisible();

  // Nasi Goreng's first line is 150 g of rice; a 10% yield loss means the
  // kitchen draws 150 ÷ 0,9 = 166,6667 g from stock (owner Q19/Q20).
  const waste = page.getByLabel("Susut (%)").first();
  await retry(async () => {
    await waste.fill("10");
    await expect(page.getByText("166,6667 g")).toBeVisible({ timeout: 1000 });
  });
});

test("F17 creates a recipe and saves the edit as a new version", async ({
  page,
}) => {
  await open(page, "/kelola/inventori/resep");
  await retry(async () => {
    await page.getByRole("button", { name: "Resep baru" }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 1000 });
  });
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Nama resep").fill("Resep Uji F17");
  await dialog.getByRole("combobox", { name: "Komponen", exact: true }).click();
  await page.getByRole("option", { name: "Kopi Arabika Gayo" }).click();
  await dialog.getByLabel("Jumlah net").fill("0.5");
  await dialog.getByRole("button", { name: "Buat dan buka editor" }).click();

  await expect(page).toHaveURL(/\/kelola\/inventori\/resep\/[0-9a-f-]+$/);
  await expect(
    page.getByRole("heading", { name: "Resep Uji F17" }),
  ).toBeVisible();
  await expect(page.getByText("Kopi Arabika Gayo").first()).toBeVisible();

  await page.getByLabel("Catatan perubahan").fill("Versi uji F17");
  await retry(async () => {
    await page
      .getByRole("button", { name: "Simpan sebagai versi baru" })
      .click();
    // The retried click can stack toasts; the first one proves the write.
    await expect(page.getByText("Versi baru tersimpan").first()).toBeVisible({
      timeout: 2000,
    });
  });
  await expect(page.getByText("v2", { exact: true })).toBeVisible();
});

test("F17 production batches move draft -> in_progress -> completed only", async ({
  page,
}) => {
  await open(page, "/kelola/inventori/produksi");
  await expect(
    page.getByRole("heading", { name: "Produksi batch", exact: true }),
  ).toBeVisible();

  const table = page.getByRole("table");
  await expect(table.getByText("Cold Brew Concentrate").first()).toBeVisible();
  await expect(table.getByText("Selesai").first()).toBeVisible();

  await retry(async () => {
    await page.getByRole("button", { name: "Produksi baru" }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 1000 });
  });
  const createDialog = page.getByRole("dialog");
  await createDialog.getByLabel("Jumlah batch").fill("2");
  await createDialog.getByRole("button", { name: "Buat perintah" }).click();
  await expect(page.getByText("Perintah produksi dibuat")).toBeVisible();

  // Newest first: the created draft is the first body row.
  const row = page.getByRole("table").getByRole("row").nth(1);
  await expect(row).toContainText("Cold Brew Concentrate");
  await expect(row.getByText("Draf", { exact: true })).toBeVisible();

  await retry(async () => {
    await row
      .getByRole("button", {
        name: "Mulai produksi Cold Brew Concentrate",
        exact: true,
      })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 1000 });
  });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Mulai produksi", exact: true })
    .click();
  await expect(row.getByText("Berjalan", { exact: true })).toBeVisible();

  await retry(async () => {
    await row
      .getByRole("button", {
        name: "Selesaikan produksi Cold Brew Concentrate",
        exact: true,
      })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 1000 });
  });
  const completeDialog = page.getByRole("dialog");
  await completeDialog.getByLabel("Hasil aktual").fill("2.1");
  await completeDialog
    .getByRole("button", { name: "Selesaikan", exact: true })
    .click();
  await expect(row.getByText("Selesai", { exact: true })).toBeVisible();
  // A completed batch offers no further transition.
  await expect(row.getByRole("button", { name: /Mulai produksi/ })).toHaveCount(
    0,
  );
  await expect(
    row.getByRole("button", { name: /Batalkan produksi/ }),
  ).toHaveCount(0);
});

test("F17 empty, error and offline states are reachable in mock mode", async ({
  page,
}) => {
  await open(page, "/kelola/inventori/resep?mock=empty");
  await expect(page.getByText("Belum ada resep")).toBeVisible();

  await open(page, "/kelola/inventori/produksi?mock=empty");
  await expect(page.getByText("Belum ada perintah produksi")).toBeVisible();

  await open(
    page,
    `/kelola/inventori/resep/${NASI_GORENG_RECIPE_ID}?mock=error`,
  );
  await expect(page.getByRole("alert")).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByRole("button", { name: "Coba lagi" }).first(),
  ).toBeVisible();

  await open(page, "/kelola/inventori/resep?mock=offline");
  await expect(page.getByText(/Anda sedang offline/)).toBeVisible({
    timeout: 20_000,
  });
});

test("F17 list, editor and production render at 390 and 1440", async ({
  page,
}) => {
  for (const width of [390, 1440] as const) {
    await page.setViewportSize({
      width,
      height: width === 390 ? 844 : 900,
    });
    await open(page, "/kelola/inventori/resep");
    await captureScreenshot(page, `legend-w0v/resep-${width}.png`);

    await open(page, `/kelola/inventori/resep/${COLD_BREW_RECIPE_ID}`);
    await captureScreenshot(page, `legend-w0v/resep-editor-${width}.png`);

    await open(page, "/kelola/inventori/produksi");
    await captureScreenshot(page, `legend-w0v/produksi-${width}.png`);
  }
});

// Dark mode evidence (DESIGN.md §1 warm dark) for the dense editor screen.
for (const width of [390, 1440]) {
  test(`F17 recipe editor captures in dark mode at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.addInitScript(() =>
      localStorage.setItem("legend-theme", "dark"),
    );
    await open(page, `/kelola/inventori/resep/${COLD_BREW_RECIPE_ID}`);
    await expect(
      page.getByRole("heading", { name: "Cold Brew Legendaris" }).first(),
    ).toBeVisible();
    await captureScreenshot(page, `legend-w0v/resep-editor-${width}-dark.png`);
  });
}
