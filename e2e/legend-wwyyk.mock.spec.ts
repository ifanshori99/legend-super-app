// legend-wwyyk: claim button of a split part on the phone bill screen
// (PRD §3 F10 "Split Bill"; mockup design/mockups/split-claim-wwyyk.html).
// Contract: shared `getSplitClaim` always answers 200 with the status in the
// body; the screen shows each part's claim as `split-claim-<splitId>` with a
// `data-claim-state` of belum-bayar | siap | sedang-klaim | available | claimed
// | expired | error.
//
// ASSUMPTIONS: the guest who creates an equal split owns the part they pay
// (the claim shows on the bill for that part); "Lanjut ke akun" is the
// available state's action (a link to /masuk). Token handling is not asserted.
// Run: pnpm test:e2e:mock e2e/legend-wwyyk.mock.spec.ts
import { expect, test, type Page } from "@playwright/test";
import { failNextCall } from "./mock-fail-next.ts";

const COLD_START_TIMEOUT_MS = 30_000;
const freeTable = `v1.${"C".repeat(40)}.${"D".repeat(43)}`; // A01, pay-first
const CLAIM_ENDPOINT =
  "POST /api/table-sessions/:sessionId/splits/:splitId/claim";

test.use({ viewport: { width: 390, height: 844 } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      if (!sessionStorage.getItem("e2e-init")) {
        sessionStorage.clear();
        sessionStorage.setItem("e2e-init", "1");
        localStorage.setItem("legend-theme", "light");
      }
    } catch {
      // storage blocked: the test still runs
    }
  });
});

async function joinTable(page: Page) {
  await page.goto(`/t/${freeTable}`);
  const save = page.getByRole("button", { name: "Simpan" });
  await expect(async () => {
    await page.getByRole("button", { name: /Pilih jumlah tamu/ }).click();
    await expect(save).toBeVisible({ timeout: 1_500 });
  }).toPass({ timeout: COLD_START_TIMEOUT_MS });
  await save.click();
  await expect(
    page.getByRole("button", { name: /Pilih jumlah tamu/ }),
  ).toHaveCount(0);
}

/** Splits the order in two, pays the first part with QRIS, opens the bill. */
async function splitAndPayFirstPart(page: Page) {
  await joinTable(page);
  await page.getByRole("button", { name: "Lihat detail Espresso" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("radio", { name: /Dingin/ }).click();
  await sheet.getByRole("radio", { name: "Normal" }).click();
  await sheet.getByRole("button", { name: /^Tambah · / }).click();
  await expect(sheet).toBeHidden();
  await page.getByRole("link", { name: "Lihat keranjang" }).click();
  await page.getByRole("button", { name: "Bagi tagihan" }).click();
  await page.getByRole("button", { name: "Buat pembagian" }).click();
  await expect(page.getByText("Bagian 1")).toBeVisible();
  await page.getByRole("button", { name: "Bayar bagian ini" }).first().click();
  const pay = page.getByRole("dialog");
  await pay.getByRole("radio", { name: /QRIS/ }).click();
  await pay.getByRole("button", { name: /^Bayar Rp.* dengan QRIS$/ }).click();
  await expect(
    page.getByText("Pembayaran berhasil", { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await page.goto(`/t/${freeTable}/bill`);
  await expect(page.getByText("Lunas").first()).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
}

const claimOf = (page: Page, state: string) =>
  page.locator(`[data-testid^="split-claim-"][data-claim-state="${state}"]`);

test("a paid part offers 'Klaim bagian saya' and the claim becomes ready", async ({
  page,
}) => {
  await splitAndPayFirstPart(page);
  const ready = claimOf(page, "siap");
  await expect(ready).toHaveCount(1);
  await expect(page.getByText("Bagian Anda sudah lunas.")).toBeVisible();
  await expect(
    ready.getByText("Klaim tersedia sampai 24 jam setelah pembayaran."),
  ).toBeVisible();
  await ready.getByRole("button", { name: "Klaim bagian saya" }).click();

  const done = claimOf(page, "berhasil");
  await expect(done).toHaveCount(1);
  await expect(page.getByText("Klaim siap dilanjutkan")).toBeVisible();
  await expect(
    done.getByRole("link", { name: "Lanjut ke akun" }),
  ).toBeVisible();
});

// Assumption: the claim bar is only shown for a part this guest started to pay,
// so "not paid yet -> disabled" cannot be reached without racing the 4 s mock
// settlement; the `unavailable` status is covered by the unit test instead.

test("a failed claim says so, keeps the payment and can be retried", async ({
  page,
}) => {
  await splitAndPayFirstPart(page);
  await failNextCall(page, CLAIM_ENDPOINT, {
    status: 500,
    code: "INTERNAL_ERROR",
  });
  await claimOf(page, "siap")
    .getByRole("button", { name: "Klaim bagian saya" })
    .click();

  const failed = claimOf(page, "error");
  await expect(failed).toHaveCount(1);
  await expect(page.getByText("Klaim belum dapat disiapkan")).toBeVisible();
  await expect(
    failed.getByText("Pembayaran Anda tetap tercatat."),
  ).toBeVisible();
  await failed.getByRole("button", { name: "Coba klaim lagi" }).click();

  await expect(claimOf(page, "berhasil")).toHaveCount(1);
});

test("the claim stays inside a 320 px screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await splitAndPayFirstPart(page);
  await expect(claimOf(page, "siap")).toHaveCount(1);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
