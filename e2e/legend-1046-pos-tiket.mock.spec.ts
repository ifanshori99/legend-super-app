// legend-1046: POS facility ticket at the counter (sell -> pay -> issue QR+PIN
// once -> print rotates the credential -> reload shows no credential) against
// the FE mock runtime (VITE_API_MOCK=true).
//
// Run: pnpm test:e2e:mock e2e/legend-1046-pos-tiket.mock.spec.ts
//
// Source of expected behavior: docs/briefs/1046-sub-shared.md "Alur UI" (agent
// decisions after Explore), the founder-approved screenshots
// pos936-tiket-terbit-light-{360,1280}.png, and the existing Indonesian
// message catalog for the ticket screen. Never backend code.
//
// Assumptions (the brief leaves these open):
//  A1 Sell form (/pos/tiket, no search): product tile is a button named after
//     the product ("Shower Sekali Pakai"), the customer is searched through the
//     "Cari nama pelanggan" field and picked with the "Pilih <nama>" button
//     (mock CRM customer "Budi Santoso"). Area and time keep their defaults
//     (first area, "Masuk sekarang"). The sell button is "Jual tiket".
//  A2 Selling navigates (client side) to /pos/bayar/<orderId>. Cash payment
//     uses the same controls as the POS 936 spec (legend-mjmm): "Tunai",
//     "Lanjutkan dengan Tunai", "Uang diterima", "Konfirmasi terima tunai",
//     heading "Pembayaran selesai". The cash amount is generous (Rp 100.000)
//     so the test never encodes the server-computed bill.
//  A3 Once the bill is paid, the pay screen shows a small card containing the
//     words "siap diterbitkan" and a link to `/pos/tiket?order=..&tiket=..`.
//     The link is found by role link + href (the sidebar also has a "Tiket
//     fasilitas" link, so a name-only query would be ambiguous).
//  A4 The issue screen has a button "Terbitkan tiket"; nothing is issued on
//     mount. After it, the screen shows "Tiket terbit", the QR as an image
//     named "QR tiket <produk>", the label "PIN pintu" and the 6 digit PIN as
//     its own text node.
//  A5 "Cetak tiket" (or "Cetak ulang" once printed) rotates the credential:
//     QR drawing and PIN change, and the screen says the old code no longer
//     works (text matching "kode ... tidak berlaku"). The print result is a
//     status line: printed on a printer ("tercetak di ...") or printer not
//     available ("printer ... tidak tersedia"); the QR stays visible either way.
//  A6 The mock store is in memory, so after a reload the mock order is gone:
//     the screen returns either to the "Terbitkan tiket" step or to an error
//     state. Both are fine; what must hold is that no QR, PIN or old code is
//     shown, and nothing credential-like sits in local/session storage.
//  A7 The credential is random: the PIN differs after a rotation (1 in a
//     million collision chance is accepted); the QR drawing is compared too.
//  A8 An unknown ticket/order shows an error notice and no "Terbitkan tiket"
//     button. `?mock=error` shows "Coba lagi" (repo convention).
//  A9 Screenshots are the issued-ticket screen, light theme, 360 and 1280.
import {
  expect as baseExpect,
  test,
  type Locator,
  type Page,
} from "@playwright/test";
import { waitForHydration } from "./hydration.ts";
import { captureScreenshot } from "./screenshots.ts";

const expect = baseExpect.configure({ timeout: 15_000 });

test.describe.configure({ timeout: 120_000 });
test.use({ viewport: { width: 1280, height: 800 } });

const PRODUCT = "Shower Sekali Pakai";
const CUSTOMER_QUERY = "Budi";
const CUSTOMER = "Budi Santoso";
const BACKSPACE = /^Hapus angka terakhir$/;

// ---------------------------------------------------------------- helpers

const main = (page: Page) => page.locator("#main-content");

const heading = (page: Page, name: string | RegExp) =>
  page.getByRole("heading", { name }).first();

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await waitForHydration(page);
}

async function setLightTheme(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("legend-theme", "light"));
}

/**
 * Scrolls the app shell's scroll container (and the window) to the end, so the
 * evidence shot shows PIN, price and print status like the approved
 * pos936-tiket-terbit-light-*.png (scrolled to the end). No-op when it fits.
 */
async function scrollToEnd(page: Page): Promise<void> {
  // The area frame scrolls an inner `overflow-y-auto` box, not the window:
  // scroll every scrollable box to its end, like the approved 936 shots.
  const remaining = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>("*"))
        .filter((el) => {
          const overflow = getComputedStyle(el).overflowY;
          return (
            (overflow === "auto" || overflow === "scroll") &&
            el.scrollHeight > el.clientHeight
          );
        })
        .reduce(
          (max, el) =>
            Math.max(
              max,
              Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop),
            ),
          0,
        ),
    );
  await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
      const overflow = getComputedStyle(el).overflowY;
      if (overflow === "auto" || overflow === "scroll")
        el.scrollTop = el.scrollHeight;
    }
    window.scrollTo(0, document.documentElement.scrollHeight);
  });
  await expect.poll(remaining).toBeLessThanOrEqual(1);
}

/** Evidence screenshot; hides the mock support-access banner (as legend-mjmm). */
async function shot(page: Page, name: string): Promise<void> {
  await page.addStyleTag({
    content: '[data-slot="support-session-bar"]{display:none !important}',
  });
  await scrollToEnd(page);
  await captureScreenshot(page, `legend-1046/${name}.png`, {
    fullPage: false,
  });
}

/** Types an amount: keypad when the screen has one, otherwise fill (A2). */
async function enterAmount(
  page: Page,
  input: Locator,
  amount: number,
): Promise<void> {
  await expect(input).toBeVisible();
  const zero = page.getByRole("button", { name: "0", exact: true });
  if ((await zero.count()) === 0) {
    await input.fill(String(amount));
    return;
  }
  const back = page.getByRole("button", { name: BACKSPACE });
  for (let i = 0; i < 14; i += 1) {
    const digits = (await input.inputValue()).replace(/\D/g, "");
    if (/^0*$/.test(digits)) break;
    await back.click();
  }
  for (const digit of String(amount)) {
    await page.getByRole("button", { name: digit, exact: true }).click();
  }
}

/** Step 1: pick product + customer and sell. Ends on the pay screen. */
async function sellTicket(page: Page): Promise<void> {
  await open(page, "/pos/tiket");
  await expect(heading(page, "Tiket fasilitas")).toBeVisible();
  await page.getByRole("button", { name: new RegExp(PRODUCT) }).click();
  await page.getByLabel("Cari nama pelanggan").fill(CUSTOMER_QUERY);
  await page.getByRole("button", { name: `Pilih ${CUSTOMER}` }).click();
  await page.getByRole("button", { name: "Jual tiket" }).click();
  await expect(page).toHaveURL(/\/pos\/bayar\/[^/?]+/);
}

/** Step 2: pay the whole bill in cash on the mock pay screen. */
async function payInCash(page: Page): Promise<void> {
  await expect(
    page
      .getByRole("button", { name: /^Tunai/ })
      .or(page.getByRole("radio", { name: /^Tunai/ })),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /^Tunai/ })
    .or(page.getByRole("radio", { name: /^Tunai/ }))
    .click();
  await page.getByRole("button", { name: /Lanjutkan dengan Tunai/ }).click();
  await expect(heading(page, "Terima pembayaran tunai")).toBeVisible();
  await enterAmount(page, page.getByLabel("Uang diterima"), 100_000);
  await page.getByRole("button", { name: /Konfirmasi terima tunai/ }).click();
  await expect(heading(page, "Pembayaran selesai")).toBeVisible();
}

/** A3: link in the paid pay screen that leads to the issue screen. */
const issueLink = (page: Page) =>
  main(page).getByRole("link").and(page.locator('[href*="/pos/tiket?"]'));

/** Step 3: from the paid pay screen to the issue screen (nothing issued yet). */
async function openIssueScreen(page: Page): Promise<void> {
  await expect(main(page)).toContainText(/siap diterbitkan/i);
  await issueLink(page).click();
  await expect(page).toHaveURL(/order=[^&]+/);
  await expect(page).toHaveURL(/tiket=[^&]+/);
  await expect(
    page.getByRole("button", { name: "Terbitkan tiket" }),
  ).toBeVisible();
}

const qr = (page: Page) =>
  page.getByRole("img", { name: new RegExp(`QR tiket ${PRODUCT}`) });
const pinText = (page: Page) => main(page).getByText(/^\d{6}$/);

async function readPin(page: Page): Promise<string> {
  await expect(pinText(page)).toHaveCount(1);
  return (await pinText(page).innerText()).trim();
}

async function readQr(page: Page): Promise<string> {
  await expect(qr(page)).toBeVisible();
  return qr(page).evaluate((el) => el.outerHTML);
}

async function noCredentialOnScreen(page: Page): Promise<void> {
  await expect(qr(page)).toHaveCount(0);
  await expect(page.getByRole("img", { name: /^QR tiket/ })).toHaveCount(0);
  await expect(main(page)).not.toContainText("PIN pintu");
  await expect(pinText(page)).toHaveCount(0);
}

/** Whole flow up to the issued ticket on screen. */
async function issueTicket(page: Page): Promise<void> {
  await sellTicket(page);
  await payInCash(page);
  await openIssueScreen(page);
  await page.getByRole("button", { name: "Terbitkan tiket" }).click();
  await expect(main(page)).toContainText("Tiket terbit");
  await expect(qr(page)).toBeVisible();
}

// -------------------------------------------------------------- main flow

test("legend-1046 TKT-01 sell, pay, issue shows QR and PIN, print rotates them, reload shows no credential", async ({
  page,
}) => {
  await setLightTheme(page);
  await sellTicket(page);

  // Pay screen: the bill is open and the ticket is NOT issuable yet.
  await expect(heading(page, /^Pembayaran/)).toBeVisible();
  await expect(main(page)).toContainText("Belum lunas");
  await expect(main(page)).not.toContainText(/siap diterbitkan/i);
  await expect(issueLink(page)).toHaveCount(0);

  await payInCash(page);
  await openIssueScreen(page);

  // Explicit action: nothing is issued by opening the screen.
  const area = main(page);
  await expect(area).toContainText(PRODUCT);
  await expect(area).toContainText(CUSTOMER);
  await noCredentialOnScreen(page);

  await page.getByRole("button", { name: "Terbitkan tiket" }).click();
  await expect(area).toContainText("Tiket terbit");
  await expect(area).toContainText("PIN pintu");
  const firstPin = await readPin(page);
  const firstQr = await readQr(page);
  expect(firstPin).toMatch(/^\d{6}$/);
  await expect(area).toContainText(/Atas nama Budi Santoso/);
  await expect(area).toContainText(/Rp\s*25\.000/);
  await shot(page, "pos-tiket-terbit-light-1280");

  // Print goes through the print path and rotates the credential (A5).
  await page.getByRole("button", { name: /^Cetak (tiket|ulang)/ }).click();
  await expect(area).toContainText(/kode.*tidak berlaku/i);
  await expect(page.locator('[data-slot="ticket-print-status"]')).toContainText(
    /(tercetak|dicetak( ulang)?) di|printer.*tidak tersedia|tidak ada printer/i,
  );
  await expect(qr(page)).toBeVisible();
  await expect
    .poll(() => readQr(page), { message: "QR drawing rotated by print" })
    .not.toBe(firstQr);
  const secondPin = await readPin(page);
  expect(secondPin).not.toBe(firstPin); // A7
  await expect(area).not.toContainText(firstPin);

  // Reload: the credential is gone and is not stored anywhere (A6).
  await page.reload();
  await waitForHydration(page);
  await noCredentialOnScreen(page);
  await expect(
    page
      .getByRole("button", { name: "Terbitkan tiket" })
      .or(page.getByRole("button", { name: /coba lagi/i }))
      .or(main(page).getByText(/tidak ditemukan|belum bisa dimuat/i))
      .first(),
  ).toBeVisible();
  const body = await page.locator("body").innerText();
  expect(body).not.toContain(firstPin);
  expect(body).not.toContain(secondPin);
  const stored = await page.evaluate(() =>
    JSON.stringify([
      ...Object.entries(localStorage),
      ...Object.entries(sessionStorage),
    ]),
  );
  expect(stored).not.toContain(firstPin);
  expect(stored).not.toContain(secondPin);
});

test("legend-1046 TKT-01 the pay screen offers the ticket only after payment, and issuing is never automatic", async ({
  page,
}) => {
  await sellTicket(page);
  // Unpaid: no "siap diterbitkan" card, no way to reach the issue screen.
  await expect(main(page)).toContainText("Belum lunas");
  await expect(main(page)).not.toContainText(/siap diterbitkan/i);
  await expect(issueLink(page)).toHaveCount(0);
  await noCredentialOnScreen(page);

  await payInCash(page);
  await expect(main(page)).toContainText(/siap diterbitkan/i);
  // Paying alone shows no QR/PIN: the cashier must press "Terbitkan tiket".
  await noCredentialOnScreen(page);
  await openIssueScreen(page);
  await noCredentialOnScreen(page);
});

test("legend-1046 TKT-02 the sell form stays locked until ticket and customer are chosen", async ({
  page,
}) => {
  await open(page, "/pos/tiket");
  await expect(heading(page, "Tiket fasilitas")).toBeVisible();
  const sell = page.getByRole("button", { name: "Jual tiket" });
  const area = main(page);

  // Empty state: nothing chosen, nothing sellable.
  await expect(area).toContainText("Belum dipilih");
  await expect(area).toContainText("Pilih tiket, pelanggan, dan waktu dulu.");
  await expect(sell).toBeDisabled();

  await page.getByRole("button", { name: new RegExp(PRODUCT) }).click();
  await expect(sell).toBeDisabled(); // customer still missing

  // Customer search with no match: empty state, still locked.
  await page.getByLabel("Cari nama pelanggan").fill("Zzzzqq");
  await expect(area).toContainText("Pelanggan tidak ditemukan");
  await expect(sell).toBeDisabled();

  await page.getByLabel("Cari nama pelanggan").fill(CUSTOMER_QUERY);
  await page.getByRole("button", { name: `Pilih ${CUSTOMER}` }).click();
  await expect(area).toContainText(`Dipilih: ${CUSTOMER}`);
  await expect(area).toContainText(/Rp\s*25\.000/);
  await expect(sell).toBeEnabled();
});

// ------------------------------------------------------------ error states

test("legend-1046 ERR-01 an unknown ticket shows an error and offers no issue button", async ({
  page,
}) => {
  await open(
    page,
    "/pos/tiket?order=01JZZZZZZZZZZZZZZZZZZZZZZZ&tiket=01JYYYYYYYYYYYYYYYYYYYYYYY",
  );
  // A8: an error state, never a half-drawn issue screen.
  await expect(
    main(page)
      .getByText(/tidak ditemukan|belum bisa dimuat|tidak bisa dimuat/i)
      .or(page.getByRole("button", { name: /coba lagi/i }))
      .first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Terbitkan tiket" }),
  ).toHaveCount(0);
  await noCredentialOnScreen(page);
});

test("legend-1046 ERR-01 a failed load of the issue screen says so and offers a retry", async ({
  page,
}) => {
  await open(
    page,
    "/pos/tiket?order=01JZZZZZZZZZZZZZZZZZZZZZZZ&tiket=01JYYYYYYYYYYYYYYYYYYYYYYY&mock=error",
  );
  await expect(page.getByRole("button", { name: /coba lagi/i })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Terbitkan tiket" }),
  ).toHaveCount(0);
  await noCredentialOnScreen(page);
});

// ------------------------------------------------------------- 360 px width

test.describe("360 px", () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test("legend-1046 RESP-01 issued ticket fits 360 px without horizontal scroll", async ({
    page,
  }) => {
    await setLightTheme(page);
    await issueTicket(page);
    await expect(main(page)).toContainText("PIN pintu");
    await expect(pinText(page)).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: /^Cetak (tiket|ulang)/ }),
    ).toBeVisible();
    const overflow = await page.evaluate(() => {
      const root = document.documentElement;
      const area = document.querySelector("#main-content");
      return {
        page: root.scrollWidth - root.clientWidth,
        main: area ? area.scrollWidth - area.clientWidth : 0,
      };
    });
    expect(overflow.page).toBeLessThanOrEqual(1);
    expect(overflow.main).toBeLessThanOrEqual(1);
    // Print so the evidence also shows the print status under the ticket.
    await page.getByRole("button", { name: /^Cetak (tiket|ulang)/ }).click();
    await expect(
      page.locator('[data-slot="ticket-print-status"]'),
    ).toContainText(/(tercetak|dicetak( ulang)?) di|tidak tersedia/i);
    await shot(page, "pos-tiket-terbit-light-360");
  });
});
