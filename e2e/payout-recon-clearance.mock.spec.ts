// Brief 1015 (legend-o2b4m): payout recon clearance and return-claim withdrawal,
// both two-person steps. Mock-mode spec:
// `pnpm test:e2e:mock e2e/payout-recon-clearance.mock.spec.ts`; skips without
// LEGEND_MOCK_WEB_URL so `pnpm test:e2e` never runs it.
// Contract: docs/briefs/1015/brief.md, mockup notes
// design/mockups/backoffice/payout-recon-clearance-notes.md. Texts come from the
// approved mockup / catalog (payrollPayoutReview.recon.*, .returnWithdraw.*).
//
// How the mock is driven (features/ws10-payroll-payout/mock.ts header):
// - Scenarios `?mock=` normal, recon-approve, recon-self, recon-changed,
//   recon-reopened, empty, error, slow.
// - The signed-in mock person is the role cookie `legend-mock-role`: `finance`
//   is the proposer, `hr` the other person. Proposals live in sessionStorage
//   (`payoutReconMock`), so a reload plus a cookie switch approves as someone
//   else.
// - Step-up: sessionStorage `payoutMockStepUp=password`; right password
//   "benar-123".
//
// ASSUMPTIONS (the spec is silent):
// - Route /kelola/payroll/rekonsiliasi, h1 "Flag rekonsiliasi payout". Each
//   flag is a listitem holding the flag's reason and one button ("Tinjau flag",
//   "Lihat usulan" or "Lihat persetujuan") that selects it.
// - The panel labels are "Alasan clearance" and "Konfirmasi kata sandi akun";
//   buttons "Usulkan clearance", "Setujui clearance", "Buat usulan baru".
// - The mock refusing a wrong password on the recon screen is not asserted: the
//   brief only says the mock follows `payoutMockStepUp` for the existing tabs.
// - The withdraw section sits on the status tab of the pencairan screen
//   (?tab=status), titled "Klaim dana kembali"; its password step is the same
//   "Verifikasi" panel (label "Kata sandi akun", button "Verifikasi dan
//   lanjutkan") as the other payout actions.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const base = process.env.LEGEND_MOCK_WEB_URL;
test.skip(
  !base,
  "Set LEGEND_MOCK_WEB_URL (pnpm test:e2e:mock) to a web server running VITE_API_MOCK.",
);

const COLD_START_TIMEOUT_MS = 30_000;
test.describe.configure({ timeout: 90_000 });

const RECON = "/kelola/payroll/rekonsiliasi";
const PAYOUT = "/kelola/payroll/pencairan";
const RIGHT_PASSWORD = "benar-123";
const REASON =
  "Selisih sudah dicocokkan dengan mutasi bank dan bukti transfer.";
// Reasons of the seeded flags in `normal` (mock.ts).
const OPEN_FLAG = "Biaya PT tidak cocok dengan jurnal biaya.";
const PROPOSED_FLAG = "Dana kembali dicatat tanpa jurnal yang cocok.";

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
    page.getByRole("heading", { name: "Flag rekonsiliasi payout" }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
}

function flagRow(page: Page, reason: string) {
  return page.getByRole("listitem").filter({ hasText: reason });
}

async function selectFlag(page: Page, reason: string) {
  const row = flagRow(page, reason).first();
  await expect(row).toBeVisible();
  await row.getByRole("button").first().click();
}

async function switchTo(
  page: Page,
  context: BrowserContext,
  role: "finance" | "hr",
) {
  await signInAs(context, role);
  await page.reload({ waitUntil: "networkidle" });
  await expect(
    page.getByRole("heading", { name: "Flag rekonsiliasi payout" }),
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

test("payout-recon-clearance: one person proposes, the proposer cannot approve, another person approves", async ({
  page,
  context,
}) => {
  await openRecon(page);

  // 1. Finance proposes for the open flag.
  await selectFlag(page, OPEN_FLAG);
  await page.getByLabel("Alasan clearance").fill(REASON);
  await page.getByLabel("Konfirmasi kata sandi akun").fill(RIGHT_PASSWORD);
  await page.getByRole("button", { name: "Usulkan clearance" }).click();
  await expect(
    flagRow(page, OPEN_FLAG).getByText("Diusulkan", { exact: true }),
  ).toBeVisible();
  // The password is never kept: whatever field is left on screen is empty.
  const leftover = page.getByLabel("Konfirmasi kata sandi akun");
  if ((await leftover.count()) > 0)
    await expect(leftover.first()).toHaveValue("");

  // 2. Same person after a reload: approve is disabled and explained.
  await page.reload({ waitUntil: "networkidle" });
  await selectFlag(page, OPEN_FLAG);
  const approve = page.getByRole("button", { name: "Setujui clearance" });
  await expect(approve).toBeDisabled();
  await expect(
    page.getByText(/Anda mengusulkan clearance ini/).first(),
  ).toBeVisible();

  // 3. The other person (hr) approves with a password.
  await switchTo(page, context, "hr");
  await selectFlag(page, OPEN_FLAG);
  const approveAsOther = page.getByRole("button", {
    name: "Setujui clearance",
  });
  await expect(approveAsOther).toBeEnabled();
  await page.getByLabel("Konfirmasi kata sandi akun").fill(RIGHT_PASSWORD);
  await approveAsOther.click();
  await expect(
    flagRow(page, OPEN_FLAG).getByText("Disetujui", { exact: true }),
  ).toBeVisible();

  // Nothing on this screen pays anyone.
  await expect(
    page.getByRole("button", { name: /bayar|transfer|cairkan/i }),
  ).toHaveCount(0);
  await expect(page.getByText(/gaji (sudah|telah) dibayar/i)).toHaveCount(0);
});

test("payout-recon-clearance: a proposal needs a reason of 10 characters and a password", async ({
  page,
}) => {
  await openRecon(page);
  await selectFlag(page, OPEN_FLAG);

  await page.getByRole("button", { name: "Usulkan clearance" }).click();
  await expect(
    page.getByText("Tulis alasan minimal 10 karakter."),
  ).toBeVisible();
  await expect(
    page.getByText("Isi konfirmasi kata sandi untuk melanjutkan."),
  ).toBeVisible();
  await expect(
    flagRow(page, OPEN_FLAG).getByText("Diusulkan", { exact: true }),
  ).toHaveCount(0);

  // A reason that is too short is refused even with a password.
  await page.getByLabel("Alasan clearance").fill("singkat");
  await page.getByLabel("Konfirmasi kata sandi akun").fill(RIGHT_PASSWORD);
  await page.getByRole("button", { name: "Usulkan clearance" }).click();
  await expect(
    page.getByText("Tulis alasan minimal 10 karakter."),
  ).toBeVisible();
  await expect(
    flagRow(page, OPEN_FLAG).getByText("Diusulkan", { exact: true }),
  ).toHaveCount(0);
});

test("payout-recon-clearance: status labels Terbuka, Diusulkan, Disetujui", async ({
  page,
}) => {
  await openRecon(page);
  await expect(
    flagRow(page, OPEN_FLAG).getByText("Terbuka", { exact: true }),
  ).toBeVisible();
  await expect(
    flagRow(page, PROPOSED_FLAG).getByText("Diusulkan", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("listitem").filter({ hasText: "Disetujui" }).first(),
  ).toBeVisible();
});

test("payout-recon-clearance: another person's proposal can be approved by finance", async ({
  page,
}) => {
  await openRecon(page, "recon-approve");
  await selectFlag(page, PROPOSED_FLAG);
  const approve = page.getByRole("button", { name: "Setujui clearance" });
  await expect(approve).toBeEnabled();
  await page.getByLabel("Konfirmasi kata sandi akun").fill(RIGHT_PASSWORD);
  await approve.click();
  await expect(
    flagRow(page, PROPOSED_FLAG).getByText("Disetujui", { exact: true }),
  ).toBeVisible();
});

test("payout-recon-clearance: your own proposal shows approve disabled with the reason", async ({
  page,
}) => {
  await openRecon(page, "recon-self");
  await selectFlag(page, PROPOSED_FLAG);
  await expect(
    page.getByRole("button", { name: "Setujui clearance" }),
  ).toBeDisabled();
  await expect(
    page.getByText(
      "Anda mengusulkan clearance ini. Persetujuan harus dilakukan oleh orang lain.",
    ),
  ).toBeVisible();
});

test("payout-recon-clearance: a changed flag (409) reloads and offers a new proposal", async ({
  page,
}) => {
  await openRecon(page, "recon-changed");
  await selectFlag(page, PROPOSED_FLAG);
  await page.getByLabel("Konfirmasi kata sandi akun").fill(RIGHT_PASSWORD);
  await page.getByRole("button", { name: "Setujui clearance" }).click();
  const alert = page
    .getByRole("alert")
    .filter({ hasText: "Data berubah setelah usulan dibuat" });
  await expect(alert).toBeVisible();
  await expect(
    alert.getByRole("button", { name: "Buat usulan baru" }),
  ).toBeVisible();
  // The old proposal is gone: it cannot be approved any more.
  await expect(
    flagRow(page, PROPOSED_FLAG).getByText("Disetujui", { exact: true }),
  ).toHaveCount(0);
});

test("payout-recon-clearance: a reopened flag says the old clearance no longer applies", async ({
  page,
}) => {
  await openRecon(page, "recon-reopened");
  await expect(page.getByText("Terbuka ulang").first()).toBeVisible();
  await expect(
    page.getByText(/Clearance lama tidak berlaku/).first(),
  ).toBeVisible();
});

test("payout-recon-clearance: empty, loading and error states", async ({
  page,
}) => {
  await openRecon(page, "empty");
  await expect(
    page.getByText("Tidak ada flag rekonsiliasi", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Setujui clearance" }),
  ).toHaveCount(0);

  // Slow answer: the loading state reads as loading, never as empty or Rp0.
  await page.goto(`${RECON}?mock=slow`);
  await expect(
    page.getByRole("status", { name: "Memuat flag rekonsiliasi" }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await expect(
    page.getByText("Tidak ada flag rekonsiliasi", { exact: true }),
  ).toHaveCount(0);

  await openRecon(page, "error");
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Flag rekonsiliasi belum dapat dimuat" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();
  await expect(page.getByText(/Rp\s?0\b/)).toHaveCount(0);
});

test("payout-recon-clearance: mobile 390 and desktop 1280 do not scroll sideways", async ({
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

// ---- Withdraw of a return claim (status tab) ------------------------------------

async function openClaims(page: Page, scenario: string) {
  await page.goto(`${PAYOUT}?tab=status&mock=${scenario}`, {
    waitUntil: "networkidle",
  });
  const section = page.getByRole("region", { name: "Klaim dana kembali" });
  await expect(section).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  return section;
}

/**
 * The approve dialog first asks to confirm; the mock answers REAUTH_REQUIRED
 * (payoutMockStepUp=password) and only then the "Verifikasi" panel appears.
 */
async function confirmWithdrawDialog(page: Page) {
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Setujui penarikan" })
    .click();
}

test("payout-recon-clearance: withdraw, another person's proposal can be approved", async ({
  page,
}) => {
  const section = await openClaims(page, "recon-approve");
  const approve = section.getByRole("button", { name: "Setujui penarikan" });
  await expect(approve).toBeEnabled();
  await approve.click();
  await confirmWithdrawDialog(page);
  const panel = page.getByRole("form", { name: /^Verifikasi/ });
  await expect(panel).toBeVisible();
  await panel.getByLabel("Kata sandi akun").fill(RIGHT_PASSWORD);
  await panel.getByRole("button", { name: "Verifikasi dan lanjutkan" }).click();
  await expect(
    page.getByText(/Penarikan klaim disetujui/).first(),
  ).toBeVisible();
  // No payment happens: no pay or transfer action appears in the section.
  await expect(
    section.getByRole("button", { name: /bayar|transfer|cairkan/i }),
  ).toHaveCount(0);
});

test("payout-recon-clearance: withdraw, your own proposal cannot be approved by you", async ({
  page,
}) => {
  const section = await openClaims(page, "recon-self");
  await expect(
    section.getByRole("button", { name: "Setujui penarikan" }),
  ).toBeDisabled();
  await expect(
    section.getByText(
      "Anda yang mengusulkan penarikan ini. Orang lain yang menyetujuinya.",
    ),
  ).toBeVisible();
});

test("payout-recon-clearance: withdraw, a claim that changed (409) is reloaded", async ({
  page,
}) => {
  const section = await openClaims(page, "recon-changed");
  await section.getByRole("button", { name: "Setujui penarikan" }).click();
  await confirmWithdrawDialog(page);
  const panel = page.getByRole("form", { name: /^Verifikasi/ });
  await panel.getByLabel("Kata sandi akun").fill(RIGHT_PASSWORD);
  await panel.getByRole("button", { name: "Verifikasi dan lanjutkan" }).click();
  await expect(page.getByText(/Klaim ini sudah berubah/).first()).toBeVisible();
  // The dialog closes on a conflict; the claim list is the reloaded data.
  await expect(panel).toHaveCount(0);
  await expect(
    section.getByRole("button", { name: "Setujui penarikan" }),
  ).toHaveCount(0);
});

test("payout-recon-clearance: withdraw, a consumed or withdrawn claim has no action", async ({
  page,
}) => {
  const section = await openClaims(page, "normal");
  await expect(
    section.getByText("Sudah dikonfirmasi", { exact: true }),
  ).toBeVisible();
  await expect(section.getByText("Ditarik", { exact: true })).toBeVisible();
  // The open claim offers one withdraw proposal; the other two rows offer none.
  await expect(
    section
      .getByRole("listitem")
      .filter({ hasText: "Sudah dikonfirmasi" })
      .getByRole("button"),
  ).toHaveCount(0);
  await expect(
    section
      .getByRole("listitem")
      .filter({ hasText: "Ditarik" })
      .getByRole("button"),
  ).toHaveCount(0);
});
