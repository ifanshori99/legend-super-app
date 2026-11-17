import { expect, test, type Page } from "@playwright/test";

// Inventory back office happy paths (legend-qdc) against mock mode.
// Mock mode is a web-app-only flag (VITE_API_MOCK=true) with the role cookie
// `legend-mock-role=all` as the dev default, so no API or database is needed.
// PRD v1.7 §16 "Lokasi Stok" and "Item Bahan & Satuan"; INV-01 for the
// transfer's paired ledger rows.
//
// Run with `pnpm test:e2e:mock` (playwright.mock.config.ts owns the server).

const KOPI = "00000000-0000-4000-8000-000000007101";

/**
 * Vite compiles a route on its first request and React hydrates after the
 * streamed HTML arrives, so Playwright's actionability checks can run before
 * an input or button has a live handler. Waiting for React's props on a
 * rendered node is the reliable "interactive" signal: server HTML has none.
 */
async function ready(page: Page) {
  await page.waitForFunction(
    () => {
      const main = document.querySelector("main");
      if (!main) return false;
      const nodes = [
        main,
        ...Array.from(main.querySelectorAll("input, button, a")),
      ];
      return nodes.some((node) =>
        Object.keys(node).some((key) => key.startsWith("__reactProps$")),
      );
    },
    { timeout: 20_000 },
  );
}

test.describe("legend-qdc · inventory back office", () => {
  test("F16 Item Bahan & Satuan: list, search and edit an item", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto("/kelola/inventori?mock=normal");
    await ready(page);
    await expect(
      page.getByRole("heading", { name: "Inventori" }).first(),
    ).toBeVisible();
    await expect(page.getByText("Kopi Arabika Gayo").first()).toBeVisible();

    await page.getByLabel("Cari").fill("matcha");
    await expect(page.getByText("Matcha Powder").first()).toBeVisible();
    await expect(page.getByText("Kopi Arabika Gayo").first()).toBeHidden();
    await page.getByLabel("Cari").fill("");

    await page.goto(`/kelola/inventori/${KOPI}?mock=normal`);
    await ready(page);
    await expect(
      page.getByRole("heading", { name: "Ubah item bahan" }),
    ).toBeVisible();
    await expect(page.getByLabel("Nama item")).toHaveValue("Kopi Arabika Gayo");
    await page.getByLabel("Par minimum").fill("5");
    await page.getByLabel("Par maksimum").fill("20");
    await page.getByRole("button", { name: "Simpan item" }).click();
    await expect(page.getByText("Item tersimpan.").first()).toBeVisible();
    await expect(page.getByLabel("Par minimum")).toHaveValue("5");

    expect(errors).toEqual([]);
  });

  test("F16 Item Bahan & Satuan: create an item with its base unit", async ({
    page,
  }) => {
    await page.goto("/kelola/inventori/baru?mock=normal");
    await ready(page);
    await page.getByLabel("Nama item").fill("Gula Kelapa");
    await page.getByLabel("Kategori").fill("Sirup & Gula");
    await page.getByRole("button", { name: "Simpan item" }).click();
    await expect(page.getByText("Item dibuat.").first()).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Ubah item bahan" }),
    ).toBeVisible();
    await expect(page.getByLabel("Nama item")).toHaveValue("Gula Kelapa");

    // Client navigation keeps the mock runtime's state.
    await page.getByRole("link", { name: "Kembali ke daftar item" }).click();
    await page.getByLabel("Cari").fill("gula kelapa");
    await expect(page.getByText("Gula Kelapa").first()).toBeVisible();
  });

  test("F16 satuan: catalog and a per-item conversion", async ({ page }) => {
    await page.goto("/kelola/inventori/satuan?mock=normal");
    await ready(page);
    await expect(
      page.getByRole("heading", { name: "Daftar satuan" }),
    ).toBeVisible();
    await expect(page.getByText("Kilogram").first()).toBeVisible();

    // Air Mineral already has l → ml; add kg → g (the form defaults).
    await page.getByLabel("Faktor").fill("1000");
    await page.getByRole("button", { name: "Tambah konversi" }).click();
    await expect(page.getByText("Konversi ditambahkan.").first()).toBeVisible();
    const row = page
      .getByRole("row")
      .filter({
        has: page.getByRole("cell", { name: "kg — Kilogram", exact: true }),
      })
      .first();
    await expect(row).toBeVisible();
    await expect(row).toContainText("1.000");

    await page
      .getByRole("button", {
        name: "Hapus konversi kg — Kilogram ke g — Gram",
      })
      .click();
    await expect(page.getByText("Konversi dihapus.").first()).toBeVisible();
  });

  test("F16 bahan alternatif: add and remove a substitute", async ({
    page,
  }) => {
    await page.goto(`/kelola/inventori/${KOPI}?mock=normal`);
    await ready(page);
    await expect(page.getByText("Bahan alternatif").first()).toBeVisible();
    await expect(page.getByText("Kopi Arabika Toraja").first()).toBeVisible();

    await page.getByRole("button", { name: "Tambah alternatif" }).click();
    await expect(
      page.getByText("Bahan alternatif ditambahkan.").first(),
    ).toBeVisible();
    await expect(page.getByText("Prioritas 0").first()).toBeVisible();

    await page
      .getByRole("button", { name: /Hapus bahan alternatif/ })
      .last()
      .click();
    await expect(
      page.getByText("Bahan alternatif dihapus.").first(),
    ).toBeVisible();
  });

  test("F16 Lokasi Stok: create and deactivate a location", async ({
    page,
  }) => {
    await page.goto("/kelola/inventori/lokasi?mock=normal");
    await ready(page);
    await expect(page.getByText("Gudang Utama").first()).toBeVisible();

    await page.getByRole("button", { name: "Tambah lokasi" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Nama lokasi").fill("Gudang Kering");
    await dialog.getByRole("button", { name: "Simpan lokasi" }).click();
    await expect(page.getByText("Lokasi dibuat.").first()).toBeVisible();
    await expect(page.getByText("Gudang Kering").first()).toBeVisible();

    const row = page
      .getByRole("row")
      .filter({ hasText: "Gudang Kering" })
      .first();
    await row.getByRole("button", { name: /Nonaktifkan/ }).click();
    await expect(page.getByText("Lokasi tersimpan.").first()).toBeVisible();
    await expect(row.getByText("Nonaktif")).toBeVisible();
  });

  test("F16 + INV-01 transfer: move stock between two locations", async ({
    page,
  }) => {
    await page.goto("/kelola/inventori/transfer?mock=normal");
    await ready(page);
    await expect(
      page.getByRole("heading", { name: "Transfer antarlokasi" }),
    ).toBeVisible();
    await expect(page.getByText("Gudang Utama").first()).toBeVisible();

    await page.getByRole("link", { name: "Transfer baru" }).first().click();
    await expect(
      page.getByRole("heading", { name: "Transfer baru" }),
    ).toBeVisible();

    await page.getByLabel("Jumlah").fill("1");
    await page.getByRole("button", { name: "Tambah baris" }).click();
    await expect(
      page.getByRole("row").filter({ hasText: "Air Mineral" }).first(),
    ).toBeVisible();

    await page.getByRole("button", { name: "Simpan transfer" }).click();
    await expect(page.getByText("Transfer tersimpan.").first()).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Transfer antarlokasi" }),
    ).toBeVisible();
    const first = page.getByRole("row").nth(1);
    await expect(first).toContainText("Air Mineral");
  });

  test("F16 states: empty and error render honest feedback", async ({
    page,
  }) => {
    await page.goto("/kelola/inventori?mock=empty");
    await ready(page);
    await expect(page.getByText("Belum ada item bahan")).toBeVisible();

    await page.goto("/kelola/inventori?mock=error");
    await ready(page);
    await expect(page.getByText("Data tidak dapat dimuat")).toBeVisible({
      timeout: 15_000,
    });
  });
});
