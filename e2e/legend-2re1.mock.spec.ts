// Checkout with a voucher code charges the plain quote (bead legend-2re1).
// The place-order contract has no code field, so the order is charged without
// the voucher: the breakdown, the total and the pay button keep the plain
// amount, a warning says the code discount is not part of this payment, and
// the pay button stays blocked until that plain quote exists. Runs against the
// mock-mode web server (no API, no database):
// `pnpm test:e2e:mock e2e/legend-2re1.mock.spec.ts`.
import { expect, test, type Page } from "@playwright/test";

const baseURL =
  process.env.LEGEND_MOCK_WEB_URL ?? process.env.E2E_MOCK_BASE_URL;

test.skip(
  !baseURL,
  "Mock runner not started: use pnpm test:e2e:mock (playwright.mock.config.ts).",
);
test.use({ baseURL });

const freeTable = `v1.${"C".repeat(40)}.${"D".repeat(43)}`; // A01: pay-first, no minimum spend
const voucherCode = "LEG-7K2M-4QX9"; // mock fixture: issued apology voucher, Rp35.000

type MockControl = {
  __legendMock: {
    failNext: (
      id: string,
      error: { status: number; code: string; message?: string },
    ) => void;
  };
};

/**
 * Join the table, add one menu line, and open checkout as a guest.
 * `beforeCart` runs right before the cart link is clicked, i.e. before the
 * checkout page asks for its first quote.
 */
async function openCheckout(page: Page, beforeCart?: () => Promise<void>) {
  await page.goto(`/t/${freeTable}`);
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

  await page.getByRole("button", { name: "Lihat detail Espresso" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("radio", { name: /Dingin/ }).click();
  await sheet.getByRole("radio", { name: "Normal" }).click();
  await sheet.getByRole("button", { name: /^Tambah · / }).click();
  await expect(sheet).toBeHidden();

  await beforeCart?.();

  // Cart and checkout are one page ("Keranjang & bayar").
  await page.getByRole("link", { name: "Lihat keranjang" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Keranjang & bayar" }),
  ).toBeVisible();
}

const payButton = (page: Page) =>
  page
    .getByRole("button", { name: /^Bayar Rp.* dengan QRIS$/ })
    .filter({ visible: true });

/** The amount shown beside the visible "Total pembayaran" label (the aside on
 * desktop; the phone footer is in the DOM too but hidden from lg up). */
const totalAmount = (page: Page) =>
  page
    .getByText("Total pembayaran", { exact: true })
    .filter({ visible: true })
    .locator("xpath=following-sibling::span");

async function applyVoucher(page: Page) {
  await page.getByRole("button", { name: "Kode promo / voucher" }).click();
  await page
    .getByRole("textbox", { name: /Kode promo atau voucher/ })
    .fill(voucherCode);
  await page.getByRole("button", { name: "Pakai kode" }).click();
  await expect(page.getByText(`Kode ${voucherCode} dipakai`)).toBeVisible();
}

test("F10 checkout with a voucher code keeps the plain amount and says the code is not charged", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openCheckout(page);

  // Before the code: the plain total, mirrored in the pay button.
  await expect(totalAmount(page)).toBeVisible();
  const plainTotal = (await totalAmount(page).innerText()).trim();
  const plainCta = (await payButton(page).innerText()).trim();
  expect(plainCta).toContain(plainTotal);
  await expect(
    page.getByText("Potongan kode belum ikut dalam pembayaran ini"),
  ).toHaveCount(0);

  await applyVoucher(page);

  // The code shows as applied, with the warning that it is not charged.
  await expect(
    page
      .getByText("Potongan kode belum ikut dalam pembayaran ini")
      .filter({ visible: true }),
  ).toBeVisible();
  // The amount to pay is still the plain one, in the total and the button.
  await expect(totalAmount(page)).toHaveText(plainTotal);
  await expect(payButton(page)).toHaveText(plainCta);
  await expect(payButton(page)).toBeEnabled();
  // The warning names the same amount that is charged.
  await expect(
    page
      .getByText(
        new RegExp(
          `Potongan kode belum ikut.*Yang dibayar: ${escape(plainTotal)}`,
        ),
      )
      .filter({ visible: true }),
  ).toBeVisible();
  // The breakdown is the plain one: no voucher discount line.
  await expect(page.getByText("Voucher permintaan maaf")).toHaveCount(0);

  // Removing the code clears the warning; the amount is unchanged.
  await page.getByRole("button", { name: "Lepas kode" }).click();
  await expect(
    page.getByText("Potongan kode belum ikut dalam pembayaran ini"),
  ).toHaveCount(0);
  await expect(totalAmount(page)).toHaveText(plainTotal);
});

// The hold: when the plain quote is unavailable (its request failed) and the
// coded quote still succeeds, the page must not fall back to the coded total.
// Reproduced in mock mode by failing the first quote call (the checkout page's
// plain quote, issued on mount) before the checkout page opens; the code is
// applied afterwards. A failed plain quote is not retried automatically
// (quoteQuery retry: false), so the held state is stable until "Coba lagi".
test("F10 checkout with a voucher code blocks payment while the plain quote is unavailable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openCheckout(page, async () => {
    await page.evaluate(() => {
      (window as unknown as MockControl).__legendMock.failNext(
        "POST /api/table-sessions/:sessionId/quote",
        { status: 500, code: "INTERNAL_ERROR" },
      );
    });
  });

  // Without a code the page still shows the session's own quote and can pay.
  await expect(payButton(page)).toBeEnabled();

  await applyVoucher(page);

  // The coded quote exists, the plain one does not: nothing to pay yet, and
  // the button names no amount (never the coded total).
  const held = page
    .getByRole("button", { name: "Menunggu total pembayaran" })
    .filter({ visible: true });
  await expect(held).toBeDisabled();
  await expect(payButton(page)).toHaveCount(0);
  await expect(page.getByText("Total pembayaran", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByText("Potongan kode belum ikut dalam pembayaran ini"),
  ).toHaveCount(0);
  await expect(page.getByText("Voucher permintaan maaf")).toHaveCount(0);

  // The guest is told why and can retry; once the plain quote loads the
  // charged amount appears and payment is possible again.
  await expect(
    page
      .getByText("Total tanpa kode belum bisa dihitung")
      .filter({ visible: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Coba lagi" })
    .filter({ visible: true })
    .click();
  await expect(payButton(page)).toBeEnabled();
  await expect(
    page
      .getByText("Total pembayaran", { exact: true })
      .filter({ visible: true }),
  ).toBeVisible();
});

function escape(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
