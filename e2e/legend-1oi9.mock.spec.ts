// Staff facility screens (WS-09 FE, bead legend-1oi9) against the FE mock
// runtime: the booth status board, the cleaning checklist, the incident log and
// the emergency alert screen. No API and no database — every request is served
// by features/facility-staff/mock.ts through VITE_API_MOCK=true, the way the
// bead was built (frontend guide, "Typed endpoints and mock mode").
//
// Covers FAC-06 (a unit that is not clean or is under maintenance cannot be
// booked) and FAC-08 (the emergency signal reaches staff and the response is
// recorded in the incident log). PRD v1.7 §3 F25 "Siklus Kebersihan" and
// "Keselamatan".
//
// Run: pnpm test:e2e:mock e2e/legend-1oi9.mock.spec.ts — mock mode only.
//
// The mock server address is injected by playwright.mock.config.ts; a spec
// started without it skips instead of failing, so the real-API suite never runs
// this file.
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

/** The first assertion of the first test on a route pays Vite's cold compile. */
const COLD_START_TIMEOUT_MS = 30_000;

/**
 * A cold Vite dev server takes 20–35 s for a route's first SSR + client module
 * graph, and the data arrives one client fetch after the SSR HTML. The staff
 * routes are not in `e2e/mock-global-setup.ts` `WARM_ROUTES`, so every test
 * raises its own budget instead of relying on a warm server.
 */
function coldStart(page: Page) {
  test.setTimeout(120_000);
  page.setDefaultTimeout(COLD_START_TIMEOUT_MS);
  // The navigation itself compiles the route server-side; a loaded machine has
  // been seen at 35 s, so the document load gets twice the assertion budget.
  page.setDefaultNavigationTimeout(60_000);
}

function unitTile(page: Page, code: string) {
  return page.locator(`[data-slot="facility-unit"][data-unit-code="${code}"]`);
}

test("FAC-06 the booth board groups units by area and shows the bookable rule", async ({
  page,
}) => {
  coldStart(page);
  await page.goto("/fasilitas?mock=normal");

  await expect(
    page.getByRole("heading", { level: 1, name: "Papan status bilik" }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await expect(
    page.getByRole("region", { name: "Perlu tindakan" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Area Pria" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Area Wanita" }),
  ).toBeVisible();

  // P1 is clean and free: the only unit that can be booked right now.
  const p1 = unitTile(page, "P1");
  await expect(p1).toHaveAttribute("data-unit-status", "available");
  await expect(p1).toHaveAttribute("data-bookable", "true");
  await expect(p1.getByText("Bisa dibooking", { exact: true })).toBeVisible();

  // P2 is in use: the session end and the cleaning buffer are visible.
  const p2 = unitTile(page, "P2");
  await expect(p2).toHaveAttribute("data-unit-status", "in_use");
  await expect(p2).toHaveAttribute("data-bookable", "false");
  await expect(p2.getByText(/Sisa \d+ menit/)).toBeVisible();
  await expect(p2.getByText(/Bisa dibooking lagi sekitar/)).toBeVisible();

  // W1 needs cleaning and W2 is under maintenance: neither is bookable.
  const w1 = unitTile(page, "W1");
  await expect(w1).toHaveAttribute("data-unit-status", "needs_cleaning");
  await expect(w1).toHaveAttribute("data-bookable", "false");
  await expect(w1.getByText("Perlu dibersihkan")).toBeVisible();
  await expect(
    w1.getByText("Belum bisa dibooking", { exact: true }),
  ).toBeVisible();

  const w2 = unitTile(page, "W2");
  await expect(w2).toHaveAttribute("data-unit-status", "maintenance");
  await expect(w2).toHaveAttribute("data-bookable", "false");
  await expect(w2.getByText("Perawatan", { exact: true })).toBeVisible();
});

test("FAC-06 a completed cleaning checklist returns the unit to bookable", async ({
  page,
}) => {
  coldStart(page);
  await page.goto("/fasilitas/kebersihan?mock=normal");

  await expect(
    page.getByRole("heading", { level: 1, name: "Kebersihan bilik" }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  const task = page.locator('[data-slot="cleaning-task"][data-unit-code="W1"]');
  await expect(task).toBeVisible();
  await expect(task).toHaveAttribute("data-task-status", "pending");
  await task.getByRole("button", { name: "Buka checklist" }).click();

  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Checklist bilik W1" }),
  ).toBeVisible();

  // The checklist is inert until the task starts (contract cleaning cycle).
  const floor = dialog.getByRole("checkbox", {
    name: "Lantai bersih dan kering",
  });
  await expect(floor).toBeDisabled();
  await dialog.getByRole("button", { name: "Mulai tugas" }).click();
  await expect(floor).toBeEnabled();

  for (const label of [
    "Lantai bersih dan kering",
    "Saluran air lancar",
    "Perlengkapan lengkap",
    "Sampah dibuang",
  ]) {
    const checkbox = dialog.getByRole("checkbox", { name: label });
    await checkbox.click();
    await expect(checkbox).toHaveAttribute("aria-checked", "true");
  }

  await dialog.getByRole("button", { name: "Selesaikan pembersihan" }).click();
  await expect(
    page
      .getByText("Bilik W1 selesai dibersihkan dan kembali bisa dibooking.")
      .first(),
  ).toBeVisible();

  // The unit returns to available through the contract transition; navigate
  // client-side so the mock store keeps the mutation.
  await page.getByRole("link", { name: "Papan bilik", exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Papan status bilik" }),
  ).toBeVisible();
  const w1 = unitTile(page, "W1");
  await expect(w1).toHaveAttribute("data-unit-status", "available");
  await expect(w1).toHaveAttribute("data-bookable", "true");
});

test("FAC-06 maintenance removes a unit from booking and release needs cleaning", async ({
  page,
}) => {
  coldStart(page);
  await page.goto("/fasilitas?mock=normal");
  const p1 = unitTile(page, "P1");
  await expect(p1).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });

  await p1.getByRole("button", { name: "Tandai perawatan" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Tandai perawatan bilik P1" }),
  ).toBeVisible();
  await dialog.getByLabel(/Catatan perawatan/).fill("Keran bocor.");
  await dialog.getByRole("button", { name: "Tandai perawatan" }).click();

  await expect(
    page.getByText("Bilik P1 masuk perawatan.").first(),
  ).toBeVisible();
  await expect(p1).toHaveAttribute("data-unit-status", "maintenance");
  await expect(p1).toHaveAttribute("data-bookable", "false");
  await expect(
    p1.getByText("Belum bisa dibooking", { exact: true }),
  ).toBeVisible();

  // FAC-06: releasing maintenance lands on needs_cleaning, never available.
  await p1.getByRole("button", { name: "Aktifkan lagi" }).click();
  await expect(
    page
      .getByText("Bilik P1 diaktifkan lagi dan menunggu dibersihkan.")
      .first(),
  ).toBeVisible();
  await expect(p1).toHaveAttribute("data-unit-status", "needs_cleaning");
  await expect(p1).toHaveAttribute("data-bookable", "false");
});

test("FAC-08 the emergency button raises a signal and Tangani records the response", async ({
  page,
}) => {
  coldStart(page);
  await page.goto("/fasilitas/darurat?mock=normal");

  await expect(
    page.getByRole("heading", { level: 1, name: "Layar darurat" }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  // The seeded open damage report is a maintenance matter (incident log
  // only): it must not raise the alarm state (PRD §4 Alur V).
  await expect(page.getByText("Tidak ada darurat aktif")).toBeVisible();
  await expect(
    page.locator('[data-slot="emergency-alert"][data-unit-code="W2"]'),
  ).toHaveCount(0);

  await page
    .locator('[data-slot="emergency-unit-button"][data-unit-code="P1"]')
    .click();
  await expect(
    page.getByText("Sinyal darurat bilik P1 terkirim.").first(),
  ).toBeVisible();
  await expect(page.getByText("Darurat aktif", { exact: true })).toBeVisible();

  const alert = page.locator(
    '[data-slot="emergency-alert"][data-unit-code="P1"]',
  );
  await expect(alert).toBeVisible();
  await expect(alert.getByText(/Sejak \d+ detik/)).toBeVisible();
  await alert.getByRole("button", { name: /Tangani/ }).click();

  await expect(
    page.getByText(/Darurat bilik P1 ditangani dalam \d+ detik\./).first(),
  ).toBeVisible();
  const ack = page.locator('[data-slot="emergency-ack"][data-unit-code="P1"]');
  await expect(ack).toBeVisible();
  await expect(ack.getByText("Tim di lokasi menangani tamu.")).toBeVisible();

  // FAC-08: raising a signal creates an incident log entry and the
  // acknowledgement (with the seconds it took) stays on record.
  await page.getByRole("link", { name: "Buka log insiden" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Log insiden" }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  const logged = page
    .locator(
      '[data-slot="facility-incident"][data-incident-status="responded"]',
    )
    .filter({ hasText: "Bilik P1 · Area Pria" });
  await expect(logged).toBeVisible();
  await expect(logged.getByText(/Tanggapan \d+ detik/)).toBeVisible();
  await expect(logged.getByText("Tim di lokasi menangani tamu.")).toBeVisible();
});

test("FAC-08 the incident log raises an incident and acknowledges it", async ({
  page,
}) => {
  coldStart(page);
  await page.goto("/fasilitas/insiden?mock=normal");

  await expect(
    page.getByRole("heading", { level: 1, name: "Log insiden" }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });

  // The seeded offline damage signal is open and says so (FAC-08 edge case).
  const seeded = page.locator(
    '[data-slot="facility-incident"][data-incident-status="open"]',
  );
  await expect(seeded).toHaveCount(1);
  await expect(seeded.getByText("Tercatat offline")).toBeVisible();
  const seededId = await seeded.getAttribute("data-incident-id");

  // Raise an incident without a booth; it appears in the log at once.
  await page.getByRole("radio", { name: "Kerusakan" }).click();
  await page.getByLabel(/Catatan/).fill("Kaca pintu area WFC retak.");
  await page.getByRole("button", { name: "Catat insiden" }).click();
  await expect(page.getByText("Insiden dicatat.").first()).toBeVisible();
  const raised = page
    .locator('[data-slot="facility-incident"][data-incident-type="damage"]')
    .filter({ hasText: "Tanpa bilik" });
  await expect(raised).toBeVisible();

  // Acknowledge the seeded open incident with an action note.
  const seededCard = page.locator(
    `[data-slot="facility-incident"][data-incident-id="${seededId}"]`,
  );
  await seededCard.getByRole("button", { name: "Tangani" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/Tindakan/).fill("Teknisi memeriksa keran.");
  await dialog.getByRole("button", { name: "Simpan tanggapan" }).click();
  await expect(page.getByText("Tanggapan tersimpan.").first()).toBeVisible();
  const acknowledged = page.locator(
    `[data-slot="facility-incident"][data-incident-id="${seededId}"]`,
  );
  await expect(acknowledged).toHaveAttribute(
    "data-incident-status",
    "responded",
  );
  await expect(
    acknowledged.getByText("Teknisi memeriksa keran."),
  ).toBeVisible();
});

test("FAC-06 the board has honest empty and error states", async ({ page }) => {
  coldStart(page);
  await page.goto("/fasilitas?mock=empty");
  await expect(page.getByText("Belum ada bilik")).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });

  await page.goto("/fasilitas?mock=error");
  await expect(page.getByText("Papan bilik tidak dapat dimuat")).toBeVisible();
  await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();
});

for (const width of [390, 1440] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`legend-1oi9 visual ${width} ${theme}`, async ({ page }) => {
      // Four cold routes in one test, each on its first hit of the run.
      test.setTimeout(180_000);
      coldStart(page);
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (value) => localStorage.setItem("legend-theme", value),
        theme,
      );

      await page.goto("/fasilitas?mock=normal", { waitUntil: "networkidle" });
      await expect(
        page.getByRole("heading", { level: 1, name: "Papan status bilik" }),
      ).toBeVisible();
      await expect(unitTile(page, "P1")).toBeVisible();
      await captureScreenshot(page, `legend-1oi9/board-${width}-${theme}.png`);

      await page.goto("/fasilitas/kebersihan?mock=normal", {
        waitUntil: "networkidle",
      });
      await expect(
        page.getByRole("heading", { level: 1, name: "Kebersihan bilik" }),
      ).toBeVisible();
      await expect(
        page.locator('[data-slot="cleaning-task"][data-unit-code="W1"]'),
      ).toBeVisible();
      await captureScreenshot(
        page,
        `legend-1oi9/cleaning-${width}-${theme}.png`,
      );

      await page.goto("/fasilitas/insiden?mock=normal", {
        waitUntil: "networkidle",
      });
      await expect(
        page.getByRole("heading", { level: 1, name: "Log insiden" }),
      ).toBeVisible();
      await expect(
        page.locator('[data-slot="facility-incident"]').first(),
      ).toBeVisible();
      await captureScreenshot(
        page,
        `legend-1oi9/incidents-${width}-${theme}.png`,
      );

      await page.goto("/fasilitas/darurat?mock=normal", {
        waitUntil: "networkidle",
      });
      await expect(
        page.getByRole("heading", { level: 1, name: "Layar darurat" }),
      ).toBeVisible();
      await expect(
        page.locator(
          '[data-slot="emergency-unit-button"][data-unit-code="P1"]',
        ),
      ).toBeVisible();
      await captureScreenshot(
        page,
        `legend-1oi9/emergency-${width}-${theme}.png`,
      );
    });
  }
}

test("legend-1oi9 visual empty and error", async ({ page }) => {
  coldStart(page);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.addInitScript(
    (value) => localStorage.setItem("legend-theme", value),
    "light",
  );
  await page.goto("/fasilitas?mock=empty", { waitUntil: "networkidle" });
  await expect(page.getByText("Belum ada bilik")).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
  await captureScreenshot(page, "legend-1oi9/board-empty-390-light.png");

  await page.goto("/fasilitas?mock=error", { waitUntil: "networkidle" });
  await expect(page.getByText("Papan bilik tidak dapat dimuat")).toBeVisible();
  await captureScreenshot(page, "legend-1oi9/board-error-390-light.png");
});
