// WS-09 facility admin configuration (bead legend-er32; PRD v1.7 §3 F25
// "Model Generik", "Konfigurasi Legend", "Produk & Hak Akses", "Pembatalan").
//
// Mock-mode spec: `pnpm test:e2e:mock e2e/legend-er32.mock.spec.ts` starts a web
// dev server with VITE_API_MOCK=true (no API, no database). Data comes from
// features/facility/mock.ts (GET /api/facility/config, reused) and
// features/facility-admin/mock.ts (the list read plus every config write).
// Screenshots go through e2e/screenshots.ts: tracked evidence only with
// LEGEND_CAPTURE_SCREENSHOTS=1.
import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";

const mockWebUrl = process.env.LEGEND_MOCK_WEB_URL;
test.skip(!mockWebUrl, "Requires the mock-mode web server");
test.use({ baseURL: mockWebUrl ?? "http://localhost:3320" });

// 1269 F0: showers are deferred, so the booth fixture is served as an open
// facility type (features/facility/mock-facilities.ts).
test.beforeEach(({ page }) =>
  page.addInitScript(() =>
    window.localStorage.setItem("legend.mock.boothType", "coworking"),
  ),
);

/** The first test on a new route pays Vite's cold compile (frontend guide §6). */
const COLD_START_TIMEOUT_MS = 30_000;
const SHOWER_FACILITY_ID = "00000000-0000-4000-8000-000000009001";
const SHOWER_FACILITY_NAME = "Shower Room Legend";

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.addInitScript(
    (value) => localStorage.setItem("legend-theme", value),
    theme,
  );
}

function facilityRow(page: Page, name: string) {
  return page.getByRole("row").filter({ hasText: name });
}

/**
 * The SSR HTML paints the form before React hydrates. Filling a controlled
 * input in that window is lost when hydration mounts the initial state, so the
 * spec saves the server value instead of the typed one (this failed once).
 */
async function waitForHydration(page: Page) {
  await page.waitForFunction(
    () => {
      const element = document.querySelector(
        "main a[href], #main-content a[href], main button, #main-content button",
      );
      return (
        element !== null &&
        Object.keys(element).some((key) => key.startsWith("__reactFiber$"))
      );
    },
    undefined,
    { timeout: 60_000 },
  );
}

async function openConfig(page: Page, name = SHOWER_FACILITY_NAME) {
  await facilityRow(page, name)
    .getByRole("link", { name: "Buka konfigurasi" })
    .click();
  await expect(page.getByRole("heading", { level: 2, name })).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
  await waitForHydration(page);
}

test("legend-er32 F25: the list shows facility metrics and opens the config editor", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await setTheme(page, "light");
  await page.goto(`/kelola/fasilitas?mock=normal`);

  // The management topbar owns the page title (DESIGN.md v3 §5).
  await expect(
    page.getByRole("heading", { level: 1, name: "Fasilitas" }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await expect(page.getByText("Konfigurasi fasilitas")).toBeVisible();
  // Two fixture facilities, four shower units plus two WFC units.
  const strip = page.locator('[data-slot="stat-strip"]');
  await expect(strip).toContainText("Fasilitas");
  await expect(strip).toContainText("Unit aktif");
  await expect(facilityRow(page, SHOWER_FACILITY_NAME)).toContainText(
    "06.00–10.00",
  );
  await expect(facilityRow(page, "Zona WFC Legend")).toContainText(
    "08.00–22.00",
  );
  await expect(facilityRow(page, SHOWER_FACILITY_NAME)).toContainText("Aktif");

  await openConfig(page);
  for (const tab of [
    "Umum",
    "Area & Unit",
    "Produk",
    "Hak akses",
    "Add-on",
    "Langganan",
    "Wi-Fi & WFC",
  ])
    await expect(page.getByRole("tab", { name: tab })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Simpan pengaturan umum" }),
  ).toBeVisible();
});

test("legend-er32 F25 Konfigurasi Legend: session and cleaning minutes save", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/kelola/fasilitas?mock=normal`);
  await openConfig(page);

  const session = page.getByLabel("Durasi sesi (menit)");
  const cleaning = page.getByLabel("Jeda pembersihan (menit)");
  await expect(session).toHaveValue("20");
  await session.fill("25");
  await cleaning.fill("12");
  await page.getByRole("button", { name: "Simpan pengaturan umum" }).click();

  await expect(
    page.getByText("Pengaturan umum disimpan.", { exact: true }),
  ).toBeVisible();
  await expect(session).toHaveValue("25");
  await expect(cleaning).toHaveValue("12");
});

test("legend-er32 F25 Model Generik: an area and a unit are added", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/kelola/fasilitas?mock=normal`);
  await openConfig(page);
  await page.getByRole("tab", { name: "Area & Unit" }).click();

  await page.getByRole("button", { name: "Tambah area" }).click();
  await page.getByLabel("Nama area").fill("Area Keluarga");
  await page.getByRole("button", { name: "Simpan area" }).click();
  await expect(
    page.getByText("Area ditambahkan.", { exact: true }),
  ).toBeVisible();
  const area = page
    .locator('[data-slot="facility-area"]')
    .filter({ hasText: "Area Keluarga" });
  await expect(area).toBeVisible();

  await area.getByRole("button", { name: "Tambah unit" }).click();
  await page.getByLabel("Kode unit").fill("K1");
  await page.getByRole("button", { name: "Simpan unit" }).click();
  await expect(
    page.getByText("Unit ditambahkan.", { exact: true }),
  ).toBeVisible();
  await expect(
    area.locator('[data-slot="facility-unit"]').filter({ hasText: "K1" }),
  ).toBeVisible();
  await expect(area).toContainText("Tersedia");
});

test("legend-er32 F25 Produk & Hak Akses: product and rule toggles persist", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/kelola/fasilitas?mock=normal`);
  await openConfig(page);

  await page.getByRole("tab", { name: "Produk" }).click();
  const productSwitch = page.getByRole("switch", {
    name: "Nonaktifkan Shower Sekali Pakai",
  });
  await expect(productSwitch).toBeChecked();
  await productSwitch.click();
  await expect(
    page.getByRole("switch", { name: "Aktifkan Shower Sekali Pakai" }),
  ).not.toBeChecked();
  // The five PRD sources are all represented on the product tab.
  for (const source of [
    "Sekali bayar",
    "Menu paket",
    "Minimum belanja",
    "Benefit tier",
    "Langganan bulanan",
  ])
    await expect(
      page.locator('[data-slot="entitlement-source"]', { hasText: source }),
    ).toBeVisible();

  await page.getByRole("tab", { name: "Hak akses" }).click();
  const ruleSwitch = page.getByRole("switch", {
    name: "Nonaktifkan aturan Minimum belanja",
  });
  await expect(ruleSwitch).toBeChecked();
  await ruleSwitch.click();
  await expect(
    page.getByRole("switch", { name: "Aktifkan aturan Minimum belanja" }),
  ).not.toBeChecked();
});

test("legend-er32 F25 Add-on Opsional: an add-on price update is saved", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/kelola/fasilitas?mock=normal`);
  await openConfig(page);
  await page.getByRole("tab", { name: "Add-on" }).click();

  await page.getByRole("button", { name: "Ubah add-on Handuk" }).click();
  const price = page.getByLabel("Harga (Rp)");
  await price.fill("12000");
  await page.getByRole("button", { name: "Simpan add-on" }).click();
  await expect(
    page.getByText("Add-on diperbarui.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('[data-slot="facility-addon"]').filter({ hasText: "Handuk" }),
  ).toContainText("12.000");
});

test("legend-er32: empty, offline and error states offer a way forward", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto(`/kelola/fasilitas?mock=empty`);
  await expect(page.getByText("Belum ada fasilitas")).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
  await expect(page.getByText("Konfigurasi fasilitas")).toBeVisible();

  await page.goto(`/kelola/fasilitas?mock=offline`);
  await expect(page.getByRole("alert")).toContainText("Internet terputus");
  await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();

  await page.goto(`/kelola/fasilitas?mock=error`);
  await expect(page.getByRole("alert")).toContainText(
    "Daftar fasilitas gagal dimuat",
  );
  await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();

  await page.goto(`/kelola/fasilitas/${SHOWER_FACILITY_ID}?mock=error`);
  await expect(page.getByRole("alert")).toContainText(
    "Konfigurasi fasilitas gagal dimuat",
  );
});

test("legend-er32 visual: facility list and config 390 light", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await setTheme(page, "light");
  await page.goto(`/kelola/fasilitas?mock=normal`);
  await expect(
    page.getByRole("heading", { level: 2, name: "Konfigurasi fasilitas" }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await captureScreenshot(page, "legend-er32/facility-list-390-light.png");

  await openConfig(page);
  await captureScreenshot(page, "legend-er32/facility-config-390-light.png");
});

test("legend-er32 visual: facility list and config 390 dark", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await setTheme(page, "dark");
  await page.goto(`/kelola/fasilitas?mock=normal`);
  await expect(
    page.getByRole("heading", { level: 2, name: "Konfigurasi fasilitas" }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await captureScreenshot(page, "legend-er32/facility-list-390-dark.png");

  await openConfig(page);
  await captureScreenshot(page, "legend-er32/facility-config-390-dark.png");
});

test("legend-er32 visual: facility list and config 1440 light", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await setTheme(page, "light");
  await page.goto(`/kelola/fasilitas?mock=normal`);
  await expect(
    page.getByRole("heading", { level: 2, name: "Konfigurasi fasilitas" }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await captureScreenshot(page, "legend-er32/facility-list-1440-light.png");

  await openConfig(page);
  await captureScreenshot(page, "legend-er32/facility-config-1440-light.png");
});

test("legend-er32 visual: facility list and config 1440 dark", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await setTheme(page, "dark");
  await page.goto(`/kelola/fasilitas?mock=normal`);
  await expect(
    page.getByRole("heading", { level: 2, name: "Konfigurasi fasilitas" }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await captureScreenshot(page, "legend-er32/facility-list-1440-dark.png");

  await openConfig(page);
  await captureScreenshot(page, "legend-er32/facility-config-1440-dark.png");
});
