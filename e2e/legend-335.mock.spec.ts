import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./screenshot-width.ts";

// Support access (bead legend-335; PRD v1.7 §3 F4 "Support Access", TEN-04)
// against the FE mock runtime: the Super Admin requests, lists and ends a
// session; the tenant admin reads the history and the active-session notice.
// Mock port for this bead: LEGEND_MOCK_PORT=3303 pnpm test:e2e:mock.
// Mock rules: any 6-digit authenticator code works except 000000 (wrong code).
const MOCK_URL = process.env.LEGEND_MOCK_WEB_URL;

test.skip(
  !MOCK_URL,
  "Needs a VITE_API_MOCK=true server (pnpm test:e2e:mock); see the header of this file.",
);

const NAV = { waitUntil: "networkidle" as const };

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});

async function openRequest(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Minta akses" }).first().click();
  return page.getByRole("dialog", { name: "Minta akses dukungan" });
}

test("TEN-04 · Super Admin sees the active session with a countdown and ends it now", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/platform/akses-dukungan?mock=normal`, NAV);
  await expect(page.getByRole("heading", { name: "Sesi akses" })).toBeVisible();

  const active = page.getByRole("row").filter({ hasText: "Aktif" }).first();
  await expect(active).toContainText("Legend");
  await expect(
    active.getByRole("button", { name: /Akhiri sesi untuk/ }),
  ).toBeVisible();

  await active.getByRole("button", { name: /Akhiri sesi untuk/ }).click();
  await expect(page.getByText("Sesi diakhiri.").first()).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Akhiri sesi untuk/ }),
  ).toHaveCount(0);
});

test("TEN-04 · the request needs a tenant, a written reason and a valid authenticator code", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/platform/akses-dukungan?mock=normal`, NAV);
  const dialog = await openRequest(page);
  await expect(dialog.getByText("Hanya baca").first()).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: /Durasi/ })).toContainText(
    "60 menit (bawaan)",
  );

  await dialog.getByRole("button", { name: "Mulai sesi" }).click();
  await expect(
    dialog.getByText("Pilih tenant yang akan dibuka."),
  ).toBeVisible();
  await expect(dialog.getByText("Alasan minimal 20 karakter.")).toBeVisible();
  await expect(dialog.getByText("Kode harus 6 digit angka.")).toBeVisible();

  await dialog.getByRole("combobox", { name: /Tenant/ }).click();
  await page.getByRole("option", { name: "Kopi Contoh" }).click();
  await dialog
    .getByLabel(/Alasan/)
    .fill("Memeriksa tagihan yang tertunda atas permintaan finance.");
  await dialog.getByLabel(/Kode autentikator/).fill("000000");
  await dialog.getByRole("button", { name: "Mulai sesi" }).click();
  await expect(dialog.getByText(/Kode verifikasi salah/).first()).toBeVisible();

  await dialog.getByLabel(/Kode autentikator/).fill("123456");
  await dialog.getByRole("button", { name: "Mulai sesi" }).click();
  await expect(page.getByText("Sesi akses dimulai.").first()).toBeVisible();
  await expect(
    page
      .getByRole("row")
      .filter({ hasText: "Kopi Contoh" })
      .filter({ hasText: "Aktif" }),
  ).toBeVisible();
});

test("TEN-04 · a second session for a tenant with an active one is refused with a fix", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/platform/akses-dukungan?mock=normal`, NAV);
  const dialog = await openRequest(page);
  await dialog.getByRole("combobox", { name: /Tenant/ }).click();
  await page
    .getByRole("option", { name: /Legend/ })
    .first()
    .click();
  await dialog
    .getByLabel(/Alasan/)
    .fill("Memeriksa ulang pengaturan pajak outlet utama.");
  await dialog.getByLabel(/Kode autentikator/).fill("123456");
  await dialog.getByRole("button", { name: "Mulai sesi" }).click();
  await expect(dialog.getByRole("alert")).toContainText("sesi aktif");
});

test("TEN-04 · the tenant admin sees the active-session notice and the session history", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/kelola/akses-dukungan?mock=normal`, NAV);
  await expect(
    page.getByRole("heading", { name: "Riwayat sesi" }),
  ).toBeVisible();
  await expect(
    page.getByText("Tim Legend sedang membuka data tenant Anda"),
  ).toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: "selisih kas" }),
  ).toBeVisible();
  await expect(page.getByText("Hanya baca").first()).toBeVisible();
});

test("TEN-04 · empty and error states explain what to do next", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/platform/akses-dukungan?mock=empty`, NAV);
  await expect(page.getByText("Belum ada sesi akses")).toBeVisible();
  await captureScreenshot(page, "legend-335/platform-empty-1440.png");

  await page.goto(`${MOCK_URL}/kelola/akses-dukungan?mock=empty`, NAV);
  await expect(page.getByText("Belum ada sesi dukungan")).toBeVisible();

  await page.goto(`${MOCK_URL}/platform/akses-dukungan?mock=error`, NAV);
  await expect(page.getByText("Coba lagi").first()).toBeVisible();
  await captureScreenshot(page, "legend-335/platform-error-1440.png");

  await page.goto(`${MOCK_URL}/kelola/akses-dukungan?mock=error`, NAV);
  await expect(page.getByText("Coba lagi").first()).toBeVisible();
});

for (const [width, height] of [
  [390, 844],
  [1440, 900],
] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`TEN-04 · visual support access ${width} ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await page.addInitScript(
        (value) => localStorage.setItem("legend-theme", value),
        theme,
      );
      await page.goto(`${MOCK_URL}/platform/akses-dukungan?mock=normal`, NAV);
      await expect(
        page.getByRole("heading", { name: "Sesi akses" }),
      ).toBeVisible();
      await captureScreenshot(
        page,
        `legend-335/platform-${width}-${theme}.png`,
      );

      await openRequest(page);
      await captureScreenshot(page, `legend-335/request-${width}-${theme}.png`);
      await page.keyboard.press("Escape");

      await page.goto(`${MOCK_URL}/kelola/akses-dukungan?mock=normal`, NAV);
      await expect(
        page.getByRole("heading", { name: "Riwayat sesi" }),
      ).toBeVisible();
      await captureScreenshot(page, `legend-335/tenant-${width}-${theme}.png`);
    });
  }
}
