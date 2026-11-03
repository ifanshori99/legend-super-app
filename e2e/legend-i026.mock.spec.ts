// CRM Customer 360, dynamic segments and the reviews & complaints queue
// (bead legend-i026; PRD v1.7 §3.21 "CRM, Promo & Kampanye": Customer 360,
// Segmentasi, Ulasan & Keluhan, AI-11). Runs against the mock-mode web server
// (no API, no database): `pnpm test:e2e:mock`.
//
// The mock serves `cafeLegendCrmFixtures`; a segment preview therefore counts
// the six sample profiles, and the AI-11 panel summarizes the four feedback
// rows the queue loaded. Both numbers are asserted as the screen shows them.
import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";

const baseURL =
  process.env.LEGEND_MOCK_WEB_URL ?? process.env.E2E_MOCK_BASE_URL;

test.skip(
  !baseURL,
  "Mock runner not started: use pnpm test:e2e:mock (playwright.mock.config.ts).",
);
test.use({ baseURL });

async function open(page: Page, path: string, title: string) {
  await page.goto(path, { waitUntil: "networkidle" });
  // The management topbar owns the area h1 (the nav label); the body shows its
  // section as an h2.
  await expect(
    page.getByRole("heading", { level: 1, name: title }),
  ).toBeVisible();
}

/**
 * Server-rendered controls drop a click that lands before hydration. Every
 * action below is safe to retry (open, fill, submit), so retry until React
 * owns the control (same pattern as e2e/legend-r0wz.mock.spec.ts).
 */
async function retry(action: () => Promise<void>) {
  await expect(action).toPass({ timeout: 15_000 });
}

test("§3.21 Customer 360 lists customers and opens the profile", async ({
  page,
}) => {
  await open(page, "/kelola/pelanggan", "Pelanggan");
  await expect(
    page.getByRole("heading", { name: "Customer 360" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Data kontak, tanggal lahir, dan kode referral hanya ditampilkan untuk peran yang berwenang.",
    ),
  ).toBeVisible();

  const row = page.getByRole("row", { name: /Sari Wulandari/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Platinum");
  await expect(row).toContainText("9.450.000");
  await expect(row).toContainText("1.240");
  await expect(row).toContainText("Aktif");
  await expect(page.getByRole("row", { name: /Agus Prasetyo/ })).toContainText(
    "Menunggu verifikasi",
  );

  await retry(async () => {
    await row
      .getByRole("link", { name: "Buka Customer 360 Sari Wulandari" })
      .click();
    await expect(
      page.getByRole("main").getByRole("heading", { name: "Sari Wulandari" }),
    ).toBeVisible({ timeout: 1000 });
  });

  // Customer 360: tier progress, the metric strip, visits, favorites,
  // consents and the append-only point ledger (PRD §3.21).
  await expect(page.getByText("Tier tertinggi")).toBeVisible();
  await expect(page.getByText("Belanja bergulir")).toBeVisible();
  await expect(page.getByText("Kunjungan bergulir")).toBeVisible();
  await expect(page.getByText("Saldo poin")).toBeVisible();
  await expect(page.getByText("Voucher aktif")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Kunjungan terbaru" }),
  ).toBeVisible();
  await expect(page.getByText("Kopi Susu Aren").first()).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Persetujuan berversi" }),
  ).toBeVisible();
  await expect(page.getByText("Pesan pemasaran")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Ledger poin" }),
  ).toBeVisible();
  await expect(page.getByText("Perolehan").first()).toBeVisible();
});

test("§3.21 Segmentasi (LOY-04) previews and saves a segment", async ({
  page,
}) => {
  await open(page, "/kelola/pelanggan/segmen", "Pelanggan");
  await expect(
    page.getByRole("heading", { name: "Susun segmen" }),
  ).toBeVisible();

  const saved = page.getByRole("row", {
    name: /Pelanggan Tidak Aktif 30 Hari/,
  });
  await expect(saved).toBeVisible();
  await expect(saved).toContainText("128 pelanggan");
  await expect(
    page.getByRole("row", { name: /Pecinta Kopi Susu/ }),
  ).toContainText("512 pelanggan");

  // The initial win-back rule (30 days) matches the three sample profiles
  // whose last visit is at least 30 days before the dataset anchor.
  await expect(page.getByText("Pelanggan cocok")).toBeVisible();
  await expect(page.getByText("Rina Kartika")).toBeVisible();
  await expect(
    page.getByText(
      "Hanya pelanggan dengan persetujuan pemasaran aktif yang menerima kampanye. Ukuran segmen bukan jumlah audiens kampanye.",
    ),
  ).toBeVisible();

  await retry(async () => {
    await page.getByLabel("Nama segmen").fill("Win-back uji");
    await expect(page.getByLabel("Nama segmen")).toHaveValue("Win-back uji", {
      timeout: 1000,
    });
  });

  // The input round-trip proves hydration; clicking once avoids a second
  // submit (which would create a duplicate segment row).
  await page.getByRole("button", { name: "Simpan segmen" }).click();
  await expect(
    page.getByText("Segmen Win-back uji dibuat.", { exact: true }),
  ).toBeVisible({
    timeout: 5000,
  });

  const created = page.getByRole("row", { name: /Win-back uji/ });
  await expect(created).toBeVisible();
  await expect(created).toContainText("Belum dihitung ulang");
});

test("§3.21 Ulasan & Keluhan moves a complaint through the queue", async ({
  page,
}) => {
  await open(page, "/kelola/ulasan", "Ulasan & keluhan");
  await expect(
    page.getByRole("heading", { name: "Ringkasan ulasan" }),
  ).toBeVisible();

  const row = page.getByRole("row", {
    name: /Menunggu meja lebih dari 20 menit tanpa informasi/,
  });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Baru");
  await expect(row).toContainText("Keluhan");

  await retry(async () => {
    await row.getByRole("button", { name: "Mulai tinjau" }).click();
    await expect(row).toContainText("Ditinjau", { timeout: 1000 });
  });

  await retry(async () => {
    await row.getByRole("button", { name: "Selesaikan" }).click();
    await expect(row).toContainText("Selesai", { timeout: 1000 });
  });
  await expect(
    page.getByText("Status ulasan diperbarui.").first(),
  ).toBeVisible();
});

test("AI-11 summarizes only the loaded review queue", async ({ page }) => {
  await open(page, "/kelola/ulasan", "Ulasan & keluhan");

  await expect(
    page.getByText("Hitungan otomatis", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Dihitung dari 4 ulasan yang dimuat."),
  ).toBeVisible();
  await expect(page.getByText("Rata-rata rating")).toBeVisible();
  // Ratings loaded: 5 and 3 → mean 4,0 (id-ID decimal comma).
  await expect(page.getByText("4,0")).toBeVisible();
  await expect(page.getByText("2 rating")).toBeVisible();
  await expect(page.getByText("2 terbuka")).toBeVisible();
  await expect(page.getByText("Status antrean")).toBeVisible();
  await expect(page.getByText("Keluhan terbuka per outlet")).toBeVisible();
  await expect(
    page.getByText(
      "Ringkasan tema pujian dan keluhan oleh AI belum tersedia; panel ini tidak mengarang tema.",
    ),
  ).toBeVisible();
});

test("§3.21 Customer 360 shows an empty directory", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await open(page, "/kelola/pelanggan?mock=empty", "Pelanggan");
  await expect(page.getByText("Belum ada pelanggan")).toBeVisible();
  await captureScreenshot(page, "legend-i026/pelanggan-390-empty.png");
});

test("§3.21 Customer 360 reports an unreadable directory", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await open(page, "/kelola/pelanggan?mock=error", "Pelanggan");
  await expect(page.getByText("Daftar pelanggan gagal dimuat")).toBeVisible();
  await captureScreenshot(page, "legend-i026/pelanggan-390-error.png");
});

for (const [width, theme] of [
  [390, "light"],
  [390, "dark"],
  [1440, "light"],
] as const) {
  test(`§3.21 Customer 360 visual ${width} ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(
      (value) => localStorage.setItem("legend-theme", value),
      theme,
    );
    await open(page, "/kelola/pelanggan", "Pelanggan");
    // At 390 the directory renders as cards (no row role); assert the name.
    await expect(
      page.getByText("Sari Wulandari").filter({ visible: true }).first(),
    ).toBeVisible();
    await captureScreenshot(
      page,
      `legend-i026/pelanggan-${width}-${theme}.png`,
    );
  });
}

test("§3.21 Segmentasi visual 390 light", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await open(page, "/kelola/pelanggan/segmen", "Pelanggan");
  await expect(
    page.getByRole("heading", { name: "Susun segmen" }),
  ).toBeVisible();
  await captureScreenshot(page, "legend-i026/segmen-390-light.png");
});

test("§3.21 Ulasan & Keluhan visual 390 light", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await open(page, "/kelola/ulasan", "Ulasan & keluhan");
  await expect(
    page.getByRole("heading", { name: "Ringkasan ulasan" }),
  ).toBeVisible();
  await captureScreenshot(page, "legend-i026/ulasan-390-light.png");
});
