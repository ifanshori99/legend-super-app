import { expect, test } from "@playwright/test";

// Design v2 ticket treatment (bead legend-ujxl, owner answers Q25/Q26):
// a KDS late ticket is a full red header band, the station switch is a neutral
// segmented control (no accent), and expo and pickup tickets carry the same
// state band. Runs in mock mode against @starter/shared/kitchen fixtures:
// `pnpm test:e2e:mock` starts that server and exports LEGEND_MOCK_WEB_URL.
const mockWebUrl = process.env.LEGEND_MOCK_WEB_URL;
test.skip(
  mockWebUrl === undefined,
  "Set LEGEND_MOCK_WEB_URL to a VITE_API_MOCK=true web server to run the mock-mode screens.",
);
test.use({ baseURL: mockWebUrl ?? "http://localhost:3000" });

// The kitchen area is always dark (PRD §3 F1), so one theme covers both.

test("Q26 · a late KDS ticket carries a full danger header band", async ({
  page,
}) => {
  await page.goto("/kds");
  const late = page.locator(
    '[data-slot="kds-ticket"][data-timer-state="late"]',
  );
  await expect(late).toHaveCount(1);

  const band = late.locator('[data-slot="status-band"]');
  await expect(band).toHaveAttribute("data-tone", "danger");
  await expect(band).toContainText("Lewat target");
  // Elapsed time is minutes:seconds (DESIGN.md §5: 30px tabular).
  await expect(band).toContainText(/\d+:\d{2}/);
});

test("Q26 · a finished KDS ticket shows its duration in a success band", async ({
  page,
}) => {
  await page.goto("/kds");
  const done = page.locator(
    '[data-slot="kds-ticket"][data-timer-state="done"]',
  );
  const band = done.locator('[data-slot="status-band"]');
  await expect(band).toHaveAttribute("data-tone", "success");
  await expect(band).toContainText("Selesai");
  // Fixture ticket fired 03:57 and was bumped 04:05: a fixed 8:00, not a clock.
  await expect(band).toContainText("8:00");
});

test("Q21 · the station switch is a neutral segmented control, not buttons", async ({
  page,
}) => {
  await page.goto("/kds");
  const stations = page.getByRole("radiogroup", { name: "Stasiun" });
  await expect(stations).toBeVisible();
  await expect(stations.getByRole("radio", { name: /^Kopi/ })).toBeChecked();
  // Each station carries its live queue count (DESIGN.md §5: a station group
  // with counts, selected in ink — never an accent-filled chip).
  await expect(
    stations.getByRole("radio", { name: /^Kopi \d+$/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Kopi", exact: true }),
  ).toHaveCount(0);

  // Selecting a station still swaps the board (KDS-01).
  await stations.getByRole("radio", { name: /^Dapur/ }).click();
  await expect(
    page.locator('[data-slot="kds-ticket"]').filter({ hasText: "Sate Ayam" }),
  ).toHaveCount(1);
});

test("Q26 · expo orders carry the same state band", async ({ page }) => {
  await page.goto("/expo");
  const ready = page.locator('[data-slot="expo-ticket"][data-complete="true"]');
  const readyBand = ready.locator('[data-slot="status-band"]');
  await expect(readyBand).toHaveAttribute("data-tone", "success");
  await expect(readyBand).toContainText("Siap diantar");
  await expect(readyBand).toContainText("Antrean A-014");

  const preparing = page.locator(
    '[data-slot="expo-ticket"][data-complete="false"]',
  );
  await expect(
    preparing.first().locator('[data-slot="status-band"]'),
  ).toHaveAttribute("data-tone", "neutral");
  await expect(preparing.first()).toContainText("Sedang disiapkan");
});

test("Q26 · pickup tiles carry the same state band and keep the call flow", async ({
  page,
}) => {
  await page.goto("/pickup");
  const called = page.locator(
    '[data-slot="pickup-call"][data-call-status="called"]',
  );
  await expect(called.locator('[data-slot="status-band"]')).toHaveAttribute(
    "data-tone",
    "info",
  );
  await expect(called).toContainText("Dipanggil");

  const waiting = page.locator(
    '[data-slot="pickup-call"][data-call-status="assigned"]',
  );
  await expect(waiting.locator('[data-slot="status-band"]')).toHaveAttribute(
    "data-tone",
    "neutral",
  );
  await expect(waiting).toContainText("Menunggu siap");

  await page.getByRole("button", { name: "Panggil nomor A-012" }).click();
  const newlyCalled = page
    .locator('[data-slot="pickup-call"][data-call-status="called"]')
    .filter({ hasText: "12" });
  await expect(newlyCalled).toHaveCount(1);
  await expect(
    newlyCalled.locator('[data-slot="status-band"]'),
  ).toHaveAttribute("data-tone", "info");
});
