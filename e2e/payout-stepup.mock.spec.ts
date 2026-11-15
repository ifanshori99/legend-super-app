// WS-10 payout password step-up (brief 890). Mock-mode spec:
// `pnpm test:e2e:mock e2e/payout-stepup.mock.spec.ts`; skips without
// LEGEND_MOCK_WEB_URL so `pnpm test:e2e` never runs it.
//
// The mock emulates the server's stepUp + passwordStepUp for approve, export
// and config save only when sessionStorage `payoutMockStepUp` is "password":
// no password -> 401 REAUTH_REQUIRED, wrong password -> 403
// REAUTH_PASSWORD_INVALID, right password "benar-123" -> the action runs.
// `window.__payoutMockCalls[action]` counts handler runs that got past the
// step-up, so it proves a double click sends the action once.
//
// ASSUMPTIONS (the spec is silent, the catalog and the brief are the source):
// - The step-up panel is a form named "Verifikasi identitas" (approve, export)
//   or "Verifikasi faktor kedua" (settings): matched here by /^Verifikasi/.
// - Its password field is labelled "Kata sandi akun", its submit button is
//   "Verifikasi dan lanjutkan", and a wrong password shows the catalog text
//   "Kata sandi salah. Periksa lalu coba lagi." inside the panel, which stays
//   open with an empty password field.
// - Approve needs a person other than the batch creator. The mock session is
//   given the "finance" role cookie (mock actor differs from the creator). If
//   the UI still blocks the approve button for the creator, the approve and
//   export tests skip with a reason (same stance as payout.mock.spec.ts).
// - Export needs an approved batch: the test approves the pending one first
//   (right password), then opens the status tab, which follows that batch.
// - Screenshots of the open panel go to /private/tmp/claude-501/scratch/shots/.
import { mkdirSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";

const base = process.env.LEGEND_MOCK_WEB_URL;
test.skip(
  !base,
  "Set LEGEND_MOCK_WEB_URL (pnpm test:e2e:mock) to a web server running VITE_API_MOCK.",
);

const COLD_START_TIMEOUT_MS = 30_000;
test.describe.configure({ timeout: 90_000 });

const ROUTE = "/kelola/payroll/pencairan";
const RIGHT_PASSWORD = "benar-123";
const WRONG_PASSWORD = "salah-456";
const SHOTS_DIR = "/private/tmp/claude-501/scratch/shots";

type Action = "approve" | "export" | "config";

test.beforeEach(async ({ page, context }) => {
  await page.addInitScript(() => {
    window.sessionStorage.setItem("payoutMockStepUp", "password");
  });
  if (base)
    await context.addCookies([
      { name: "legend-mock-role", value: "finance", url: base },
    ]);
});

async function open(page: Page, tab: "approval" | "status" | "settings") {
  await page.goto(`${ROUTE}?tab=${tab}&mock=normal`, {
    waitUntil: "networkidle",
  });
}

function panelOf(page: Page) {
  return page.getByRole("form", { name: /^Verifikasi/ });
}

async function mockCalls(page: Page, action: Action) {
  return page.evaluate(
    (name) =>
      (
        window as unknown as {
          __payoutMockCalls?: Record<string, number>;
        }
      ).__payoutMockCalls?.[name] ?? 0,
    action,
  );
}

async function submitPassword(panel: Locator, password: string) {
  await panel.getByLabel("Kata sandi akun").fill(password);
  await panel.getByRole("button", { name: "Verifikasi dan lanjutkan" }).click();
}

/** Ticks the review checkbox and clicks approve; the password panel opens. */
async function openApprovePanel(page: Page) {
  await open(page, "approval");
  const approve = page.getByRole("button", { name: /Verifikasi & setujui/i });
  await expect(approve).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await page.getByRole("checkbox").first().check();
  test.skip(
    !(await approve.isEnabled()),
    "Approve is disabled for this session (creator); needs a second person.",
  );
  await approve.click();
  const panel = panelOf(page);
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel("Kata sandi akun")).toBeVisible();
  // Nothing ran yet: the click without a password was refused by step-up.
  expect(await mockCalls(page, "approve")).toBe(0);
  return panel;
}

/** Approves the pending batch with the right password, then opens export. */
async function openExportPanel(page: Page) {
  const approvePanel = await openApprovePanel(page);
  await submitPassword(approvePanel, RIGHT_PASSWORD);
  await expect(page.getByText(/Pencairan disetujui/).first()).toBeVisible();
  await expect(approvePanel).toHaveCount(0);
  await page.getByRole("tab", { name: /^Status karyawan$/ }).click();
  const download = page.getByRole("button", { name: "Unduh berkas bank" });
  await expect(download).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await download.click();
  const panel = panelOf(page);
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel("Kata sandi akun")).toBeVisible();
  expect(await mockCalls(page, "export")).toBe(0);
  return panel;
}

/** Changes the fee so save is enabled, clicks save; the password panel opens. */
async function openConfigPanel(page: Page) {
  await open(page, "settings");
  const fee = page.getByRole("textbox", { name: "Biaya per transfer (Rp)" });
  await expect(fee).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await fee.fill("6000");
  const save = page.getByRole("button", { name: "Simpan pengaturan" });
  await expect(save).toBeEnabled();
  await save.click();
  const panel = panelOf(page);
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel("Kata sandi akun")).toBeVisible();
  expect(await mockCalls(page, "config")).toBe(0);
  return panel;
}

async function expectWrongThenRight(
  page: Page,
  panel: Locator,
  action: Action,
  success: RegExp,
) {
  await submitPassword(panel, WRONG_PASSWORD);
  await expect(panel.getByText(/Kata sandi salah/)).toBeVisible();
  // The panel stays open, asks again with an empty field, and nothing ran.
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel("Kata sandi akun")).toHaveValue("");
  expect(await mockCalls(page, action)).toBe(0);
  await expect(page.getByText(success)).toHaveCount(0);

  await submitPassword(panel, RIGHT_PASSWORD);
  await expect(page.getByText(success).first()).toBeVisible();
  await expect(panel).toHaveCount(0);
  expect(await mockCalls(page, action)).toBe(1);
}

async function expectDoubleClickRunsOnce(
  page: Page,
  panel: Locator,
  action: Action,
  success: RegExp,
) {
  await panel.getByLabel("Kata sandi akun").fill(RIGHT_PASSWORD);
  // The mock answers at once, so slow it down: the first request must still be
  // in flight when the second click lands (a real server takes this long too).
  await page.evaluate(() =>
    (
      window as unknown as {
        __legendMock: { setLatencyMs: (ms: number) => void };
      }
    ).__legendMock.setLatencyMs(1500),
  );
  await panel
    .getByRole("button", { name: "Verifikasi dan lanjutkan" })
    .dblclick();
  await expect(page.getByText(success).first()).toBeVisible({
    timeout: 20_000,
  });
  // Let a late second request (if the guard failed) land before counting.
  await page.waitForTimeout(2_000);
  expect(await mockCalls(page, action)).toBe(1);
}

const APPROVED = /Pencairan disetujui/;
const EXPORTED = /Berkas bank diunduh/;
const SAVED = /Pengaturan pencairan tersimpan/;

test("payout approve asks for the account password and rejects a wrong one", async ({
  page,
}) => {
  const panel = await openApprovePanel(page);
  await expectWrongThenRight(page, panel, "approve", APPROVED);
});

test("payout approve double-click on the password button approves once", async ({
  page,
}) => {
  const panel = await openApprovePanel(page);
  await expectDoubleClickRunsOnce(page, panel, "approve", APPROVED);
});

test("payout export asks for the account password and rejects a wrong one", async ({
  page,
}) => {
  const panel = await openExportPanel(page);
  await expectWrongThenRight(page, panel, "export", EXPORTED);
});

test("payout export double-click on the password button downloads once", async ({
  page,
}) => {
  const panel = await openExportPanel(page);
  await expectDoubleClickRunsOnce(page, panel, "export", EXPORTED);
});

test("payout settings save asks for the account password and rejects a wrong one", async ({
  page,
}) => {
  const panel = await openConfigPanel(page);
  await expectWrongThenRight(page, panel, "config", SAVED);
});

test("payout settings save double-click on the password button saves once", async ({
  page,
}) => {
  const panel = await openConfigPanel(page);
  await expectDoubleClickRunsOnce(page, panel, "config", SAVED);
});

const VIEWPORTS = [
  { name: "390x844", width: 390, height: 844 },
  { name: "1280x800", width: 1280, height: 800 },
] as const;

for (const viewport of VIEWPORTS) {
  const openers: Record<Action, (page: Page) => Promise<Locator>> = {
    approve: openApprovePanel,
    export: openExportPanel,
    config: openConfigPanel,
  };
  for (const action of ["approve", "export", "config"] as const) {
    test(`payout ${action} password panel screenshot at ${viewport.name}`, async ({
      page,
    }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      const panel = await openers[action](page);
      await panel.scrollIntoViewIfNeeded();
      await expect(panel.getByLabel("Kata sandi akun")).toBeVisible();
      // No horizontal scroll with the panel open.
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      mkdirSync(SHOTS_DIR, { recursive: true });
      await page.screenshot({
        path: `${SHOTS_DIR}/payout-stepup-${action}-${viewport.name}.png`,
      });
    });
  }
}
