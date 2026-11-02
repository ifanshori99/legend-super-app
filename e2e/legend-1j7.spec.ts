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
  // The shell title and the page heading both read "Pengadaan".
  await expect(
    page.getByRole("heading", { name: "Pengadaan" }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Daftar permintaan" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Buat permintaan" }).click();
  await page.getByLabel("Bahan").first().click();
  const firstItem = await page.getByRole("option").first().textContent();
  await page.getByRole("option").first().click();
  await page.getByLabel("Jumlah").first().fill("2");
  await page.getByRole("button", { name: "Tambah bahan" }).click();
  await page.getByLabel("Bahan").nth(1).click();
  const secondItem = await page.getByRole("option").nth(1).textContent();
  await page.getByRole("option").nth(1).click();
  await page.getByLabel("Jumlah").nth(1).fill("3");
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
  await page
    .getByLabel(/Harga satuan/)
    .first()
    .fill("10000");
  await page
    .getByLabel(/Harga satuan/)
    .nth(1)
    .fill("12000");
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
  const [preview] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("link", { name: "Pratinjau cetak" }).click(),
  ]);
  await expect(preview.getByText(firstItem!.trim())).toBeVisible();
  await expect(preview.getByText(secondItem!.trim())).toBeVisible();
});

test("PRD Alur I: a par-based suggestion fills a request line", async ({
  page,
}) => {
  await page.goto("/kelola/pengadaan");
  await expect(
    page.getByRole("heading", { name: "Daftar permintaan" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Buat permintaan" }).click();
  await expect(
    page.getByText(/Perkiraan sementara berdasarkan batas par/),
  ).toBeVisible();
  const suggestion = page
    .getByRole("button", { name: /^Gunakan saran/ })
    .first();
  await expect(suggestion).toBeVisible();
  await suggestion.click();
  await expect(page.getByLabel("Jumlah").first()).not.toHaveValue("");
  await expect(page.getByLabel("Bahan").first()).not.toContainText(
    "Pilih bahan",
  );
});
