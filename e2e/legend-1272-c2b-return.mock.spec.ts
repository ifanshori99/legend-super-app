// C2b (legend-osqou.4): guest e-wallet and card through Duitku's page, and the
// single return page `/bayar/kembali`. The mock answers an e-wallet or card
// payment with this app's own return URL (with Duitku's `resultCode=00`), and
// the cookie `legend-mock-duitku` picks what the "gateway" reports. Every
// state comes from the polled payment, never from `resultCode`: the failed,
// expired and pending runs all return with `resultCode=00`.
// `pnpm test:e2e:mock e2e/legend-1272-c2b-return.mock.spec.ts`
// Screenshots: C2B_SHOTS=docs/review/img.
import { createRequire } from "node:module";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const baseURL =
  process.env.LEGEND_MOCK_WEB_URL ?? process.env.E2E_MOCK_BASE_URL;

test.skip(
  !baseURL,
  "Mock runner not started: use pnpm test:e2e:mock (playwright.mock.config.ts).",
);
test.use({ baseURL, viewport: { width: 390, height: 844 } });

const SHOT = process.env.C2B_SHOTS;
const freeTable = `v1.${"C".repeat(40)}.${"D".repeat(43)}`; // A01, pay-first

async function shot(page: Page, name: string, wide = false) {
  if (!SHOT) return;
  await page.screenshot({
    path: join(SHOT, `c2b-${name}-390.png`),
    fullPage: true,
  });
  if (!wide) return;
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: join(SHOT, `c2b-${name}-1280.png`) });
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
  await page.context().addCookies([
    {
      name: "legend-mock-duitku",
      value: mode,
      url: baseURL!,
    },
  ]);
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

/** Visible only: the method list renders once, the action button twice (aside and phone footer). */
const radio = (page: Page, options: { name: string | RegExp }) =>
  page
    .getByRole("radio", { ...options, exact: typeof options.name === "string" })
    .filter({ visible: true });

const payWith = (page: Page, what: RegExp) =>
  page.getByRole("button", { name: what }).filter({ visible: true });

/** Checkout with DANA, through the opening screen, back to /bayar/kembali. */
async function payWithDana(page: Page) {
  await openCheckout(page);
  await radio(page, { name: /^E-wallet/ }).click();
  await radio(page, { name: "DANA" }).click();
  await payWith(page, /^Bayar Rp.* dengan DANA$/).click();
  await page.waitForURL(/\/bayar\/kembali\?merchantOrderId=.*resultCode=00/);
}

test("C2b checkout lists e-wallet apps and card from the server; off methods are hidden", async ({
  page,
}) => {
  await openCheckout(page);
  for (const name of [
    /^QRIS/,
    /^E-wallet/,
    /^Virtual Account/,
    /^Kartu kredit atau debit/,
    /^Bayar di kasir/,
  ])
    await expect(page.getByRole("radio", { name })).toBeVisible();
  await radio(page, { name: /^E-wallet/ }).click();
  for (const wallet of ["OVO", "DANA", "ShopeePay", "LinkAja"])
    await expect(radio(page, { name: wallet })).toBeVisible();
  // No app is preselected: the guest picks one, and pay stays off until then.
  for (const wallet of ["OVO", "DANA", "ShopeePay", "LinkAja"])
    await expect(radio(page, { name: wallet })).not.toBeChecked();
  await expect(payWith(page, /^Bayar Rp.* dengan e-wallet$/)).toBeDisabled();
  await expect(page.getByText("Pilih aplikasi e-wallet dulu.")).toBeVisible();
  await radio(page, { name: "DANA" }).click();
  await expect(
    page.getByText(/dibawa ke halaman DANA untuk menyetujui/),
  ).toBeVisible();
  await expect(payWith(page, /^Bayar Rp.* dengan DANA$/)).toBeEnabled();
  await axe(page);
  await shot(page, "metode", true);

  await radio(page, { name: /^Kartu kredit atau debit/ }).click();
  await expect(
    page.getByText(/Nomor kartu diisi di halaman pembayaran Duitku/),
  ).toBeVisible();
  await expect(payWith(page, /^Bayar Rp.* dengan kartu$/)).toBeVisible();
  await shot(page, "metode-kartu");
});

test("C2b an outlet with only some methods on shows only those", async ({
  page,
}) => {
  await setDuitku(page, "partial");
  await openCheckout(page);
  await expect(radio(page, { name: /^Virtual Account/ })).toHaveCount(0);
  await expect(radio(page, { name: /^Kartu kredit/ })).toHaveCount(0);
  await radio(page, { name: /^E-wallet/ }).click();
  await expect(radio(page, { name: "OVO" })).toHaveCount(0);
  await expect(radio(page, { name: "DANA" })).toBeVisible();
  await expect(radio(page, { name: "ShopeePay" })).toBeVisible();
  await shot(page, "metode-sebagian");
});

test("C2b the opening screen names Duitku once and keeps a manual button", async ({
  page,
}) => {
  // Hold the gateway page so the opening screen stays on.
  await page.route("**/bayar/kembali**", () => new Promise(() => {}));
  await openCheckout(page);
  await radio(page, { name: /^E-wallet/ }).click();
  await radio(page, { name: "OVO" }).click();
  await payWith(page, /^Bayar Rp.* dengan OVO$/).click();
  await expect(
    page.getByRole("heading", { name: "Bayar dengan OVO" }),
  ).toBeVisible();
  await expect(page.getByText(/milik Duitku/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Buka halaman OVO" }),
  ).toBeVisible();
  await shot(page, "membuka");
});

test("C2b opening fails: nothing paid, retry or another method", async ({
  page,
}) => {
  await setDuitku(page, "open-fail");
  await openCheckout(page);
  await radio(page, { name: /^E-wallet/ }).click();
  await radio(page, { name: "DANA" }).click();
  await payWith(page, /^Bayar Rp.* dengan DANA$/).click();
  await expect(
    page.getByRole("heading", { name: "Halaman DANA belum bisa dibuka" }),
  ).toBeVisible();
  await expect(page.getByText(/Anda belum membayar apa pun/)).toBeVisible();
  await axe(page);
  await shot(page, "membuka-gagal");
  // Focus moves to the new screen's heading, not to <body>.
  await expect(
    page.getByRole("heading", { name: "Halaman DANA belum bisa dibuka" }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Pilih metode lain" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Keranjang & bayar" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Metode bayar" }),
  ).toBeFocused();
});

test("C2b return: waiting, then paid only once the server says so", async ({
  page,
}) => {
  await payWithDana(page);
  await expect(
    page.getByRole("heading", { name: "Memastikan pembayaran Anda" }),
  ).toBeVisible();
  await expect(page.getByText(/Jangan bayar ulang/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Cek lagi" })).toBeVisible();
  await expect(page.getByText(/^·/)).toHaveCount(0);
  // The action footer sits at the bottom of the phone screen, in thumb reach.
  const footer = await page
    .getByRole("button", { name: "Cek lagi" })
    .boundingBox();
  expect(footer!.y + footer!.height).toBeGreaterThan(844 - 40);
  await axe(page);
  await shot(page, "kembali-menunggu", true);
  // The mock gateway confirms a few seconds after the payment was made.
  await expect(
    page.getByRole("heading", { name: "Pembayaran berhasil" }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Lunas", { exact: true })).toBeVisible();
  await axe(page);
  await shot(page, "kembali-berhasil", true);
  await page.getByRole("link", { name: /Lihat status pesanan/ }).click();
  await expect(page).toHaveURL(/\/t\/.*\/orders/);
});

test("C2b return: still pending after a minute says so and keeps checking", async ({
  page,
}) => {
  await page.clock.install();
  await setDuitku(page, "pending");
  await payWithDana(page);
  await expect(
    page.getByRole("heading", { name: "Memastikan pembayaran Anda" }),
  ).toBeVisible();
  await page.clock.fastForward(61_000);
  await expect(
    page.getByRole("heading", { name: "Pembayaran masih diproses" }),
  ).toBeVisible();
  await expect(page.getByText(/tunjukkan kode QR-/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Cek lagi" })).toBeVisible();
  await axe(page);
  await shot(page, "kembali-lama", true);
});

test("C2b return: failed although Duitku said resultCode=00", async ({
  page,
}) => {
  await setDuitku(page, "failed");
  await payWithDana(page);
  await expect(
    page.getByRole("heading", { name: "Pembayaran belum selesai" }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/dengan DANA dibatalkan/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Coba lagi dengan DANA" }),
  ).toBeVisible();
  await axe(page);
  await shot(page, "kembali-gagal", true);
  await page.getByRole("link", { name: /Pilih metode lain/ }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Keranjang & bayar" }),
  ).toBeVisible();
});

test("C2b return: expired", async ({ page }) => {
  await setDuitku(page, "expired");
  await payWithDana(page);
  await expect(
    page.getByRole("heading", { name: "Waktu pembayaran habis" }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByRole("link", { name: /Buat pembayaran baru/ }),
  ).toBeVisible();
  await axe(page);
  await shot(page, "kembali-kedaluwarsa", true);
});

test("C2b return: a link this browser never sent away is not recognised", async ({
  page,
}) => {
  await page.goto(
    "/bayar/kembali?merchantOrderId=11111111-1111-4111-8111-111111111111&resultCode=00",
  );
  await expect(
    page.getByRole("heading", { name: "Tautan ini tidak dikenali" }),
  ).toBeVisible();
  await expect(page.getByText("Pindai lagi QR di meja")).toBeVisible();
  await expect(page.getByText("Pembayaran berhasil")).toHaveCount(0);
  await axe(page);
  await shot(page, "kembali-tidak-valid", true);
});

test("C2b return: a new tab without the table session points to the order status (review P2-1)", async ({
  page,
}) => {
  await payWithDana(page);
  // The e-wallet app reopened the browser in a tab without the session login.
  await setDuitku(page, "no-login");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Cek status pesanan Anda" }),
  ).toBeVisible();
  await expect(page.getByText("Tautan ini tidak dikenali")).toHaveCount(0);
  await expect(page.getByText(/Jangan bayar ulang/)).toBeVisible();
  await axe(page);
  await shot(page, "kembali-tab-lain", true);
  await page.getByRole("link", { name: /Lihat status pesanan/ }).click();
  await expect(page).toHaveURL(/\/t\/.*\/orders/);
});

test("C2b return: an unreachable server is not 'checking' forever (audit P1-1)", async ({
  page,
}) => {
  await payWithDana(page);
  await setDuitku(page, "down");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Status belum bisa diperiksa" }),
  ).toBeVisible();
  await expect(page.getByText(/Jangan bayar ulang/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Cek lagi" })).toBeVisible();
  await axe(page);
  await shot(page, "kembali-tidak-terhubung", true);
  // Back online: checking again finds the real answer.
  await setDuitku(page, "pending");
  await page.getByRole("button", { name: "Cek lagi" }).click();
  await expect(
    page.getByRole("heading", { name: "Memastikan pembayaran Anda" }),
  ).toBeVisible();
});

test("C2b return: a refund is not shown as paid (review P3-3)", async ({
  page,
}) => {
  await setDuitku(page, "refunded");
  await payWithDana(page);
  await expect(
    page.getByRole("heading", { name: "Pembayaran sudah dikembalikan" }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Lunas", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Pembayaran berhasil")).toHaveCount(0);
  await axe(page);
  await shot(page, "kembali-dikembalikan", true);
});

test("C2b return: failed, then paid late, turns into paid without a second payment (review P2-2)", async ({
  page,
}) => {
  await page.clock.install();
  await setDuitku(page, "late-paid");
  await payWithDana(page);
  await page.clock.fastForward(6_000);
  await expect(
    page.getByRole("heading", { name: "Pembayaran belum selesai" }),
  ).toBeVisible();
  // The page keeps watching (slow, every 15 s): the gateway settles late.
  await page.clock.fastForward(40_000);
  await expect(
    page.getByRole("heading", { name: "Pembayaran berhasil" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Coba lagi dengan/ }),
  ).toHaveCount(0);
});

test("C2b return: 'Coba lagi' asks the server first and never pays twice (review P2-2)", async ({
  page,
}) => {
  await page.clock.install();
  await setDuitku(page, "late-paid");
  await payWithDana(page);
  await page.clock.fastForward(6_000);
  await expect(
    page.getByRole("heading", { name: "Pembayaran belum selesai" }),
  ).toBeVisible();
  const url = page.url();
  // The late payment lands, then the guest taps retry before the next poll.
  await page.clock.setSystemTime(Date.now() + 60_000);
  await page.getByRole("button", { name: "Coba lagi dengan DANA" }).click();
  await expect(
    page.getByRole("heading", { name: "Pembayaran berhasil" }),
  ).toBeVisible();
  expect(page.url()).toBe(url);
});
