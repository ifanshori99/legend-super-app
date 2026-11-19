// Brief 1192 (legend-6o7pc): release of a payout slip hold by two people, on the
// recon screen. Mock-mode spec:
// `pnpm test:e2e:mock e2e/payout-recon-hold.mock.spec.ts`; skips without
// LEGEND_MOCK_WEB_URL so `pnpm test:e2e` never runs it.
// Texts come from the catalog (payrollPayoutReview.reconHold.*).
//
// How the mock is driven (features/ws10-payroll-payout/mock.ts header):
// - Scenarios `?mock=` normal, hold-approve, hold-self, hold-taken-over, empty,
//   error, slow.
// - The signed-in mock person is the role cookie `legend-mock-role`: `finance`
//   proposes, `hr` is the other person. Holds live in sessionStorage
//   (`payoutReconHoldMock`), so a reload plus a cookie switch approves as
//   someone else.
// - Step-up: sessionStorage `payoutMockStepUp=password`; right password
//   "benar-123".
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const base = process.env.LEGEND_MOCK_WEB_URL;
test.skip(
  !base,
  "Set LEGEND_MOCK_WEB_URL (pnpm test:e2e:mock) to a web server running VITE_API_MOCK.",
);

const COLD_START_TIMEOUT_MS = 30_000;
test.describe.configure({ timeout: 90_000 });

const RECON = "/kelola/payroll/rekonsiliasi";
const RIGHT_PASSWORD = "benar-123";
const PASSWORD_LABEL = "Konfirmasi sandi untuk pelepasan hold";
const REASON = "Bukti bank terbaca bersih pada pemeriksaan malam berikutnya.";

async function signInAs(context: BrowserContext, role: "finance" | "hr") {
  if (base)
    await context.addCookies([
      { name: "legend-mock-role", value: role, url: base },
    ]);
}

test.beforeEach(async ({ page, context }) => {
  await page.addInitScript(() => {
    window.sessionStorage.setItem("payoutMockStepUp", "password");
  });
  await signInAs(context, "finance");
});

async function openRecon(page: Page, scenario = "normal") {
  await page.goto(`${RECON}?mock=${scenario}`, { waitUntil: "networkidle" });
  await expect(
    page.getByRole("heading", { name: "Hold slip", exact: true }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
}

const holds = (page: Page) => page.getByTestId("recon-hold");
const holdWith = (page: Page, status: string) =>
  page.locator(`[data-testid="recon-hold"][data-status="${status}"]`);

async function switchTo(
  page: Page,
  context: BrowserContext,
  role: "finance" | "hr",
) {
  await signInAs(context, role);
  await page.reload({ waitUntil: "networkidle" });
  await expect(
    page.getByRole("heading", { name: "Hold slip", exact: true }),
  ).toBeVisible();
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("payout-recon-hold: one person proposes, the proposer cannot approve, another person approves", async ({
  page,
  context,
}) => {
  await openRecon(page);
  // Normal shows one hold of each status.
  await expect(holdWith(page, "held")).toHaveCount(2);
  await expect(holdWith(page, "proposed")).toHaveCount(1);
  await expect(holdWith(page, "released")).toHaveCount(1);
  await expect(holdWith(page, "takenOver")).toHaveCount(1);

  // Only the hold with clean evidence offers a proposal.
  const releasable = holdWith(page, "held").filter({
    has: page.getByRole("button", { name: "Usulkan pelepasan" }),
  });
  await expect(releasable).toHaveCount(1);
  await expect(
    holdWith(page, "held").filter({
      hasText: "Bukti rekonsiliasi belum bersih",
    }),
  ).toHaveCount(1);

  // 1. Finance proposes; empty reason or password is refused in the form.
  await releasable.getByRole("button", { name: "Usulkan pelepasan" }).click();
  await releasable.getByRole("button", { name: "Usulkan pelepasan" }).click();
  await expect(
    page.getByText("Usulan belum dapat dikirim").first(),
  ).toBeVisible();
  await releasable.getByLabel("Alasan pelepasan").fill(REASON);
  await releasable.getByLabel(PASSWORD_LABEL).fill(RIGHT_PASSWORD);
  await releasable.getByRole("button", { name: "Usulkan pelepasan" }).click();
  await expect(
    page.getByText("Usulan pelepasan terkirim", { exact: false }).first(),
  ).toBeVisible();
  // Two holds now wait for a second person.
  await expect(holdWith(page, "proposed")).toHaveCount(2);
  // The password is never kept: no password field is left filled.
  const leftover = page.getByLabel(PASSWORD_LABEL);
  for (let i = 0; i < (await leftover.count()); i += 1)
    await expect(leftover.nth(i)).toHaveValue("");

  // 2. Same person after a reload: their own proposal cannot be approved.
  await page.reload({ waitUntil: "networkidle" });
  const own = holdWith(page, "proposed").filter({ hasText: REASON });
  await expect(own).toHaveCount(1);
  await expect(
    own.getByRole("button", { name: "Setujui pelepasan" }),
  ).toBeDisabled();
  await expect(own.getByText(/Anda mengusulkan pelepasan ini/)).toBeVisible();

  // 3. The other person (hr) approves with a password.
  await switchTo(page, context, "hr");
  const asOther = holdWith(page, "proposed").filter({ hasText: REASON });
  await expect(
    asOther.getByRole("button", { name: "Setujui pelepasan" }),
  ).toBeEnabled();
  await asOther.getByLabel(PASSWORD_LABEL).fill(RIGHT_PASSWORD);
  await asOther.getByRole("button", { name: "Setujui pelepasan" }).click();
  await expect(page.getByText("Hold dilepas oleh orang kedua")).toBeVisible();
  await expect(holdWith(page, "released")).toHaveCount(2);
  // Nothing on the screen promises a payment.
  await expect(page.getByText(/gaji (sudah|telah) dibayar/i)).toHaveCount(0);
});

test("payout-recon-hold: a wrong password is refused and the hold stays", async ({
  page,
}) => {
  await openRecon(page, "hold-approve");
  // hold-approve is proposed by the other user; finance is the signed-in one,
  // and sees the mock proposer as someone else, so approve is offered.
  const proposed = holdWith(page, "proposed");
  await expect(proposed).toHaveCount(1);
  await proposed.getByLabel(PASSWORD_LABEL).fill("salah-123");
  await proposed.getByRole("button", { name: "Setujui pelepasan" }).click();
  await expect(holdWith(page, "released")).toHaveCount(0);
  await expect(holdWith(page, "proposed")).toHaveCount(1);
});

test("payout-recon-hold: hold-self disables approve with a reason", async ({
  page,
}) => {
  await openRecon(page, "hold-self");
  const proposed = holdWith(page, "proposed");
  await expect(proposed).toHaveCount(1);
  await expect(
    proposed.getByRole("button", { name: "Setujui pelepasan" }),
  ).toBeDisabled();
  await expect(
    proposed.getByText(/Anda mengusulkan pelepasan ini/),
  ).toBeVisible();
});

test("payout-recon-hold: a flag took the hold over (409) reloads and keeps the slip held", async ({
  page,
  context,
}) => {
  await openRecon(page, "hold-taken-over");
  const releasable = holds(page).filter({
    has: page.getByRole("button", { name: "Usulkan pelepasan" }),
  });
  await releasable.getByRole("button", { name: "Usulkan pelepasan" }).click();
  await releasable.getByLabel("Alasan pelepasan").fill(REASON);
  await releasable.getByLabel(PASSWORD_LABEL).fill(RIGHT_PASSWORD);
  await releasable.getByRole("button", { name: "Usulkan pelepasan" }).click();
  const alert = page
    .getByRole("alert")
    .filter({ hasText: "Status hold sudah berubah" });
  await expect(alert).toBeVisible();
  // The data was reloaded: that hold now reads as taken over by a flag.
  await expect(holdWith(page, "takenOver")).toHaveCount(1);
  await alert.getByRole("button", { name: "Tutup pesan" }).click();
  await expect(alert).toHaveCount(0);
  void context;
});

test("payout-recon-hold: empty, loading and error states", async ({ page }) => {
  await openRecon(page, "empty");
  await expect(
    page.getByText("Tidak ada hold slip", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Setujui pelepasan" }),
  ).toHaveCount(0);

  await page.goto(`${RECON}?mock=slow`);
  await expect(
    page.getByRole("status", { name: "Memuat hold slip" }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await expect(
    page.getByText("Tidak ada hold slip", { exact: true }),
  ).toHaveCount(0);

  await page.goto(`${RECON}?mock=error`, { waitUntil: "networkidle" });
  await expect(
    page.getByRole("alert").filter({ hasText: "Hold slip belum dapat dimuat" }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await expect(
    page.getByRole("button", { name: "Muat ulang hold" }),
  ).toBeVisible();
});

test("payout-recon-hold: mobile 390 and desktop 1280 do not scroll sideways", async ({
  page,
}) => {
  for (const [width, height] of [
    [390, 844],
    [1280, 1000],
  ] as const) {
    await page.setViewportSize({ width, height });
    await openRecon(page);
    await expectNoHorizontalScroll(page);
  }
});
