// Payslip PIN screens (bead legend-ilzrj; PRD v1.7 §3 F30 "Slip Gaji", HR-01).
// Mock-mode spec, run once at the end:
//   heavy pnpm test:e2e:mock e2e/payslip-pin.mock.spec.ts
//
// Expected behavior comes from the brief docs/briefs/sub-payslip-pin-ui.md
// ("Founder decisions", "Mock facts") and the Indonesian copy in
// packages/shared/src/i18n/messages/ws10-payslip-pin*.ts, never from component
// code. docs/SPEC.md and docs/features.json do not exist in this repo, so test
// titles carry the PRD id (F30 / HR-01) plus the bead id.
//
// Assumptions:
//  - The mock store lives in browser memory, so every flow that depends on
//    earlier attempts (wrong PIN, lock) stays on one page load and moves
//    between screens through links, not page.goto. `?mock=pin-*` is read from
//    the URL at request time, so those flows open the URL directly.
//  - The signed-in mock employee is CL-1003 with demo PIN 123456; five wrong
//    tries lock the PIN for 15 minutes.
//  - The remaining-attempts and lock messages use the copy catalog
//    ("4 percobaan tersisa.", "PIN terkunci sementara", "sekitar 15 menit").
//  - ?mock=pin-not-set / pin-locked are applied once from the URL of the
//    history page, then the slip is opened through its link.
//  - After saving a first PIN the continue action is a button named
//    "Lanjut ke slip gaji" and the saved title is "PIN berhasil disimpan".
//  - Each history row link is named "Lihat slip {period}" (aria-label, fix
//    round 1), matched by prefix.
//  - The "hr" role template (cookie legend-mock-role=hr) holds payroll.run;
//    outlet_manager holds hr.employee.view but not payroll.run.
//  - Submit buttons are always enabled and validate on submit (fix round 1).
//    They change label after a wrong PIN ("Buka slip gaji" -> "Coba lagi"), so
//    the helper matches either. A wrong PIN clears the field.
//  - Wrong PIN text is one message: "PIN belum benar. Periksa PIN dan coba
//    lagi. N percobaan tersisa."
import { expect, test, type Page } from "@playwright/test";
import { waitForHydration } from "./hydration.ts";

const base = process.env.LEGEND_MOCK_WEB_URL;
test.skip(
  !base,
  "Mock runner not started: use pnpm test:e2e:mock (playwright.mock.config.ts).",
);
test.use({ baseURL: base });

/** Vite compiles a route on its first request: the first assertion waits. */
const COLD = 30_000;
const ROLE_COOKIE = "legend-mock-role";
const DEMO_PIN = "123456";
// Not all-same, not a straight sequence: passes the weak-PIN rule.
const NEW_PIN = "135792";
/** CL-1001 Rizky Pratama, the fixture employee used by the HR specs. */
const EMPLOYEE_ID = "00000000-0000-4000-8000-000000001001";

async function setRole(page: Page, role: string) {
  await page
    .context()
    .addCookies([{ name: ROLE_COOKIE, value: role, url: base! }]);
}

async function openEmployee(page: Page, path: string) {
  await setRole(page, "employee");
  await page.goto(path);
  await waitForHydration(page);
}

/** List -> the first payslip's PIN gate, through the link (state survives). */
async function openGate(page: Page) {
  await openEmployee(page, "/karyawan/slip-gaji");
  await page
    .getByRole("link", { name: /^Lihat slip/ })
    .first()
    .click({ timeout: COLD });
  await expect(page.getByRole("heading", { name: "Masukkan PIN" })).toBeVisible(
    { timeout: COLD },
  );
}

/**
 * List -> the first payslip's page with a mock scenario. The scenario is read
 * from the current URL, so the query rides on the slip page itself.
 */
async function openSlipFromList(page: Page, query: string) {
  await openEmployee(page, `/karyawan/slip-gaji${query}`);
  const href = await page
    .getByRole("link", { name: /^Lihat slip/ })
    .first()
    .getAttribute("href", { timeout: COLD });
  expect(href).toBeTruthy();
  await page.goto(`${href!.split("?")[0]}${query}`);
  await waitForHydration(page);
}

async function submitPin(page: Page, pin: string) {
  await page.getByLabel("PIN slip gaji", { exact: true }).fill(pin);
  await page
    .getByRole("button", { name: /^(Buka slip gaji|Coba lagi)$/ })
    .click();
}

// ---------------------------------------------------------------------------
// Payslip gate: wrong PIN, right PIN, lock
// ---------------------------------------------------------------------------

test("F30 HR-01 ilzrj: amounts are hidden until the PIN is entered", async ({
  page,
}) => {
  await openGate(page);
  await expect(page.getByLabel("PIN slip gaji", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Buka slip gaji" }),
  ).toBeVisible();
  await expect(page.getByText(/Rp/)).toHaveCount(0);
  await expect(page.getByText("Gaji bersih")).toHaveCount(0);
});

test("F30 ilzrj: the gate shows the payslip period above the PIN field", async ({
  page,
}) => {
  await openGate(page);
  const period = page.getByText("Periode gaji", { exact: true });
  await expect(period).toBeVisible();
  const periodBox = await period.boundingBox();
  const fieldBox = await page
    .getByLabel("PIN slip gaji", { exact: true })
    .boundingBox();
  expect(periodBox!.y).toBeLessThan(fieldBox!.y);
});

test("F30 HR-01 ilzrj: submitting an incomplete PIN shows an error and keeps amounts hidden", async ({
  page,
}) => {
  await openGate(page);
  // The button is never disabled; the check happens on submit.
  const submit = page.getByRole("button", { name: "Buka slip gaji" });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByText("PIN harus 6 angka.")).toBeVisible();

  await submitPin(page, "123");
  await expect(page.getByText("PIN harus 6 angka.")).toBeVisible();
  await expect(page.getByText(/Rp/)).toHaveCount(0);
});

test("F30 HR-01 ilzrj: a wrong PIN shows the remaining attempts and keeps amounts hidden", async ({
  page,
}) => {
  await openGate(page);
  await submitPin(page, "000000");
  await expect(page.getByText(/PIN belum benar/)).toBeVisible();
  await expect(page.getByText(/4 percobaan tersisa/)).toBeVisible();
  await expect(page.getByText(/Rp/)).toHaveCount(0);

  await submitPin(page, "000000");
  await expect(page.getByText(/3 percobaan tersisa/)).toBeVisible();
  await expect(page.getByText("Gaji bersih")).toHaveCount(0);
});

test("F30 HR-01 ilzrj: the right PIN reveals the payslip amounts", async ({
  page,
}) => {
  await openGate(page);
  await submitPin(page, "000000");
  await expect(page.getByText(/4 percobaan tersisa/)).toBeVisible();

  await submitPin(page, DEMO_PIN);
  await expect(page.getByText("Gaji bersih").first()).toBeVisible({
    timeout: COLD,
  });
  await expect(page.getByText(/Rp/).first()).toBeVisible();
  await expect(page.getByText(/PIN belum benar/)).toHaveCount(0);
});

test("F30 HR-01 ilzrj: five wrong PINs lock the gate, amounts stay hidden, Lupa PIN is offered", async ({
  page,
}) => {
  await openGate(page);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await submitPin(page, "000000");
    if (attempt < 4) {
      await expect(
        page.getByText(new RegExp(`${4 - attempt} percobaan tersisa`)),
      ).toBeVisible();
    }
  }
  await expect(page.getByText("PIN terkunci sementara")).toBeVisible();
  await expect(page.getByText(/15 menit/).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Lupa PIN?" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Kembali ke daftar slip" }),
  ).toBeVisible();
  // Locked: no way to type another PIN and no amounts.
  await expect(
    page.getByRole("button", { name: /^(Buka slip gaji|Coba lagi)$/ }),
  ).toHaveCount(0);
  await expect(page.getByText(/Rp/)).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// First-time PIN (?mock=pin-not-set) and locked on arrival (?mock=pin-locked)
// ---------------------------------------------------------------------------

test("F30 HR-01 ilzrj: opening a slip without a PIN asks the employee to create one, no amounts", async ({
  page,
}) => {
  await openSlipFromList(page, "?mock=pin-not-set");
  await expect(
    page.getByRole("heading", { name: "Buat PIN slip gaji" }),
  ).toBeVisible({ timeout: COLD });
  await expect(page.getByLabel("PIN baru", { exact: true })).toBeVisible();
  await expect(
    page.getByLabel("Ulangi PIN baru", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Simpan PIN" })).toBeVisible();
  // The employee alone knows the PIN; the copy says HR cannot see it.
  await expect(page.getByText(/HR dapat mereset PIN/)).toBeVisible();
  await expect(page.getByText(/Rp/)).toHaveCount(0);
});

test("F30 ilzrj: creating a PIN rejects a short, weak or mismatched PIN near the field", async ({
  page,
}) => {
  await openSlipFromList(page, "?mock=pin-not-set");
  await expect(
    page.getByRole("heading", { name: "Buat PIN slip gaji" }),
  ).toBeVisible({ timeout: COLD });
  const newPin = page.getByLabel("PIN baru", { exact: true });
  const repeat = page.getByLabel("Ulangi PIN baru", { exact: true });
  const save = page.getByRole("button", { name: "Simpan PIN" });

  // Always enabled; an empty form is checked on submit.
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByText("PIN harus 6 angka.")).toBeVisible();

  await newPin.fill("12345");
  await repeat.fill("12345");
  await save.click();
  await expect(page.getByText("PIN harus 6 angka.")).toBeVisible();

  await newPin.fill("111111");
  await repeat.fill("111111");
  await save.click();
  await expect(page.getByText(/PIN terlalu mudah ditebak/)).toBeVisible();

  await newPin.fill("123456");
  await repeat.fill("123456");
  await save.click();
  await expect(page.getByText(/PIN terlalu mudah ditebak/)).toBeVisible();

  await newPin.fill(NEW_PIN);
  await repeat.fill("246801");
  await save.click();
  await expect(
    page.getByText("Ulangan PIN tidak sama dengan PIN baru."),
  ).toBeVisible();
  await expect(page.getByText("PIN berhasil disimpan")).toHaveCount(0);
  await expect(page.getByText(/Rp/)).toHaveCount(0);
});

test("F30 HR-01 ilzrj: a created PIN is saved, then the slip opens only with that PIN", async ({
  page,
}) => {
  await openSlipFromList(page, "?mock=pin-not-set");
  await expect(
    page.getByRole("heading", { name: "Buat PIN slip gaji" }),
  ).toBeVisible({ timeout: COLD });
  await page.getByLabel("PIN baru", { exact: true }).fill(NEW_PIN);
  await page.getByLabel("Ulangi PIN baru", { exact: true }).fill(NEW_PIN);
  await page.getByRole("button", { name: "Simpan PIN" }).click();

  await expect(page.getByText("PIN berhasil disimpan")).toBeVisible({
    timeout: COLD,
  });
  await expect(page.getByText(/Rp/)).toHaveCount(0);

  await page.getByRole("button", { name: "Lanjut ke slip gaji" }).click();
  await expect(
    page.getByRole("heading", { name: "Masukkan PIN" }),
  ).toBeVisible();
  await expect(page.getByText(/Rp/)).toHaveCount(0);

  // The old demo PIN no longer works; the new one does.
  await submitPin(page, DEMO_PIN);
  await expect(page.getByText(/PIN belum benar/)).toBeVisible();
  await submitPin(page, NEW_PIN);
  await expect(page.getByText("Gaji bersih").first()).toBeVisible({
    timeout: COLD,
  });
  await expect(page.getByText(/Rp/).first()).toBeVisible();
});

test("F30 HR-01 ilzrj: a PIN that is already locked shows the lock state without a PIN field", async ({
  page,
}) => {
  await openSlipFromList(page, "?mock=pin-locked");
  await expect(page.getByText("PIN terkunci sementara")).toBeVisible({
    timeout: COLD,
  });
  await expect(page.getByText(/menit/).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Lupa PIN?" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^(Buka slip gaji|Coba lagi)$/ }),
  ).toHaveCount(0);
  await expect(page.getByText(/Rp/)).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Forgot PIN: the old OTP-by-WhatsApp-send flow was replaced by the inbound
// WhatsApp reset (the employee sends a code to the company number). Those
// screens are covered in e2e/payslip-pin-wa-reset.mock.spec.ts.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Change PIN
// ---------------------------------------------------------------------------

test("F30 ilzrj: Ubah PIN rejects a wrong current PIN with the remaining attempts", async ({
  page,
}) => {
  await openEmployee(page, "/karyawan/slip-gaji/ubah-pin");
  await expect(page.getByRole("heading", { name: "Ubah PIN" })).toBeVisible({
    timeout: COLD,
  });
  await page.getByLabel("PIN saat ini", { exact: true }).fill("000000");
  await page.getByLabel("PIN baru", { exact: true }).fill(NEW_PIN);
  await page.getByLabel("Ulangi PIN baru", { exact: true }).fill(NEW_PIN);
  await page.getByRole("button", { name: "Simpan PIN baru" }).click();
  await expect(
    page.getByText(/PIN saat ini salah\. Sisa 4 percobaan\./),
  ).toBeVisible();
  await expect(page.getByText("PIN berhasil diubah")).toHaveCount(0);
});

test("F30 ilzrj: Ubah PIN validates the new PIN before sending", async ({
  page,
}) => {
  await openEmployee(page, "/karyawan/slip-gaji/ubah-pin");
  await expect(page.getByRole("heading", { name: "Ubah PIN" })).toBeVisible({
    timeout: COLD,
  });
  const current = page.getByLabel("PIN saat ini", { exact: true });
  const newPin = page.getByLabel("PIN baru", { exact: true });
  const repeat = page.getByLabel("Ulangi PIN baru", { exact: true });
  const save = page.getByRole("button", { name: "Simpan PIN baru" });

  // Always enabled; an empty form is checked on submit.
  await expect(save).toBeEnabled();
  await save.click();
  await expect(
    page.getByText("Masukkan PIN saat ini (6 angka)."),
  ).toBeVisible();

  await current.fill(DEMO_PIN);
  await newPin.fill("12345");
  await repeat.fill("12345");
  await save.click();
  await expect(page.getByText("PIN harus 6 angka.")).toBeVisible();

  await newPin.fill("654321");
  await repeat.fill("654321");
  await save.click();
  await expect(page.getByText(/PIN terlalu mudah ditebak/)).toBeVisible();

  await newPin.fill(NEW_PIN);
  await repeat.fill("246801");
  await save.click();
  await expect(
    page.getByText("Ulangan PIN tidak sama dengan PIN baru."),
  ).toBeVisible();
  await expect(page.getByText("PIN berhasil diubah")).toHaveCount(0);
});

test("F30 ilzrj: Ubah PIN succeeds with the right current PIN", async ({
  page,
}) => {
  await openEmployee(page, "/karyawan/slip-gaji/ubah-pin");
  await expect(page.getByRole("heading", { name: "Ubah PIN" })).toBeVisible({
    timeout: COLD,
  });
  await page.getByLabel("PIN saat ini", { exact: true }).fill(DEMO_PIN);
  await page.getByLabel("PIN baru", { exact: true }).fill(NEW_PIN);
  await page.getByLabel("Ulangi PIN baru", { exact: true }).fill(NEW_PIN);
  await page.getByRole("button", { name: "Simpan PIN baru" }).click();
  await expect(page.getByText("PIN berhasil diubah")).toBeVisible({
    timeout: COLD,
  });
});

// ---------------------------------------------------------------------------
// History list: entry link, empty, error
// ---------------------------------------------------------------------------

test("F30 ilzrj: the history offers Ubah PIN slip gaji and it opens the change screen", async ({
  page,
}) => {
  await openEmployee(page, "/karyawan/slip-gaji");
  await page
    .getByRole("link", { name: /Ubah PIN slip gaji/ })
    .click({ timeout: COLD });
  await expect(page.getByRole("heading", { name: "Ubah PIN" })).toBeVisible({
    timeout: COLD,
  });
});

test("F30 HR-01 ilzrj: the history lists periods without amounts or a paid badge", async ({
  page,
}) => {
  await openEmployee(page, "/karyawan/slip-gaji");
  await expect(
    page.getByRole("link", { name: /^Lihat slip/ }).first(),
  ).toBeVisible({ timeout: COLD });
  await expect(page.getByText("Dibayar", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Rp/)).toHaveCount(0);
});

test("F30 ilzrj: an empty history says there are no payslips yet", async ({
  page,
}) => {
  await openEmployee(page, "/karyawan/slip-gaji?mock=empty");
  await expect(page.getByText("Belum ada slip gaji").first()).toBeVisible({
    timeout: COLD,
  });
  await expect(page.getByText(/Rp/)).toHaveCount(0);
});

test("F30 ilzrj: a failing history shows an error with retry and no amounts", async ({
  page,
}) => {
  await openEmployee(page, "/karyawan/slip-gaji?mock=error");
  await expect(page.getByText("Slip gaji tidak dapat dimuat")).toBeVisible({
    timeout: COLD,
  });
  await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();
  await expect(page.getByText(/Rp/)).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// HR reset dialog
// ---------------------------------------------------------------------------

async function openHrProfile(page: Page, role = "hr") {
  await setRole(page, role);
  await page.goto(`/kelola/karyawan/${EMPLOYEE_ID}?mock=normal`);
  await waitForHydration(page);
}

test("F30 HR-01 ilzrj: HR resets a PIN after confirming with a reason of 3-500 characters", async ({
  page,
}) => {
  await openHrProfile(page);
  await page
    .getByRole("button", { name: "Reset PIN slip gaji" })
    .click({ timeout: COLD });
  const dialog = page.getByRole("dialog", { name: "Reset PIN karyawan?" });
  await expect(dialog).toBeVisible();
  // HR never sees or sets a PIN: the reason is the only free-text field.
  await expect(dialog.getByRole("textbox")).toHaveCount(1);

  const confirm = dialog.getByRole("button", { name: "Ya, reset PIN" });
  const reason = dialog.getByLabel(/Alasan reset/);

  // Empty reason.
  await confirm.click();
  await expect(
    dialog.getByText("Alasan reset harus 3–500 karakter."),
  ).toBeVisible();
  await expect(dialog).toBeVisible();

  // Too short, and the counter follows the typing.
  await reason.fill("ab");
  await expect(dialog.getByText("2/500")).toBeVisible();
  await confirm.click();
  await expect(
    dialog.getByText("Alasan reset harus 3–500 karakter."),
  ).toBeVisible();

  // Valid reason.
  await reason.fill("Karyawan lupa PIN, diminta lewat atasan outlet");
  await confirm.click();
  await expect(dialog).toBeHidden({ timeout: COLD });
  // The toast text also lands in the screen-reader live region: match the toast.
  await expect(
    page.getByText(
      "PIN direset. Karyawan membuat PIN baru saat membuka slip.",
      {
        exact: true,
      },
    ),
  ).toBeVisible();
});

test("F30 ilzrj: cancelling the HR reset dialog changes nothing", async ({
  page,
}) => {
  await openHrProfile(page);
  await page
    .getByRole("button", { name: "Reset PIN slip gaji" })
    .click({ timeout: COLD });
  const dialog = page.getByRole("dialog", { name: "Reset PIN karyawan?" });
  await dialog.getByRole("button", { name: "Batal" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/PIN direset/)).toHaveCount(0);
});

test("F30 HR-01 ilzrj: a role without payroll access does not see the reset button", async ({
  page,
}) => {
  await openHrProfile(page, "outlet_manager");
  await expect(
    page.getByRole("heading", { name: "Profil karyawan" }),
  ).toBeVisible({ timeout: COLD });
  await expect(
    page.getByRole("button", { name: "Reset PIN slip gaji" }),
  ).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Narrow screen (390x844): no horizontal overflow on the employee screens
// ---------------------------------------------------------------------------

test.describe("390px viewport", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  for (const [path, heading] of [
    ["/karyawan/slip-gaji", "Slip gaji"],
    ["/karyawan/slip-gaji/ubah-pin", "Ubah PIN"],
    ["/karyawan/slip-gaji/lupa-pin", "Lupa PIN?"],
  ] as const) {
    test(`F30 ilzrj: ${path} fits a phone screen`, async ({ page }) => {
      await openEmployee(page, path);
      await expect(
        page.getByRole("heading", { name: heading }).first(),
      ).toBeVisible({ timeout: COLD });
      const fits = await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      );
      expect(fits).toBe(true);
    });
  }
});
