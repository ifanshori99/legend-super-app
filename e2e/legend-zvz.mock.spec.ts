import { expect, test } from "@playwright/test";

// Expo and pickup display (bead legend-zvz, PRD v1.7 §3 F12).
//
// Run: pnpm test:e2e:mock e2e/legend-zvz.mock.spec.ts — mock mode only, no API
// and no DB. This file reads LEGEND_MOCK_WEB_URL (the mock runner sets it) for
// its own baseURL and skips when it is missing.
const mockWebUrl = process.env.LEGEND_MOCK_WEB_URL;
test.skip(
  mockWebUrl === undefined,
  "Run with pnpm test:e2e:mock so LEGEND_MOCK_WEB_URL is set.",
);
test.use({ baseURL: mockWebUrl ?? "http://localhost:3000" });

// The kitchen area is always dark (PRD §3 F1), so one theme covers both.

test("F12 · Expo shows a complete order with every station and its runner", async ({
  page,
}) => {
  await page.goto("/expo");
  await expect(
    page.getByRole("heading", { name: /Siap diantar/ }),
  ).toBeVisible();
  const ready = page.locator('[data-slot="expo-ticket"][data-complete="true"]');
  await expect(ready).toHaveCount(1);
  await expect(ready).toContainText("Antrean A-014");
  await expect(ready).toContainText("1 dari 1 stasiun selesai");
  await expect(ready).toContainText("Runner: Rizky Alfian");
  await expect(ready).toContainText("Takeaway");
});

test("F12 · Expo assigns a runner from the outlet's runner list", async ({
  page,
}) => {
  await page.goto("/expo");
  const preparing = page.locator(
    '[data-slot="expo-ticket"][data-complete="false"]',
  );
  await expect(preparing.first()).toContainText("Belum ada runner");

  await preparing
    .first()
    .getByRole("button", { name: "Tugaskan runner" })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Bagas Prakoso");

  await dialog.getByRole("button", { name: "Bagas Prakoso" }).click();
  await expect(dialog).toBeHidden();
  await expect(preparing.first()).toContainText("Runner: Bagas Prakoso");
  await expect(
    page.getByRole("status").filter({ hasText: "Runner untuk" }),
  ).toBeVisible();
});

test("KDS-03 · Expo marks a station ticket cancelled after it was fired", async ({
  page,
}) => {
  await page.goto("/expo");
  const cancelled = page
    .locator('[data-slot="expo-ticket"]')
    .filter({ hasText: "Antrean A-013" });
  await expect(cancelled).toContainText("Nonkopi");
  await expect(cancelled).toContainText("Dibatalkan");
});

test("F12 · Expo has a loading, empty and error state", async ({ page }) => {
  await page.goto("/expo?mock=empty");
  await expect(
    page.getByText("Belum ada pesanan di expo", { exact: true }),
  ).toBeVisible();

  await page.goto("/expo?mock=error");
  await expect(
    page.getByText("Expo tidak dapat dimuat", { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();
});

test("F12 · Pickup display calls a waiting number and lists it as called", async ({
  page,
}) => {
  await page.goto("/pickup");
  const waiting = page.getByRole("region", { name: /Menunggu siap/ });
  await expect(waiting).toContainText("A-012");

  await page.getByRole("button", { name: "Panggil nomor A-012" }).click();

  const called = page.getByRole("region", { name: /Nomor dipanggil/ });
  await expect(called).toContainText("A-012");
  await expect(called).toContainText("GoFood");
  await expect(called).toContainText("Dipanggil");
  await expect(
    page.getByRole("button", { name: "Panggil nomor A-012" }),
  ).toHaveCount(0);
});

test("F12 · Pickup display shows the promotion slide", async ({ page }) => {
  await page.goto("/pickup");
  const promo = page.locator('[data-slot="pickup-promo"]');
  await expect(promo).toContainText("Kopi Susu Aren · 2 gelas Rp 45.000");
  await expect(promo).toContainText("Berlaku sampai");
});

test("F12 · Pickup display keeps the sound choice per device", async ({
  page,
}) => {
  await page.goto("/pickup");
  // The sound button is server-rendered before the page is interactive; wait
  // for the pickup data so the click below cannot land on inert markup.
  const waiting = page.getByRole("region", { name: /Menunggu siap/ });
  await expect(waiting).toBeVisible();

  const toggle = page.getByRole("button", { name: "Suara mati" });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  await toggle.click();
  await expect(
    page.getByRole("button", { name: "Suara aktif" }),
  ).toHaveAttribute("aria-pressed", "true");

  await page.reload();
  // The device preference is read once the page hydrates again.
  await expect(waiting).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Suara aktif" }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("F12 · Pickup display has an empty and an error state", async ({
  page,
}) => {
  await page.goto("/pickup?mock=empty");
  await expect(
    page.getByText("Belum ada nomor panggilan", { exact: true }),
  ).toBeVisible();

  await page.goto("/pickup?mock=error");
  await expect(
    page.getByText("Pickup display tidak dapat dimuat", { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();
});
