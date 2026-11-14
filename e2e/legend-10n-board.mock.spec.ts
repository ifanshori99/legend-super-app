import { expect, test } from "@playwright/test";

// This exercises the UI against synthetic kitchen fixtures; timing, durable
// reconnect delivery and the server audit trail require the integration bead.
//
// Run: pnpm test:e2e:mock e2e/legend-10n-board.mock.spec.ts — mock mode only, no API and no DB.
const mockWebUrl = process.env.LEGEND_MOCK_WEB_URL;
test.skip(!mockWebUrl, "Requires the mock-mode web server");
test.use({ baseURL: mockWebUrl ?? "http://localhost:3225" });

test("KDS-01 station selection shows its routed tickets and all-day count", async ({
  page,
}) => {
  await page.goto("/kds?mock=normal");
  await expect(
    page.getByRole("radio", { name: /^Dapur(?: \d+)?$/ }),
  ).toBeVisible();
  await page.getByRole("radio", { name: /^Dapur(?: \d+)?$/ }).click();
  const sate = page
    .locator('[data-slot="kds-ticket"]')
    .filter({ hasText: "Sate Ayam" });
  await expect(sate).toHaveCount(1);
  await expect(sate).toContainText("Bumbu kacang");
  await expect(sate).toContainText("Tanpa lontong");
  await expect(page.getByText("Jumlah antrean", { exact: true })).toBeVisible();
  await expect(
    page
      .locator('[data-slot="kds-ticket"]')
      .filter({ hasText: "Kopi Susu Aren" }),
  ).toHaveCount(0);
});

test("KDS-02 station changes preserve the displayed ticket without duplicates", async ({
  page,
}) => {
  await page.goto("/kds?mock=normal");
  await page.getByRole("radio", { name: /^Dapur(?: \d+)?$/ }).click();
  const sate = page
    .locator('[data-slot="kds-ticket"]')
    .filter({ hasText: "Sate Ayam" });
  await expect(sate).toHaveCount(1);
  await page.getByRole("radio", { name: /^Kopi(?: \d+)?$/ }).click();
  await page.getByRole("radio", { name: /^Dapur(?: \d+)?$/ }).click();
  await expect(sate).toHaveCount(1);
});

test("KDS-03 a voided item is visibly marked on its station", async ({
  page,
}) => {
  await page.goto("/kds?mock=normal");
  await page.getByRole("radio", { name: /^Nonkopi(?: \d+)?$/ }).click();
  const ticket = page
    .locator('[data-slot="kds-ticket"]')
    .filter({ hasText: "Matcha Latte" });
  await expect(ticket).toContainText("Dibatalkan");
});

test("KDS-04 start and bump update the ticket through the kitchen contract", async ({
  page,
}) => {
  await page.goto("/kds?mock=normal");
  await page.getByRole("radio", { name: /^Dapur(?: \d+)?$/ }).click();
  const ticket = page
    .locator('[data-slot="kds-ticket"]')
    .filter({ hasText: "Sate Ayam" });
  await ticket.getByRole("button", { name: "Mulai", exact: true }).click();
  await expect(
    ticket.getByRole("button", { name: "Selesai", exact: true }),
  ).toBeVisible();
  await ticket.getByRole("button", { name: "Selesai", exact: true }).click();
  await expect(
    ticket.getByRole("button", { name: "Panggil ulang", exact: true }),
  ).toBeVisible();
});
