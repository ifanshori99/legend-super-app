// Failed-item recovery (ORD-08) on the mock API (bead legend-tz1; PRD §3 F10
// "Pemulihan Item Gagal", "Voucher Permintaan Maaf", "Ulasan Pascamakan").
// Run: pnpm test:e2e:mock e2e/legend-tz1.mock.spec.ts — mock mode only, no API
// and no DB.
import { expect, test, type Page } from "@playwright/test";

const privateRoom = `v1.${"E".repeat(40)}.${"F".repeat(43)}`; // P1: one open failed item
const freeTable = `v1.${"C".repeat(40)}.${"D".repeat(43)}`; // A01: pay-first, no minimum spend

async function joinTable(page: Page, token: string) {
  await page.goto(`/t/${token}`);
  // The guest count is asked inline in the menu (PRD §3 "Scan & Sesi Meja").
  // A click before hydration is lost, so retry it until the panel is open.
  const save = page.getByRole("button", { name: "Simpan" });
  await expect(async () => {
    await page.getByRole("button", { name: /Pilih jumlah tamu/ }).click();
    await expect(save).toBeVisible({ timeout: 1_500 });
  }).toPass({ timeout: 30_000 });
  await save.click();
  await expect(
    page.getByRole("button", { name: /Pilih jumlah tamu/ }),
  ).toHaveCount(0);
}

test.describe("Failed-item recovery and review (mock)", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        if (!sessionStorage.getItem("e2e-init")) {
          sessionStorage.clear();
          sessionStorage.setItem("e2e-init", "1");
          localStorage.setItem("legend-theme", "light");
        }
      } catch {
        // storage blocked: the test still runs
      }
    });
  });

  test("ORD-08 the guest is told on every screen and offered only swap or voucher", async ({
    page,
  }) => {
    await joinTable(page, privateRoom);
    await expect(
      page.getByRole("status").filter({ hasText: "belum bisa kami siapkan" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Pilih solusi" }).click();
    await expect(
      page.getByRole("heading", { name: "Item belum bisa disiapkan" }),
    ).toBeVisible();
    await expect(page.getByRole("radio")).toHaveCount(2);
    await expect(page.getByRole("radio", { name: /Ganti menu/ })).toBeVisible();
    await expect(
      page.getByRole("radio", { name: /Kredit ke voucher/ }),
    ).toBeVisible();
    await expect(page.getByText(/refund|uang kembali/i)).toHaveCount(0);
  });

  test("ORD-08 choosing the voucher credit shows the voucher receipt and clears the prompt", async ({
    page,
  }) => {
    await joinTable(page, privateRoom);
    await page.getByRole("link", { name: "Pilih solusi" }).click();
    await page.getByRole("radio", { name: /Kredit ke voucher/ }).click();
    await page.getByRole("button", { name: "Konfirmasi pilihan" }).click();
    await expect(page.getByText("Voucher permintaan maaf")).toBeVisible();
    await expect(page.getByText(/LEG-[A-Z0-9]{4}-[A-Z0-9]{4}/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Pilih solusi" })).toHaveCount(
      0,
    );
  });

  test("ORD-08 a swap shows the price difference before it is confirmed", async ({
    page,
  }) => {
    await joinTable(page, privateRoom);
    await page.getByRole("link", { name: "Pilih solusi" }).click();
    await page.getByRole("radio", { name: /Ganti menu/ }).click();
    await expect(page.getByText(/Mie Goreng Jawa/)).toBeVisible();
    await expect(
      page.getByText(/Bayar selisih|Dikreditkan|Tanpa selisih/),
    ).toBeVisible();
  });

  test("PRD Ulasan Pascamakan: a paid guest rates the visit and gets the Google review CTA", async ({
    page,
  }) => {
    await joinTable(page, freeTable);
    await page.getByRole("searchbox", { name: "Cari menu" }).fill("espresso");
    await page.getByRole("button", { name: "Lihat detail Espresso" }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("radio", { name: /Dingin/ }).click();
    await sheet.getByRole("radio", { name: "Normal" }).click();
    await sheet.getByRole("button", { name: /^Tambah · / }).click();
    await expect(sheet).toBeHidden();

    // Pay the held order, so the bill is settled and the review opens.
    await page.getByRole("link", { name: "Lihat keranjang" }).click();
    // QRIS is the default method; the button goes straight to the QR screen.
    await page
      .getByRole("button", { name: /^Bayar Rp.* dengan QRIS$/ })
      .click();
    await expect(page.getByRole("img", { name: /Kode QRIS/ })).toBeVisible();
    await expect(
      page.getByText("Pembayaran berhasil", { exact: true }),
    ).toBeVisible({
      timeout: 15_000,
    });

    // The bill must be settled before the review opens (PRD "Ulasan Pascamakan").
    await page.goto(`/t/${freeTable}/bill`);
    await expect(page.getByText("Tagihan lunas")).toBeVisible({
      timeout: 15_000,
    });
    await page.getByRole("link", { name: "Beri ulasan" }).click();
    await expect(
      page.getByRole("heading", { name: "Bagaimana kunjungan Anda?" }),
    ).toBeVisible();
    await page.getByRole("radio", { name: "5 dari 5 bintang" }).click();
    await page
      .getByRole("textbox", { name: "Komentar" })
      .fill("Kopi enak dan pelayanannya cepat.");
    await page.getByRole("button", { name: "Kirim ulasan" }).click();

    await expect(
      page.getByRole("heading", { name: "Terima kasih atas ulasan Anda" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Tulis ulasan di Google/ }),
    ).toHaveAttribute("href", /^https:\/\//);
  });

  test("review stays closed until the bill is paid", async ({ page }) => {
    await joinTable(page, privateRoom);
    await page
      .getByRole("navigation", { name: "Bagian meja" })
      .getByRole("link", { name: "Tagihan", exact: true })
      .click();
    await page.goto(`/t/${privateRoom}/review`);
    await expect(
      page.getByText("Ulasan dibuka setelah tagihan lunas"),
    ).toBeVisible();
  });
});
