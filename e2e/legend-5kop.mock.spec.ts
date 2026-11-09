// legend-5kop: 1mi5 follow-ups. (a) the typed `orgOutlet.*` catalog needs no
// runtime fallback, (b) the cutoff saved on /kelola/pengaturan/outlet reaches
// the app-level outlet clock on every route, (c) `?mock=empty` reaches the
// outlet list empty state, (d) a cutoff change appends an
// `outlet.business_day_cutoff.updated` event the /audit screen lists.
//
// Runs against the FE mock runtime (VITE_API_MOCK=true):
//   pnpm test:e2e:mock e2e/legend-5kop.mock.spec.ts
import { expect, test, type Page } from "@playwright/test";
import { waitForHydration } from "./hydration.ts";

// The clock must come from the outlet, never from the device: the assertions
// below still read Asia/Jakarta values in a New York browser.
test.use({ timezoneId: "America/New_York" });

const DEFAULT_CUTOFF = "04:00";
const EDITED_CUTOFF = "03:30";
const SAVED_COPY = "Pengaturan outlet tersimpan.";

/** Opens the outlet screen and saves one cutoff through the real mock PATCH. */
async function saveCutoff(page: Page, cutoff: string): Promise<void> {
  await page.goto("/kelola/pengaturan/outlet");
  await waitForHydration(page);
  const input = page.locator("#outlet-cutoff");
  await expect(input).toHaveValue(DEFAULT_CUTOFF, { timeout: 15_000 });
  await input.fill(cutoff);
  await page.getByRole("button", { name: "Simpan" }).click();
  // The success status only renders after the mock PATCH resolved (and the
  // audit event, when it landed, was appended).
  await expect(page.getByText(SAVED_COPY).first()).toBeVisible({
    timeout: 15_000,
  });
}

test("legend-5kop the saved cutoff reaches the outlet clock on another route", async ({
  page,
}) => {
  await saveCutoff(page, EDITED_CUTOFF);

  // A full navigation to another area. The server HTML keeps the fixture
  // default (sessionStorage is browser-only); after hydration the app-level
  // provider re-reads the saved rows, so the operations header — which renders
  // `useOutletClock()` — exposes the saved cutoff.
  await page.goto("/pos/meja");
  await waitForHydration(page);
  const header = page.locator("header[data-outlet-time-zone]");
  await expect(header).toContainText("Cafe Legend Bandung", {
    timeout: 15_000,
  });
  await expect(header).toHaveAttribute(
    "data-business-day-cutoff",
    EDITED_CUTOFF,
    { timeout: 15_000 },
  );
  await expect(header).toHaveAttribute("data-outlet-time-zone", "Asia/Jakarta");

  // Fail-closed still wins over the saved store: `?tenant=none` resolves to
  // null in both the server and the client pass, so the neutral copy and the
  // documented default clock stay.
  await page.goto("/pos/meja?tenant=none");
  await waitForHydration(page);
  await expect(header).toContainText("Outlet belum dipilih", {
    timeout: 15_000,
  });
  await expect(header).toHaveAttribute(
    "data-business-day-cutoff",
    DEFAULT_CUTOFF,
  );
});

test("legend-5kop ?mock=empty reaches the outlet list empty state", async ({
  page,
}) => {
  await page.goto("/kelola/pengaturan/outlet?mock=empty");
  await waitForHydration(page);

  // GET /api/org/outlets passes the scenario to paginateFixture, so the list
  // is empty and the screen renders its empty state instead of a form.
  const empty = page.locator('[data-slot="empty-state"]');
  await expect(empty).toBeVisible({ timeout: 20_000 });
  await expect(empty).toContainText("Belum ada data");
  await expect(page.locator("#outlet-cutoff")).toHaveCount(0);
});

test("legend-5kop saving the cutoff appends the audit event", async ({
  page,
}) => {
  // The management sidebar only renders at desktop width.
  await page.setViewportSize({ width: 1440, height: 900 });
  await saveCutoff(page, EDITED_CUTOFF);

  // Client-side navigation: the audit mock's store lives in memory for this
  // document, so a full reload would re-seed it. The sidebar link keeps the
  // SPA alive and the appended event on the first page.
  await page
    .getByRole("navigation", { name: "Navigasi utama" })
    .first()
    .getByRole("link", { name: "Log audit" })
    .click();
  await expect(page).toHaveURL(/\/audit$/);

  const rows = page
    .getByRole("list", { name: "Daftar catatan audit" })
    .getByRole("listitem");
  const cutoffRow = rows
    .filter({ hasText: "outlet.business_day_cutoff.updated" })
    .first();
  await expect(cutoffRow).toBeVisible({ timeout: 20_000 });
  await expect(cutoffRow).toContainText("Cafe Legend Bandung");
});
