import { expect, test } from "@playwright/test";

// PRD v1.7 §3.18 and §4 Alur I. The purchasing API is represented by
// contract fixtures in mock mode until the integration bead lands.
const baseURL =
  process.env.LEGEND_MOCK_WEB_URL ?? process.env.E2E_MOCK_BASE_URL;
test.skip(!baseURL, "Run against a VITE_API_MOCK=true web server.");
test.use({ baseURL });

test("PRD §3.18 / Alur I: request, approve, create a PO and generate a sample share link", async ({
  page,
}) => {
  await page.goto("/kelola/pengadaan?mock=normal");
  await expect(page.getByRole("heading", { name: "Pengadaan" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Daftar permintaan" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Buat permintaan" }).click();
  await page.getByLabel("Bahan").click();
  await page.getByRole("option").first().click();
  await page.getByLabel("Jumlah").fill("2");
  await page.getByLabel("Dibutuhkan pada").fill("2026-11-30");
  await page.getByRole("button", { name: "Simpan permintaan" }).click();
  await page
    .getByRole("button", { name: "Ajukan", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Setujui", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "Buat PO" }).first().click();
  await page.getByLabel("Supplier").click();
  await page.getByRole("option").first().click();
  await page.getByLabel(/Harga satuan/).fill("10000");
  await page.getByLabel("Perkiraan tiba").fill("2026-12-01");
  await page.getByRole("button", { name: "Simpan PO" }).click();
  await page
    .getByRole("button", { name: "Ajukan", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Setujui", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "Buat tautan PDF" }).click();
  await expect(page.getByLabel(/tautan/i)).toBeVisible();
});
