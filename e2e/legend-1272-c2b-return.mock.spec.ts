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

const payWith = (page: Page, what: RegExp) =>
  page.getByRole("button", { name: what }).filter({ visible: true });

/** Checkout with DANA, through the opening screen, back to /bayar/kembali. */
async function payWithDana(page: Page) {
  await openCheckout(page);
  await page.getByRole("radio", { name: /^E-wallet/ }).click();
  await page.getByRole("radio", { name: "DANA" }).click();
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
  await page.getByRole("radio", { name: /^E-wallet/ }).click();
  for (const wallet of ["OVO", "DANA", "ShopeePay", "LinkAja"])
    await expect(page.getByRole("radio", { name: wallet })).toBeVisible();
  await page.getByRole("radio", { name: "DANA" }).click();
  await expect(
    page.getByText(/dibawa ke halaman DANA untuk menyetujui/),
  ).toBeVisible();
  await expect(payWith(page, /^Bayar Rp.* dengan DANA$/)).toBeEnabled();
  await axe(page);
  await shot(page, "metode", true);

  await page.getByRole("radio", { name: /^Kartu kredit atau debit/ }).click();
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
  await expect(
    page.getByRole("radio", { name: /^Virtual Account/ }),
  ).toHaveCount(0);
  await expect(page.getByRole("radio", { name: /^Kartu kredit/ })).toHaveCount(
    0,
  );
  await page.getByRole("radio", { name: /^E-wallet/ }).click();
  await expect(page.getByRole("radio", { name: "OVO" })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "DANA" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "ShopeePay" })).toBeVisible();
  await shot(page, "metode-sebagian");
});

test("C2b the opening screen names Duitku once and keeps a manual button", async ({
  page,
}) => {
  // Hold the gateway page so the opening screen stays on.
  await page.route("**/bayar/kembali**", () => new Promise(() => {}));
  await openCheckout(page);
  await page.getByRole("radio", { name: /^E-wallet/ }).click();
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
  await page.getByRole("radio", { name: /^E-wallet/ }).click();
  await page.getByRole("radio", { name: "DANA" }).click();
  await payWith(page, /^Bayar Rp.* dengan DANA$/).click();
  await expect(
    page.getByRole("heading", { name: "Halaman DANA belum bisa dibuka" }),
  ).toBeVisible();
  await expect(page.getByText(/Anda belum membayar apa pun/)).toBeVisible();
  await axe(page);
  await shot(page, "membuka-gagal");
  await page.getByRole("button", { name: "Pilih metode lain" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Keranjang & bayar" }),
  ).toBeVisible();
});

test("C2b return: waiting, then paid only once the server says so", async ({
  page,
}) => {
  await payWithDana(page);
  await expect(
    page.getByRole("heading", { name: "Memastikan pembayaran Anda" }),
  ).toBeVisible();
  await expect(page.getByText(/Jangan bayar ulang/)).toBeVisible();
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
