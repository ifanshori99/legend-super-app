// Optional sign-in nudge on QR checkout (bead legend-0rsv; PRD v1.7 §3 F10
// "Login Opsional"): a guest may order without an account. The app invites
// sign-in for points, saved favorites and reordering, and the guest can keep
// ordering as a guest. Runs against the mock-mode web server (no API, no
// database): `pnpm test:e2e:mock e2e/legend-0rsv.mock.spec.ts`.
import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";

const baseURL =
  process.env.LEGEND_MOCK_WEB_URL ?? process.env.E2E_MOCK_BASE_URL;

test.skip(
  !baseURL,
  "Mock runner not started: use pnpm test:e2e:mock (playwright.mock.config.ts).",
);
test.use({ baseURL });

const freeTable = `v1.${"C".repeat(40)}.${"D".repeat(43)}`; // A01: pay-first, no minimum spend

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.addInitScript(
    (value) => localStorage.setItem("legend-theme", value),
    theme,
  );
}

/** Join the table, add one menu line, and open checkout as a guest. */
async function openCheckout(page: Page) {
  await page.goto(`/t/${freeTable}`);
  // The guest-count dialog opens on the first visit (PRD §3 "Scan & Sesi Meja").
  await page.getByRole("button", { name: "Mulai pesan" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  await page.getByRole("searchbox", { name: "Cari menu" }).fill("espresso");
  await page.getByRole("button", { name: "Lihat detail Espresso" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("radio", { name: /Dingin/ }).click();
  await sheet.getByRole("radio", { name: "Normal" }).click();
  await sheet.getByRole("button", { name: "Tambah ke keranjang" }).click();
  await expect(sheet).toBeHidden();

  await page.getByRole("link", { name: /Keranjang/ }).click();
  await page.getByRole("link", { name: "Lanjut ke checkout" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Checkout" }),
  ).toBeVisible();
}

function nudgeTitle(page: Page) {
  return page.getByRole("heading", {
    level: 2,
    name: "Dapatkan poin untuk pesanan ini",
  });
}

test("F10 Login Opsional: guest checkout invites sign-in and still lets the guest pay", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await setTheme(page, "light");
  await openCheckout(page);

  // The nudge is a guest-only invitation; checkout itself stays available.
  await expect(nudgeTitle(page)).toBeVisible();
  await expect(
    page.getByText("Poin dari setiap pembelian masuk ke akun Anda."),
  ).toBeVisible();
  await expect(
    page.getByText("Favorit tersimpan untuk kunjungan berikutnya."),
  ).toBeVisible();
  await expect(
    page.getByText("Pesan ulang pesanan sebelumnya dengan sekali ketuk."),
  ).toBeVisible();
  await expect(
    page.getByText("Tetap bisa memesan sebagai tamu."),
  ).toBeVisible();

  // The sign-in link hands the checkout URL back to `/masuk` and never uses
  // the staff `/sign-in` route.
  const signIn = page.getByRole("link", { name: "Masuk atau daftar" });
  await expect(signIn).toHaveAttribute(
    "href",
    /^\/masuk\?lanjut=%2Ft%2Fv1\.[^?]*%2Fcheckout/,
  );

  // F10: sign-in is optional, so the order button is usable as a guest.
  const payButton = page.getByRole("button", { name: /^Bayar Rp/ });
  await expect(payButton).toBeEnabled();

  await captureScreenshot(page, "legend-0rsv/checkout-390-light.png");

  // Continuing the order proves the nudge does not block the flow.
  await payButton.click();
  await expect(
    page.getByRole("heading", { name: "Pilih cara bayar" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();

  // Pay-first completion state: the order waits for payment and the invite is
  // not shown there, but the payment action stays available.
  await expect(page.getByRole("button", { name: /^Bayar Rp/ })).toBeVisible();
  await expect(nudgeTitle(page)).toHaveCount(0);
});

test("F10 Login Opsional: dismissing the nudge hides it for this browser session", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await setTheme(page, "light");
  await openCheckout(page);

  await expect(nudgeTitle(page)).toBeVisible();
  await page.getByRole("button", { name: "Tutup ajakan masuk" }).click();
  await expect(nudgeTitle(page)).toHaveCount(0);

  // A reload keeps the dismissal (sessionStorage) and the order actions.
  await page.reload({ waitUntil: "networkidle" });
  await expect(
    page.getByRole("heading", { level: 1, name: "Checkout" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Bayar Rp/ })).toBeVisible();
  await expect(nudgeTitle(page)).toHaveCount(0);
});

test("F10 Login Opsional visual 390 dark", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await setTheme(page, "dark");
  await openCheckout(page);

  await expect(nudgeTitle(page)).toBeVisible();
  await captureScreenshot(page, "legend-0rsv/checkout-390-dark.png");
});

test("F10 Login Opsional visual 1440 light", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await setTheme(page, "light");
  await openCheckout(page);

  await expect(nudgeTitle(page)).toBeVisible();
  await captureScreenshot(page, "legend-0rsv/checkout-1440-light.png");
});
