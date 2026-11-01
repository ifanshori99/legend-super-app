// QR customer journey on the mock API (beads legend-2m4, legend-8sh; PRD §3
// F10, Alur A). Runs against a web server started with VITE_API_MOCK=true and
// DEPLOYMENT_MODE=development, so no database or API is needed. The shared
// Playwright config (playwright.config.ts) builds the real API; run this file
// with a config whose webServer is `pnpm --filter @starter/web dev` in mock
// mode until the e2e runner is repaired (bead legend-y8n9).
import { expect, test } from "@playwright/test";

const token = `v1.${"C".repeat(40)}.${"D".repeat(43)}`; // table A01, pay-first, free
const soldOutToken = token;

test.describe("QR customer journey (mock)", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        sessionStorage.clear();
        localStorage.setItem("legend-theme", "light");
      } catch {
        // storage blocked: the test still runs without a remembered theme
      }
    });
  });

  test("ORD-01 scan, join with a guest count and see the menu without login", async ({
    page,
  }) => {
    await page.goto(`/t/${token}`);
    await expect(
      page.getByRole("heading", { name: /Selamat datang di Cafe Legend/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Mulai pesan" }).click();
    await expect(page.getByText("Meja A01 · 2 tamu")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Menu", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Kopi", level: 2, exact: true }),
    ).toBeVisible();
  });

  test("ORD-05 sold-out items are listed but cannot be added", async ({
    page,
  }) => {
    await page.goto(`/t/${soldOutToken}?q=sup%20buntut`);
    await page.getByRole("button", { name: "Lihat menu dulu" }).click();
    const card = page.getByRole("listitem").filter({ hasText: "Sup Buntut" });
    await expect(card.getByText("Habis").first()).toBeVisible();
    await expect(
      card.getByRole("button", { name: /Tambah|Pilih opsi/ }),
    ).toHaveCount(0);
    await card.getByRole("button", { name: /sedang habis/ }).click();
    await expect(
      page.getByText("Menu ini sedang habis dan belum bisa dipesan."),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Habis", exact: true }),
    ).toBeDisabled();
  });

  test("ORD-01 ORD-02 ORD-03 ORD-11 order from the menu, pay first, see status", async ({
    page,
  }) => {
    await page.goto(`/t/${token}`);
    await page.getByRole("button", { name: "Mulai pesan" }).click();

    // Search, then open an item whose choices are required.
    await page.getByRole("searchbox", { name: "Cari menu" }).fill("espresso");
    await expect(
      page.getByRole("heading", { name: "Espresso", level: 3 }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Lihat detail Espresso" }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("button", { name: /^Tambah ·/ }).click();
    await expect(
      sheet.getByText("Pilih salah satu varian dulu."),
    ).toBeVisible();
    await expect(
      sheet.getByText(/Pilih minimal 1 untuk Tingkat gula/),
    ).toBeVisible();

    await sheet.getByRole("radio", { name: /Dingin/ }).click();
    await sheet.getByRole("radio", { name: "Normal" }).click();
    await sheet.getByRole("button", { name: "Tambah jumlah" }).click();
    await sheet.getByRole("button", { name: /^Tambah ·/ }).click();
    await expect(sheet).toBeHidden();

    // The shared cart shows it; the nav carries the count.
    await page.getByRole("link", { name: /Keranjang/ }).click();
    await expect(
      page.getByRole("heading", { name: "Keranjang meja" }),
    ).toBeVisible();
    await expect(
      page.getByText("Espresso (Dingin)", { exact: true }),
    ).toBeVisible();

    // Checkout: the server quote adds service charge and tax to the menu price.
    await page.getByRole("link", { name: "Lanjut ke checkout" }).click();
    await expect(
      page.getByRole("heading", { name: "Checkout", level: 1 }),
    ).toBeVisible();
    await expect(page.getByText(/Service charge \(5%\)/)).toBeVisible();
    await expect(page.getByText(/PBJT.*\(10%\)/)).toBeVisible();
    await expect(page.getByText(/menit/).first()).toBeVisible();
    await page.getByRole("button", { name: /^Bayar Rp/ }).click();

    // Pay-first: choose QRIS, scan, wait for the (mock) gateway confirmation.
    const pay = page.getByRole("dialog");
    await pay.getByRole("radio", { name: /QRIS/ }).click();
    await pay.getByRole("button", { name: "Lanjut bayar" }).click();
    await expect(page.getByRole("img", { name: /Kode QRIS/ })).toBeVisible();
    await expect(page.getByText("Menunggu pembayaran Anda…")).toBeVisible();
    await expect(page.getByText("Pembayaran berhasil")).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole("link", { name: "Lihat status pesanan" }).click();
    await expect(page.getByText(/QR-\d{8}-\d{4}/).first()).toBeVisible();
  });

  test("ORD-04 a closed or unknown session cannot order and offers a new one", async ({
    page,
  }) => {
    const sessionId = "00000000-0000-4000-8000-0000000fffff";
    await page.addInitScript(
      ([qrToken, id]) => {
        const stored = {
          qrToken,
          sessionId: id,
          sessionToken: "st_expired_session_token_value_0001",
          sessionTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          participantId: null,
          pax: 2,
          outcome: "joined",
        };
        sessionStorage.setItem(
          `legend-qr-session:${qrToken}`,
          JSON.stringify(stored),
        );
        sessionStorage.setItem(`legend-qr-by-session:${id}`, qrToken);
      },
      [token, sessionId],
    );
    await page.goto(`/t/${token}`);
    await expect(page.getByText("Sesi meja sudah berakhir")).toBeVisible();
    await page.getByRole("link", { name: /Keranjang/ }).click();
    await expect(page.getByText("Sesi meja sudah berakhir")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Lanjut ke checkout" }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Buka sesi baru" }).click();
    await expect(
      page.getByRole("button", { name: "Mulai pesan" }),
    ).toBeVisible();
  });
});
