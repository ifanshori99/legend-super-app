// Customer display (WS-04, bead legend-azt): the paired second screen at the
// cashier shows the bill lines, the total and the dynamic QRIS, and refreshes
// the code when it expires (PRD v1.7 §3 F11 "Customer Display", §3 F13 "QRIS
// Dinamis"). Runs against the FE mock runtime: no API, no database.
//
// `pnpm test:e2e:mock` starts the VITE_API_MOCK=true web server and names it in
// LEGEND_MOCK_WEB_URL (playwright.mock.config.ts).
import { expect, test, type Page } from "@playwright/test";

const baseURL =
  process.env.LEGEND_MOCK_WEB_URL ?? process.env.E2E_MOCK_BASE_URL;

test.skip(
  !baseURL,
  "Mock runner not started: use pnpm test:e2e:mock (playwright.mock.config.ts).",
);
test.use({ baseURL });

/** The mock's demo switch: which display state the terminal would push. */
async function setDisplayState(page: Page, state: string) {
  await page.addInitScript(
    (value) => window.localStorage.setItem("legend-display-mock", value),
    state,
  );
}

async function openDisplay(page: Page, search = "") {
  await page.goto(`/pos/customer-display${search}`);
  await expect(
    page.getByRole("heading", { name: "Layar pelanggan" }),
  ).toBeVisible({ timeout: 60_000 });
}

test("F11 customer display: a live bill shows its items, total and QRIS", async ({
  page,
}) => {
  test.slow();
  await openDisplay(page);

  // The bill the paired terminal is working on (fixture BDG-01-POS-0001).
  await expect(
    page.getByRole("heading", { name: /Pesanan BDG-01-POS-0001/ }),
  ).toBeVisible();
  await expect(page.getByText("Menunggu pembayaran")).toBeVisible();
  for (const name of [
    "Kopi Susu Aren",
    "Nasi Goreng Kampung",
    "Croissant Mentega",
  ])
    await expect(page.getByText(name)).toBeVisible();
  // A line note reaches the customer as written.
  await expect(page.getByText("Catatan: Tidak pedas")).toBeVisible();

  // Totals: prices exclude tax and service charge (owner decision 12); the
  // screen shows the final total, not a client-side calculation.
  await expect(
    page.getByRole("heading", { name: "Rincian tagihan" }),
  ).toBeVisible();
  await expect(page.getByText("Service charge")).toBeVisible();
  await expect(page.getByText("Pajak")).toBeVisible();
  // The hero total is a `<data>` value; the v3 Money tier renders the `Rp`
  // prefix at 0.6em, so the figure is the stable assertion.
  await expect(page.locator('data[value="120100"]').first()).toBeVisible();

  // The dynamic QRIS, its amount and the countdown under it.
  await expect(
    page.getByRole("img", { name: /Kode QRIS pembayaran/ }),
  ).toBeVisible();
  await expect(page.getByText(/^Berlaku \d+:\d{2}$/)).toBeVisible();
});

test("F11 customer display: no bill open shows the idle slide", async ({
  page,
}) => {
  test.slow();
  await openDisplay(page, "?mock=empty");
  await expect(
    page.getByRole("heading", { name: "Selamat datang" }),
  ).toBeVisible();
  await expect(page.getByText("Menunggu transaksi")).toBeVisible();
  await expect(page.getByRole("img", { name: /Kode QRIS/ })).toHaveCount(0);
});

test("F11 customer display: an error says how to fix it", async ({ page }) => {
  test.slow();
  await openDisplay(page, "?mock=error");
  await expect(
    page.getByText("Layar pelanggan tidak dapat dimuat"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();
});

test("F11 customer display: offline is its own state", async ({ page }) => {
  test.slow();
  await openDisplay(page, "?mock=offline");
  await expect(page.getByText("Layar pelanggan sedang offline")).toBeVisible();
  await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();
});

test("F11/F13 customer display: an expired QRIS is refreshed, not left payable", async ({
  page,
}) => {
  test.slow();
  await setDisplayState(page, "awaiting_expired");
  await openDisplay(page);

  // The terminal served a code that already expired: the screen says so and
  // reads again; the next read carries a live code with a countdown.
  await expect(page.getByText("Kode kedaluwarsa, menyegarkan…")).toBeVisible();
  await expect(page.getByText(/^Berlaku \d+:\d{2}$/)).toBeVisible({
    timeout: 15_000,
  });
});

test("F11 customer display: a paid bill shows the tenders and the change", async ({
  page,
}) => {
  test.slow();
  await setDisplayState(page, "paid");
  await openDisplay(page);
  await expect(
    page.getByRole("heading", { name: "Pembayaran berhasil" }),
  ).toBeVisible();
  await expect(page.getByText("Tunai")).toBeVisible();
  await expect(page.getByText("Poin")).toBeVisible();
  await expect(page.getByText("Kembalian", { exact: true })).toBeVisible();
  await expect(page.locator('data[value="4900"]')).toBeVisible();
});

test("F11 customer display: a bill still being taken has no QR yet", async ({
  page,
}) => {
  test.slow();
  await setDisplayState(page, "ordering");
  await openDisplay(page);
  await expect(page.getByText("Pesanan dicatat")).toBeVisible();
  await expect(page.getByText("Kasir masih mencatat pesanan")).toBeVisible();
  await expect(page.getByRole("img", { name: /Kode QRIS/ })).toHaveCount(0);
});
