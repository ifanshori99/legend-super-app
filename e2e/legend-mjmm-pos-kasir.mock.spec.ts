// legend-mjmm: POS kasir (pembayaran, EDC, kode pelanggan, shift, supervisor,
// tutup hari) against the FE mock runtime (VITE_API_MOCK=true).
//
// Run: pnpm test:e2e:mock e2e/legend-mjmm-pos-kasir.mock.spec.ts
//
// Source of expected behavior: design/mockups/pos/*.html + README.md (founder
// decisions Q7-Q10, 8 Nov 2026) and the sub-pos-kasir.md brief (demo ids and
// `?demo=` seeds). Never backend code.
//
// Assumptions (the mockup or brief leaves these open):
//  A1 Money may render as "Rp148.000" or "Rp 148.000": every amount regex uses
//     `Rp\s*`. Amount rows are asserted as label-then-value in DOM order.
//  A2 Payment methods render as buttons or radios named after the mockup
//     ("Tunai", "QRIS", ...). The primary action reads "Lanjutkan dengan <metode>".
//  A3 After choosing Tunai on a split order, the screen shows either the split
//     panel ("Terima tunai Rp 48.000") first or the cash panel directly; the
//     test handles both.
//  A4 Amount fields are filled through the on-screen keypad when one exists,
//     otherwise by typing (the mockup shows readonly inputs).
//  A5 EDC standalone is reachable from the EDC select screen through a control
//     whose name contains "standalone".
//  A6 The supervisor PIN is a labelled "PIN supervisor" field or the shared
//     PinPad (digit buttons). Any 6 digit PIN is accepted by the mock.
//  A7 `?mock=error` shows a "Coba lagi" button (repo convention).
//  A8 The day-close screen shows the business-day cutoff as 04.00 or 04:00.
//  A9 After the cashier sends the blind count the screen says the count waits
//     for a supervisor ("Menunggu supervisor").
//  A10 Founder decision Q8: blind count is per denomination, so the mockup's
//     "Masukkan total saja" shortcut must not exist.
//  A11 The seed `edc-tidak-pasti` resolves to a successful EDC result after
//     "Cek status EDC".
//  A12 Day close needs no confirmation dialog; if one appears it is confirmed.
import {
  expect as baseExpect,
  test,
  type Locator,
  type Page,
} from "@playwright/test";
import { waitForHydration } from "./hydration.ts";
import { captureScreenshot } from "./screenshots.ts";

const expect = baseExpect.configure({ timeout: 15_000 });

// Demo ids from the sub-pos-kasir.md brief.
const DEMO_ORDER_ID = "0b0b0048-0000-4000-8000-000000000048";
const DEMO_CODE_ORDER_ID = "0b0b0044-0000-4000-8000-000000000044";
const DEMO_SHIFT_ID = "0c0c0001-0000-4000-8000-000000000001";

test.describe.configure({ timeout: 90_000 });
test.use({ viewport: { width: 1280, height: 800 } });

// ---------------------------------------------------------------- helpers

/** "148.000" -> regex source `Rp\s*148\.000`. */
const rp = (amount: string) => `Rp\\s*${amount.replace(/\./g, "\\.")}`;
/** Rupiah minus sign: U+2212, en dash or hyphen. */
const MINUS = "[\\u2212\\u2013-]";
const DASH = "[\\u2013\\u2212-]";
// The shared keypad names its delete key "Hapus angka terakhir".
const BACKSPACE = /^Hapus angka terakhir$/;

const payUrl = (seed?: string, orderId = DEMO_ORDER_ID) =>
  `/pos/bayar/${orderId}${seed ? `?demo=${seed}` : ""}`;

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await waitForHydration(page);
}

const main = (page: Page) => page.locator("#main-content");

/** Evidence screenshot 1280x800, named after the mockup PNG. */
async function shot(page: Page, mockupName: string): Promise<void> {
  // The mock tenant has an active support-access session from WS-01; a real
  // cashier session has none, so hide that banner in the evidence shots only.
  await page.addStyleTag({
    content: '[data-slot="support-session-bar"]{display:none !important}',
  });
  await captureScreenshot(page, `legend-mjmm/${mockupName}.png`, {
    fullPage: false,
  });
}

// The payment screens repeat a state title as page h1 and panel h2 (for example
// "Pembayaran gabungan"), so a bare heading query breaks strict mode. `.first()`
// keeps the assertion on the visible title without relaxing its text.
const heading = (page: Page, name: string | RegExp) =>
  page.getByRole("heading", { name }).first();

/** A payment method tile: button or radio named "<Metode> <hint>". */
function methodOption(page: Page, name: string): Locator {
  const re = new RegExp(`^${name}`);
  return page
    .getByRole("button", { name: re })
    .or(page.getByRole("radio", { name: re }));
}

/** Clicks only when the control is enabled (a disabled control is a valid "required" guard). */
async function clickIfEnabled(button: Locator): Promise<void> {
  await expect(button).toBeVisible();
  if (await button.isEnabled()) await button.click();
}

/** Types an amount: keypad when the screen has one (A4), otherwise fill. */
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

/** Supervisor PIN: labelled field or the PinPad digit buttons (A6). */
async function enterPin(page: Page, pin: string): Promise<void> {
  const field = page.getByLabel(/PIN supervisor/i).and(page.locator("input"));
  const pad = page.getByRole("button", { name: "1", exact: true });
  await expect(field.or(pad)).toBeVisible();
  if ((await field.count()) > 0) {
    await field.fill(pin);
    return;
  }
  for (const digit of pin) {
    await page.getByRole("button", { name: digit, exact: true }).click();
  }
}

/** U2 (legend-pspy): held cash outs must be reviewed before the approval form. */
async function reviewHeldCashOuts(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Lanjutkan peninjauan" }).click();
}

// ------------------------------------------------------------ payment core

test("legend-mjmm PAY-01 payment screen shows the bill, DP and the six methods", async ({
  page,
}) => {
  await open(page, payUrl());
  await expect(heading(page, /^Pembayaran/).first()).toBeVisible();

  const area = main(page);
  await expect(area).toContainText(/Meja A12/);
  await expect(area).toContainText("Belum lunas");
  await expect(area).toContainText(/POS.0048\s*·\s*6 item\s*·\s*2 tamu/);
  await expect(area).toContainText(new RegExp(`Subtotal\\s*${rp("220.000")}`));
  await expect(area).toContainText(new RegExp(`Service\\s*${rp("8.000")}`));
  await expect(area).toContainText(new RegExp(`Pajak\\s*${rp("20.000")}`));
  await expect(area).toContainText(
    new RegExp(`Total tagihan\\s*${rp("248.000")}`),
  );
  await expect(area).toContainText(
    new RegExp(`DP reservasi terpakai\\s*${MINUS}\\s*${rp("100.000")}`),
  );
  await expect(area).toContainText(
    new RegExp(`DP lunas\\s*·\\s*RSV${DASH}?0018`),
  );
  await expect(area).toContainText(
    new RegExp(`Sisa yang harus dibayar\\s*${rp("148.000")}`),
  );

  await expect(heading(page, "Pilih metode pembayaran")).toBeVisible();
  for (const method of [
    "QRIS",
    "Virtual Account",
    "E-wallet",
    "Kartu kredit/debit",
    "Tunai",
    "EDC",
  ]) {
    await expect(methodOption(page, method)).toBeVisible();
  }
  await expect(
    page.getByRole("button", { name: "Bayar sebagian" }),
  ).toBeVisible();
  await shot(page, "payment-methods");
});

test("legend-mjmm PAY-01 cash pays the whole bill and shows the change", async ({
  page,
}) => {
  await open(page, payUrl());
  await methodOption(page, "Tunai").click();
  await page.getByRole("button", { name: /Lanjutkan dengan Tunai/ }).click();

  await expect(heading(page, "Terima pembayaran tunai")).toBeVisible();
  const area = main(page);
  await expect(area).toContainText(
    new RegExp(`Sisa tagihan\\s*${rp("148.000")}`),
  );

  await enterAmount(page, page.getByLabel("Uang diterima"), 150_000);
  await expect(area).toContainText(
    new RegExp(`Kembalian pelanggan\\s*${rp("2.000")}`),
  );
  // Not paid until the cashier confirms.
  await expect(area).toContainText("Belum lunas");

  await page.getByRole("button", { name: /Konfirmasi terima tunai/ }).click();

  await expect(heading(page, "Pembayaran selesai")).toBeVisible();
  await expect(
    heading(page, new RegExp(`Serahkan kembalian\\s*${rp("2.000")}`)),
  ).toBeVisible();
  await expect(area).toContainText(/Total\s*Rp\s*248\.000 sudah lunas/);
  await expect(area).toContainText("Lunas");
  await expect(area).toContainText(new RegExp(`Sisa bayar\\s*${rp("0")}`));
  await expect(
    page.getByRole("button", { name: "Cetak struk", exact: true }),
  ).toBeVisible();
});

test("legend-mjmm PAY-01 split: QRIS confirmed, cash 48.000 with 50.000 received gives change 2.000 and a paid bill", async ({
  page,
}) => {
  await open(page, payUrl("split"));
  const area = main(page);
  await expect(area).toContainText(
    new RegExp(`QRIS terkonfirmasi\\s*${MINUS}\\s*${rp("100.000")}`),
  );
  await expect(area).toContainText(
    new RegExp(`Sisa yang harus dibayar\\s*${rp("48.000")}`),
  );

  await methodOption(page, "Tunai").click();
  await page.getByRole("button", { name: /Lanjutkan dengan Tunai/ }).click();

  // A3: split panel first, or the cash panel directly.
  const acceptCash = page.getByRole("button", {
    name: new RegExp(`Terima tunai\\s*${rp("48.000")}`),
  });
  const received = page.getByLabel("Uang diterima");
  await expect(acceptCash.or(received)).toBeVisible();
  if (await acceptCash.isVisible()) {
    await expect(heading(page, "Pembayaran gabungan")).toBeVisible();
    await expect(area).toContainText(/Dikonfirmasi pukul 14[.:]31/);
    await expect(area).toContainText(
      new RegExp(`Masih kurang\\s*${rp("48.000")}`),
    );
  }
  await shot(page, "payment-split");
  if (await acceptCash.isVisible()) await acceptCash.click();

  await expect(received).toBeVisible();
  await expect(area).toContainText(
    new RegExp(`Sisa tagihan\\s*${rp("48.000")}`),
  );
  await enterAmount(page, received, 50_000);
  await expect(area).toContainText(
    new RegExp(`Kembalian pelanggan\\s*${rp("2.000")}`),
  );
  await expect(area).toContainText("Belum lunas");
  await shot(page, "payment-cash");

  await page.getByRole("button", { name: /Konfirmasi terima tunai/ }).click();
  await expect(
    heading(page, new RegExp(`Serahkan kembalian\\s*${rp("2.000")}`)),
  ).toBeVisible();
  await expect(area).toContainText("Lunas");
});

test("legend-mjmm PAY-01 paid order shows the allocation breakdown and receipt", async ({
  page,
}) => {
  await open(page, payUrl("lunas"));
  const area = main(page);
  await expect(heading(page, "Pembayaran selesai")).toBeVisible();
  await expect(
    heading(page, new RegExp(`Serahkan kembalian\\s*${rp("2.000")}`)),
  ).toBeVisible();
  await expect(area).toContainText(/Struk POS01.000048/);
  await expect(area).toContainText(
    new RegExp(`DP reservasi\\s*${rp("100.000")}`),
  );
  await expect(area).toContainText(new RegExp(`QRIS\\s*${rp("100.000")}`));
  await expect(area).toContainText(
    new RegExp(`Tunai untuk tagihan\\s*${rp("48.000")}`),
  );
  await expect(area).toContainText(
    new RegExp(`Uang diterima\\s*${rp("50.000")}`),
  );
  await expect(area).toContainText(new RegExp(`Kembalian\\s*${rp("2.000")}`));
  await expect(area).toContainText(new RegExp(`Sisa bayar\\s*${rp("0")}`));
  await expect(
    page.getByRole("button", { name: "Lihat e-receipt" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Cetak struk", exact: true }),
  ).toBeVisible();
  await shot(page, "payment-success");
});

// ----------------------------------------------------------------- gateway

test("legend-mjmm PAY-02 active QRIS waits for confirmation and shows no QR on the cashier screen", async ({
  page,
}) => {
  await open(page, payUrl("qris-aktif"));
  await expect(heading(page, "QRIS siap dipindai")).toBeVisible();
  const area = main(page);
  await expect(area).toContainText(/Berlaku\s*\d{1,2}:\d{2}\s*lagi/);
  await expect(area).toContainText("Menunggu konfirmasi pembayaran");
  await expect(area).toContainText("Belum lunas");
  // The QR belongs on the customer display, never on the cashier screen.
  await expect(page.getByRole("img", { name: /qr|pindai/i })).toHaveCount(0);
  // Brief R4: "Lihat customer display →" is a link to /pos/customer-display.
  await expect(
    page.getByRole("link", { name: /Lihat customer display/ }),
  ).toBeVisible();
  await shot(page, "payment-qris-active");

  // The mock confirms the payment only after "Cek status pembayaran".
  await page.getByRole("button", { name: "Cek status pembayaran" }).click();
  await expect(heading(page, "Pembayaran selesai")).toBeVisible();
});

test("legend-mjmm PAY-02 starting QRIS from the method grid opens the waiting state", async ({
  page,
}) => {
  await open(page, payUrl());
  await methodOption(page, "QRIS").click();
  await page.getByRole("button", { name: /Lanjutkan dengan QRIS/ }).click();
  await expect(heading(page, "QRIS siap dipindai")).toBeVisible();
  await expect(main(page)).toContainText(new RegExp(rp("148.000")));
});

test("legend-mjmm PAY-02 expired QRIS never shows the old code and offers another method", async ({
  page,
}) => {
  await open(page, payUrl("qris-kedaluwarsa"));
  await expect(heading(page, "QRIS kedaluwarsa")).toBeVisible();
  const area = main(page);
  await expect(area).toContainText("Jangan gunakan kode QR sebelumnya");
  await expect(area).toContainText("Tagihan belum lunas");
  await expect(area).toContainText(new RegExp(rp("148.000")));
  await expect(page.getByRole("img", { name: /qr|pindai/i })).toHaveCount(0);
  await expect(area).not.toContainText("QRIS siap dipindai");
  await shot(page, "payment-qris-expired");

  await page.getByRole("button", { name: "Pilih metode lain" }).click();
  await expect(heading(page, "Pilih metode pembayaran")).toBeVisible();
  await expect(area).toContainText(
    new RegExp(`Sisa yang harus dibayar\\s*${rp("148.000")}`),
  );
});

test("legend-mjmm PAY-02 failed QRIS keeps the bill unpaid and recovers through another method", async ({
  page,
}) => {
  await open(page, payUrl("gagal"));
  // The seed may start waiting (failure arrives on status check) or failed.
  const check = page.getByRole("button", { name: "Cek status pembayaran" });
  const failedHeading = heading(page, "Pembayaran gagal");
  await expect(check.or(failedHeading)).toBeVisible();
  if (await check.isVisible()) await check.click();

  await expect(failedHeading).toBeVisible();
  const area = main(page);
  await expect(area).toContainText("QRIS ini belum menerima pembayaran");
  await expect(area).toContainText(
    new RegExp(`DP\\s*${rp("100.000")}\\s*tetap terpakai`),
  );
  await expect(area).toContainText("Belum lunas");
  await expect(
    page.getByRole("button", { name: /Coba QRIS lagi/ }),
  ).toBeVisible();
  await shot(page, "payment-failed");

  await page.getByRole("button", { name: /Pilih metode lain/ }).click();
  await expect(heading(page, "Pilih metode pembayaran")).toBeVisible();
  await expect(area).toContainText(
    new RegExp(`Sisa yang harus dibayar\\s*${rp("148.000")}`),
  );
});

test("legend-mjmm PAY-02 Virtual Account shows number and deadline and is not paid from a transfer proof", async ({
  page,
}) => {
  await open(page, payUrl("va"));
  await expect(heading(page, "Nomor VA sudah tersedia")).toBeVisible();
  const area = main(page);
  await expect(area).toContainText("Nomor Virtual Account");
  await expect(area).toContainText(/\d{4}\s?\d{4}\s?\d{4}/);
  await expect(area).toContainText("Batas pembayaran");
  await expect(area).toContainText("Belum lunas");
  await expect(area).toContainText("Jangan konfirmasi dari bukti transfer");
  await shot(page, "payment-va");

  await page.getByRole("button", { name: "Cek status pembayaran" }).click();
  await expect(heading(page, "Pembayaran selesai")).toBeVisible();
});

// --------------------------------------------------------------------- EDC

test("legend-mjmm EDC-01 sending to EDC locks amount and terminal, then the result arrives", async ({
  page,
}) => {
  await open(page, payUrl());
  await methodOption(page, "EDC").click();
  await page.getByRole("button", { name: /Lanjutkan dengan EDC/ }).click();

  await expect(heading(page, /Pilih terminal.*metode EDC/)).toBeVisible();
  const area = main(page);
  await expect(area).toContainText("Kartu kredit / debit");
  await expect(area).toContainText("QRIS melalui EDC");
  await expect(area).toContainText(/EDC 01/);
  await expect(area).toContainText(/EDC 02/);
  await expect(area).toContainText(
    new RegExp(`Sisa tagihan\\s*${rp("148.000")}`),
  );
  await shot(page, "edc-select");

  await page
    .getByRole("button", {
      name: new RegExp(`Kirim\\s*${rp("148.000")}\\s*ke EDC`),
    })
    .click();

  await expect(heading(page, "Selesaikan di mesin EDC")).toBeVisible();
  await expect(area).toContainText("Nominal terkunci");
  await expect(area).toContainText(new RegExp(rp("148.000")));
  await expect(area).toContainText("Pembayaran belum tercatat lunas");
  // No second payment and no terminal switch while the machine works.
  await expect(page.getByRole("button", { name: /^Kirim/ })).toHaveCount(0);
  await expect(area).not.toContainText(/EDC 02/);
  await expect(
    page.getByRole("button", { name: /Batalkan melalui EDC/ }),
  ).toBeVisible();
  await shot(page, "edc-waiting");

  // The mock answers after about 3 seconds.
  await expect(heading(page, "Pembayaran EDC berhasil")).toBeVisible();
  await expect(area).toContainText("Lunas");
});

test("legend-mjmm EDC-02 an approved EDC payment shows bank reference and masked card", async ({
  page,
}) => {
  await open(page, payUrl("edc-berhasil"));
  await expect(heading(page, "Pembayaran EDC berhasil")).toBeVisible();
  const area = main(page);
  await expect(area).toContainText("Disetujui oleh bank");
  await expect(area).toContainText(/EDC 01/);
  await expect(area).toContainText(/•{2,}\s*\d{4}/);
  await expect(area).toContainText(/Referensi bank\s*\d+/);
  await expect(area).toContainText(/Referensi POS/);
  await expect(area).toContainText("Lunas");
  await expect(
    page.getByRole("button", { name: /Cetak ulang struk/ }),
  ).toBeVisible();
  await shot(page, "edc-success");
});

test("legend-mjmm EDC-03 an uncertain EDC result forces a status check before any retry or method change", async ({
  page,
}) => {
  await open(page, payUrl("edc-tidak-pasti"));
  await expect(heading(page, "Cek hasil pembayaran EDC")).toBeVisible();
  const area = main(page);
  await expect(area).toContainText("Hasil dari mesin belum diterima");
  await expect(area).toContainText("Status belum pasti");
  await expect(area).toContainText("Cek status sebelum menagih ulang");
  await expect(area).toContainText("Nominal terkunci");
  await expect(area).toContainText("Referensi transaksi");
  await shot(page, "edc-unknown");

  // Retry is locked (absent or disabled); no way to switch method or go standalone.
  const retry = page.getByRole("button", { name: /Ulang pembayaran/ });
  if ((await retry.count()) > 0) await expect(retry).toBeDisabled();
  await expect(
    page.getByRole("button", {
      name: /metode lain|ganti metode|pilih metode|standalone|^Kirim/i,
    }),
  ).toHaveCount(0);
  await expect(page.getByRole("link", { name: /standalone/i })).toHaveCount(0);

  await page.getByRole("button", { name: "Cek status EDC" }).click();
  await expect(heading(page, "Pembayaran EDC berhasil")).toBeVisible();
});

test("legend-mjmm EDC-04 standalone needs a bank reference and a supervisor PIN, and is marked for reconciliation", async ({
  page,
}) => {
  await open(page, payUrl());
  await methodOption(page, "EDC").click();
  await page.getByRole("button", { name: /Lanjutkan dengan EDC/ }).click();
  await expect(heading(page, /Pilih terminal.*metode EDC/)).toBeVisible();

  // A5: the entry point is named "...standalone".
  const entry = page
    .getByRole("button", { name: /standalone/i })
    .or(page.getByRole("link", { name: /standalone/i }));
  await entry.click();

  await expect(heading(page, "Catat pembayaran EDC standalone")).toBeVisible();
  const area = main(page);
  await expect(area).toContainText("Perlu rekonsiliasi");
  await expect(area).toContainText("Koneksi ECR tidak tersedia");
  await expect(area).toContainText(new RegExp(rp("148.000")));
  await expect(area).toContainText(/Nomor referensi bank\s*·?\s*wajib/);
  await expect(area).toContainText(/PIN supervisor\s*·?\s*wajib/);
  await shot(page, "edc-standalone");

  const submit = page.getByRole("button", {
    name: /Setujui & catat pembayaran/,
  });
  const reference = page.getByLabel(/Nomor referensi bank/);
  const enabledSubmit = submit.and(page.locator(":enabled"));

  // Nothing filled: cannot record.
  await clickIfEnabled(submit);
  await expect(heading(page, "Catat pembayaran EDC standalone")).toBeVisible();

  // PIN without a bank reference: still cannot record.
  await enterPin(page, "123456");
  await clickIfEnabled(submit);
  await expect(heading(page, "Catat pembayaran EDC standalone")).toBeVisible();
  await expect(reference).toHaveValue("");

  // Reference + PIN without a chosen supervisor: still cannot record.
  await reference.fill("736214805192");
  await expect(enabledSubmit).toHaveCount(0);

  // Reference + supervisor + PIN: recorded and the bill is paid.
  await page
    .getByRole("combobox", { name: /Supervisor yang menyetujui/ })
    .click();
  await page.getByRole("option", { name: "Supervisor 01" }).click();
  await expect(enabledSubmit).toHaveCount(1);
  await submit.click();
  await expect(
    heading(page, /Pembayaran EDC berhasil|Pembayaran selesai|Tagihan lunas/),
  ).toBeVisible();
});

// ------------------------------------------------------------ cashier code

test("legend-mjmm CODE-01 a valid customer code is matched and leads to payment", async ({
  page,
}) => {
  await open(page, "/pos/kode");
  await expect(heading(page, "Terima kode pelanggan")).toBeVisible();
  const code = page.getByLabel(/Kode .Bayar di kasir./);
  await expect(code).toBeVisible();
  // Empty state: nothing found yet and no way to pay.
  await expect(main(page)).not.toContainText("Pesanan ditemukan");
  await expect(
    page.getByRole("link", { name: /Lanjut ke pembayaran/ }),
  ).toHaveCount(0);

  await code.fill("0044");
  await page.getByRole("button", { name: /^Cari (ulang )?pesanan$/ }).click();

  const area = main(page);
  await expect(area).toContainText("Pesanan ditemukan");
  await expect(area).toContainText(new RegExp(`LG${DASH}?0044`));
  await expect(area).toContainText("Meja A01");
  await expect(area).toContainText("Espresso dingin");
  await expect(area).toContainText(new RegExp(rp("26.600")));
  await expect(area).toContainText("Belum dibayar · Belum masuk dapur");
  await expect(area).toContainText(
    "Membuka pembayaran belum menandai pesanan lunas",
  );
  await shot(page, "cashier-code-found");

  // "Lanjut ke pembayaran" is a link to /pos/bayar/<id>, not a button.
  await page
    .getByRole("link", {
      name: new RegExp(`Lanjut ke pembayaran\\s*${rp("26.600")}`),
    })
    .click();
  await expect(page).toHaveURL(new RegExp(`/pos/bayar/${DEMO_CODE_ORDER_ID}`));
  await expect(heading(page, /^Pembayaran/).first()).toBeVisible();
  await expect(main(page)).toContainText("Meja A01");
  await expect(main(page)).toContainText(
    new RegExp(`Sisa yang harus dibayar\\s*${rp("26.600")}`),
  );
});

// legend-doykg: with the first script held back the screen paints from server
// HTML for seconds. open() must wait until it is interactive, so the typed code
// reaches React state and the lookup finds the order (flaky ~1 in 8 before).
test("legend-doykg CODE-01 a code typed right after open() survives slow hydration", async ({
  page,
}) => {
  let held = false;
  await page.route(/\.(js|mjs|ts|tsx)(\?|$)/, async (route) => {
    if (!held) {
      held = true;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    await route.continue();
  });
  await open(page, "/pos/kode");
  await page.getByLabel(/Kode .Bayar di kasir./).fill("0044");
  await page.getByRole("button", { name: /^Cari (ulang )?pesanan$/ }).click();
  await expect(main(page)).toContainText("Pesanan ditemukan");
});

test("legend-mjmm CODE-02 a wrong code keeps the input, starts no payment and can be corrected", async ({
  page,
}) => {
  await open(page, "/pos/kode");
  const code = page.getByLabel(/Kode .Bayar di kasir./);
  // Typed through the keypad: its buttons only work once React has hydrated,
  // so a value typed before hydration cannot slip past the screen's state.
  await expect(async () => {
    await code.fill("");
    for (const digit of "0049")
      await page.getByRole("button", { name: digit, exact: true }).click();
    await expect(code).toHaveValue(/0049/, { timeout: 1_000 });
  }).toPass();
  await page.getByRole("button", { name: /^Cari (ulang )?pesanan$/ }).click();

  const area = main(page);
  await expect(area).toContainText("Kode tidak ditemukan. Periksa kembali.");
  await expect(heading(page, "Pesanan belum ditemukan")).toBeVisible();
  await expect(area).toContainText("Belum ada pembayaran diproses");
  await expect(code).toHaveValue(/0049/);
  await expect(
    page.getByRole("link", { name: /Lanjut ke pembayaran/ }),
  ).toHaveCount(0);
  await shot(page, "cashier-code-invalid");

  // Correct it and search again.
  // Editing drops the stale "not found" result, so the label may reset.
  await code.fill("0044");
  await page.getByRole("button", { name: /^Cari (ulang )?pesanan$/ }).click();
  await expect(area).toContainText("Pesanan ditemukan");
  await expect(area).toContainText("Meja A01");
  await expect(area).not.toContainText("Kode tidak ditemukan");
});

// ------------------------------------------------------------------- shift

test("legend-mjmm SHIFT-01 opening a shift records the 500.000 opening cash", async ({
  page,
}) => {
  await open(page, "/pos/shift");
  await expect(heading(page, "Buka shift kasir")).toBeVisible();
  const area = main(page);
  await expect(area).toContainText("Belum ada shift aktif");
  await expect(area).toContainText("Kasir 01");
  await expect(area).toContainText("Terminal 01");
  await expect(area).toContainText("Modal awal dicatat per shift");

  const opening = page.getByLabel("Uang yang sudah dihitung");
  const submit = page.getByRole("button", { name: /^Buka shift/ });
  // Nothing counted yet: the shift must not open.
  await clickIfEnabled(submit);
  await expect(heading(page, "Buka shift kasir")).toBeVisible();

  await enterAmount(page, opening, 500_000);
  await expect(
    page.getByRole("button", {
      name: new RegExp(`^Buka shift.*${rp("500.000")}`),
    }),
  ).toBeVisible();
  await shot(page, "shift-open");
  await submit.click();

  await expect(heading(page, "Shift kasir")).toBeVisible();
  await expect(area).toContainText("Shift aktif");
  await expect(area).toContainText(
    new RegExp(`Modal awal\\s*${rp("500.000")}`),
  );
  await expect(
    page.getByRole("link", { name: "Mulai tutup shift" }),
  ).toBeVisible();
});

test("legend-mjmm SHIFT-02 a cash-out needs an amount and a reason before it is saved", async ({
  page,
}) => {
  await open(page, "/pos/shift?demo=shift-aktif");
  await expect(heading(page, "Shift kasir")).toBeVisible();
  const area = main(page);
  await expect(area).toContainText("Shift aktif");
  await expect(area).toContainText(
    new RegExp(`Modal awal\\s*${rp("500.000")}`),
  );
  await expect(area).toContainText("Pergerakan kas shift ini");
  await expect(area).toContainText(`Kas keluar`);
  await expect(area).toContainText(new RegExp(`${MINUS}\\s*${rp("100.000")}`));
  // The cashier never sees the system balance.
  await expect(area).not.toContainText(/Rp\s*2\.250\.000/);

  // Kas masuk tab exists and uses the same form.
  const tab = (name: RegExp) =>
    page
      .getByRole("tab", { name })
      .or(page.getByRole("radio", { name }))
      .or(page.getByRole("button", { name }));
  await tab(/^\+?\s*Kas masuk$/).click();
  await expect(page.getByLabel(/Alasan kas masuk/)).toBeVisible();
  await tab(/^[−–-]?\s*Kas keluar$/).click();

  const amount = page.getByLabel("Nominal tunai");
  const reason = page.getByLabel(/Alasan kas keluar/);
  const save = page.getByRole("button", { name: "Simpan kas keluar" });
  const newRow = area.getByText(/Pembelian bahan tambahan dapur/);
  await expect(amount).toBeVisible();
  await shot(page, "shift-active");

  // Nothing filled, then amount only: no new movement.
  await clickIfEnabled(save);
  await enterAmount(page, amount, 200_000);
  await clickIfEnabled(save);
  await expect(newRow).toHaveCount(0);
  await expect(area).not.toContainText(
    new RegExp(`${MINUS}\\s*${rp("200.000")}`),
  );

  // Amount + reason: saved on top of the history.
  await reason.fill("Pembelian bahan tambahan dapur");
  await save.click();
  await expect(newRow).toBeVisible();
  await expect(area).toContainText(new RegExp(`${MINUS}\\s*${rp("200.000")}`));
  await expect(area).toContainText(new RegExp(`${MINUS}\\s*${rp("100.000")}`));
});

test("legend-mjmm SHIFT-03 blind count by denomination hides the system balance and difference from the cashier", async ({
  page,
}) => {
  await open(page, "/pos/shift/tutup?demo=shift-aktif");
  await expect(heading(page, /Tutup shift.*Hitung kas/)).toBeVisible();
  const area = main(page);
  await expect(area).toContainText("Langkah 1 dari 2");
  await expect(area).toContainText("Jumlah lembar per pecahan");
  await expect(area).toContainText("Saldo sistem tidak ditampilkan");
  // A10 (Q8): per denomination is mandatory, no "total only" shortcut.
  await expect(
    page.getByRole("button", { name: /Masukkan total saja/i }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: /Masukkan total saja/i }),
  ).toHaveCount(0);

  const counts: Array<[string, string]> = [
    ["100.000", "18"],
    ["50.000", "6"],
    ["20.000", "5"],
    ["10.000", "2"],
    ["5.000", "2"],
  ];
  // Denomination labels render as "Rp 100.000" (space or NBSP): tolerate both.
  for (const [value, qty] of counts) {
    await page
      .getByRole("textbox", {
        name: new RegExp(`^Rp\\s?${value.replace(/\./g, "\\.")}$`),
      })
      .fill(qty);
  }
  await expect(area).toContainText(/Rp\s*1\.800\.000/);
  await expect(area).toContainText(
    new RegExp(`Total uang fisik\\s*${rp("2.230.000")}`),
  );
  // Never the system figure or a difference before the count is sent.
  await expect(area).not.toContainText(/Rp\s*2\.250\.000/);
  await expect(area).not.toContainText(/Kas sistem|Kas kurang|Kas lebih/);
  await shot(page, "shift-blind");

  await page.getByRole("button", { name: "Kirim hitungan kas" }).click();
  // A9: after sending, the cashier only learns it waits for a supervisor.
  await expect(area).toContainText(/Menunggu (persetujuan )?supervisor/i);
  await expect(area).not.toContainText(/Rp\s*2\.250\.000/);
  await expect(area).not.toContainText(/Kas sistem|Kas kurang|Kas lebih/);
});

// -------------------------------------------------------------- supervisor

test("legend-mjmm SUP-01 supervisor sees the -20.000 difference and must give reason and PIN to close the shift", async ({
  page,
}) => {
  await open(page, `/pos/supervisor/shift/${DEMO_SHIFT_ID}`);
  await expect(heading(page, "Persetujuan tutup shift")).toBeVisible();
  const area = main(page);
  await expect(area).toContainText("Kas kurang");
  await expect(area).toContainText(/Kas kurang\s*[−-]?\s*Rp\s*20\.000/);
  await expect(area).toContainText(
    new RegExp(`Kas dihitung:?\\s*${rp("2.230.000")}`),
  );
  await expect(area).toContainText(
    new RegExp(`Modal awal\\s*${rp("500.000")}`),
  );
  await expect(area).toContainText(
    new RegExp(`Kas sistem\\s*${rp("2.250.000")}`),
  );
  await shot(page, "supervisor-approval");
  await reviewHeldCashOuts(page);
  await expect(area).toContainText("Persetujuan mengunci hasil");

  const approve = page.getByRole("button", { name: /Setujui & tutup shift/ });
  const enabledApprove = approve.and(page.locator(":enabled"));
  const reason = page
    .getByRole("textbox", { name: /Penjelasan selisih|Alasan/i })
    .first();
  await expect(reason).toBeVisible();

  // Nothing filled: cannot approve.
  await clickIfEnabled(approve);
  await expect(heading(page, "Persetujuan tutup shift")).toBeVisible();
  await expect(approve).toBeVisible();

  // Reason without PIN: cannot approve.
  await reason.fill("Uang kembalian diduga berlebih pada transaksi tunai.");
  await clickIfEnabled(approve);
  await expect(approve).toBeVisible();

  // Reason and PIN: approved, the approve action is gone or locked.
  await enterPin(page, "123456");
  await expect(enabledApprove).toHaveCount(1);
  await approve.click();
  await expect(enabledApprove).toHaveCount(0);
});

test("legend-mjmm SUP-01 PIN without a reason cannot approve", async ({
  page,
}) => {
  await open(page, `/pos/supervisor/shift/${DEMO_SHIFT_ID}`);
  await expect(heading(page, "Persetujuan tutup shift")).toBeVisible();
  const approve = page.getByRole("button", { name: /Setujui & tutup shift/ });
  await reviewHeldCashOuts(page);
  await enterPin(page, "123456");
  await clickIfEnabled(approve);
  await expect(heading(page, "Persetujuan tutup shift")).toBeVisible();
  await expect(approve).toBeVisible();
});

// --------------------------------------------------------------- day close

test("legend-mjmm DAY-01 day close shows the 04.00 cutoff, recap and per-bank settlement, then closes the day", async ({
  page,
}) => {
  await open(page, "/pos/tutup-hari");
  await expect(heading(page, "Tutup harian")).toBeVisible();
  const area = main(page);
  await expect(area).toContainText(/Hari usaha\s*8 November 2026/);
  // A8: cutoff 04.00 (founder Q9).
  await expect(area).toContainText(/04[.:]00/);
  await expect(area).toContainText("Rekap per kanal");
  await expect(area).toContainText(new RegExp(`Dine-in\\s*${rp("8.250.000")}`));
  await expect(area).toContainText(
    new RegExp(`Takeaway\\s*${rp("2.730.000")}`),
  );
  await expect(area).toContainText(
    new RegExp(`Ojek online\\s*${rp("1.500.000")}`),
  );
  await expect(area).toContainText(new RegExp(rp("12.480.000")));
  await expect(area).toContainText("Pembayaran bersih");
  for (const [method, amount] of [
    ["Tunai", "4.230.000"],
    ["QRIS", "4.650.000"],
    ["EDC", "2.400.000"],
    ["Virtual Account", "850.000"],
    ["E-wallet", "250.000"],
    ["Kartu kredit/debit", "100.000"],
  ] as const) {
    await expect(area).toContainText(new RegExp(`${method}\\s*${rp(amount)}`));
  }
  await expect(area).toContainText("Settlement EDC");
  await expect(area).toContainText(
    new RegExp(`BCA\\s*·\\s*${rp("1.600.000")}`),
  );
  await expect(area).toContainText(
    new RegExp(`Mandiri\\s*·\\s*${rp("800.000")}`),
  );
  await expect(area).toContainText("Semua shift ditutup");
  await expect(area).toContainText(/2 transaksi standalone/);
  await shot(page, "supervisor-day-close");

  await page.getByRole("button", { name: "Settlement & tutup hari" }).click();
  // A12: confirm only if the app asks.
  const closed = heading(page, "Hari usaha ditutup");
  const dialog = page.getByRole("dialog");
  await expect(closed.or(dialog)).toBeVisible();
  if (await dialog.isVisible()) {
    await dialog
      .getByRole("button", { name: /tutup hari|ya|lanjut|konfirmasi/i })
      .last()
      .click();
  }

  await expect(closed).toBeVisible();
  await expect(area).toContainText("Rekap tersimpan");
  await expect(area).toContainText("Tutup harian berhasil");
  await expect(area).toContainText(/Sinkronisasi akuntansi/);
  await expect(area).toContainText(/Antrean/);
  await expect(area).toContainText(/BCA:\s*batch berhasil/);
  await expect(area).toContainText(/Mandiri:\s*batch berhasil/);
  await expect(area).toContainText(/standalone tetap perlu rekonsiliasi/);
  await expect(area).toContainText(
    "Batch berhasil belum berarti dana sudah cocok",
  );
  await expect(
    page.getByRole("button", { name: "Cetak rekap harian" }),
  ).toBeVisible();
  // Brief R6: "Kembali ke kasir" is a link to /pos.
  await expect(
    page.getByRole("link", { name: "Kembali ke kasir" }),
  ).toBeVisible();
});

test("legend-mjmm DAY-02 an already closed day shows the saved recap and cannot be closed again", async ({
  page,
}) => {
  await open(page, "/pos/tutup-hari?demo=hari-ditutup");
  await expect(heading(page, "Hari usaha ditutup")).toBeVisible();
  const area = main(page);
  await expect(area).toContainText("Rekap tersimpan");
  await expect(area).toContainText(/Tutup harian berhasil/);
  await expect(area).toContainText(new RegExp(rp("12.480.000")));
  await expect(area).toContainText(/Antrean/);
  await expect(area).toContainText(/BCA:\s*batch berhasil/);
  await expect(area).toContainText(/Mandiri:\s*batch berhasil/);
  await expect(area).toContainText(/standalone tetap perlu rekonsiliasi/);
  await expect(
    page.getByRole("button", { name: "Settlement & tutup hari" }),
  ).toHaveCount(0);
  await shot(page, "supervisor-day-closed");
});

// ------------------------------------------------------------ error states

const ERROR_ROUTES: Array<[string, string]> = [
  ["bayar", `/pos/bayar/${DEMO_ORDER_ID}?mock=error`],
  ["shift", "/pos/shift?demo=shift-aktif&mock=error"],
  ["supervisor", `/pos/supervisor/shift/${DEMO_SHIFT_ID}?mock=error`],
  ["tutup hari", "/pos/tutup-hari?mock=error"],
];

for (const [name, url] of ERROR_ROUTES) {
  test(`legend-mjmm ERR-01 ${name}: a failed load says what went wrong and offers a retry`, async ({
    page,
  }) => {
    await open(page, url);
    // A7: recovery action is "Coba lagi".
    await expect(
      page.getByRole("button", { name: /coba lagi/i }),
    ).toBeVisible();
    // No half-drawn money screen behind the error.
    await expect(
      page.getByRole("button", {
        name: /Settlement & tutup hari|Setujui & tutup shift|^Tunai/,
      }),
    ).toHaveCount(0);
  });
}

// ------------------------------------------------------------- 390 px width

const NARROW_ROUTES: Array<[string, string, string | RegExp]> = [
  ["bayar", payUrl(), "Sisa yang harus dibayar"],
  ["kode", "/pos/kode", "Jumlah"],
  ["shift", "/pos/shift", "Modal awal tunai"],
  [
    "blind count",
    "/pos/shift/tutup?demo=shift-aktif",
    "Jumlah lembar per pecahan",
  ],
  ["supervisor", `/pos/supervisor/shift/${DEMO_SHIFT_ID}`, "Hasil hitung kas"],
  ["tutup hari", "/pos/tutup-hari", "Rekap per kanal"],
];

test.describe("390 px", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  for (const [name, url, anchor] of NARROW_ROUTES) {
    test(`legend-mjmm RESP-01 ${name} fits 390 px without horizontal scroll`, async ({
      page,
    }) => {
      await open(page, url);
      const target =
        name === "kode"
          ? page.getByLabel(/Kode .Bayar di kasir./)
          : main(page).getByText(anchor, { exact: false }).first();
      await expect(target).toBeVisible();
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
    });
  }
});

// ------------------------------------------------- supervisor, blind caller
//
// Contract (orchestrator brief): `?demo=laci-buta` is a blind caller
// (legend-ekaca). The server withholds every drawer figure, so the drawer shows
// "—" instead of a number, and the variance block says the difference is not
// shown. Assumptions:
//  B1 Placeholder is the em dash "—" (U+2014), as stated in the brief; each
//     figure is asserted as label-then-value in DOM order (like A1).
//  B2 "Modal awal" is not asserted for the blind caller (the brief does not
//     list it among the withheld figures).
//  B3 "Rp 0" / "Rp0" means a standalone zero amount, not the start of e.g.
//     "Rp0.5" or "Rp 0xx": the regex rejects a following digit or dot.
const BLIND_DRAWER_FIGURES = [
  "Penerimaan tunai",
  "Refund tunai",
  "Kas masuk",
  // U2: the held cash out is its own block, so the counted row is renamed.
  "Kas keluar diperhitungkan",
  "Setoran kas",
  "Kas sistem",
] as const;

async function expectBlindDrawer(page: Page): Promise<void> {
  await open(page, `/pos/supervisor/shift/${DEMO_SHIFT_ID}?demo=laci-buta`);
  await expect(heading(page, "Persetujuan tutup shift")).toBeVisible();
  const area = main(page);

  // Variance block: explicit "not shown", never a verdict.
  await expect(area).toContainText("Selisih tidak ditampilkan");
  await expect(area).not.toContainText(/Kas sesuai|Kas kurang|Kas lebih/);
  // One explanation, inside the variance block (visible before the dashes at 390).
  await expect(
    page
      .locator('[data-variance="hidden"]')
      .getByText(/disembunyikan untuk shift Anda sendiri/),
  ).toBeVisible();
  await expect(
    area.getByText(/disembunyikan untuk shift Anda sendiri/),
  ).toHaveCount(1);

  // Every withheld figure reads "—", not a number or a fake zero.
  for (const label of BLIND_DRAWER_FIGURES) {
    await expect(area, `${label} shows a dash`).toContainText(
      new RegExp(`${label}\\s*\\u2014`),
    );
  }

  // The caller's own count is still visible.
  await expect(area).toContainText(
    new RegExp(`Kas dihitung:?\\s*${rp("2.230.000")}`),
  );

  // No broken or invented numbers anywhere on the page.
  const text = await page.locator("body").innerText();
  expect(text).not.toContain("NaN");
  expect(text).not.toMatch(/Rp\s*0(?![\d.,])/);
  // The system figure from the non-blind view must not leak.
  expect(text).not.toMatch(/Rp\s*2\.250\.000/);
}

test.describe("blind drawer 1440 px", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("legend-mjmm SUP-01 blind drawer shows dashes and no difference verdict", async ({
    page,
  }) => {
    await expectBlindDrawer(page);
    await shot(page, "supervisor-blind-1440");
  });
});

test.describe("blind drawer 390 px", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("legend-mjmm RESP-01 blind drawer fits 390 px without horizontal scroll", async ({
    page,
  }) => {
    await expectBlindDrawer(page);
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
    await shot(page, "supervisor-blind-390");
  });
});

// Regression: without `?demo` the supervisor still sees every figure.
test("legend-mjmm SUP-01 non-blind drawer (no demo) still shows numbers, not blind placeholders", async ({
  page,
}) => {
  await open(page, `/pos/supervisor/shift/${DEMO_SHIFT_ID}`);
  await expect(heading(page, "Persetujuan tutup shift")).toBeVisible();
  const area = main(page);
  await expect(area).toContainText(/Penerimaan tunai\s*\+?\s*Rp\s*1\.850\.000/);
  await expect(area).toContainText(
    new RegExp(`Refund tunai\\s*${MINUS}?\\s*Rp\\s*50\\.000`),
  );
  await expect(area).toContainText(/Kas masuk\s*\+?\s*Rp\s*100\.000/);
  await expect(area).toContainText(
    // U2: "Kas keluar diperhitungkan" excludes the held (expired) cash out.
    new RegExp(`Kas keluar diperhitungkan\\s*${MINUS}?\\s*Rp\\s*150\\.000`),
  );
  await expect(area).toContainText(
    new RegExp(`Kas sistem\\s*${rp("2.250.000")}`),
  );
  await expect(area).not.toContainText("Selisih tidak ditampilkan");
  await expect(area).toContainText(/Kas kurang\s*[−-]?\s*Rp\s*20\.000/);
});

// Regression (reviewer): after a blind approval the closed panel must not say
// "Tidak ada selisih" (the real variance is unknown and not zero).
test("legend-ekaca blind drawer: closing the shift never claims there is no difference", async ({
  page,
}) => {
  await open(page, `/pos/supervisor/shift/${DEMO_SHIFT_ID}?demo=laci-buta`);
  await expect(heading(page, "Persetujuan tutup shift")).toBeVisible();
  const approve = page.getByRole("button", { name: /Setujui & tutup shift/ });
  const enabledApprove = approve.and(page.locator(":enabled"));
  await reviewHeldCashOuts(page);
  await page
    .getByRole("textbox", { name: /Penjelasan selisih|Alasan|Catatan/i })
    .first()
    .fill("Hitungan kas diperiksa ulang oleh supervisor.");
  await enterPin(page, "123456");
  await expect(enabledApprove).toHaveCount(1);
  await approve.click();
  await expect(enabledApprove).toHaveCount(0);
  const area = main(page);
  await expect(area).toContainText("Selisih tidak ditampilkan");
  await expect(area).not.toContainText("Tidak ada selisih");
  const text = await page.locator("body").innerText();
  expect(text).not.toContain("NaN");
  expect(text).not.toMatch(/Kas (sesuai|kurang|lebih)/);
});
