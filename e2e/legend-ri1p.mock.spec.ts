import { expect, test } from "@playwright/test";

// legend-ri1p: the shells read the tenant/outlet context instead of the
// catalog brand, "Outlet belum dipilih" and a hardcoded time zone. Mock mode
// serves the Cafe Legend core fixtures (packages/shared/src/core/fixtures.ts):
// brand "Cafe Legend", outlet BDG-01 "Cafe Legend Bandung" in Asia/Jakarta
// with the owner Q39 default business_day_cutoff 04:00.
//
// Runs on the mock web server (no API, no database):
//   pnpm test:e2e:mock e2e/legend-ri1p.mock.spec.ts
const BRAND = "Cafe Legend";
const OUTLET = "Cafe Legend Bandung";
const TIME_ZONE = "Asia/Jakarta";
const CUTOFF = "04:00";

test("legend-ri1p shells show the configured brand, outlet and outlet clock", async ({
  page,
}) => {
  // The management sidebar only renders its full brand at desktop width.
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto("/kelola");
  const sidebar = page
    .getByRole("navigation", { name: "Navigasi utama" })
    .first();
  await expect(sidebar.getByText(BRAND, { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  await page.goto("/member");
  await expect(
    page.getByRole("banner").getByText(BRAND, { exact: true }),
  ).toBeVisible({ timeout: 15_000 });

  // The operations status bar shows the outlet name and exposes the clock the
  // shell renders with, so the test checks the configured values themselves.
  await page.goto("/pos/meja");
  const header = page.locator("header[data-outlet-time-zone]");
  await expect(header).toContainText(OUTLET, { timeout: 15_000 });
  await expect(header).toHaveAttribute("data-outlet-time-zone", TIME_ZONE);
  await expect(header).toHaveAttribute("data-business-day-cutoff", CUTOFF);
});

test("legend-ri1p no config keeps the neutral shell copy", async ({ page }) => {
  // ?tenant=none is the mock fail-closed switch (lib/mock/tenant-context.ts).
  await page.goto("/pos/meja?tenant=none");
  const header = page.locator("header[data-outlet-time-zone]");
  await expect(header).toContainText("Outlet belum dipilih", {
    timeout: 15_000,
  });
  // Without an outlet the clock falls back to the shared default clock.
  await expect(header).toHaveAttribute("data-outlet-time-zone", TIME_ZONE);
  await expect(header).toHaveAttribute("data-business-day-cutoff", CUTOFF);

  // The customer shell falls back to the catalog brand, never a blank header.
  await page.goto("/member?tenant=none");
  await expect(
    page.getByRole("banner").getByText("Legend", { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
});
