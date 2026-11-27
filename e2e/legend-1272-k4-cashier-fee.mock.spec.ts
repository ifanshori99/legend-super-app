// 1272 K4 (legend-osqou.59): the guest service fee ("Biaya layanan") on the
// cashier's VA and e-wallet screens and on the customer display. The cookie
// `legend-mock-duitku=fee` turns the mock fee on (same switch as K3): each
// bank and wallet shows its fee and what the guest pays, the live code shows
// the fee, the total and the no-refund note. Without the cookie nothing
// changes. The bill (tender) stays the remaining balance.
// `pnpm test:e2e:mock e2e/legend-1272-k4-cashier-fee.mock.spec.ts`
// Screenshots: LEGEND_CAPTURE_SCREENSHOTS=1 refreshes the tracked evidence (e2e/screenshots.ts).
import { expect as baseExpect, test, type Page } from "@playwright/test";
import { waitForHydration } from "./hydration.ts";
import { captureScreenshot } from "./screenshots.ts";

const expect = baseExpect.configure({ timeout: 15_000 });
const baseURL =
  process.env.LEGEND_MOCK_WEB_URL ?? process.env.E2E_MOCK_BASE_URL;

test.skip(
  !baseURL,
  "Mock runner not started: use pnpm test:e2e:mock (playwright.mock.config.ts).",
);
test.describe.configure({ timeout: 90_000 });
test.use({ baseURL, viewport: { width: 1280, height: 800 } });

const BEAD = "legend-osqou-59";
// Kasir demo order POS-0048: remaining Rp148.000 after its DP.
const DEMO_ORDER_ID = "0b0b0048-0000-4000-8000-000000000048";
const NO_REFUND = "Biaya layanan tidak dikembalikan bila pesanan dibatalkan.";
const rp = (amount: string) =>
  new RegExp(`Rp\\s*${amount.replace(/\./g, "\\.")}`);

async function setFee(page: Page) {
  await page
    .context()
    .addCookies([{ name: "legend-mock-duitku", value: "fee", url: baseURL! }]);
}

async function shot(page: Page, name: string, widths = [1280, 390]) {
  await page.addStyleTag({
    content: '[data-slot="support-session-bar"]{display:none !important}',
  });
  for (const width of widths) {
    await page.setViewportSize({ width, height: width === 1280 ? 800 : 844 });
    await captureScreenshot(page, `${BEAD}/${name}-${width}.png`, {
      fullPage: false,
    });
  }
  await page.setViewportSize({ width: 1280, height: 800 });
}

function methodOption(page: Page, name: string) {
  const re = new RegExp(`^${name}`);
  return page
    .getByRole("button", { name: re })
    .or(page.getByRole("radio", { name: re }));
}

async function openMethod(page: Page, method: string) {
  await page.goto(`/pos/bayar/${DEMO_ORDER_ID}`);
  await waitForHydration(page);
  await methodOption(page, method).click();
  await page
    .getByRole("button", { name: new RegExp(`Lanjutkan dengan ${method}`) })
    .click();
}

test("K4 VA: each bank shows its service fee and guest total; the live code shows fee, total and the no-refund note", async ({
  page,
}) => {
  await setFee(page);
  await openMethod(page, "Virtual Account");
  const main = page.locator("#main-content");
  await expect(
    page.getByRole("heading", { name: "Pilih bank Virtual Account" }).first(),
  ).toBeVisible();
  const bca = page.getByRole("radio", { name: /Bank BCA/ });
  await expect(page.locator("label", { has: bca })).toContainText(
    /Biaya layanan Rp\s*4\.000/,
  );
  await expect(page.locator("label", { has: bca })).toContainText(
    /Total dibayar tamu Rp\s*152\.000/,
  );
  await expect(main).not.toContainText(NO_REFUND);
  await page.locator("label", { has: bca }).click();
  await expect(main).toContainText(NO_REFUND);
  await shot(page, "kasir-va-pilih-bank");

  await page.getByRole("button", { name: "Buat nomor VA" }).click();
  await expect(main).toContainText("Nomor Virtual Account");
  await expect(main).toContainText("Total dibayar tamu");
  await expect(main).toContainText(rp("152.000"));
  await expect(main).toContainText(NO_REFUND);
  await shot(page, "kasir-va-kode");
});

test("K4 e-wallet: the percentage fee is shown per wallet before the request", async ({
  page,
}) => {
  await setFee(page);
  await openMethod(page, "E-wallet");
  const ovo = page.getByRole("radio", { name: /OVO/ });
  // 1.5% gross-up on Rp148.000: Rp2.254 (outlet keeps at least the bill).
  await expect(page.locator("label", { has: ovo })).toContainText(
    /Biaya layanan Rp\s*2\.254/,
  );
  await page.locator("label", { has: ovo }).click();
  await expect(page.locator("#main-content")).toContainText(NO_REFUND);
  await shot(page, "kasir-ewallet-pilih");
});

test("K4 without the fee switch: banks show no fee lines (as before)", async ({
  page,
}) => {
  await openMethod(page, "Virtual Account");
  await expect(
    page.getByRole("heading", { name: "Pilih bank Virtual Account" }).first(),
  ).toBeVisible();
  await expect(page.locator("#main-content")).not.toContainText(
    "Biaya layanan",
  );
});

test("K4 customer display: a VA with a fee lists the bill, the fee and the total paid", async ({
  page,
}) => {
  await page.addInitScript(() =>
    window.localStorage.setItem("legend-display-mock", "awaiting_va_fee"),
  );
  await page.goto("/pos/customer-display");
  await waitForHydration(page);
  const panel = page.getByRole("heading", {
    name: "Bayar dengan Virtual Account",
  });
  await expect(panel).toBeVisible();
  const main = page.locator("main");
  await expect(main).toContainText("8808123456789012");
  await expect(main).toContainText("Biaya layanan");
  await expect(main).toContainText("Total dibayar");
  await expect(main).toContainText(NO_REFUND);
  await shot(page, "layar-pelanggan-va-biaya", [1366, 1280, 390]);
});

test("K4 customer display: an e-wallet without a fee shows the bill only", async ({
  page,
}) => {
  await page.addInitScript(() =>
    window.localStorage.setItem("legend-display-mock", "awaiting_ewallet"),
  );
  await page.goto("/pos/customer-display");
  await waitForHydration(page);
  await expect(
    page.getByRole("heading", { name: "Bayar dengan OVO" }),
  ).toBeVisible();
  await expect(page.locator("main")).not.toContainText(NO_REFUND);
  await shot(page, "layar-pelanggan-ewallet", [1280]);
});
