// CRM campaigns and automations (bead legend-hbad; PRD v1.7 §3.21 "Kampanye",
// "Otomasi", LOY-04, AI-12) against the FE mock runtime: no API, no database.
// The screens read the @starter/shared/crm fixtures (segments, campaigns,
// campaign sends and results) through VITE_API_MOCK=true; the automation tab
// reads the feature's local fixture because the contract has no automation
// endpoint.
//
// How to run: `LEGEND_MOCK_PORT=3296 pnpm test:e2e:mock e2e/legend-hbad.mock.spec.ts`
// starts a mock-mode web server and names it in LEGEND_MOCK_WEB_URL. The
// production e2e config ignores `*.mock.spec.ts`, and with no variable set
// every test skips. `LEGEND_CAPTURE_SCREENSHOTS=1` refreshes the tracked
// evidence for this bead through e2e/screenshots.ts.
import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots";

const MOCK_URL = process.env.LEGEND_MOCK_WEB_URL;
const COLD_START_TIMEOUT_MS = 30_000;

test.skip(
  !MOCK_URL,
  "Needs a VITE_API_MOCK=true server (pnpm test:e2e:mock); see the header of this file.",
);

const NAV = { waitUntil: "networkidle" as const };

async function open(page: Page, path: string, title: string) {
  await page.goto(`${MOCK_URL}${path}?mock=normal`, NAV);
  await expect(
    page.getByRole("heading", { level: 1, name: title }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
}

/** The management topbar owns the area h1; the section renders an h2. */
async function section(page: Page) {
  await expect(
    page.getByRole("heading", { level: 2, name: "Kampanye" }).first(),
  ).toBeVisible();
}

/**
 * Server-rendered controls drop a click that lands before hydration. Every
 * action below is safe to retry (open dialog, choose an option, submit), so
 * retry until React owns the control (same pattern as legend-r0wz).
 */
async function retry(action: () => Promise<void>) {
  await expect(action).toPass({ timeout: 15_000 });
}

test("LOY-04 §3.21 Kampanye: the list shows status, channel, schedule, A/B and results, and counts the recipients skipped without consent", async ({
  page,
}) => {
  await open(page, "/kelola/kampanye", "Kampanye");
  await section(page);

  const table = page.getByRole("table");
  // The finished fixture campaign: 342 recipients, 330 sent, 57 redeemed,
  // Rp 8.450.000 revenue; the A/B split is 50%.
  const completed = table
    .getByRole("row")
    .filter({ hasText: "Promo Akhir Pekan" });
  await expect(completed).toBeVisible();
  await expect(completed).toContainText("Selesai");
  await expect(completed).toContainText("WhatsApp template");
  await expect(completed).toContainText("B 50%");
  await expect(completed).toContainText("342");
  await expect(completed).toContainText("330");
  await expect(completed).toContainText("57");
  await expect(completed).toContainText(/8\.450\.000/);

  // LOY-04: the 12 skipped recipients of the finished campaign are counted.
  await expect(page.getByText(/12 penerima dilewati/)).toBeVisible();

  // The draft fixture campaign has no results yet.
  const draft = table
    .getByRole("row")
    .filter({ hasText: "Selamat Datang Member Baru" });
  await expect(draft).toContainText("Draf");
  await expect(draft).toContainText("Web push");
  await expect(draft).toContainText("Belum dijadwalkan");

  // The status filter narrows the list to one state.
  await retry(async () => {
    await page
      .getByRole("combobox", { name: "Filter status kampanye" })
      .click();
    await expect(page.getByRole("option", { name: "Draf" })).toBeVisible({
      timeout: 1000,
    });
  });
  await page.getByRole("option", { name: "Draf" }).click();
  await expect(table.getByText("Selamat Datang Member Baru")).toBeVisible();
  await expect(table.getByText("Promo Akhir Pekan")).toHaveCount(0);
});

test("AI-12 §3.21 Kampanye: create a campaign with a segment, a Dibantu AI draft, a simple A/B test and a schedule", async ({
  page,
}) => {
  await open(page, "/kelola/kampanye", "Kampanye");

  await retry(async () => {
    await page.getByRole("button", { name: "Buat kampanye" }).click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 1000 });
  });
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Buat kampanye" }),
  ).toBeVisible();

  await dialog.getByLabel("Nama kampanye").fill("Promo Kopi Pagi");

  await retry(async () => {
    await dialog.getByRole("combobox", { name: "Segmen audiens" }).click();
    await expect(
      page.getByRole("option", { name: /Pelanggan Tidak Aktif 30 Hari/ }),
    ).toBeVisible({ timeout: 1000 });
  });
  await page
    .getByRole("option", { name: /Pelanggan Tidak Aktif 30 Hari/ })
    .click();

  // The audience block shows the live preview count and the segment's stored
  // size (128 in the fixtures), so both the preview and the segment agree.
  const audience = dialog.getByTestId("campaign-audience");
  await expect(audience).toContainText(/\d+ pelanggan/);
  await expect(audience).toContainText(
    "Ukuran segmen tersimpan: 128 pelanggan.",
  );

  // AI-12: the draft is generated locally and labelled as a draft to edit.
  await retry(async () => {
    await dialog.getByRole("button", { name: "Dibantu AI" }).click();
    await expect(dialog.getByText("Draf · Dibantu AI")).toBeVisible({
      timeout: 1000,
    });
  });
  await expect(dialog.getByLabel("Judul pesan")).toHaveValue(
    "Ada penawaran untukmu",
  );
  await expect(
    dialog.getByText(/bukan keluaran model langsung/).first(),
  ).toBeVisible();

  // Simple A/B test: variant B gets 40% of the audience.
  await retry(async () => {
    await dialog.getByRole("switch", { name: "Uji A/B sederhana" }).click();
    await expect(dialog.getByLabel("Judul varian B")).toBeVisible({
      timeout: 1000,
    });
  });
  await dialog.getByLabel("Judul varian B").fill("Versi B untuk pagi");
  await dialog.getByLabel("Isi varian B").fill("Penawaran sarapan untukmu.");
  await dialog.getByLabel("Porsi varian B (%)").fill("40");
  await expect(dialog.getByText("Varian B 40% · Varian A 60%")).toBeVisible();

  await dialog.getByLabel("Jadwal kirim").fill("2026-11-10T09:00");

  // Evidence: the filled create sheet on a phone.
  await page.setViewportSize({ width: 390, height: 900 });
  await captureScreenshot(page, "legend-hbad/baru-390-light.png", {
    fullPage: false,
  });

  await dialog.getByRole("button", { name: "Simpan kampanye" }).click();
  await expect(
    page.getByText("Kampanye Promo Kopi Pagi dibuat.").first(),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByText("Promo Kopi Pagi").filter({ visible: true }).first(),
  ).toBeVisible();
  // A campaign with a send time starts as scheduled.
  await expect(
    page.getByText("Terjadwal").filter({ visible: true }).first(),
  ).toBeVisible();
});

test("LOY-04 §3.21 Kampanye: one StatStrip holds every result and the send-status table explains the skipped recipients", async ({
  page,
}) => {
  await open(page, "/kelola/kampanye", "Kampanye");
  await page
    .getByRole("table")
    .getByRole("link", { name: "Promo Akhir Pekan", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Promo Akhir Pekan" }),
  ).toBeVisible();
  // Scope to the header pill: the completed timestamp label is also "Selesai".
  await expect(
    page.locator('[data-slot="status-pill"]').filter({ hasText: "Selesai" }),
  ).toBeVisible();

  const strip = page.getByRole("region", { name: "Hasil kampanye" });
  await expect(strip).toBeVisible();
  for (const value of ["342", "330", "321", "9", "12", "184", "57"]) {
    await expect(strip.getByText(value, { exact: true })).toBeVisible();
  }
  await expect(strip).toContainText(/8\.450\.000/);
  await expect(strip).toContainText(/115\.500/);

  // LOY-04: 12 recipients were skipped, and the notice names both reasons the
  // contract's campaignSendDecision can return.
  await expect(page.getByText(/12 penerima dilewati/)).toBeVisible();
  await expect(
    page.getByText("tidak ada persetujuan pemasaran aktif", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("keanggotaan tidak aktif", { exact: true }),
  ).toBeVisible();

  const skippedRow = page
    .getByRole("row")
    .filter({ hasText: "Dilewati (tanpa persetujuan)" });
  await expect(skippedRow).toContainText("12");

  // The A/B variant and the audience are on the same page.
  await expect(page.getByText("Varian B", { exact: true })).toBeVisible();
  await expect(page.getByText(/Porsi varian B: 50%/)).toBeVisible();
  await expect(page.getByText(/Gold & Platinum/)).toBeVisible();

  await page.setViewportSize({ width: 390, height: 900 });
  await captureScreenshot(page, "legend-hbad/hasil-390-light.png");
});

test("LOY-04 §3.21 Kampanye: only legal status transitions are offered, and consent gates the derived results", async ({
  page,
}) => {
  await open(page, "/kelola/kampanye", "Kampanye");
  await page
    .getByRole("table")
    .getByRole("link", { name: "Selamat Datang Member Baru", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Selamat Datang Member Baru" }),
  ).toBeVisible();
  await expect(page.getByText("Draf", { exact: true })).toBeVisible();

  // A draft can be scheduled or cancelled — never started or completed.
  await expect(page.getByRole("button", { name: "Jadwalkan" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Batalkan" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Mulai sekarang" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Selesaikan" })).toHaveCount(0);

  await retry(async () => {
    await page.getByRole("button", { name: "Jadwalkan" }).click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 1000 });
  });
  const scheduleDialog = page.getByRole("dialog");
  await scheduleDialog.getByLabel("Jadwal kirim").fill("2026-11-12T10:00");
  await scheduleDialog.getByRole("button", { name: "Simpan jadwal" }).click();
  await expect(
    page.getByText("Kampanye Selamat Datang Member Baru dijadwalkan.").first(),
  ).toBeVisible();
  await expect(page.getByText("Terjadwal", { exact: true })).toBeVisible();

  // A scheduled campaign may start now.
  await page.getByRole("button", { name: "Mulai sekarang" }).click();
  await expect(
    page
      .getByText("Kampanye Selamat Datang Member Baru mulai berjalan.")
      .first(),
  ).toBeVisible();
  await expect(page.getByText("Berjalan", { exact: true })).toBeVisible();

  // The 87-customer segment minus the 3 recipients the consent rule skips
  // (membership inactive or no marketing consent in the fixtures).
  const strip = page.getByRole("region", { name: "Hasil kampanye" });
  await expect(strip.getByText("87", { exact: true })).toBeVisible();
  await expect(strip.getByText("84", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/3 penerima dilewati/)).toBeVisible();

  // A running campaign may complete.
  await page.getByRole("button", { name: "Selesaikan" }).click();
  await expect(
    page.getByText("Kampanye Selamat Datang Member Baru selesai.").first(),
  ).toBeVisible();
  await expect(
    page.locator('[data-slot="status-pill"]').filter({ hasText: "Selesai" }),
  ).toBeVisible();
  await expect(
    page.getByText("Tidak ada aksi tersedia untuk status ini."),
  ).toBeVisible();
});

test("§3.21 Otomasi: the four triggers show channel, state, audience and last run, and a toggle persists in this browser", async ({
  page,
}) => {
  await open(page, "/kelola/kampanye/otomasi", "Kampanye");
  await section(page);
  await expect(
    page.getByRole("link", { name: "Otomasi", exact: true }),
  ).toHaveAttribute("aria-current", "page");

  for (const name of [
    "Selamat datang member baru",
    "Ulang tahun",
    "Win-back pelanggan tidak aktif",
    "Pengingat poin kedaluwarsa",
  ])
    await expect(page.getByRole("heading", { name })).toBeVisible();

  await expect(page.getByText("24 pelanggan")).toBeVisible();
  await expect(page.getByText("128 pelanggan")).toBeVisible();
  await expect(page.getByText("Belum pernah", { exact: true })).toBeVisible();
  // No endpoint exists for automations; the tab says it is a local preview.
  await expect(
    page.getByText(/Kontrak API otomasi kampanye belum ada/),
  ).toBeVisible();
  await expect(page.getByText(/Aturan yang sama berlaku/)).toBeVisible();

  const toggle = page.getByRole("switch", {
    name: "Aktifkan otomasi Pengingat poin kedaluwarsa",
  });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await retry(async () => {
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true", {
      timeout: 1000,
    });
  });

  // Persistence: the choice is read back from this browser's storage only.
  await page.reload(NAV);
  await expect(
    page.getByRole("switch", {
      name: "Aktifkan otomasi Pengingat poin kedaluwarsa",
    }),
  ).toHaveAttribute("aria-checked", "true");

  await page.setViewportSize({ width: 390, height: 900 });
  await captureScreenshot(page, "legend-hbad/otomasi-390-light.png");
});

test("§3.21 Kampanye: empty, error and offline states offer a way forward", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/kelola/kampanye?mock=empty`, NAV);
  await expect(
    page.getByRole("heading", { level: 1, name: "Kampanye" }),
  ).toBeVisible();
  await expect(page.getByText("Belum ada kampanye")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 900 });
  await captureScreenshot(page, "legend-hbad/kampanye-empty-390-light.png");

  await page.goto(`${MOCK_URL}/kelola/kampanye?mock=error`, NAV);
  await expect(page.getByRole("alert").first()).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
  await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();
  await captureScreenshot(page, "legend-hbad/kampanye-error-390-light.png");

  // Offline: the shell says the connection is gone instead of failing silently.
  await page.goto(`${MOCK_URL}/kelola/kampanye?mock=normal`, NAV);
  await page.context().setOffline(true);
  await expect(page.getByText(/Internet terputus/).first()).toBeVisible();
  await page.context().setOffline(false);
});

const SHOTS = [
  ["390-light", 390, "light"],
  ["390-dark", 390, "dark"],
  ["1440-light", 1440, "light"],
] as const;

for (const [name, width, theme] of SHOTS) {
  test(`§3.21 Kampanye: visual list ${name}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(
      (value) => localStorage.setItem("legend-theme", value),
      theme,
    );
    await page.goto(`${MOCK_URL}/kelola/kampanye?mock=normal`, NAV);
    await expect(
      page.getByRole("heading", { level: 1, name: "Kampanye" }),
    ).toBeVisible();
    // No horizontal page scroll at any width (wide tables scroll inside).
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
    await captureScreenshot(page, `legend-hbad/kampanye-${name}.png`);
  });
}
