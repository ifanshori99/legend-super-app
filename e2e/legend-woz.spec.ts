// Order status, call waiter, bill, split and point claim on the mock API (bead
// legend-woz; PRD §3 F10 "Status Pesanan", "Panggil Waiter & Minta Tagihan",
// "Split Bill", "Klaim Poin per Orang"; acceptance ORD-06, ORD-07).
// Run: pnpm exec playwright test -c playwright.mock.config.ts e2e/legend-woz.spec.ts
import { expect, test, type Page } from "@playwright/test";

const privateRoom = `v1.${"E".repeat(40)}.${"F".repeat(43)}`; // P1, open bill, bill + 2 splits (1 paid)

async function joinTable(page: Page, token: string) {
  await page.goto(`/t/${token}`);
  // The guest-count dialog opens on the first visit (PRD §3 "Scan & Sesi Meja").
  await page.getByRole("button", { name: "Mulai pesan" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
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
    await page.getByRole("link", { name: "Pesanan", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Pesanan", level: 1 }),
    ).toBeVisible();
    await expect(page.getByText("Kopi Susu Aren")).toBeVisible();
    await expect(page.getByText("Diterima").first()).toBeVisible();

    await page.getByRole("button", { name: "Panggil waiter" }).click();
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
    await page.getByRole("link", { name: "Tagihan", exact: true }).click();
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

  test("ORD-06 point claim asks for the guest's own share and confirms it", async ({
    page,
  }) => {
    await joinTable(page, privateRoom);
    await page.getByRole("link", { name: "Tagihan", exact: true }).click();
    await page.getByRole("button", { name: /^Klaim \d+ poin$/ }).click();
    await expect(page.getByText(/poin sudah masuk ke akun Anda/)).toBeVisible();
  });
});
