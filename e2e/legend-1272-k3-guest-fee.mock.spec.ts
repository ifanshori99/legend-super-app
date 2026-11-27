// 1272 K3 (legend-osqou.58): the guest service fee ("Biaya layanan") on the
// QR pay screens. The cookie `legend-mock-duitku=fee` turns the mock fee on:
// options named for a placed order carry a fee per VA bank and e-wallet, and a
// payment charges it on top of the bill. Without the cookie nothing changes
// (the production flag is empty until K2 + K4).
// `pnpm test:e2e:mock e2e/legend-1272-k3-guest-fee.mock.spec.ts`
// Screenshots: LEGEND_CAPTURE_SCREENSHOTS=1 refreshes the tracked evidence (e2e/screenshots.ts).
import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";

const baseURL =
  process.env.LEGEND_MOCK_WEB_URL ?? process.env.E2E_MOCK_BASE_URL;

test.skip(
  !baseURL,
  "Mock runner not started: use pnpm test:e2e:mock (playwright.mock.config.ts).",
);
test.use({ baseURL, viewport: { width: 390, height: 844 } });

const BEAD = "legend-osqou-58";
const freeTable = `v1.${"C".repeat(40)}.${"D".repeat(43)}`; // A01, pay-first
const NO_REFUND = "Biaya layanan tidak dikembalikan bila pesanan dibatalkan.";

async function shot(page: Page, name: string) {
  for (const width of [390, 1280, 320]) {
    await page.setViewportSize({ width, height: width === 1280 ? 800 : 844 });
    await captureScreenshot(page, `${BEAD}/${name}-${width}.png`, {
      fullPage: false,
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
}

async function axe(page: Page) {
  await page.addScriptTag({
    path: createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  });
  const violations = await page.evaluate(async () => {
    const result = await (
      window as unknown as {
        axe: {
          run: (
            context: Element,
            options: object,
          ) => Promise<{
            violations: { id: string; impact: string; nodes: unknown[] }[];
          }>;
        };
      }
    ).axe.run(document.body, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
      },
    });
    return result.violations.map((v) => `${v.id} (${v.impact})`);
  });
  expect(violations).toEqual([]);
}

async function setDuitku(page: Page, mode: string) {
  await page
    .context()
    .addCookies([{ name: "legend-mock-duitku", value: mode, url: baseURL! }]);
}

/** Join table A01, add one espresso and open "Keranjang & bayar". */
async function openCheckout(page: Page) {
  await page.goto(`/t/${freeTable}`);
  const save = page.getByRole("button", { name: "Simpan" });
  await expect(async () => {
    await page.getByRole("button", { name: /Pilih jumlah tamu/ }).click();
    await expect(save).toBeVisible({ timeout: 1_500 });
  }).toPass({ timeout: 30_000 });
  await save.click();
  await page.getByRole("button", { name: "Lihat detail Espresso" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("radio", { name: /Dingin/ }).click();
  await sheet.getByRole("radio", { name: "Normal" }).click();
  await sheet.getByRole("button", { name: /^Tambah · / }).click();
  await expect(sheet).toBeHidden();
  await page.getByRole("link", { name: "Lihat keranjang" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Keranjang & bayar" }),
  ).toBeVisible();
}

const radio = (page: Page, name: string | RegExp) =>
  page
    .getByRole("radio", { name, exact: typeof name === "string" })
    .filter({ visible: true });

const button = (page: Page, name: RegExp) =>
  page.getByRole("button", { name }).filter({ visible: true });

/** Pay-first cart with VA chosen: the order is placed and the bank list opens. */
async function openBankList(page: Page) {
  await openCheckout(page);
  await radio(page, /^Virtual Account/).click();
  await button(page, /^Buat nomor Virtual Account$/).click();
  await expect(page).toHaveURL(/\/bayar\/.*metode=va/);
}

test("K3 VA bank list shows the fee and total per bank, and the no-refund note once one is chosen", async ({
  page,
}) => {
  await setDuitku(page, "fee");
  await openBankList(page);
  await expect(page.getByText(/^Biaya layanan Rp\s?4\.000$/)).toHaveCount(4);
  await expect(page.getByText(/^Total dibayar Rp/).first()).toBeVisible();
  await expect(page.getByText(NO_REFUND)).toHaveCount(0);
  await page.getByRole("radio", { name: /^Mandiri/ }).click();
  await expect(page.getByText(NO_REFUND)).toBeVisible();
  await axe(page);
  await shot(page, "va-bank");

  await page
    .getByRole("button", { name: "Buat nomor Virtual Account" })
    .click();
  await expect(page.getByText("Biaya layanan", { exact: true })).toBeVisible();
  await expect(page.getByText(NO_REFUND)).toBeVisible();
  await axe(page);
  await shot(page, "va-nomor");
});

test("K3 a placed order priced for e-wallet: fee per app, total in the button, none for QRIS", async ({
  page,
}) => {
  await setDuitku(page, "fee");
  await openBankList(page);
  await page.getByRole("link", { name: "Ganti metode bayar" }).click();
  await expect(page).toHaveURL(/\/checkout/);
  await radio(page, /^E-wallet/).click();
  await expect(page.getByText(/^Biaya layanan Rp/).first()).toBeVisible();
  await expect(page.getByText(NO_REFUND)).toHaveCount(0);
  await radio(page, /^DANA/).click();
  await expect(page.getByText(NO_REFUND).first()).toBeVisible();
  await expect(
    page
      .getByText("Biaya layanan", { exact: true })
      .filter({ visible: true })
      .first(),
  ).toBeVisible();
  await axe(page);
  await shot(page, "ewallet");
  await radio(page, /^QRIS/).click();
  await expect(page.getByText(NO_REFUND)).toHaveCount(0);
  await expect(page.getByText(/Biaya layanan/)).toHaveCount(0);
});

test("K3 without the fee on, no screen mentions a service fee", async ({
  page,
}) => {
  await openBankList(page);
  await expect(page.getByText(/Biaya layanan/)).toHaveCount(0);
  await page.getByRole("radio", { name: /^Mandiri/ }).click();
  await expect(page.getByText(/Biaya layanan/)).toHaveCount(0);
});

test("K3 fresh cart, e-wallet with a fee: the guest confirms fee and total before Duitku opens", async ({
  page,
}) => {
  await setDuitku(page, "fee");
  await openCheckout(page);
  await radio(page, /^E-wallet/).click();
  await radio(page, /^DANA/).click();
  await button(page, /^Bayar Rp.* dengan DANA$/).click();
  // The order is placed, but the gateway page has not been opened.
  await expect(
    page.getByRole("heading", { name: "Ada biaya layanan" }),
  ).toBeVisible();
  await expect(page).not.toHaveURL(/bayar\/kembali/);
  await expect(page.getByText("Biaya layanan", { exact: true })).toBeVisible();
  await expect(page.getByText(NO_REFUND)).toBeVisible();
  await axe(page);
  await shot(page, "konfirmasi");
  await page.getByRole("button", { name: /^Bayar Rp[\s\d.]+$/ }).click();
  await page.waitForURL(/\/bayar\/kembali\?merchantOrderId=.*resultCode=00/);
  await expect(page.getByText("Biaya layanan", { exact: true })).toBeVisible();
});

test("K3 fresh cart, e-wallet with a fee: another method returns to the placed order's list, fee already shown", async ({
  page,
}) => {
  await setDuitku(page, "fee");
  await openCheckout(page);
  await radio(page, /^E-wallet/).click();
  await radio(page, /^DANA/).click();
  await button(page, /^Bayar Rp.* dengan DANA$/).click();
  await expect(
    page.getByRole("heading", { name: "Ada biaya layanan" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Pilih metode lain" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Keranjang & bayar" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Metode bayar" }),
  ).toBeFocused();
  // The placed order's list is priced: the fee shows before any choice.
  await radio(page, /^E-wallet/).click();
  await expect(page.getByText(/^Biaya layanan Rp/).first()).toBeVisible();
  await expect(page).not.toHaveURL(/bayar\/kembali/);
});

test("K3 fresh cart, card without a fee: straight to Duitku, no confirm step", async ({
  page,
}) => {
  await setDuitku(page, "fee");
  await openCheckout(page);
  await radio(page, /^Kartu kredit atau debit/).click();
  await button(page, /^Bayar Rp.* dengan kartu$/).click();
  await page.waitForURL(/\/bayar\/kembali\?merchantOrderId=.*resultCode=00/);
});

test("K3 fresh cart, e-wallet while the fee is off: straight to Duitku, no confirm step", async ({
  page,
}) => {
  await openCheckout(page);
  await radio(page, /^E-wallet/).click();
  await radio(page, /^DANA/).click();
  await button(page, /^Bayar Rp.* dengan DANA$/).click();
  await page.waitForURL(/\/bayar\/kembali\?merchantOrderId=.*resultCode=00/);
});
