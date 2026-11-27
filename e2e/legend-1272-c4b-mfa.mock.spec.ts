import { expect, test, type Page } from "@playwright/test";
import { waitForHydration } from "./hydration";

// C4b UI audit P1-2 (legend-osqou.8): the MFA step-up of the Duitku and EDC
// settlement imports sits beside the upload form, not inside it. Pressing
// Enter or "Verifikasi dan lanjutkan" with a wrong code must not send the
// upload; a right code sends it once. Against the FE mock runtime. Run:
//   pnpm test:e2e:mock e2e/legend-1272-c4b-mfa.mock.spec.ts
const mockWebUrl = process.env.LEGEND_MOCK_WEB_URL;
test.skip(!mockWebUrl, "Requires the mock-mode web server");
test.use({ baseURL: mockWebUrl ?? "http://localhost:3320" });
test.setTimeout(120_000);

const WAIT = { timeout: 60_000 };
// The auth mock refuses this code and accepts any other six digits.
const WRONG_CODE = "000000";
const RIGHT_CODE = "123456";
const CODE_REJECTED =
  "Kode tidak cocok atau sudah kedaluwarsa. Coba kode terbaru.";

const gateway = {
  path: "/kelola/pembayaran/settlement-duitku",
  endpoint: "POST /api/payments/admin/reconciliation/settlements/csv",
  submit: "Impor dan cocokkan",
  verifyTitle: "Verifikasi MFA untuk mengimpor",
  csv: "reference,amount_idr,fee_idr\nDK-1-0001,55000,385\nDK-1-0002,30000,210\n",
};
const edc = {
  path: "/kelola/pembayaran/edc-settlement",
  endpoint: "POST /api/payments/admin/edc/settlement-csv",
  submit: "Unggah dan cocokkan",
  verifyTitle: "Verifikasi MFA untuk mengunggah",
  csv: "tid,rrn,amount\nT001,612345678901,55000\nT001,612345678902,30000\n",
};
type Screen = typeof gateway;

async function openAtStepUp(page: Page, screen: Screen, reference: string) {
  await page
    .context()
    .addCookies([
      { name: "legend-mock-role", value: "all", url: mockWebUrl ?? "" },
    ]);
  await page.goto(`${screen.path}?mock=normal`);
  await page.getByRole("button", { name: screen.submit }).waitFor(WAIT);
  await waitForHydration(page);
  if (screen === gateway) {
    await page.getByLabel("Nomor laporan settlement").fill(reference);
    await page.getByLabel("Periode mulai").fill("2026-11-11");
    await page.getByLabel("Periode selesai").fill("2026-11-11");
  }
  await page.locator('input[type="file"]').setInputFiles({
    name: "settlement.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(screen.csv),
  });
  await expect(page.getByText("2 baris data")).toBeVisible(WAIT);
  await page.evaluate(
    (match) =>
      (
        window as unknown as {
          __legendMock: {
            failNext: (m: string, f: { status: number; code: string }) => void;
          };
        }
      ).__legendMock.failNext(match, { status: 403, code: "MFA_REQUIRED" }),
    screen.endpoint,
  );
  await page.getByRole("button", { name: screen.submit }).click();
  await expect(page.getByText(screen.verifyTitle)).toBeVisible(WAIT);
}

for (const screen of [gateway, edc]) {
  test.describe(screen.path, () => {
    test("a wrong code sent with Enter does not upload", async ({ page }) => {
      await openAtStepUp(page, screen, "STL-C4B-ENTER-WRONG");
      const code = page.getByLabel("Kode 6 digit");
      await code.fill(WRONG_CODE);
      await code.press("Enter");
      await expect(page.getByText(CODE_REJECTED)).toBeVisible(WAIT);
      await expect(page.getByText("Hasil pencocokan")).toHaveCount(0);
      // The panel kept its place and the typed code: no remount.
      await expect(page.getByText(screen.verifyTitle)).toBeVisible();
      await expect(code).toHaveValue(WRONG_CODE);
    });

    test("a wrong code sent with the button does not upload", async ({
      page,
    }) => {
      await openAtStepUp(page, screen, "STL-C4B-CLICK-WRONG");
      await page.getByLabel("Kode 6 digit").fill(WRONG_CODE);
      await page
        .getByRole("button", { name: "Verifikasi dan lanjutkan" })
        .click();
      await expect(page.getByText(CODE_REJECTED)).toBeVisible(WAIT);
      await expect(page.getByText("Hasil pencocokan")).toHaveCount(0);
    });

    test("a right code sent with Enter uploads once", async ({ page }) => {
      await openAtStepUp(page, screen, "STL-C4B-ENTER-RIGHT");
      if (screen === gateway)
        // The upload fields are frozen while the step-up is open.
        await expect(
          page.getByLabel("Nomor laporan settlement"),
        ).toBeDisabled();
      const code = page.getByLabel("Kode 6 digit");
      await code.fill(RIGHT_CODE);
      await code.press("Enter");
      await expect(page.getByText("Hasil pencocokan")).toBeVisible(WAIT);
      // One upload only: a second send of the same report reads "Sudah ada".
      await expect(page.getByText(/^Sudah ada:/)).toHaveCount(0);
    });
  });
}
