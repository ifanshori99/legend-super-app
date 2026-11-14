// Forgot payslip PIN through an inbound WhatsApp message (bead legend-ur82k;
// PRD v1.7 §3 F30 "Slip Gaji", HR-01). Mock-mode spec, run once at the end:
//   heavy pnpm test:e2e:mock e2e/payslip-pin-wa-reset.mock.spec.ts
//
// Expected behavior comes from the founder-approved mockup copy
// (design/mockups/payslip-pin-inbound/README.md, "Teks layar") and the brief
// (founder decisions: number linked >= 3 days, "Hubungi HR atau atasan di
// outlet" without a verified WhatsApp, wa.me link + desktop QR + 2 s polling +
// new PIN form after verification), never from component code.
// docs/SPEC.md and docs/features.json do not exist in this repo, so test titles
// carry the PRD id (F30 / HR-01) plus the bead id.
//
// Scenarios are chosen with `?waScenario=` (fallback localStorage
// "legend.mock.waScenario"): verify (default, verified after 2 polls), pending,
// expire, no-wa, needs-update, too-new, unavailable-plain, rate-limited,
// rate-limited-wait, unavailable, proof-invalid.
//
// Assumptions where the mockup is silent:
//  - The mock store lives in browser memory and the scenario is read from the
//    URL at request time, so every test opens /karyawan/slip-gaji/lupa-pin with
//    its scenario in the first URL and stays on that page load.
//  - Actions named in the mockup ("Lewat WhatsApp", "Lihat cara minta bantuan",
//    "Kembali ke slip gaji", "Buat kode baru", ...) may be a button or a link;
//    helpers accept either role. Names match by prefix/regex because a button
//    can carry helper text ("Kirim pesan dari nomor yang terdaftar.").
//  - The recovery code is shown as text in the shape XXXX-XXXX (README example
//    "PIN K7M9-2Q4P"); the exact message prefix is not asserted.
//  - "Buka WhatsApp" is a link whose href is https://wa.me/<number>?text=<code>.
//  - "Salin nomor tujuan" copies the number taken from the wa.me link.
//  - No mockup exists for "nomor belum 3 hari" (too-new) or the combined
//    "unavailable-plain" screen: asserted only by "3 hari", HR/atasan text and
//    the absence of an active WhatsApp button (brief "Tambahan").
//  - 429 without a Retry-After header shows a general "Coba lagi nanti"
//    sentence without a number (brief "Tambahan"). With no number to wait for,
//    the "Coba lagi" button is offered at once (CTO decision, bead 851b).
//  - 429 with a wait: no "Coba lagi" button during the countdown; it appears
//    once the countdown ends. The wait is 12:34, so the test jumps the browser
//    clock forward (page.clock) instead of sleeping.
//  - needs-update (409, verified number that cannot be used): own heading,
//    HR help as the main button, no WhatsApp button, no number shown.
//  - proof-invalid (403 on saving the new PIN) shows an alert, keeps the
//    new-PIN form, and never reaches "PIN berhasil disimpan".
//  - The QR (role img) shows from the md breakpoint up (1280 px), not at 390 px.
//  - Cancelling a challenge has no mockup copy, so it is not covered here.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { waitForHydration } from "./hydration.ts";

const base = process.env.LEGEND_MOCK_WEB_URL;
test.skip(
  !base,
  "Mock runner not started: use pnpm test:e2e:mock (playwright.mock.config.ts).",
);
test.use({ baseURL: base });

/** Vite compiles a route on its first request: the first assertion waits. */
const COLD = 30_000;
/** Two 2 s polls plus slack. */
const POLL = 20_000;
const ROLE_COOKIE = "legend-mock-role";
const FORGOT_PATH = "/karyawan/slip-gaji/lupa-pin";
// Not all-same, not a straight sequence: passes the weak-PIN rule.
const NEW_PIN = "135792";
const CODE_SHAPE = /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/;
const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

async function openForgot(page: Page, scenario?: string, extra = "") {
  await page
    .context()
    .addCookies([{ name: ROLE_COOKIE, value: "employee", url: base! }]);
  const query = [scenario ? `waScenario=${scenario}` : "", extra]
    .filter(Boolean)
    .join("&");
  await page.goto(query ? `${FORGOT_PATH}?${query}` : FORGOT_PATH);
  await waitForHydration(page);
  await expect(page.getByRole("heading", { name: "Lupa PIN?" })).toBeVisible({
    timeout: COLD,
  });
}

/** A button or a link named like `name` (the mockup does not fix the role). */
function action(page: Page, name: string | RegExp): Locator {
  return page
    .getByRole("button", { name })
    .or(page.getByRole("link", { name }))
    .first();
}

const chooseWhatsApp = (page: Page) => action(page, /^Lewat WhatsApp/);

async function startWhatsApp(page: Page) {
  await chooseWhatsApp(page).click();
}

async function expectWaiting(page: Page) {
  await expect(
    page.getByRole("heading", { name: "Kirim lewat WhatsApp" }),
  ).toBeVisible({ timeout: COLD });
}

async function expectNoActiveWhatsApp(page: Page) {
  await expect(page.getByRole("link", { name: "Buka WhatsApp" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "Buka WhatsApp" })).toHaveCount(
    0,
  );
}

async function overflowX(page: Page) {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
}

// ---------------------------------------------------------------------------
// Choose screen
// ---------------------------------------------------------------------------

test("F30 HR-01 ur82k: Lupa PIN offers WhatsApp or HR help and says the PIN stays private", async ({
  page,
}) => {
  await page.setViewportSize(MOBILE);
  await openForgot(page);
  await expect(
    page.getByText("Pilih cara untuk membuat PIN baru."),
  ).toBeVisible();
  await expect(chooseWhatsApp(page)).toBeVisible();
  await expect(
    page.getByText("Kirim pesan dari nomor yang terdaftar."),
  ).toBeVisible();
  await expect(
    page.getByText("Minta bantuan HR atau supervisor").first(),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Tidak bisa pakai nomor terdaftar? Minta reset PIN ke HR atau supervisor di outlet.",
    ),
  ).toBeVisible();
  await expect(action(page, "Lihat cara minta bantuan")).toBeVisible();
  await expect(page.getByText("PIN tetap pribadi")).toBeVisible();
  await expect(
    page.getByText(/HR bisa mereset PIN, tetapi tidak bisa melihat/),
  ).toBeVisible();
  expect(await overflowX(page)).toBeLessThanOrEqual(0);
});

// ---------------------------------------------------------------------------
// Main flow (verify): waiting -> verified dialog -> new PIN -> done
// ---------------------------------------------------------------------------

test("F30 HR-01 ur82k: the waiting screen shows the code, countdown, sender hint and wa.me link, then verification opens the new PIN form", async ({
  page,
}) => {
  await page.setViewportSize(MOBILE);
  await openForgot(page, "verify");
  await startWhatsApp(page);
  await expectWaiting(page);

  await expect(page.getByText(/Gunakan nomor terdaftar/)).toBeVisible();
  await expect(page.getByText(/••••/).first()).toBeVisible();
  await expect(page.getByText("Pesan yang akan dikirim")).toBeVisible();
  await expect(page.getByText(CODE_SHAPE).first()).toBeVisible();
  await expect(page.getByText(/Berlaku \d{2}:\d{2} lagi/)).toBeVisible();
  await expect(
    page.getByText(
      "Pesan sudah terisi. Tekan Kirim tanpa mengubahnya, lalu kembali ke halaman ini.",
    ),
  ).toBeVisible();
  await expect(page.getByText(/Menunggu pesan Anda/)).toBeVisible();
  await expect(
    page.getByText("Verifikasi muncul di sini, tanpa balasan WhatsApp."),
  ).toBeVisible();
  await expect(page.getByText("WhatsApp di perangkat lain?")).toBeVisible();
  await expect(action(page, "Salin pesan")).toBeVisible();
  await expect(action(page, "Salin nomor tujuan")).toBeVisible();
  await expect(action(page, "Minta bantuan HR atau supervisor")).toBeVisible();

  // "Buka WhatsApp" opens wa.me with the message already filled in.
  const open = page.getByRole("link", { name: "Buka WhatsApp" });
  await expect(open).toBeVisible();
  const href = await open.getAttribute("href");
  expect(href).toMatch(/^https:\/\/wa\.me\/\d+\?text=/);
  expect(decodeURIComponent(href!)).toMatch(CODE_SHAPE);

  // A verified answer from the server opens the success dialog (2 polls).
  const dialog = page.getByRole("dialog", {
    name: "Nomor berhasil diverifikasi",
  });
  await expect(dialog).toBeVisible({ timeout: POLL });
  await expect(
    dialog.getByText("Sekarang buat PIN slip gaji yang baru."),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Buat PIN baru" }).click();

  // The existing new-PIN form; no WhatsApp code field.
  await expect(
    page.getByRole("heading", { name: "Buat PIN slip gaji" }),
  ).toBeVisible();
  await expect(page.getByLabel("PIN baru", { exact: true })).toBeVisible();
  await expect(
    page.getByLabel("Ulangi PIN baru", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("PIN baru", { exact: true }).fill(NEW_PIN);
  await page.getByLabel("Ulangi PIN baru", { exact: true }).fill(NEW_PIN);
  await page.getByRole("button", { name: "Simpan PIN" }).click();

  await expect(page.getByText("PIN berhasil disimpan")).toBeVisible({
    timeout: COLD,
  });
  await expect(
    page
      .getByRole("button", { name: "Lanjut ke slip gaji" })
      .or(page.getByRole("link", { name: "Lanjut ke slip gaji" })),
  ).toBeVisible();
});

test("F30 ur82k: the new PIN form rejects an incomplete, a weak and a non-matching PIN", async ({
  page,
}) => {
  await openForgot(page, "verify");
  await startWhatsApp(page);
  await page
    .getByRole("dialog", { name: "Nomor berhasil diverifikasi" })
    .getByRole("button", { name: "Buat PIN baru" })
    .click({ timeout: POLL });
  const newPin = page.getByLabel("PIN baru", { exact: true });
  const repeat = page.getByLabel("Ulangi PIN baru", { exact: true });
  const save = page.getByRole("button", { name: "Simpan PIN" });

  await save.click();
  await expect(page.getByText("PIN harus 6 angka.").first()).toBeVisible();

  await newPin.fill("111111");
  await repeat.fill("111111");
  await save.click();
  await expect(page.getByText(/PIN terlalu mudah ditebak/)).toBeVisible();

  await newPin.fill(NEW_PIN);
  await repeat.fill("246801");
  await save.click();
  await expect(
    page.getByText("Ulangan PIN tidak sama dengan PIN baru."),
  ).toBeVisible();
  await expect(page.getByText("PIN berhasil disimpan")).toHaveCount(0);
});

test("F30 ur82k: waiting shows a desktop QR at 1280 px and hides it at 390 px", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await openForgot(page, "pending");
  await startWhatsApp(page);
  await expectWaiting(page);
  await expect(page.getByRole("img", { name: /QR/i })).toBeVisible();

  const mobile = await page.context().newPage();
  await mobile.setViewportSize(MOBILE);
  await openForgot(mobile, "pending");
  await startWhatsApp(mobile);
  await expectWaiting(mobile);
  await expect(mobile.getByRole("img", { name: /QR/i })).toBeHidden();
  expect(await overflowX(mobile)).toBeLessThanOrEqual(0);
});

test("F30 ur82k: copying the code or the number gives feedback and the status stays waiting", async ({
  page,
}) => {
  await page
    .context()
    .grantPermissions(["clipboard-read", "clipboard-write"], { origin: base! });
  await openForgot(page, "pending");
  await startWhatsApp(page);
  await expectWaiting(page);

  await action(page, "Salin pesan").click();
  await expect(
    page.getByText("Pesan disalin. Tempel dan kirim lewat WhatsApp."),
  ).toBeVisible();
  await expect(page.getByText(/Menunggu pesan Anda/)).toBeVisible();

  await action(page, "Salin nomor tujuan").click();
  await expect(page.getByText("Nomor tujuan disalin")).toBeVisible();
  await expect(page.getByText(/Menunggu pesan Anda/)).toBeVisible();
  // Copying is not verification.
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("F30 HR-01 ur82k: without the WhatsApp message there is no verification and no dialog", async ({
  page,
}) => {
  await openForgot(page, "pending");
  await startWhatsApp(page);
  await expectWaiting(page);
  // Several poll rounds pass (2 s each); the answer stays "pending".
  await page.waitForTimeout(7000);
  await expect(page.getByText(/Menunggu pesan Anda/)).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Buat PIN slip gaji" }),
  ).toHaveCount(0);
  await expect(page.getByText("Nomor berhasil diverifikasi")).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Expired code
// ---------------------------------------------------------------------------

test("F30 ur82k: an expired code stops being usable and a new code can be made", async ({
  page,
}) => {
  await openForgot(page, "expire");
  await startWhatsApp(page);
  await expectWaiting(page);

  await expect(
    page.getByRole("heading", { name: "Kode sudah kedaluwarsa" }),
  ).toBeVisible({ timeout: COLD });
  await expect(
    page.getByText(
      "Pesan dengan kode ini tidak bisa dipakai lagi. Buat kode baru, lalu kirim lewat WhatsApp.",
    ),
  ).toBeVisible();
  await expect(page.getByText(/Kode tidak berlaku/)).toBeVisible();
  await expectNoActiveWhatsApp(page);
  await expect(action(page, "Minta bantuan HR atau supervisor")).toBeVisible();

  await action(page, "Buat kode baru").click();
  await expectWaiting(page);
  await expect(page.getByText(CODE_SHAPE).first()).toBeVisible();
});

// ---------------------------------------------------------------------------
// Blocked states
// ---------------------------------------------------------------------------

test("F30 HR-01 ur82k: no verified WhatsApp number points to HR or the outlet superior", async ({
  page,
}) => {
  await page.setViewportSize(MOBILE);
  await openForgot(page, "no-wa");
  await startWhatsApp(page);
  await expect(
    page.getByRole("heading", { name: "Nomor WhatsApp belum terdaftar" }),
  ).toBeVisible({ timeout: COLD });
  await expect(
    page.getByText(
      /Pemulihan lewat WhatsApp belum bisa dipakai\. Minta HR atau supervisor di outlet memperbarui nomor atau mereset PIN Anda\./,
    ),
  ).toBeVisible();
  // Founder decision: the HR/atasan wording.
  await expect(
    page.getByText(/Hubungi HR atau atasan di outlet/).first(),
  ).toBeVisible();
  await expect(page.getByText("PIN tetap pribadi")).toBeVisible();
  await expect(action(page, "Lihat cara minta bantuan")).toBeVisible();
  await expect(action(page, "Kembali ke slip gaji")).toBeVisible();
  await expectNoActiveWhatsApp(page);
  // No field to change the number oneself.
  await expect(page.getByRole("textbox")).toHaveCount(0);
  expect(await overflowX(page)).toBeLessThanOrEqual(0);
});

test("F30 HR-01 ur82k: a verified number that needs an update asks HR to update it, without showing a number", async ({
  page,
}) => {
  await openForgot(page, "needs-update");
  await startWhatsApp(page);
  await expect(
    page.getByRole("heading", { name: "Nomor WhatsApp perlu diperbarui" }),
  ).toBeVisible({ timeout: COLD });
  await expect(
    page.getByText(
      /Minta HR atau supervisor di outlet untuk memperbarui nomor/,
    ),
  ).toBeVisible();
  // HR help is the main way on: a button, not a side link.
  await expect(
    page.getByRole("button", { name: "Lihat cara minta bantuan" }),
  ).toBeVisible();
  await expect(action(page, "Kembali ke slip gaji")).toBeVisible();
  await expectNoActiveWhatsApp(page);
  // Not mistaken for the other blocked screens.
  await expect(
    page.getByRole("heading", { name: "Nomor WhatsApp belum terdaftar" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Nomor WhatsApp belum 3 hari" }),
  ).toHaveCount(0);
  // No phone number on screen and no field to change it.
  await expect(page.getByText(/\+?\d{8,}/)).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveCount(0);
});

test("F30 HR-01 ur82k: a number linked less than 3 days asks for HR and offers no WhatsApp", async ({
  page,
}) => {
  await openForgot(page, "too-new");
  await startWhatsApp(page);
  await expect(page.getByText(/3 hari/).first()).toBeVisible({
    timeout: COLD,
  });
  await expect(
    page.getByText(/HR atau (supervisor|atasan)/).first(),
  ).toBeVisible();
  await expect(action(page, "Kembali ke slip gaji")).toBeVisible();
  await expectNoActiveWhatsApp(page);
  // Not mistaken for the "no number" screen.
  await expect(
    page.getByRole("heading", { name: "Nomor WhatsApp belum terdaftar" }),
  ).toHaveCount(0);
});

test("F30 HR-01 ur82k: a 409 without a reason shows one combined screen that names both causes", async ({
  page,
}) => {
  await openForgot(page, "unavailable-plain");
  await startWhatsApp(page);
  await expect(
    page.getByText(/Hubungi HR atau supervisor di outlet/).first(),
  ).toBeVisible({ timeout: COLD });
  await expect(page.getByText(/3 hari/).first()).toBeVisible();
  await expect(action(page, "Kembali ke slip gaji")).toBeVisible();
  await expectNoActiveWhatsApp(page);
});

test("F30 ur82k: too many attempts shows a wait notice, HR help and no WhatsApp button", async ({
  page,
}) => {
  await page.setViewportSize(MOBILE);
  await openForgot(page, "rate-limited");
  await startWhatsApp(page);
  await expect(
    page.getByRole("heading", { name: "Terlalu banyak percobaan" }),
  ).toBeVisible({ timeout: COLD });
  await expect(
    page.getByText(
      "Pemulihan lewat WhatsApp dibatasi sementara. Tunggu sebelum mencoba lagi.",
    ),
  ).toBeVisible();
  await expect(page.getByText(/Coba lagi nanti/).first()).toBeVisible();
  await expect(
    page.getByText(/minta reset PIN ke HR atau supervisor di outlet/),
  ).toBeVisible();
  await expect(action(page, "Lihat cara minta bantuan")).toBeVisible();
  await expect(action(page, "Kembali ke slip gaji")).toBeVisible();
  // No number to wait for: the user may try again at once.
  await expect(
    page.getByRole("button", { name: "Coba lagi", exact: true }),
  ).toBeVisible();
  await expectNoActiveWhatsApp(page);
  expect(await overflowX(page)).toBeLessThanOrEqual(0);
});

test("F30 ur82k: a 429 with a wait counts down on the screen", async ({
  page,
}) => {
  await openForgot(page, "rate-limited-wait");
  await startWhatsApp(page);
  await expect(
    page.getByRole("heading", { name: "Terlalu banyak percobaan" }),
  ).toBeVisible({ timeout: COLD });
  const timer = page.getByRole("timer");
  await expect(timer).toHaveText(/Coba lagi dalam 12:\d\d/);
  const first = await timer.innerText();
  await expect.poll(() => timer.innerText(), { timeout: 5000 }).not.toBe(first);
  await expect(action(page, "Lihat cara minta bantuan")).toBeVisible();
  // While the wait runs there is no retry button.
  await expect(
    page.getByRole("button", { name: "Coba lagi", exact: true }),
  ).toHaveCount(0);
  await expectNoActiveWhatsApp(page);
});

test("F30 ur82k: after the 429 countdown ends the retry button appears", async ({
  page,
}) => {
  // Fake clock that still runs in real time; jumped forward below.
  await page.clock.install({ time: new Date() });
  await openForgot(page, "rate-limited-wait");
  await startWhatsApp(page);
  await expect(page.getByRole("timer")).toHaveText(/Coba lagi dalam 12:\d\d/, {
    timeout: COLD,
  });
  await expect(
    page.getByRole("button", { name: "Coba lagi", exact: true }),
  ).toHaveCount(0);

  await page.clock.fastForward("14:00");

  await expect(page.getByRole("timer")).toHaveText("Pembatasan sudah selesai");
  await expect(
    page.getByRole("button", { name: "Coba lagi", exact: true }),
  ).toBeVisible();
  await expect(action(page, "Lihat cara minta bantuan")).toBeVisible();
  await expectNoActiveWhatsApp(page);
});

test("F30 ur82k: a service that is not set up (503) is a calm state, not a generic failure", async ({
  page,
}) => {
  await openForgot(page, "unavailable");
  await startWhatsApp(page);
  await expect(page.getByText(/belum tersedia/i).first()).toBeVisible({
    timeout: COLD,
  });
  await expect(
    page.getByText(/Hubungi HR atau supervisor di outlet/).first(),
  ).toBeVisible();
  await expectNoActiveWhatsApp(page);
  await expect(page.getByText("Terjadi kesalahan")).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// HR help
// ---------------------------------------------------------------------------

test("F30 ur82k: the HR help screen gives two manual steps and a way back", async ({
  page,
}) => {
  await page.setViewportSize(MOBILE);
  await openForgot(page, "verify");
  await action(page, "Lihat cara minta bantuan").click();

  await expect(
    page.getByRole("heading", { name: "Minta bantuan HR atau supervisor" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Hubungi HR atau supervisor di outlet dan minta reset PIN slip gaji.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Minta reset PIN", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Sampaikan bahwa Anda lupa PIN slip gaji."),
  ).toBeVisible();
  await expect(
    page.getByText("Buka slip gaji lagi", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Setelah HR meresetnya, buat PIN baru sendiri."),
  ).toBeVisible();
  await expect(
    page.getByText("HR tidak bisa melihat atau menentukan PIN Anda."),
  ).toBeVisible();
  // A guide, not a request that was sent.
  await expect(page.getByText(/permintaan (sudah )?terkirim/i)).toHaveCount(0);

  await action(page, "Kembali ke slip gaji").click();
  await expect(page).toHaveURL(/\/karyawan\/slip-gaji(\?.*)?$/);
});

test("F30 ur82k: HR help is reachable from the waiting screen too", async ({
  page,
}) => {
  await openForgot(page, "pending");
  await startWhatsApp(page);
  await expectWaiting(page);
  await action(page, "Minta bantuan HR atau supervisor").click();
  await expect(
    page.getByRole("heading", { name: "Minta bantuan HR atau supervisor" }),
  ).toBeVisible();
});

// ---------------------------------------------------------------------------
// Errors and loading
// ---------------------------------------------------------------------------

test("F30 HR-01 ur82k: a rejected new PIN (403) shows an error and never reports success", async ({
  page,
}) => {
  await openForgot(page, "proof-invalid");
  await startWhatsApp(page);
  await page
    .getByRole("dialog", { name: "Nomor berhasil diverifikasi" })
    .getByRole("button", { name: "Buat PIN baru" })
    .click({ timeout: POLL });
  await page.getByLabel("PIN baru", { exact: true }).fill(NEW_PIN);
  await page.getByLabel("Ulangi PIN baru", { exact: true }).fill(NEW_PIN);
  await page.getByRole("button", { name: "Simpan PIN" }).click();

  await expect(
    page.getByRole("alert").filter({ hasText: /\S/ }).first(),
  ).toBeVisible({ timeout: COLD });
  await expect(page.getByText("PIN berhasil disimpan")).toHaveCount(0);
});

test("F30 ur82k: starting WhatsApp shows a loading state while the request is slow", async ({
  page,
}) => {
  await openForgot(page, "verify", "mock=slow");
  const start = chooseWhatsApp(page);
  await start.click();
  // The request takes 3 s: the action cannot be fired twice meanwhile.
  await expect(start).toBeDisabled();
  await expectWaiting(page);
});

test("F30 ur82k: a failing start request shows an error and keeps the choices", async ({
  page,
}) => {
  await openForgot(page, "verify", "mock=error");
  await startWhatsApp(page);
  await expect(
    page.getByRole("alert").filter({ hasText: /\S/ }).first(),
  ).toBeVisible({ timeout: COLD });
  await expect(chooseWhatsApp(page)).toBeEnabled();
  await expectNoActiveWhatsApp(page);
});

test("F30 ur82k: the scenario falls back to localStorage when the URL has none", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("legend.mock.waScenario", "no-wa");
  });
  await openForgot(page);
  await startWhatsApp(page);
  await expect(
    page.getByRole("heading", { name: "Nomor WhatsApp belum terdaftar" }),
  ).toBeVisible({ timeout: COLD });
});
