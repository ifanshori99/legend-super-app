import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshot-width.ts";

// Platform panel: packages and module flags, quotas and cost caps, health and
// the cross-tenant audit list (bead legend-y6s; PRD v1.7 §3 F4 "Feature Flag &
// Paket", "Kuota & Plafon", TEN-05) against the FE mock runtime. No API and no
// database; the screens read @starter/shared platform fixtures via
// VITE_API_MOCK=true.
// Mock port for this bead: LEGEND_MOCK_PORT=3307 pnpm test:e2e:mock.
const MOCK_URL = process.env.LEGEND_MOCK_WEB_URL;

test.skip(
  !MOCK_URL,
  "Needs a VITE_API_MOCK=true server (pnpm test:e2e:mock); see the header of this file.",
);

const NAV = { waitUntil: "networkidle" as const };

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});

async function confirmWithReason(page: Page, reason: string) {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: /Alasan perubahan/ }).fill(reason);
  await dialog.getByRole("button", { name: "Terapkan perubahan" }).click();
}

test("TEN-05 · packages list and a module switched off needs a confirm with a reason", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/platform/paket?mock=normal`, NAV);
  await expect(
    page.getByRole("heading", { name: "Paket", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("cell", { name: /Paket Lengkap/ })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Modul per tenant" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      /tidak dapat dibuka lewat tampilan, API, Tanya AI, maupun MCP/,
    ),
  ).toBeVisible();

  const accounting = page.getByRole("switch", { name: "Akuntansi" });
  await expect(accounting).toBeChecked();
  const review = page.getByRole("button", { name: "Tinjau & simpan" });
  await expect(review).toBeDisabled();
  await accounting.click();
  await review.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Dimatikan:")).toBeVisible();
  await expect(dialog.getByText("Akuntansi")).toBeVisible();
  // The reason is required (contract: 10-500 characters).
  await dialog.getByRole("button", { name: "Terapkan perubahan" }).click();
  await expect(dialog.getByText(/minimal 10 karakter/).last()).toBeVisible();
  await confirmWithReason(page, "Tenant belum memakai modul akuntansi.");
  await expect(
    page.getByText("Paket dan modul tersimpan.").first(),
  ).toBeVisible();
});

test("TEN-05 · a module outside the chosen package cannot be saved (MODULE_NOT_IN_PACKAGE)", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/platform/paket?mock=normal`, NAV);
  await page.getByRole("combobox", { name: "Paket tenant" }).click();
  await page.getByRole("option", { name: "Paket Outlet Dasar" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Simpan ditahan" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Tinjau & simpan" }),
  ).toBeDisabled();
  // Switching an extra module off removes it from the block list.
  const blocked = page.getByRole("alert").filter({ hasText: "Simpan ditahan" });
  await expect(blocked).toContainText("Akuntansi");
  await page.getByRole("switch", { name: "Akuntansi" }).click();
  await expect(blocked).not.toContainText("Akuntansi");
});

test("TEN-05 · quota bars show usage against the limit and the 80% warning", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/platform/kuota?mock=normal`, NAV);
  await expect(
    page.getByRole("heading", { name: "Pemakaian kuota" }),
  ).toBeVisible();
  const employees = page.getByRole("progressbar", { name: "Karyawan aktif" });
  await expect(employees).toHaveAttribute("aria-valuenow", "85");
  const whatsapp = page.getByRole("progressbar", { name: "WhatsApp" });
  await expect(whatsapp).toHaveAttribute("aria-valuenow", "83");
  await expect(page.getByText("Mendekati batas").first()).toBeVisible();
});

test("TEN-05 · limits form validates with the contract and saves after a confirm", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/platform/kuota?mock=normal`, NAV);
  const employees = page.getByRole("textbox", { name: /Karyawan aktif/ });
  await employees.fill("20");
  await expect(
    page.getByText(/Lebih rendah dari pemakaian saat ini/),
  ).toBeVisible();
  await employees.fill("abc");
  await expect(page.getByText(/Isi dengan angka bulat/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Tinjau & simpan" }).first(),
  ).toBeDisabled();

  await employees.fill("45");
  await page.getByRole("button", { name: "Tinjau & simpan" }).first().click();
  await expect(
    page.getByRole("dialog").getByText("Karyawan aktif"),
  ).toBeVisible();
  await confirmWithReason(page, "Tenant menambah karyawan shift malam.");
  await expect(page.getByText("Batas tenant tersimpan.").first()).toBeVisible();

  // The change lives in the tenants feature's mock store (one owner of
  // setTenantPackage), so it survives moving between platform screens.
  await page.getByRole("link", { name: "Paket & modul" }).click();
  await expect(
    page.getByRole("heading", { name: "Modul per tenant" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Kuota & plafon" }).click();
  await expect(
    page.getByRole("textbox", { name: /Karyawan aktif/ }),
  ).toHaveValue("45");
});

test("TEN-05 · available gateways are grouped and saved with a confirm", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/platform/kuota?mock=normal`, NAV);
  await expect(
    page.getByRole("heading", { name: "Gateway & integrasi tersedia" }),
  ).toBeVisible();
  await expect(
    page.getByText("Gateway pembayaran", { exact: true }),
  ).toBeVisible();
  const duitku = page.getByRole("switch", { name: "Duitku" });
  await expect(duitku).not.toBeChecked();
  await duitku.click();
  await page.getByRole("button", { name: "Tinjau & simpan" }).last().click();
  await expect(page.getByRole("dialog").getByText("Disediakan:")).toBeVisible();
  await confirmWithReason(page, "Tenant meminta gateway cadangan.");
  await expect(
    page.getByText("Gateway tersedia tersimpan.").first(),
  ).toBeVisible();
});

test("TEN-05 · health shows only what the contract provides and says infra metrics are missing", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/platform/kesehatan?mock=normal`, NAV);
  await expect(page.getByText("Tenant aktif", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Perlu perhatian" }),
  ).toBeVisible();
  await expect(
    page.getByText("Metrik infrastruktur belum tersedia"),
  ).toBeVisible();
});

test("TEN-05 · audit list filters, paginates by cursor and expands a row", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/platform/audit?mock=normal`, NAV);
  await expect(
    page.getByRole("heading", { name: "Riwayat audit" }),
  ).toBeVisible();
  const expanders = page.getByRole("button", { name: /^Buka detail/ });
  await expect(expanders).toHaveCount(20);
  await page.getByRole("button", { name: "Muat lebih banyak" }).click();
  await expect(expanders).toHaveCount(34);

  await expanders.first().click();
  await expect(page.getByText("Perubahan (disamarkan)")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Tutup detail/ }),
  ).toHaveAttribute("aria-expanded", "true");

  await page.getByRole("searchbox", { name: "Aksi" }).fill("support_access");
  await expect(
    page.getByRole("button", { name: "Muat lebih banyak" }),
  ).toHaveCount(0);
  await expect(page.getByText("tenant.package_changed")).toHaveCount(0);
  await expect(page.getByText("support_access.started").first()).toBeVisible();

  await page.getByRole("button", { name: "Hapus filter" }).click();
  await expect(expanders.first()).toBeVisible();
});

test("TEN-05 · empty and error states on every platform ops screen", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/platform/paket?mock=empty`, NAV);
  await expect(page.getByText("Belum ada paket")).toBeVisible();
  await captureScreenshot(page, "legend-y6s/paket-empty-1440.png");
  await page.goto(`${MOCK_URL}/platform/kuota?mock=empty`, NAV);
  await expect(page.getByText("Belum ada tenant")).toBeVisible();
  await page.goto(`${MOCK_URL}/platform/audit?mock=empty`, NAV);
  await expect(page.getByText("Belum ada catatan audit")).toBeVisible();
  await captureScreenshot(page, "legend-y6s/audit-empty-1440.png");

  for (const path of ["paket", "kuota", "kesehatan", "audit"]) {
    await page.goto(`${MOCK_URL}/platform/${path}?mock=error`, NAV);
    await expect(page.getByRole("alert").first()).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Coba lagi" }).first(),
    ).toBeVisible();
    await captureScreenshot(page, `legend-y6s/${path}-error-1440.png`);
  }
});

for (const [width, height] of [
  [390, 844],
  [1440, 900],
] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`TEN-05 · visual platform ops ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.addInitScript(
        (value) => localStorage.setItem("legend-theme", value),
        theme,
      );
      for (const [path, heading] of [
        ["paket", "Modul per tenant"],
        ["kuota", "Pemakaian kuota"],
        ["kesehatan", "Perlu perhatian"],
        ["audit", "Riwayat audit"],
      ] as const) {
        await page.goto(`${MOCK_URL}/platform/${path}?mock=normal`, NAV);
        await expect(
          page.getByRole("heading", { name: heading }).first(),
        ).toBeVisible();
        await captureScreenshot(
          page,
          `legend-y6s/${path}-${width}-${theme}.png`,
        );
      }
    });
  }
}
