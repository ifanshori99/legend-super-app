import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./screenshots";

// Panel Platform tenant screens (bead legend-tno; PRD v1.7 §3 F1 "Layar
// Platform", §3 F4, §4 Alur R; TEN-06) against the FE mock runtime. Mock port
// 3306: LEGEND_MOCK_WEB_URL names the VITE_API_MOCK=true server
// (pnpm test:e2e:mock); with no variable every test skips.
const MOCK_URL = process.env.LEGEND_MOCK_WEB_URL;

test.skip(
  !MOCK_URL,
  "Needs a VITE_API_MOCK=true server (pnpm test:e2e:mock); see the header of this file.",
);

const NAV = { waitUntil: "networkidle" as const };

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test("TEN-06 · list shows status and plan, filters, searches and pages by cursor", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/platform/tenant?mock=normal`, NAV);
  const table = page.getByRole("table");
  await expect(
    table.getByRole("link", { name: /Cafe Legend/ }).first(),
  ).toBeVisible();
  await expect(table.getByText("Nonaktif").first()).toBeVisible();

  // 14 sample tenants, 10 per page.
  await expect(page.getByText("Halaman 1")).toBeVisible();
  await page.getByRole("button", { name: "Berikutnya" }).click();
  await expect(page.getByText("Halaman 2")).toBeVisible();
  await page.getByRole("button", { name: "Sebelumnya" }).click();

  await page
    .getByRole("searchbox", { name: "Cari nama atau slug tenant" })
    .fill("warung");
  await expect(table.getByRole("link", { name: /Warung Senja/ })).toBeVisible();
  await expect(table.getByRole("link", { name: /Cafe Legend/ })).toHaveCount(0);

  for (const [width, height, name] of [
    [1440, 900, "daftar-1440"],
    [390, 844, "daftar-390"],
  ] as const) {
    await page.setViewportSize({ width, height });
    await captureScreenshot(page, `legend-tno/${name}-light.png`);
  }
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await captureScreenshot(page, "legend-tno/daftar-390-dark.png");
});

test("TEN-06 · detail shows usage, legal entity NPWP/PKP and deactivates with a confirmation", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/platform/tenant?mock=normal`, NAV);
  await page
    .getByRole("link", { name: /Cafe Legend/ })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Cafe Legend" }).first(),
  ).toBeVisible();
  await expect(page.getByText("Karyawan aktif")).toBeVisible();
  await expect(page.getByText("Biaya WhatsApp")).toBeVisible();
  await expect(page.getByText("Badan hukum").first()).toBeVisible();
  await expect(
    page.locator("#main-content").getByRole("link", { name: "Akses dukungan" }),
  ).toBeVisible();
  await captureScreenshot(page, "legend-tno/detail-1440-light.png");

  await page.getByRole("button", { name: "Nonaktifkan" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Ya, nonaktifkan" }).click();
  await expect(
    dialog.getByText("Tulis alasan minimal 10 karakter."),
  ).toBeVisible();
  await dialog
    .getByLabel("Alasan", { exact: false })
    .fill("Tunggakan langganan tiga bulan");
  await dialog.getByRole("button", { name: "Ya, nonaktifkan" }).click();
  await expect(page.getByText("Tenant dinonaktifkan.").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Aktifkan" })).toBeVisible();
});

test("TEN-06 · wizard creates tenant, brand, outlet, legal entity and first admin", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/platform/tenant/baru?mock=normal`, NAV);
  await expect(
    page.getByRole("heading", { name: "Tenant baru" }).first(),
  ).toBeVisible();

  // Validation uses the contract schemas: an empty step cannot continue.
  await page.getByRole("button", { name: "Lanjut" }).click();
  await expect(
    page.getByText("Isi nama tenant, maksimal 150 karakter."),
  ).toBeVisible();
  await captureScreenshot(page, "legend-tno/wizard-kesalahan-390-light.png");

  await page.getByLabel("Nama tenant", { exact: false }).fill("Kopi Senja");
  await expect(page.getByLabel("Slug tenant", { exact: false })).toHaveValue(
    "kopi-senja",
  );
  await page.getByRole("button", { name: "Lanjut" }).click();

  await page.getByLabel("Nama brand", { exact: false }).fill("Kopi Senja");
  await page.getByRole("button", { name: "Lanjut" }).click();

  await page
    .getByLabel("Nama outlet", { exact: false })
    .fill("Kopi Senja Dago");
  await page.getByLabel("Kode outlet", { exact: false }).fill("ks-01");
  await page
    .getByLabel("Alamat outlet", { exact: false })
    .fill("Jl. Ir. H. Juanda No. 1, Bandung");
  await page.getByRole("button", { name: "Lanjut" }).click();

  await page
    .getByLabel("Nama badan hukum", { exact: false })
    .fill("PT Senja Nusantara");
  await page.getByLabel("NPWP", { exact: false }).fill("01.234.567.8-901.000");
  await page.getByLabel("Pengusaha Kena Pajak (PKP)").check();
  await page.getByRole("button", { name: "Lanjut" }).click();

  await page.getByLabel("Nama admin", { exact: false }).fill("Sari Wulandari");
  await page
    .getByLabel("Nomor WhatsApp", { exact: false })
    .fill("0812 3456 7890");
  await page.getByRole("button", { name: "Lanjut" }).click();

  await expect(page.getByText("6281234567890")).toBeVisible();
  await expect(page.getByText("••••1000")).toBeVisible();
  await captureScreenshot(page, "legend-tno/wizard-tinjau-1440-light.png");
  await page.getByRole("button", { name: "Buat tenant" }).click();

  await expect(
    page.getByText("Tenant Kopi Senja dibuat.").first(),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Kopi Senja" }).first(),
  ).toBeVisible();
  await expect(page.getByText("Sari Wulandari").first()).toBeVisible();
  await expect(page.getByText("Kopi Senja Dago").first()).toBeVisible();
  await expect(page.getByText("PT Senja Nusantara").first()).toBeVisible();
});

test("legend-tno · empty, error and offline scenarios render honest states", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/platform/tenant?mock=empty`, NAV);
  await expect(page.getByText("Belum ada tenant")).toBeVisible();
  await captureScreenshot(page, "legend-tno/daftar-kosong-1440-light.png");

  await page.goto(`${MOCK_URL}/platform/tenant?mock=error`, NAV);
  await expect(page.getByText("Data tidak dapat dimuat")).toBeVisible({
    timeout: 15_000,
  });
  await captureScreenshot(page, "legend-tno/daftar-galat-1440-light.png");

  await page.goto(`${MOCK_URL}/platform/tenant?mock=offline`, NAV);
  await expect(page.getByRole("alert").first()).toBeVisible({
    timeout: 15_000,
  });
});
