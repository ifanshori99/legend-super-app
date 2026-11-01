// Failed-item recovery (ORD-08) on the mock API (bead legend-tz1; PRD §3 F10
// "Pemulihan Item Gagal", "Voucher Permintaan Maaf", "Ulasan Pascamakan").
// Run: pnpm exec playwright test -c playwright.mock.config.ts e2e/legend-tz1.spec.ts
import { expect, test, type Page } from "@playwright/test";

const privateRoom = `v1.${"E".repeat(40)}.${"F".repeat(43)}`; // P1: one open failed item

async function joinTable(page: Page, token: string) {
  await page.goto(`/t/${token}`);
  // The guest-count dialog opens on the first visit (PRD §3 "Scan & Sesi Meja").
  await page.getByRole("button", { name: "Mulai pesan" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
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

  test("review stays closed until the bill is paid", async ({ page }) => {
    await joinTable(page, privateRoom);
    await page.getByRole("link", { name: "Tagihan", exact: true }).click();
    await page.goto(`/t/${privateRoom}/review`);
    await expect(
      page.getByText("Ulasan dibuka setelah tagihan lunas"),
    ).toBeVisible();
  });
});
