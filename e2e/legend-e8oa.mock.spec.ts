// WS-08 ojek online delivery ops (bead legend-e8oa; PRD v1.7 §3.23 "Integrasi
// Ojek Online" / F20, §4 Alur G "Alur Pesanan Ojek Online", D12 "Mode Manual").
// Runs against the mock-mode web server (no API, no database):
// `pnpm test:e2e:mock`.
//
// The specs cover the operator's day: close and reopen a platform store, push
// a stale menu, accept a platform order into the KDS, record an order in the
// POS while a platform integration is not active, and read the commission
// variance of the GoFood statement.
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
  // The management topbar owns the area h1 (the nav label).
  await expect(
    page.getByRole("heading", { level: 1, name: title }),
  ).toBeVisible();
}

/**
 * Server-rendered controls drop a click that lands before hydration. Every
 * action below is safe to retry (toggle, open sheet, submit), so retry until
 * React owns the control (same pattern as e2e/legend-r0wz.mock.spec.ts).
 */
async function retry(action: () => Promise<void>) {
  await expect(action).toPass({ timeout: 15_000 });
}

/** The platform card of one channel in tab Kanal. */
function channelCard(page: Page, platform: string) {
  return page
    .locator("[data-slot=card-shell]")
    .filter({ has: page.getByRole("heading", { name: platform, level: 3 }) });
}

test("§3.23 kanal: tutup lalu buka kembali toko GoFood", async ({ page }) => {
  await open(page, "/kelola/delivery?tab=kanal", "Ojek online");
  const card = channelCard(page, "GoFood");
  const storeSwitch = card.getByRole("switch");
  await expect(storeSwitch).toBeChecked();

  await retry(async () => {
    // Guarded so a retry after a slow re-render never flips the store back.
    if (await storeSwitch.isChecked()) await storeSwitch.click();
    await expect(storeSwitch).not.toBeChecked({ timeout: 1000 });
  });
  await expect(page.getByText("Toko GoFood ditutup.").first()).toBeVisible();
  await expect(card.getByText("Toko tertutup")).toBeVisible();
  await expect(
    card.getByText("Toko ditutup tanpa jadwal buka kembali."),
  ).toBeVisible();

  await retry(async () => {
    if (!(await storeSwitch.isChecked())) await storeSwitch.click();
    await expect(storeSwitch).toBeChecked({ timeout: 1000 });
  });
  await expect(page.getByText("Toko GoFood dibuka.").first()).toBeVisible();
  await expect(card.getByText("Toko terbuka")).toBeVisible();
});

test("§3.23 kanal: sinkronkan menu GrabFood yang kedaluwarsa", async ({
  page,
}) => {
  await open(page, "/kelola/delivery?tab=kanal", "Ojek online");
  const card = channelCard(page, "GrabFood");
  await expect(card.getByText("Kedaluwarsa")).toBeVisible();

  await retry(async () => {
    await card.getByRole("button", { name: "Sinkronkan menu" }).click();
    await expect(card.getByText("Tersinkron")).toBeVisible({ timeout: 1000 });
  });
  // The contract's sync result: pushed items and the sold-out count. The toast
  // renders its text twice for assistive tech; pin the visible one.
  await expect(
    page.getByText(/\d+ item dikirim, \d+ item habis diperbarui\./).first(),
  ).toBeVisible();
  await expect(card.getByText(/^Terakhir /)).toBeVisible();
});

test("Alur G: terima pesanan GoFood yang baru masuk dan masuk ke KDS", async ({
  page,
}) => {
  await open(page, "/kelola/delivery?tab=pesanan", "Ojek online");
  const row = page.getByRole("row", { name: /GF-2026-1101-4471/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Baru masuk");
  await expect(row).toContainText("Platform");

  await retry(async () => {
    if ((await page.getByRole("dialog").count()) === 0)
      await row.getByRole("button", { name: "Lihat rincian" }).click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 1000 });
  });

  const sheet = page.getByRole("dialog");
  await expect(
    sheet.getByRole("heading", { name: "Pesanan GF-2026-1101-4471" }),
  ).toBeVisible();
  await expect(sheet.getByText("Nasi Goreng Kampung")).toBeVisible();
  await expect(sheet.getByText("Diterima bersih")).toBeVisible();
  await expect(sheet.getByText("Belum dikirim ke KDS")).toBeVisible();

  // The sheet is already interactive (it opened through a React handler), so
  // the acceptance click needs no retry.
  await sheet.getByRole("button", { name: "Terima pesanan" }).click();
  // Alur G step 2: acceptance injects the order and mints its pickup number.
  await expect(sheet.getByText(/D-0\d{3}/)).toBeVisible();
  await expect(
    sheet.getByRole("button", { name: "Mulai siapkan" }),
  ).toBeVisible();

  await sheet.getByRole("button", { name: "Tutup" }).first().click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(row).toContainText("Diterima");
});

test("D12 mode manual: catat pesanan ojek online lewat POS", async ({
  page,
}) => {
  await open(page, "/kelola/delivery?tab=pesanan", "Ojek online");

  await retry(async () => {
    if ((await page.getByRole("dialog").count()) === 0)
      await page.getByRole("button", { name: "Catat pesanan manual" }).click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 1000 });
  });

  const sheet = page.getByRole("dialog");
  await expect(
    sheet.getByRole("heading", { name: "Catat pesanan manual" }),
  ).toBeVisible();

  // The sheet is interactive from here on (it opened through React).
  await sheet.getByLabel("Nomor pesanan platform").fill("GF-2026-1103-9001");
  await expect(sheet.getByLabel("Nomor pesanan platform")).toHaveValue(
    "GF-2026-1103-9001",
  );

  await retry(async () => {
    if (
      (await page
        .getByRole("option", { name: "Nasi Goreng Kampung" })
        .count()) === 0
    )
      await sheet.getByRole("combobox", { name: "Item menu" }).click();
    await page.getByRole("option", { name: "Nasi Goreng Kampung" }).click();
    await expect(
      sheet.getByRole("combobox", { name: "Item menu" }),
    ).toContainText("Nasi Goreng Kampung", { timeout: 1000 });
  });

  await sheet.getByLabel("Jumlah").fill("2");
  await expect(sheet.getByLabel("Jumlah")).toHaveValue("2");

  await sheet.getByRole("button", { name: "Simpan pesanan" }).click();
  await expect(
    page.getByText("Pesanan manual tercatat.").first(),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const row = page.getByRole("row", { name: /GF-2026-1103-9001/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText("POS manual");
  await expect(row).toContainText("Baru masuk");
});

test("§3.23 rekonsiliasi: selisih komisi GoFood terlihat", async ({ page }) => {
  await open(page, "/kelola/delivery?tab=rekonsiliasi", "Ojek online");

  // The fixture statement is dated 1 Nov 2026; pin the period so the assertion
  // never depends on the wall clock. The retry verifies the data, not just the
  // field value, so a fill that lands before hydration is repeated.
  await retry(async () => {
    await page.getByLabel("Dari tanggal").fill("2026-11-01");
    await page.getByLabel("Sampai tanggal").fill("2026-11-03");
    await expect(
      page.getByRole("row", { name: /GF-2026-1101-4452/ }),
    ).toBeVisible({ timeout: 1500 });
  });

  // One StatStrip carries the money question and the counts behind it.
  await expect(page.getByText("Bruto platform").first()).toBeVisible();
  await expect(page.getByText("Dana diterima").first()).toBeVisible();

  const varianceRow = page.getByRole("row", { name: /GF-2026-1101-4452/ });
  await expect(varianceRow).toBeVisible();
  await expect(varianceRow).toHaveAttribute("data-state", "selected");
  await expect(varianceRow).toContainText("Selisih");
  await expect(varianceRow).toContainText(/Rp\s*2\.400/);

  const unknownRow = page.getByRole("row", { name: /GF-2026-1101-9930/ });
  await expect(unknownRow).toContainText("Tak dikenal");
  await expect(unknownRow).toContainText("Tidak ada pesanan internal");
});

for (const [width, theme] of [
  [390, "light"],
  [390, "dark"],
  [1440, "light"],
] as const) {
  test(`§3.23 kanal visual ${width} ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(
      (value) => localStorage.setItem("legend-theme", value),
      theme,
    );
    await open(page, "/kelola/delivery?tab=kanal", "Ojek online");
    await expect(
      page.getByRole("heading", { name: "GoFood", level: 3 }),
    ).toBeVisible();
    await captureScreenshot(page, `legend-e8oa/kanal-${width}-${theme}.png`);
  });
}

test("§3.23 pesanan visual 390 light", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await open(page, "/kelola/delivery?tab=pesanan", "Ojek online");
  await expect(
    page.getByRole("row", { name: /GF-2026-1101-4471/ }),
  ).toBeVisible();
  await captureScreenshot(page, "legend-e8oa/pesanan-390-light.png");
});

test("§3.23 rekonsiliasi visual 390 light", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await open(page, "/kelola/delivery?tab=rekonsiliasi", "Ojek online");
  // Pin the fixture statement period so the screenshot never depends on the
  // wall clock (the default period is month to date).
  await retry(async () => {
    await page.getByLabel("Dari tanggal").fill("2026-11-01");
    await page.getByLabel("Sampai tanggal").fill("2026-11-03");
    await expect(
      page.getByRole("row", { name: /GF-2026-1101-4452/ }),
    ).toBeVisible({ timeout: 1500 });
  });
  await captureScreenshot(page, "legend-e8oa/rekonsiliasi-390-light.png");
});

test("§3.23 outlet kosong 390 empty", async ({ page }) => {
  // The shell's outlet context uses its own fail-closed switch. `mock=empty`
  // only empties endpoint data and keeps the selected fixture outlet.
  await page.setViewportSize({ width: 390, height: 900 });
  await open(page, "/kelola/delivery?tab=kanal&tenant=none", "Ojek online");
  await expect(page.getByText("Belum ada outlet")).toBeVisible();
  await captureScreenshot(page, "legend-e8oa/outlet-390-empty.png");
});

test("§3.23 kanal error 390", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await open(page, "/kelola/delivery?tab=kanal&mock=error", "Ojek online");
  await expect(
    page.getByText("Kanal pengiriman tidak dapat dimuat"),
  ).toBeVisible();
  await captureScreenshot(page, "legend-e8oa/kanal-390-error.png");
});
