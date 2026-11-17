// Customer payment pages (bead legend-2w5) against mock mode.
//
// Run: pnpm test:e2e:mock e2e/legend-2w5-payment.mock.spec.ts — mock mode only, no API and no DB.
//
// The spec skips (instead of failing) when no mock origin is set, so the
// standard runner stays green. Test names carry the acceptance IDs.
import { expect, test } from "@playwright/test";

const MOCK_URL = process.env.LEGEND_MOCK_WEB_URL ?? process.env.WS05_MOCK_URL;

test.skip(
  !MOCK_URL,
  "Mock runner not started: use pnpm test:e2e:mock (playwright.mock.config.ts).",
);

// Demo links from @starter/shared/payment fixtures (see features/ws05-payment/mock.ts).
const CHOOSE = "pl_pending_7b6d4c8fa1d3e5b7c9f0a2d4";
const QRIS = "pl_qris_4c8fa1d3e5b7c9f0a2d47b6d4c8fa1d3";
const TRANSFER = "pl_transfer_6f0ac3d5e7b9a1c2d4e6f8a0b2c4d6e8";
const PAID = "pl_paid_1a2b3c4d5e6f70819a2b3c4d5e6f7081";
const EXPIRED = "pl_expired_2b3c4d5e6f70819a2b3c4d5e6f7081a2";
const DOWN = "pl_down_4d5e6f70819a2b3c4d5e6f7081a2b3c4";

const path = (token: string, query = "") =>
  `${MOCK_URL}/bayar/${token}${query}`;

test.use({ viewport: { width: 390, height: 844 } });

test("PAY-02 a payment redirect never marks the bill paid while the intent is pending", async ({
  page,
}) => {
  // Gateways send the browser back with ?status=success; the screen must not
  // read it. Only the polled intent status may settle the bill.
  await page.goto(path(QRIS, "?status=success&mock=normal"));
  await expect(page.getByText("Menunggu pembayaran")).toBeVisible();
  await expect(page.locator("svg title")).toHaveText("Pindai kode QRIS");
  await expect(page.getByText("Pembayaran berhasil")).toHaveCount(0);
});

test("PAY-02 choosing Virtual Account shows the bank number to pay", async ({
  page,
}) => {
  await page.goto(path(CHOOSE, "?mock=normal"));
  await page.getByRole("radio", { name: /Virtual Account/ }).check();
  await page.getByRole("combobox", { name: "Bank" }).click();
  await page.getByRole("option", { name: "BCA" }).click();
  await page.getByRole("button", { name: "Lanjutkan pembayaran" }).click();
  await expect(page.getByText("Nomor Virtual Account")).toBeVisible();
  await expect(page.getByText(/^8808\d{12}$/)).toBeVisible();
});

test("PAY-02 a bank transfer shows the unique code and the exact total", async ({
  page,
}) => {
  await page.goto(path(TRANSFER, "?mock=normal"));
  await expect(page.getByText("Kode unik", { exact: true })).toBeVisible();
  await expect(page.getByText(/Rp\s?144\.722/)).toBeVisible();
});

test("PAY-02 gateway down points the guest to the cashier and tells the staff", async ({
  page,
}) => {
  await page.goto(path(DOWN, "?mock=normal"));
  await expect(
    page.getByText("Pembayaran online sedang gangguan"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Beri tahu kasir" }).click();
  // The inline confirmation, not the identical toast in the notification region.
  await expect(
    page
      .locator("#main-content")
      .getByText(/Kasir sudah menerima permintaanmu/),
  ).toBeVisible();
});

test("PAY-02 a paid link shows the confirmation and the late-payment note", async ({
  page,
}) => {
  await page.goto(path(PAID, "?mock=normal"));
  await expect(page.getByText("Pembayaran berhasil")).toBeVisible();
  await expect(
    page.getByText("Pembayaran diterima setelah kode kedaluwarsa"),
  ).toBeVisible();
});

test("PAY-02 an expired code offers a fresh one", async ({ page }) => {
  await page.goto(path(EXPIRED, "?mock=normal"));
  await expect(page.getByText("Kode pembayaran kedaluwarsa")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Buat kode baru" }),
  ).toBeVisible();
});

test("PAY-02 the payment screen has honest empty and error states", async ({
  page,
}) => {
  await page.goto(path(CHOOSE, "?mock=empty"));
  await expect(page.getByText("Tidak ada yang perlu dibayar")).toBeVisible();

  await page.goto(path(CHOOSE, "?mock=error"));
  await expect(page.getByText("Tagihan tidak dapat dimuat")).toBeVisible();
  await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();
});
