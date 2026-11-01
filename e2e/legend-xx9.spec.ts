import { expect, test } from "@playwright/test";

// Menu back office happy path (legend-xx9, legend-dpe) against mock mode.
// Mock mode is a web-app-only build flag (VITE_API_MOCK=true) with the role
// cookie `legend-mock-role=all` as the default, so no API or database is
// needed. Run with a web server started as:
//   VITE_API_MOCK=true pnpm --filter @starter/web dev --port 3315
// and WEB_URL=http://localhost:3315 pnpm exec playwright test e2e/legend-xx9.spec.ts

const ITEM_ID = "00000000-0000-4000-8000-000000001000"; // Espresso, fixtures
const NAV = { waitUntil: "networkidle" as const };

test.describe("legend-xx9 · menu back office", () => {
  test("F8 Struktur Menu + Konten Menu: list, filter, edit content", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto("/kelola/menu?mock=normal", NAV);
    await expect(
      page.getByRole("heading", { name: "Master menu" }),
    ).toBeVisible();
    await expect(page.getByText("Espresso").first()).toBeVisible();

    await page.getByLabel("Cari").fill("matcha");
    await expect(page.getByText("Matcha Latte").first()).toBeVisible();
    await expect(page.getByText("Espresso").first()).toBeHidden();
    await page.getByLabel("Cari").fill("");

    await page.goto(`/kelola/menu/${ITEM_ID}?mock=normal`, NAV);
    const name = page.getByLabel("Nama item");
    await expect(name).toHaveValue("Espresso");
    await page.getByLabel("Deskripsi").fill("Espresso ganda, biji lokal.");
    await page.getByRole("button", { name: "Simpan item" }).click();
    await expect(
      page.getByText("Perubahan item tersimpan.").first(),
    ).toBeVisible();

    await page.getByRole("tab", { name: "Varian" }).click();
    // Scope to the table: the section hint also mentions "Panas".
    await expect(
      page.getByRole("cell", { name: "Panas", exact: true }),
    ).toBeVisible();
    await page.getByRole("tab", { name: "Modifier" }).click();
    await expect(
      page.getByRole("cell", { name: "Tingkat gula", exact: true }),
    ).toBeVisible();

    expect(errors).toEqual([]);
  });

  test("F8 Struktur Menu: create a category with display order", async ({
    page,
  }) => {
    await page.goto("/kelola/menu/kategori?mock=normal", NAV);
    // Exactly one section tab is current (review legend-cyu.12).
    const current = page
      .getByRole("navigation", { name: "Master menu" })
      .locator('a[aria-current="page"]');
    await expect(current).toHaveCount(1);
    await expect(current).toHaveText("Kategori");
    await page.getByRole("button", { name: "Tambah kategori" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByLabel("Nama kategori").fill("Mocktail");
    await page.getByRole("button", { name: "Simpan" }).click();
    await expect(page.getByText("Kategori dibuat.").first()).toBeVisible();
    await expect(page.getByText("Mocktail").first()).toBeVisible();
  });

  test("F8 Ketersediaan: 86 toggle and schedules", async ({ page }) => {
    await page.goto("/kelola/menu/ketersediaan?mock=normal", NAV);
    const row = page.getByRole("row").filter({ hasText: "Espresso" }).first();
    await row.getByRole("button", { name: "Tandai habis" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Tandai habis" })
      .click();
    await expect(
      page.getByText("Espresso ditandai habis.").first(),
    ).toBeVisible();
    await expect(row.getByText("Habis (86)")).toBeVisible();
  });

  test("F8 Harga per Kanal: edit the dine-in price grid", async ({ page }) => {
    await page.goto("/kelola/menu/harga?mock=normal", NAV);
    await page.getByRole("button", { name: "Atur harga" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Harga Dine-in")).toBeVisible();
    const price = dialog.getByLabel("Espresso");
    await price.fill("22000");
    await dialog.getByRole("button", { name: "Simpan harga" }).click();
    await expect(page.getByText("Harga tersimpan.").first()).toBeVisible();
  });

  test("F8 Paket & Combo: combo contents show a 100% allocation", async ({
    page,
  }) => {
    await page.goto("/kelola/menu/paket?mock=normal", NAV);
    await expect(page.getByText("Total alokasi 100%").first()).toBeVisible();
    await page.getByRole("button", { name: "Ubah paket" }).first().click();
    await expect(page.getByRole("dialog")).toContainText("Isi paket");
  });
});
