import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";

// Tenant settings (bead legend-5k0; PRD v1.7 §3 F4 "Integrasi per Tenant",
// "Whitelabel", "Teks & Kamus Istilah", "Konfigurasi sebagai Data") against the
// FE mock runtime: write-only integration credentials (PAY-06), the Tenant
// Theme editor with its WCAG 2.2 AA gate (TEN-10, TEN-08), the term dictionary
// and the config export/import with a preview diff (TEN-09).
// Mock port for this bead: LEGEND_MOCK_PORT=3304 pnpm test:e2e:mock.
const MOCK_URL = process.env.LEGEND_MOCK_WEB_URL;

test.skip(
  !MOCK_URL,
  "Needs a VITE_API_MOCK=true server (pnpm test:e2e:mock); see the header of this file.",
);

const NAV = { waitUntil: "networkidle" as const };
const SECRET_KEY = "sk_live_TOPSECRET_9f8e7d6c5b4a";
const SECRET_HOOK = "whsec_ANOTHER_SECRET_1234567890";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});

async function leaks(page: Page, secret: string) {
  return page.evaluate((value) => {
    const inputs = Array.from(
      document.querySelectorAll("input, textarea"),
    ).some((node) => (node as HTMLInputElement).value.includes(value));
    return (
      inputs ||
      document.documentElement.outerHTML.includes(value) ||
      JSON.stringify({ ...localStorage }).includes(value) ||
      JSON.stringify({ ...sessionStorage }).includes(value)
    );
  }, secret);
}

test("PAY-06 · stored credentials are masked, and a replacement is never shown back", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/kelola/pengaturan/integrasi?mock=normal`, NAV);
  await expect(
    page.getByRole("heading", { name: "Integrasi", exact: true }).first(),
  ).toBeVisible();

  const card = page.getByRole("group", { name: "DOIT" });
  await expect(card.getByText("Kunci API")).toBeVisible();
  await expect(card.getByText("••••••••").first()).toBeVisible();

  await card.getByRole("button", { name: "Ubah" }).click();
  const dialog = page.getByRole("dialog", { name: "DOIT" });
  // The form offers a blank replace field only; no stored value is prefilled.
  const apiKey = dialog.getByLabel("Ganti Kunci API");
  await expect(apiKey).toHaveValue("");
  await expect(apiKey).toHaveAttribute("type", "password");

  await apiKey.fill(SECRET_KEY);
  await dialog.getByLabel("Ganti Rahasia webhook").fill(SECRET_HOOK);
  await dialog.getByRole("button", { name: "Simpan" }).click();

  await expect(page.getByText("DOIT disimpan.").first()).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(card.getByText("••••••••").first()).toBeVisible();
  expect(await leaks(page, SECRET_KEY)).toBe(false);
  expect(await leaks(page, SECRET_HOOK)).toBe(false);

  // Reopening starts blank again: the secret cannot be read back.
  await card.getByRole("button", { name: "Ubah" }).click();
  await expect(
    page.getByRole("dialog", { name: "DOIT" }).getByLabel("Ganti Kunci API"),
  ).toHaveValue("");
});

test("PAY-06 · replacing only part of the credential set is refused before any request", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/kelola/pengaturan/integrasi?mock=normal`, NAV);
  await page
    .getByRole("group", { name: "WhatsApp" })
    .getByRole("button", { name: "Ubah" })
    .click();
  const dialog = page.getByRole("dialog", { name: "WhatsApp" });
  await dialog.getByLabel("Ganti Kunci API").fill(SECRET_KEY);
  await dialog.getByRole("button", { name: "Simpan" }).click();
  await expect(
    dialog.getByText("Isi semua kolom kredensial saat mengganti"),
  ).toBeVisible();
  await expect(dialog).toBeVisible();
});

test("PAY-06 · a new ojol account can be set up and activated once it holds credentials", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/kelola/pengaturan/integrasi?mock=normal`, NAV);
  const card = page.getByRole("group", { name: "GrabFood" });
  await expect(card.getByText("Belum diatur", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Atur" }).click();
  const dialog = page.getByRole("dialog", { name: "GrabFood" });
  await dialog.getByLabel("ID toko").fill("GR-5521");
  await dialog.getByLabel("Client ID").fill("client-abc");
  await dialog.getByLabel("Client secret").fill(SECRET_KEY);
  await dialog.getByRole("button", { name: "Simpan" }).click();
  await expect(page.getByText("GrabFood disimpan.").first()).toBeVisible();
  await card.getByRole("button", { name: "Aktifkan", exact: true }).click();
  await expect(page.getByText("GrabFood diaktifkan.").first()).toBeVisible();
  await expect(card.getByText("Aktif", { exact: true })).toBeVisible();
  expect(await leaks(page, SECRET_KEY)).toBe(false);
});

test("TEN-10 · a theme below WCAG 2.2 AA cannot be saved until the contrast is fixed", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/kelola/pengaturan/tema?mock=normal`, NAV);
  await expect(
    page.getByRole("heading", { name: "Tema tenant", exact: true }),
  ).toBeVisible();
  const save = page.getByRole("button", { name: "Simpan & aktifkan" });
  await expect(save).toBeDisabled(); // nothing changed yet
  await expect(page.getByText("Lolos di mode terang dan gelap")).toBeVisible();

  const primary = page.getByRole("textbox", {
    name: "Warna utama",
    exact: true,
  });
  await primary.fill("#ffee00");
  await expect(page.getByText(/pasangan warna gagal/)).toBeVisible();
  await expect(save).toBeDisabled();
  await expect(
    page.getByText("Perbaiki kontras yang gagal sebelum menyimpan"),
  ).toBeVisible();

  await primary.fill("#0f5e68");
  await expect(page.getByText("Lolos di mode terang dan gelap")).toBeVisible();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(
    page.getByText("Tema disimpan dan diaktifkan.").first(),
  ).toBeVisible();
});

test("TEN-10 · loading an old failing version into the editor keeps the save blocked", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/kelola/pengaturan/tema?mock=normal`, NAV);
  await expect(page.getByText("Kontras gagal")).toBeVisible();
  // The newest version is the failing draft.
  await page.getByRole("button", { name: "Muat ke editor" }).first().click();
  await expect(page.getByText(/pasangan warna gagal/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Simpan & aktifkan" }),
  ).toBeDisabled();
});

test("TEN-08 · the theme preview shows the tenant brand and no platform identity", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/kelola/pengaturan/tema?mock=normal`, NAV);
  const preview = page.getByRole("group", { name: "Pratinjau tema" });
  await expect(preview).toBeVisible();
  await expect(preview.getByText("Cafe Legend")).toBeVisible();
  await expect(preview).not.toContainText(/legend super app/i);
  // The dark mode switch re-renders the same island in the dark palette.
  await page.getByRole("radio", { name: "Gelap" }).click();
  await expect(preview).toHaveAttribute("data-theme", "dark");
});

test("TEN-09 · the term dictionary renames a term and shows it as customized", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/kelola/pengaturan/istilah?mock=normal`, NAV);
  await expect(
    page.getByRole("heading", { name: "Kamus istilah", exact: true }),
  ).toBeVisible();
  const field = page.locator('[id="term-id-terms.table"]');
  await field.fill("Meja Tamu");
  await page.getByRole("button", { name: "Simpan 1 perubahan" }).click();
  await expect(page.getByText("1 perubahan istilah disimpan.")).toBeVisible();
  await expect(field).toHaveValue("Meja Tamu");
  // An empty box restores the platform default.
  await field.fill("");
  await page.getByRole("button", { name: "Simpan 1 perubahan" }).click();
  await expect(field).toHaveValue("");
});

test("TEN-09 · export downloads a bundle and import previews the diff before applying", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/kelola/pengaturan/konfigurasi?mock=normal`, NAV);
  await expect(
    page.getByRole("heading", { name: "Ekspor & impor konfigurasi" }),
  ).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Ekspor konfigurasi" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^konfigurasi-\d{8}\.json$/);
  const bundle = JSON.parse(readFileSync(await download.path(), "utf8"));
  expect(JSON.stringify(bundle)).not.toMatch(/credentials|tenantId/);

  // Edit the bundle the way a new tenant's setup would: one zone changes, one is new.
  bundle.sections.zones.items[0].name = "Zona diperbarui";
  bundle.sections.zones.items.push({
    ...bundle.sections.zones.items[0],
    key: "rooftop",
    name: "Rooftop",
  });
  const input = page.getByLabel("Pilih berkas .json");
  await input.setInputFiles({
    name: "konfigurasi-baru.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(bundle)),
  });

  await expect(
    page.getByRole("heading", { name: "Pratinjau perubahan" }),
  ).toBeVisible();
  const zones = page.getByRole("listitem").filter({ hasText: "Zona & meja" });
  await expect(zones.getByText("Berubah")).toBeVisible();
  await expect(zones).toContainText("+1");
  await zones.getByText(/Lihat \d+ baris/).click();
  await expect(zones.getByText("rooftop")).toBeVisible();

  // Nothing is applied until the confirmation.
  await page.getByRole("button", { name: "Terapkan konfigurasi" }).click();
  const dialog = page.getByRole("dialog", { name: "Terapkan konfigurasi?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Terapkan konfigurasi" }).click();
  await expect(
    page.getByText("Konfigurasi diterapkan (1 bagian)."),
  ).toBeVisible();
});

test("TEN-09 · an import that still carries source-tenant ids is refused with a fix hint", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/kelola/pengaturan/konfigurasi?mock=normal`, NAV);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Ekspor konfigurasi" }).click(),
  ]);
  const bundle = JSON.parse(readFileSync(await download.path(), "utf8"));
  bundle.sections.zones.items[0].tenantId =
    "11111111-2222-4333-8444-555555555555";
  await page.getByLabel("Pilih berkas .json").setInputFiles({
    name: "bocor.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(bundle)),
  });
  await expect(
    page.getByRole("alert").filter({ hasText: "bocor.json" }),
  ).toContainText("sections.zones.items[0].tenantId (forbidden_key)");
  await expect(
    page.getByRole("button", { name: "Terapkan konfigurasi" }),
  ).toHaveCount(0);
});

test("PAY-06 · empty, error and offline states explain what to do next", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${MOCK_URL}/kelola/pengaturan/integrasi?mock=empty`, NAV);
  await expect(page.getByText("Belum ada integrasi yang diatur")).toBeVisible();
  await captureScreenshot(page, "legend-5k0/integrasi-empty-1440.png");

  await page.goto(`${MOCK_URL}/kelola/pengaturan/integrasi?mock=error`, NAV);
  await expect(page.getByText("Pengaturan belum bisa dimuat")).toBeVisible();
  await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();
  await captureScreenshot(page, "legend-5k0/integrasi-error-1440.png");

  await page.goto(`${MOCK_URL}/kelola/pengaturan/tema?mock=offline`, NAV);
  await expect(page.getByText("Perangkat sedang offline")).toBeVisible();
  await captureScreenshot(page, "legend-5k0/tema-offline-1440.png");

  await page.goto(`${MOCK_URL}/kelola/pengaturan/istilah?mock=empty`, NAV);
  await expect(
    page.getByText("Semua istilah memakai nilai bawaan platform."),
  ).toBeVisible();
  await page.goto(`${MOCK_URL}/kelola/pengaturan/konfigurasi?mock=error`, NAV);
  await expect(
    page.getByRole("heading", { name: "Ekspor & impor konfigurasi" }),
  ).toBeVisible();
  await page.goto(`${MOCK_URL}/kelola/pengaturan/integrasi?mock=normal`, NAV);
});

const PAGES = [
  ["integrasi", "Integrasi"],
  ["tema", "Tema tenant"],
  ["istilah", "Kamus istilah"],
  ["konfigurasi", "Ekspor & impor konfigurasi"],
] as const;

for (const [width, height] of [
  [390, 844],
  [1440, 900],
] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`PAY-06 · visual tenant settings ${width} ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await page.addInitScript(
        (value) => localStorage.setItem("legend-theme", value),
        theme,
      );
      for (const [slug, heading] of PAGES) {
        await page.goto(
          `${MOCK_URL}/kelola/pengaturan/${slug}?mock=normal`,
          NAV,
        );
        await expect(
          page.getByRole("heading", { name: heading, exact: true }).first(),
        ).toBeVisible();
        await captureScreenshot(
          page,
          `legend-5k0/${slug}-${width}-${theme}.png`,
        );
      }
      await page.goto(
        `${MOCK_URL}/kelola/pengaturan/integrasi?mock=normal`,
        NAV,
      );
      await page
        .getByRole("group", { name: "DOIT" })
        .getByRole("button", { name: "Ubah" })
        .click();
      await expect(page.getByRole("dialog", { name: "DOIT" })).toBeVisible();
      await captureScreenshot(
        page,
        `legend-5k0/integrasi-dialog-${width}-${theme}.png`,
      );
    });
  }
}
