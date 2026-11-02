import { expect, test } from "@playwright/test";

// Connectivity kit (bead legend-diq). PRD v1.7 §3 F5 (Print Agent, Fallback
// Berlapis, Mode Latihan), §4 Alur F and EDG-05.
//
// These specs run against the web app in mock mode (VITE_API_MOCK=true), so
// they need no API or database. The mock link state is seeded through
// localStorage before the first load (see features/ws02-edge/mock.ts).
//
// First assertion = explicit timeout (bead legend-1336): `pnpm test:e2e:mock`
// warms every route first (e2e/mock-global-setup.ts), but a dev server started
// by hand is cold and needs 20-35 s for the first route compile.

/** Cold Vite dev server: the first SSR hit can take >20 s (legend-1336). */
const COLD_START_TIMEOUT_MS = 30_000;

test("Alur F: a lost cloud link shows the offline banner and the waiter fallback", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("legend-edge-mock", "cloud_down");
  });
  await page.goto("/operasional/koneksi");

  const banner = page.locator("[data-edge-banner]");
  await expect(banner).toContainText("Koneksi cloud terputus", {
    timeout: COLD_START_TIMEOUT_MS,
  });
  await expect(banner).toContainText("Pesanan QR dialihkan ke waiter");
  await expect(banner).toContainText("menunggu sinkron");

  // Step 2: guests see the waiter notice instead of a QR order form.
  await expect(page.getByText("Silakan pesan melalui waiter")).toBeVisible();
});

test("EDG-05: an offline printer is alerted and the queue retries and reprints", async ({
  page,
}) => {
  await page.goto("/operasional/koneksi");

  // The kitchen printer stopped reporting more than 30 seconds ago.
  const attention = page.getByRole("region", {
    name: "Perangkat yang perlu perhatian",
  });
  await expect(attention).toContainText("Printer Dapur");
  await expect(attention).toContainText("Luring");

  await page.getByRole("button", { name: "Buka antrean cetak" }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toContainText("Gagal");
  await drawer.getByRole("button", { name: "Cetak lagi" }).click();
  await expect(
    page.getByText("Pekerjaan cetak dikirim ulang ke antrean.", {
      exact: true,
    }),
  ).toBeVisible();

  // A printed receipt can be reprinted: a new job referencing the original.
  await drawer.getByRole("button", { name: "Cetak ulang" }).first().click();
  await expect(
    page.getByText("Cetak ulang dikirim ke antrean.", { exact: true }),
  ).toBeVisible();
  await expect(drawer).toContainText("Salinan");
});

test("Mode Latihan: the watermark follows the device training switch", async ({
  page,
}) => {
  await page.goto("/operasional/koneksi");
  await expect(page.locator("[data-edge-training-watermark]")).toHaveCount(0);

  await page
    .getByRole("switch", { name: "Mode latihan perangkat ini" })
    .click();
  await expect(page.locator("[data-edge-training-watermark]")).toBeVisible();
  await expect(
    page.getByText("Mode latihan diperbarui.", { exact: true }),
  ).toBeVisible();
});
