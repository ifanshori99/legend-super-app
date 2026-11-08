// QR customer journey on the mock API (beads legend-2m4, legend-8sh; PRD §3
// F10, Alur A).
//
// Run: pnpm test:e2e:mock e2e/legend-2m4.mock.spec.ts — mock mode only, no API
// and no DB.
//
// First assertion = explicit timeout (bead legend-b0kq): the runner warms every
// route first (e2e/mock-global-setup.ts); a cold Vite server needs 20-35 s for
// the first route compile.
import { expect, test, type Page } from "@playwright/test";

/** Cold Vite dev server: the first SSR hit can take >20 s (legend-1336). */
const COLD_START_TIMEOUT_MS = 30_000;

const token = `v1.${"C".repeat(40)}.${"D".repeat(43)}`; // table A01, pay-first, free
const soldOutToken = token;

/** Save the default guest count (2) in the inline panel of the menu. */
async function joinTable(page: Page) {
  // A click before hydration is lost, so retry it until the panel is open.
  const save = page.getByRole("button", { name: "Simpan" });
  await expect(async () => {
    await page.getByRole("button", { name: /Pilih jumlah tamu/ }).click();
    await expect(save).toBeVisible({ timeout: 1_500 });
  }).toPass({ timeout: 30_000 });
  await save.click();
}

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
    // No login wall and no welcome dialog: the menu is the first screen.
    await expect(
      page.getByRole("heading", { name: "Menu untuk meja Anda", level: 1 }),
    ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
    await joinTable(page);
    await expect(page.getByText("2 tamu", { exact: true })).toBeVisible();
    await expect(page.getByText("Meja A01", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Kopi", level: 2, exact: true }),
    ).toBeVisible();
  });

  test("ORD-05 sold-out items are listed but cannot be added", async ({
    page,
  }) => {
    await page.goto(`/t/${soldOutToken}?q=sup%20buntut`);
    const card = page.getByRole("listitem").filter({ hasText: "Sup Buntut" });
    await expect(card.getByText("Habis hari ini")).toBeVisible();
    await expect(
      card.getByRole("button", { name: /Tambah|Pilih opsi/ }),
    ).toHaveCount(0);
    // A click before hydration is lost, so retry it until the sheet opens.
    await expect(async () => {
      await card.getByRole("button", { name: /sedang habis/ }).click();
      await expect(page.getByText("Menu ini sedang habis")).toBeVisible({
        timeout: 1_500,
      });
    }).toPass({ timeout: 30_000 });
    await expect(
      page.getByRole("button", { name: "Habis", exact: true }),
    ).toBeDisabled();
  });

  test("ORD-01 ORD-02 ORD-03 ORD-11 order from the menu, pay first, see status", async ({
    page,
  }) => {
    await page.goto(`/t/${token}`);
    await joinTable(page);

    // Search, then open an item whose choices are required.
    await page.getByRole("searchbox", { name: "Cari menu" }).fill("espresso");
    await expect(
      page.getByRole("heading", { name: "Espresso", level: 3 }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Lihat detail Espresso" }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("button", { name: /^Tambah · / }).click();
    await expect(
      sheet.getByText("Pilih varian sebelum menambahkan."),
    ).toBeVisible();
    await expect(
      sheet.getByText("Pilih tingkat gula sebelum menambahkan."),
    ).toBeVisible();

    await sheet.getByRole("radio", { name: /Dingin/ }).click();
    await sheet.getByRole("radio", { name: "Normal" }).click();
    await sheet.getByRole("button", { name: "Tambah jumlah" }).click();
    await sheet.getByRole("button", { name: /^Tambah · / }).click();
    await expect(sheet).toBeHidden();

    // The shared cart shows it; cart and checkout are one page now.
    await page.getByRole("link", { name: "Lihat keranjang" }).click();
    await expect(
      page.getByRole("heading", { name: "Keranjang & bayar", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByText("Espresso (Dingin)", { exact: true }),
    ).toBeVisible();

    // Checkout: the server quote adds service charge and tax to the menu price.
    await expect(page.getByText(/Service 5%/)).toBeVisible();
    await expect(page.getByText(/PBJT.* 10%/)).toBeVisible();
    await expect(page.getByText(/menit/).first()).toBeVisible();

    // Pay-first: QRIS is the default method; the button goes straight to the
    // QR screen, then the (mock) gateway confirms.
    await expect(page.getByRole("radio", { name: /QRIS/ })).toBeChecked();
    await page
      .getByRole("button", { name: /^Bayar Rp.* dengan QRIS$/ })
      .click();
    await expect(page.getByRole("img", { name: /Kode QRIS/ })).toBeVisible();
    await expect(page.getByText("Menunggu pembayaran")).toBeVisible();
    await expect(
      page.getByText("Pembayaran berhasil", { exact: true }),
    ).toBeVisible({
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
    await page.goto(`/t/${token}/cart`);
    await expect(page.getByText("Sesi meja sudah berakhir")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Bayar Rp/ })).toHaveCount(
      0,
    );
    await page.getByRole("button", { name: "Buka sesi baru" }).click();
    await expect(page.getByRole("button", { name: "Simpan" })).toBeVisible();
  });
});

// Reload persistence: the mock engine snapshots into sessionStorage, so a
// refreshed tab keeps the joined table session and its shared cart (ORD-01).
// No beforeEach here: that script clears sessionStorage on every navigation.
test.describe("QR journey survives a reload (mock)", () => {
  test("ORD-01 ORD-03 a reload keeps the joined table and the shared cart", async ({
    page,
  }) => {
    await page.goto(`/t/${token}`);
    await joinTable(page);
    await expect(page.getByText("2 tamu", { exact: true })).toBeVisible();

    await page.getByRole("searchbox", { name: "Cari menu" }).fill("espresso");
    await page.getByRole("button", { name: "Lihat detail Espresso" }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("radio", { name: /Dingin/ }).click();
    await sheet.getByRole("radio", { name: "Normal" }).click();
    await sheet.getByRole("button", { name: /^Tambah · / }).click();
    await expect(sheet).toBeHidden();

    await page.reload();
    await expect(page.getByText("2 tamu", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Lihat keranjang" }).click();
    await expect(
      page.getByText("Espresso (Dingin)", { exact: true }),
    ).toBeVisible();
  });
});
