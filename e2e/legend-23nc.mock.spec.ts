// WS-10 employee PWA money screens (bead legend-23nc; PRD v1.7 §3 F30 "Slip
// Gaji", F31 "Kasbon & Reimbursement", HR-01). Mock-mode spec:
// `pnpm test:e2e:mock e2e/legend-23nc.mock.spec.ts` starts the web dev server
// with VITE_API_MOCK=true, so the payroll fixtures answer without an API.
//
// The signed-in mock employee is CL-1003 (lib/mock/handlers/hris-directory.ts);
// its payslip PIN is the fixed demo PIN 123456. Amounts must stay hidden until
// that PIN is accepted: the history endpoint returns myPayslipSummarySchema,
// which carries no amounts at all.
//
// New routes are not in e2e/mock-global-setup.ts WARM_ROUTES (a shared file
// this bead must not edit), so the first assertion on each route allows for a
// cold Vite compile (frontend.md "Browser specs in mock mode").
import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";
import { waitForHydration } from "./hydration.ts";

const base = process.env.LEGEND_MOCK_WEB_URL;
test.skip(
  !base,
  "Set LEGEND_MOCK_WEB_URL (pnpm test:e2e:mock) to a web server running VITE_API_MOCK.",
);

const COLD_START_TIMEOUT_MS = 30_000;
const ROLE_COOKIE = "legend-mock-role";
const DEMO_PIN = "123456";
// A 1×1 PNG: a real image, so the claim's receipt thumbnail can render.
const BUKTI_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

type Theme = "light" | "dark";

async function openEmployee(page: Page, path: string, theme: Theme = "light") {
  await page
    .context()
    .addCookies([{ name: ROLE_COOKIE, value: "employee", url: base! }]);
  await page.addInitScript(
    (value) => localStorage.setItem("legend-theme", value),
    theme,
  );
  await page.goto(`${base}${path}`, { waitUntil: "networkidle" });
  await waitForHydration(page);
}

async function openPayslipGate(page: Page) {
  await page
    .getByRole("link", { name: /^Lihat slip/ })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Masukkan PIN", exact: true }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
}

async function submitPin(page: Page, pin: string) {
  await page.getByLabel("PIN slip gaji", { exact: true }).fill(pin);
  await page
    .getByRole("button", { name: /^(Buka slip gaji|Coba lagi)$/ })
    .click();
}

async function openPayslipDetail(page: Page) {
  await openPayslipGate(page);
  await submitPin(page, DEMO_PIN);
  await expect(
    page.getByText("Gaji bersih", { exact: false }).first(),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
}

test("HR-01 the payslip history lists periods without paid status or amounts before the PIN", async ({
  page,
}) => {
  await openEmployee(page, "/karyawan/slip-gaji");
  await expect(
    page.getByRole("heading", { name: "Slip gaji", level: 1 }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await expect(page.getByText(/26 Sep 2026/)).toBeVisible();
  await expect(page.getByText("Dibayar", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Dilindungi PIN")).toBeVisible();
  // myPayslipSummarySchema has no amounts: nothing may render as rupiah here.
  await expect(page.getByText(/Rp/)).toHaveCount(0);
});

test("HR-01 a wrong PIN shows an error and keeps the amounts hidden", async ({
  page,
}) => {
  await openEmployee(page, "/karyawan/slip-gaji");
  await openPayslipGate(page);
  await submitPin(page, "000000");
  await expect(page.getByText(/PIN belum benar/)).toBeVisible();
  await expect(page.getByText(/4 percobaan tersisa/)).toBeVisible();
  await expect(page.getByText("Gaji bersih")).toHaveCount(0);
  await expect(page.getByText(/Rp/)).toHaveCount(0);
});

test("HR-01 five wrong PINs lock the gate and the amounts stay hidden", async ({
  page,
}) => {
  await openEmployee(page, "/karyawan/slip-gaji");
  await openPayslipGate(page);
  const pin = page.getByLabel("PIN slip gaji", { exact: true });
  // The payroll contract locks after five failed attempts, for 15 minutes.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await submitPin(page, "000000");
    if (attempt < 4) {
      await expect(pin).toHaveValue("");
      await expect(
        page.getByText(new RegExp(`${4 - attempt} percobaan tersisa`)),
      ).toBeVisible();
      await expect(page.getByText(/Rp/)).toHaveCount(0);
    }
  }
  await expect(page.getByText("PIN terkunci sementara")).toBeVisible();
  await expect(page.getByText(/15 menit/).first()).toBeVisible();
  // The locked screen removes the form entirely: no additional attempt.
  await expect(pin).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /^(Buka slip gaji|Coba lagi)$/ }),
  ).toHaveCount(0);
  await expect(page.getByText("Gaji bersih")).toHaveCount(0);
  await expect(page.getByText(/Rp/)).toHaveCount(0);
});

test("HR-01 another employee's payslip id in the URL is not found, even with the right PIN", async ({
  page,
}) => {
  // Fixture payslip 5701 belongs to CL-1001; the signed-in employee is CL-1003.
  await openEmployee(
    page,
    "/karyawan/slip-gaji/00000000-0000-4000-8000-000000005701",
  );
  await submitPin(page, DEMO_PIN);
  await expect(page.getByText("Slip gaji tidak ditemukan")).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
  await expect(page.getByText("Gaji bersih")).toHaveCount(0);
  await expect(page.getByText(/Rp/)).toHaveCount(0);
});

test("HR-01 a malformed payslip id shows not found without asking for the PIN", async ({
  page,
}) => {
  await openEmployee(page, "/karyawan/slip-gaji/bukan-id");
  await expect(page.getByText("Slip gaji tidak ditemukan")).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
  await expect(page.getByLabel("PIN slip gaji", { exact: true })).toHaveCount(
    0,
  );
});

test("HR-01 the correct PIN reveals the payslip with gross, deductions and net", async ({
  page,
}) => {
  await openEmployee(page, "/karyawan/slip-gaji");
  await openPayslipDetail(page);
  await expect(page.getByText("Pendapatan bruto")).toBeVisible();
  await expect(page.getByText("Total potongan")).toBeVisible();
  await expect(page.getByText("Pendapatan", { exact: true })).toBeVisible();
  await expect(page.getByText("Potongan", { exact: true })).toBeVisible();
  await expect(page.getByText(/Rp/).first()).toBeVisible();
  // The fixture payslip has a rendered PDF; a slip without one offers print.
  await expect(page.getByRole("link", { name: "Unduh PDF" })).toBeVisible();
});

test("HR-01 a kasbon request creates a pending loan with its approval timeline", async ({
  page,
}) => {
  await openEmployee(page, "/karyawan/kasbon");
  await expect(
    page.getByRole("heading", { name: "Kasbon", level: 1 }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await expect(page.getByText("Belum ada kasbon")).toBeVisible();

  // "1.5" is not a thousands group: refused, never read as Rp15.
  await page.getByLabel("Jumlah (Rp)").fill("1.5");
  await page.getByLabel("Alasan").fill("Biaya sekolah anak");
  await page.getByRole("button", { name: "Kirim pengajuan" }).click();
  await expect(
    page.getByText("Jumlah harus angka rupiah bulat."),
  ).toBeVisible();

  await page.getByLabel("Jumlah (Rp)").fill("1.000.000");
  await page.getByRole("combobox").click();
  await page.getByRole("option", { name: "3 bulan" }).click();
  await page.getByRole("button", { name: "Kirim pengajuan" }).click();

  await expect(page.getByText("Pengajuan kasbon terkirim")).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
  await expect(page.getByText("Perjalanan pengajuan")).toBeVisible();
  await expect(page.getByText("Menunggu persetujuan").first()).toBeVisible();
  await expect(page.getByText(/1\.000\.000/).first()).toBeVisible();

  // policy.singleOpenLoan: once the request is pending, a second form is blocked.
  await page.getByRole("button", { name: "Lihat daftar kasbon" }).click();
  await expect(page.getByText("Masih ada kasbon berjalan")).toBeVisible();
});

test("HR-01 a reimbursement with a photo creates a pending claim", async ({
  page,
}) => {
  await openEmployee(page, "/karyawan/reimbursement");
  await expect(
    page.getByRole("heading", { name: "Reimburse", level: 1 }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await expect(page.getByText("Belum ada klaim")).toBeVisible();

  await page.getByRole("combobox").click();
  await page.getByRole("option", { name: "Transport dinas" }).click();
  await page.getByLabel("Tanggal pengeluaran").fill("2026-11-01");
  await page.getByLabel("Jumlah (Rp)").fill("180000");
  await page
    .getByLabel("Keterangan")
    .fill("Transport antar bahan ke outlet kedua");
  await page.locator('input[type="file"]').setInputFiles({
    name: "bukti.png",
    mimeType: "image/png",
    buffer: BUKTI_PNG,
  });
  await expect(
    page.getByRole("img", { name: "Foto bukti pengeluaran" }).first(),
  ).toBeVisible();

  await page.getByRole("button", { name: "Kirim klaim" }).click();
  await expect(page.getByText("Klaim terkirim")).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
  await expect(
    page.getByText("Menunggu", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText(/180\.000/).first()).toBeVisible();
  // The new claim keeps the photo: mock mode returns the object URL back.
  await expect(
    page.getByRole("img", { name: "Foto bukti pengeluaran" }).first(),
  ).toBeVisible();
});

test("HR-01 empty states keep the payslip history and kasbon pages honest", async ({
  page,
}) => {
  await openEmployee(page, "/karyawan/slip-gaji?mock=empty");
  await expect(page.getByText("Belum ada slip gaji")).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
  await openEmployee(page, "/karyawan/kasbon?mock=empty");
  await expect(page.getByText("Belum ada kasbon")).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
});

// ---- Screenshot evidence (frontend.md §8) ----------------------------

for (const theme of ["light", "dark"] as const) {
  test(`HR-01 visual payslip gate 390 ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await openEmployee(page, "/karyawan/slip-gaji", theme);
    await openPayslipGate(page);
    await captureScreenshot(page, `legend-23nc/payslip-gate-390-${theme}.png`);
  });
}

for (const width of [390, 1440] as const) {
  test(`HR-01 visual payslip detail ${width} light`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openEmployee(page, "/karyawan/slip-gaji", "light");
    await openPayslipDetail(page);
    await captureScreenshot(
      page,
      `legend-23nc/payslip-detail-${width}-light.png`,
    );
  });
}

test("HR-01 visual kasbon 390 light", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await openEmployee(page, "/karyawan/kasbon", "light");
  await expect(
    page.getByRole("heading", { name: "Kasbon", level: 1 }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await captureScreenshot(page, "legend-23nc/kasbon-390-light.png");
});

test("HR-01 visual payslip empty 390 light", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await openEmployee(page, "/karyawan/slip-gaji?mock=empty", "light");
  await expect(page.getByText("Belum ada slip gaji")).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
  await captureScreenshot(page, "legend-23nc/payslip-empty-390-light.png");
});
