// legend-8cm4 / legend-2zb5: screenshot evidence for the open-bill UI (step 1,
// mock data): the POS "Jadikan open bill" flow on /pos/meja and the policy page
// on /kelola/pengaturan/open-bill. Ten screens at 390x844 and 1280x800.
//
// Runs against the FE mock runtime (VITE_API_MOCK=true):
//   pnpm test:e2e:mock e2e/legend-8cm4-open-bill.mock.spec.ts
// Screenshots go through e2e/screenshots.ts (tracked evidence only with
// LEGEND_CAPTURE_SCREENSHOTS=1).
//
// Fixtures (brief "Hasil A"): table B01 is pay-first with Rp218.300 unpaid
// (under the Rp3.000.000 limit), table A02 is pay-first with Rp3.492.700 unpaid
// (over it). The mock offers two approvers (the first is preselected), accepts
// PIN 123456 and rejects any other PIN.
import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";
import { waitForHydration } from "./hydration.ts";

const baseURL =
  process.env.LEGEND_MOCK_WEB_URL ?? process.env.E2E_MOCK_BASE_URL;

test.skip(
  !baseURL,
  "Mock runner not started: use pnpm test:e2e:mock (playwright.mock.config.ts).",
);
// Evidence shots must not catch the sheet-to-dialog crossfade.
test.use({ baseURL, reducedMotion: "reduce" });

const WIDTHS = [
  { label: "390", width: 390, height: 844 },
  { label: "1280", width: 1280, height: 800 },
] as const;

const UNDER_LIMIT_TABLE = "B01";
const OVER_LIMIT_TABLE = "A02";
const GOOD_PIN = "123456";
const BAD_PIN = "000000";
const REASON = "Tamu rombongan, bayar belakangan";
const POLICY_PATH = "/kelola/pengaturan/open-bill";
const POLICY_API = "GET /api/outlets/:outletId/open-bill-policy";
// Generous: the first hit of a route on a cold dev server compiles modules.
const READY_TIMEOUT_MS = 30_000;

type MockControl = {
  __legendMock: {
    failNext: (
      id: string,
      error: { status: number; code: string; message?: string },
    ) => void;
  };
};

async function openBoard(page: Page): Promise<void> {
  await page.goto("/pos/meja");
  await expect(
    page.getByRole("heading", { name: "Papan Status Meja" }),
  ).toBeVisible({ timeout: READY_TIMEOUT_MS });
  await waitForHydration(page);
}

async function openPanel(page: Page, code: string) {
  await page
    .getByRole("button", { name: new RegExp(`^Meja ${code},`) })
    .click();
  const panel = page.getByRole("dialog").last();
  await expect(panel).toBeVisible();
  return panel;
}

async function openConvertDialog(page: Page, code: string) {
  const panel = await openPanel(page, code);
  await panel.getByRole("button", { name: "Jadikan open bill" }).click();
  const dialog = page.getByRole("dialog").last();
  await expect(
    dialog.getByRole("heading", { name: `Jadikan open bill · Meja ${code}` }),
  ).toBeVisible();
  // The table sheet unmounts after its exit animation; wait for it.
  await expect(page.getByRole("dialog")).toHaveCount(1);
  return dialog;
}

async function enterPin(dialog: ReturnType<Page["getByRole"]>, pin: string) {
  for (const digit of pin) {
    await dialog.getByRole("button", { name: `Angka ${digit}` }).click();
  }
}

/** Reason first (the dialog refuses a PIN without one), then the six digits. */
async function approve(
  dialog: ReturnType<Page["getByRole"]>,
  pin: string,
): Promise<void> {
  await dialog.getByLabel("Alasan").fill(REASON);
  await enterPin(dialog, pin);
}

/**
 * The policy query retries once before it shows its error state, so one queued
 * failure would be absorbed by the retry. Queue two.
 */
async function failPolicyLoad(page: Page): Promise<void> {
  await page.evaluate((id) => {
    const control = (window as unknown as MockControl).__legendMock;
    control.failNext(id, { status: 500, code: "INTERNAL" });
    control.failNext(id, { status: 500, code: "INTERNAL" });
  }, POLICY_API);
}

async function openPolicyPage(page: Page, search = ""): Promise<void> {
  await page.goto(`${POLICY_PATH}${search}`);
  await waitForHydration(page);
}

for (const { label, width, height } of WIDTHS) {
  test.describe(`legend-8cm4 open bill ${label}`, () => {
    test.use({ viewport: { width, height } });

    test("pos-panel: pay-first table under the limit offers Jadikan open bill", async ({
      page,
    }) => {
      await openBoard(page);
      const panel = await openPanel(page, UNDER_LIMIT_TABLE);
      await expect(
        panel.getByRole("button", { name: "Jadikan open bill" }),
      ).toBeVisible();
      await captureScreenshot(page, `legend-8cm4/pos-panel-${label}.png`, {
        fullPage: false,
      });
    });

    test("pos-convert: dialog shows the outlet limits, reason and PIN pad", async ({
      page,
    }) => {
      await openBoard(page);
      const dialog = await openConvertDialog(page, UNDER_LIMIT_TABLE);
      await expect(dialog.getByText("Batas outlet").first()).toBeVisible({
        timeout: READY_TIMEOUT_MS,
      });
      // Mock default policy: limit Rp3.000.000, idle reminder after 45 minutes.
      await expect(dialog.getByText("Batas tagihan")).toBeVisible();
      await expect(dialog.getByText("Sisa tagihan")).toBeVisible();
      await expect(dialog.getByText("45 menit")).toBeVisible();
      // The first approver is preselected; the other one is in the list.
      const approver = dialog.getByRole("combobox", {
        name: /Supervisor penyetuju/,
      });
      await expect(approver).toContainText("Dewi Anggraini");
      await expect(dialog.getByLabel("Alasan")).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: "Angka 1" }),
      ).toBeVisible();
      await captureScreenshot(page, `legend-8cm4/pos-convert-${label}.png`, {
        fullPage: false,
      });
    });

    test("pos-convert-pin-error: a wrong PIN is refused with a way forward", async ({
      page,
    }) => {
      await openBoard(page);
      const dialog = await openConvertDialog(page, UNDER_LIMIT_TABLE);
      await expect(dialog.getByText("Batas outlet").first()).toBeVisible({
        timeout: READY_TIMEOUT_MS,
      });
      await approve(dialog, BAD_PIN);
      await expect(
        dialog.getByText("PIN salah. Coba lagi, atau pilih supervisor lain."),
      ).toBeVisible({ timeout: READY_TIMEOUT_MS });
      // The table is still pay-first: the dialog stays open for another try.
      await expect(
        dialog.getByRole("button", { name: "Angka 1" }),
      ).toBeVisible();
      await captureScreenshot(
        page,
        `legend-8cm4/pos-convert-pin-error-${label}.png`,
        { fullPage: false },
      );
    });

    test("pos-convert-over-limit: a bill at or over the limit is refused without a PIN pad", async ({
      page,
    }) => {
      await openBoard(page);
      const dialog = await openConvertDialog(page, OVER_LIMIT_TABLE);
      await expect(
        dialog.getByText("Sisa tagihan sudah mencapai batas"),
      ).toBeVisible({ timeout: READY_TIMEOUT_MS });
      await expect(dialog.getByRole("alert")).toContainText(
        "Minta tamu membayar sebagian dulu",
      );
      await expect(
        dialog.getByRole("button", { name: "Tutup" }).first(),
      ).toBeVisible();
      // Refused before any approval: no reason field, no PIN pad.
      await expect(dialog.getByLabel("Alasan")).toHaveCount(0);
      await expect(dialog.getByRole("button", { name: "Angka 1" })).toHaveCount(
        0,
      );
      await captureScreenshot(
        page,
        `legend-8cm4/pos-convert-over-limit-${label}.png`,
        { fullPage: false },
      );
    });

    test("pos-convert-policy-error: an unloadable policy shows a retry, no PIN pad", async ({
      page,
    }) => {
      await openBoard(page);
      await failPolicyLoad(page);
      const dialog = await openConvertDialog(page, UNDER_LIMIT_TABLE);
      await expect(
        dialog.getByText(
          "Batas open bill outlet belum bisa dimuat. Periksa koneksi lalu coba lagi.",
        ),
      ).toBeVisible({ timeout: READY_TIMEOUT_MS });
      await expect(
        dialog.getByRole("button", { name: "Coba lagi" }),
      ).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Angka 1" })).toHaveCount(
        0,
      );
      await captureScreenshot(
        page,
        `legend-8cm4/pos-convert-policy-error-${label}.png`,
        { fullPage: false },
      );
    });

    test("pos-convert-success: the right PIN confirms with a toast and closes the panel", async ({
      page,
    }) => {
      await openBoard(page);
      const dialog = await openConvertDialog(page, UNDER_LIMIT_TABLE);
      await expect(dialog.getByText("Batas outlet").first()).toBeVisible({
        timeout: READY_TIMEOUT_MS,
      });
      await approve(dialog, GOOD_PIN);
      await expect(
        page.getByText(`Meja ${UNDER_LIMIT_TABLE} sekarang open bill`).first(),
      ).toBeVisible({ timeout: READY_TIMEOUT_MS });
      // Both the convert dialog and the table panel are gone.
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(
        page.getByRole("heading", { name: "Papan Status Meja" }),
      ).toBeVisible();
      await captureScreenshot(
        page,
        `legend-8cm4/pos-convert-success-${label}.png`,
        { fullPage: false },
      );
    });

    test("kelola-policy: default policy shows the default badge and the three limits", async ({
      page,
    }) => {
      await openPolicyPage(page);
      await expect(
        page.getByRole("heading", { name: "Kebijakan open bill" }),
      ).toBeVisible({ timeout: READY_TIMEOUT_MS });
      await expect(page.getByText("Memakai nilai default")).toBeVisible({
        timeout: READY_TIMEOUT_MS,
      });
      await expect(page.getByLabel("Batas nilai tagihan")).toHaveValue(
        "3.000.000",
      );
      await expect(page.getByLabel("Pengingat meja tidak aktif")).toHaveValue(
        "45",
      );
      await expect(page.getByLabel("Target respons minta tagihan")).toHaveValue(
        "180",
      );
      await expect(
        page.getByRole("button", { name: "Simpan kebijakan" }),
      ).toBeVisible();
      await captureScreenshot(page, `legend-8cm4/kelola-policy-${label}.png`);
    });

    test("kelola-policy-invalid: a limit below Rp100.000 shows a field error on blur", async ({
      page,
    }) => {
      await openPolicyPage(page);
      const max = page.getByLabel("Batas nilai tagihan");
      await expect(max).toHaveValue("3.000.000", {
        timeout: READY_TIMEOUT_MS,
      });
      await max.fill("50000");
      await max.blur();
      await expect(
        page.getByText(/Isi angka bulat antara/).first(),
      ).toBeVisible();
      await captureScreenshot(
        page,
        `legend-8cm4/kelola-policy-invalid-${label}.png`,
      );
    });

    test("kelola-policy-error: a failed load shows a message and Coba lagi", async ({
      page,
    }) => {
      await openPolicyPage(page, "?mock=error");
      await expect(
        page.getByText(
          "Kebijakan open bill belum bisa dimuat. Periksa koneksi lalu coba lagi.",
        ),
      ).toBeVisible({ timeout: READY_TIMEOUT_MS });
      await expect(
        page.getByRole("button", { name: "Coba lagi" }),
      ).toBeVisible();
      await captureScreenshot(
        page,
        `legend-8cm4/kelola-policy-error-${label}.png`,
      );
    });

    test("kelola-policy-saved: saving a changed limit shows the success toast", async ({
      page,
    }) => {
      await openPolicyPage(page);
      const max = page.getByLabel("Batas nilai tagihan");
      await expect(max).toHaveValue("3.000.000", {
        timeout: READY_TIMEOUT_MS,
      });
      await max.fill("2500000");
      await expect(max).toHaveValue("2.500.000");
      await page.getByRole("button", { name: "Simpan kebijakan" }).click();
      await expect(
        page.getByText("Kebijakan open bill disimpan").first(),
      ).toBeVisible({ timeout: READY_TIMEOUT_MS });
      // A saved policy no longer uses the defaults.
      await expect(page.getByText("Memakai nilai default")).toHaveCount(0);
      await expect(max).toHaveValue("2.500.000");
      await captureScreenshot(
        page,
        `legend-8cm4/kelola-policy-saved-${label}.png`,
      );
    });
  });
}
