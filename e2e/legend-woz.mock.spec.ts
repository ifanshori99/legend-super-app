// Order status, call waiter, bill, split and point claim on the mock API (bead
// legend-woz; PRD §3 F10 "Status Pesanan", "Panggil Waiter & Minta Tagihan",
// "Split Bill", "Klaim Poin per Orang"; acceptance ORD-06, ORD-07).
// Run: pnpm test:e2e:mock e2e/legend-woz.mock.spec.ts — mock mode only, no API
// and no DB.
import { expect, test, type Page } from "@playwright/test";

const privateRoom = `v1.${"E".repeat(40)}.${"F".repeat(43)}`; // P1, open bill, bill + 2 splits (1 paid)
const freeTable = `v1.${"C".repeat(40)}.${"D".repeat(43)}`; // A01, pay-first, no minimum spend

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

test.describe("Order status, waiter, bill and points (mock)", () => {
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

  test("ORD-07 every item shows its status and the waiter call reaches the table list", async ({
    page,
  }) => {
    await joinTable(page, privateRoom);
    await page
      .getByRole("navigation", { name: "Bagian meja" })
      .getByRole("link", { name: "Pesanan meja", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Pesanan", level: 1 }),
    ).toBeVisible();
    await expect(page.getByText("Kopi Susu Aren")).toBeVisible();
    await expect(page.getByText("Diterima").first()).toBeVisible();

    // The frame header (desktop) carries its own "Panggil waiter"; this test
    // drives the one on the orders page.
    await page
      .getByRole("main")
      .getByRole("button", { name: "Panggil waiter" })
      .click();
    await page.getByRole("radio", { name: "Minta alat makan" }).click();
    await page
      .getByRole("button", { name: /^Panggil waiter$|^Kirim/ })
      .last()
      .click();
    await expect(page.getByText("Menunggu waiter")).toBeVisible();
  });

  test("ORD-10 a bill that was requested shows the minimum spend and what is left to pay", async ({
    page,
  }) => {
    await joinTable(page, privateRoom);
    await page
      .getByRole("navigation", { name: "Bagian meja" })
      .getByRole("link", { name: "Tagihan", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Tagihan", level: 1 }),
    ).toBeVisible();
    await expect(page.getByText("Tagihan sudah diminta")).toBeVisible();
    await expect(page.getByText("Minimum spend zona")).toBeVisible();
    await expect(page.getByText("Sisa tagihan")).toBeVisible();
    await expect(page.getByText("Lunas")).toBeVisible();
    await expect(
      page.getByText(/Jumlah semua bagian .*, sama dengan total tagihan/),
    ).toBeVisible();
  });

  test("ORD-03 ORD-06 'Bagi tagihan' at checkout opens the bill and splits the order exactly", async ({
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

    await page.getByRole("link", { name: "Lihat keranjang" }).click();
    // Checkout holds the order for payment and hands it to the split screen.
    await page.getByRole("button", { name: "Bagi tagihan" }).click();
    await expect(
      page.getByRole("heading", { name: "Tagihan", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Bagi tagihan", level: 2 }),
    ).toBeVisible();

    // The preview sums exactly to the bill total before anything is created.
    await expect(
      page.getByText(/Jumlah semua bagian .*, sama dengan total tagihan/),
    ).toBeVisible();
    await page.getByRole("button", { name: "Buat pembagian" }).click();
    await expect(page.getByText("Bagian 1")).toBeVisible();
    await expect(page.getByText("Bagian 2")).toBeVisible();

    // One guest pays their share; the gateway confirms and the bill reflects it.
    await page
      .getByRole("button", { name: "Bayar bagian ini" })
      .first()
      .click();
    const pay = page.getByRole("dialog");
    await pay.getByRole("radio", { name: /QRIS/ }).click();
    await pay.getByRole("button", { name: /^Bayar Rp.* dengan QRIS$/ }).click();
    await expect(page.getByRole("img", { name: /Kode QRIS/ })).toBeVisible();
    await expect(
      page.getByText("Pembayaran berhasil", { exact: true }),
    ).toBeVisible({
      timeout: 15_000,
    });

    await page.goto(`/t/${freeTable}/bill`);
    await expect(page.getByText("Lunas").first()).toBeVisible();
    await expect(page.getByText("Belum dibayar").first()).toBeVisible();

    // With a share paid, checkout no longer offers to charge the whole order.
    await page.goto(`/t/${freeTable}/checkout`);
    await expect(
      page.getByRole("link", { name: "Buka tagihan" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /^Bayar Rp/ })).toHaveCount(
      0,
    );
  });

  test("ORD-06 point claim asks for the guest's own share and confirms it", async ({
    page,
  }) => {
    await joinTable(page, privateRoom);
    await page
      .getByRole("navigation", { name: "Bagian meja" })
      .getByRole("link", { name: "Tagihan", exact: true })
      .click();
    await page.getByRole("button", { name: /^Klaim \d+ poin$/ }).click();
    await expect(page.getByText(/poin sudah masuk ke akun Anda/)).toBeVisible();
  });
});
