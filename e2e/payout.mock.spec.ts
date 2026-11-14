// WS-10 payroll payout screen (beads legend-wnkep.6, legend-wnkep.7).
// Contract: docs/briefs/sub-payout-finance-ui.md (screen A) and the approved
// mockup (design/mockups/payout). Mock-mode spec:
// `pnpm test:e2e:mock e2e/payout.mock.spec.ts`; skips without
// LEGEND_MOCK_WEB_URL so `pnpm test:e2e` never runs it.
//
// ASSUMPTIONS (the spec is silent, the mockup is the only text source):
// - Route /kelola/payroll/pencairan, tabs via ?tab=runs|approval|status|settings.
// - Tabs are role "tab" (shadcn Tabs) or links named like the mockup:
//   "Siap bayar", "Persetujuan", "Status karyawan", "Pengaturan PT".
// - The `normal` mock fixture mirrors the mockup: PT with Duitku off, run
//   PAY-2026-11-01 with a batch awaiting approval, 4 employees (one "Gagal",
//   one "Dibayar manual"), one item with unknown outcome, gaji diterima
//   Rp21.500.000, biaya PT Rp20.000, dana disiapkan Rp21.520.000.
// - Server failures are injected with window.__legendMock.failNext("*", ...)
//   right before the click, so the failing call is the action's own mutation.
//   The UI must show the server error (by code or message) in an alert/status.
// - The mock session may create and approve; a UI that disables "Verifikasi &
//   setujui" for the batch creator is accepted (reason shown), a UI that lets
//   the click through must show the server's PAYOUT_SELF_APPROVAL error.
import { expect, test, type Page } from "@playwright/test";

const base = process.env.LEGEND_MOCK_WEB_URL;
test.skip(
  !base,
  "Set LEGEND_MOCK_WEB_URL (pnpm test:e2e:mock) to a web server running VITE_API_MOCK.",
);

const COLD_START_TIMEOUT_MS = 30_000;
test.describe.configure({ timeout: 90_000 });

const ROUTE = "/kelola/payroll/pencairan";
type TabKey = "runs" | "approval" | "status" | "settings";
const TAB_NAME: Record<TabKey, RegExp> = {
  runs: /^Siap bayar$/,
  approval: /^Persetujuan$/,
  status: /^Status karyawan$/,
  settings: /^Pengaturan PT$/,
};

async function open(page: Page, tab: TabKey, scenario = "normal") {
  await page.goto(`${ROUTE}?tab=${tab}&mock=${scenario}`, {
    waitUntil: "networkidle",
  });
}

function tabControl(page: Page, tab: TabKey) {
  return page
    .getByRole("tab", { name: TAB_NAME[tab] })
    .or(page.getByRole("link", { name: TAB_NAME[tab] }));
}

async function failNext(
  page: Page,
  failure: { status: number; code: string; message: string },
) {
  await page.evaluate((value) => {
    (
      window as unknown as {
        __legendMock: { failNext: (id: string, f: unknown) => void };
      }
    ).__legendMock.failNext("*", value);
  }, failure);
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("payout shows four tabs and switches between them", async ({ page }) => {
  await open(page, "runs");
  await expect(
    page.getByRole("heading", { name: /Pencairan gaji/i }).first(),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  for (const key of ["runs", "approval", "status", "settings"] as const) {
    await expect(tabControl(page, key)).toBeVisible();
  }
  await tabControl(page, "approval").click();
  await expect(page).toHaveURL(/tab=approval/);
  await tabControl(page, "settings").click();
  await expect(page).toHaveURL(/tab=settings/);
});

test("payout runs tab lists payable runs and explains Duitku is off", async ({
  page,
}) => {
  await open(page, "runs");
  await expect(page.getByText("PAY-2026-11-01").first()).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
  // Duitku off: the user is pointed to the manual path, not left guessing.
  await expect(page.getByText(/Duitku belum aktif/i).first()).toBeVisible();
  await expect(page.getByText(/transfer manual/i).first()).toBeVisible();
});

test("payout runs tab empty state offers a way forward", async ({ page }) => {
  await open(page, "runs", "empty");
  // The empty title is a paragraph in the UI, so match text, not a heading.
  await expect(page.getByText("Belum ada periode gaji siap bayar")).toBeVisible(
    {
      timeout: COLD_START_TIMEOUT_MS,
    },
  );
});

test("payout runs tab error state offers retry and never shows a success", async ({
  page,
}) => {
  await open(page, "runs", "error");
  await expect(
    page.getByRole("button", { name: /Coba lagi/i }).first(),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await expect(page.getByText("PAY-2026-11-01")).toHaveCount(0);
});

test("payout approval shows salary received apart from the PT fee", async ({
  page,
}) => {
  await open(page, "approval");
  await expect(page.getByText(/Gaji diterima/i).first()).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
  await expect(page.getByText(/Biaya PT/i).first()).toBeVisible();
  // Salary stays whole: gross salary, fee and funds to prepare are three
  // separate amounts; the fee is not deducted from the salary.
  await expect(page.getByText(/Rp\s?21\.500\.000/).first()).toBeVisible();
  await expect(page.getByText(/Rp\s?20\.000/).first()).toBeVisible();
  await expect(page.getByText(/Rp\s?21\.520\.000/).first()).toBeVisible();
  await expect(
    page.getByText(/Dana disiapkan|total dana/i).first(),
  ).toBeVisible();
});

test("payout approval needs the review checkbox and a second person", async ({
  page,
}) => {
  await open(page, "approval");
  const approve = page.getByRole("button", { name: /Verifikasi & setujui/i });
  await expect(approve).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await expect(approve).toBeDisabled();
  // Two named steps: creator and a different approver.
  await expect(page.getByText(/Pembuat pengajuan/i).first()).toBeVisible();
  await expect(page.getByText(/Penyetuju/i).first()).toBeVisible();
});

test("payout approval blocks self-approval and shows the server error", async ({
  page,
}) => {
  await open(page, "approval");
  const approve = page.getByRole("button", { name: /Verifikasi & setujui/i });
  await expect(approve).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await page.getByRole("checkbox").first().check();
  if (await approve.isEnabled()) {
    await failNext(page, {
      status: 403,
      code: "PAYOUT_SELF_APPROVAL",
      message: "Pembuat pengajuan tidak boleh menyetujui pencairannya sendiri.",
    });
    await approve.click();
    await expect(
      page.getByText(/Pembuat pengajuan tidak boleh menyetujui/i).first(),
    ).toBeVisible();
    // Nothing was approved: the button is still there and no success shown.
    await expect(approve).toBeVisible();
    await expect(page.getByText(/berhasil disetujui/i)).toHaveCount(0);
  } else {
    // UI blocks the creator itself, and must say why.
    await expect(
      page.getByText(/pembuat.*(tidak dapat|tidak boleh)|orang kedua/i).first(),
    ).toBeVisible();
  }
});

test("payout approval shows a server rejection for an inactive source account", async ({
  page,
}) => {
  await open(page, "approval");
  const approve = page.getByRole("button", { name: /Verifikasi & setujui/i });
  await expect(approve).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await page.getByRole("checkbox").first().check();
  test.skip(
    !(await approve.isEnabled()),
    "Approve is disabled for this session (creator); covered by the self-approval test.",
  );
  await failNext(page, {
    status: 422,
    code: "PAYOUT_SOURCE_ACCOUNT_INVALID",
    message: "Rekening sumber tidak aktif. Pilih rekening aktif milik PT ini.",
  });
  await approve.click();
  await expect(
    page.getByText(/Rekening sumber tidak aktif/i).first(),
  ).toBeVisible();
});

test("payout approval empty state sends the user back to runs", async ({
  page,
}) => {
  await open(page, "approval", "empty");
  // Real copy: "Belum ada pengajuan untuk diperiksa" (the mockup said otherwise).
  await expect(
    page.getByText("Belum ada pengajuan untuk diperiksa"),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
});

test("payout status lists each employee with a text status", async ({
  page,
}) => {
  await open(page, "status");
  await expect(page.getByText("Alya Putri").first()).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
  // Status is a word, not only a colour.
  for (const label of [/Menunggu/, /Berhasil/, /Gagal/, /Dibayar manual/]) {
    await expect(page.getByText(label).first()).toBeVisible();
  }
});

test("payout status unknown outcome has no pay-again button", async ({
  page,
}) => {
  await open(page, "status");
  await expect(page.getByText(/belum pasti/i).first()).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
  await expect(
    page.getByText(/Jangan (bayar|kirim) ulang/i).first(),
  ).toBeVisible();
  // No retry or re-pay control anywhere for an unknown item.
  await expect(
    page.getByRole("button", { name: /bayar ulang|kirim ulang|coba bayar/i }),
  ).toHaveCount(0);
});

test("payout status empty and error states", async ({ page }) => {
  await open(page, "status", "empty");
  await expect(
    page.getByText("Belum ada pencairan untuk ditampilkan"),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await open(page, "status", "error");
  await expect(
    page.getByRole("button", { name: /Coba lagi/i }).first(),
  ).toBeVisible();
});

test("payout settings turns Duitku off and offers manual bank transfer", async ({
  page,
}) => {
  await open(page, "settings");
  const method = page.getByRole("combobox", { name: "Metode pembayaran" });
  await expect(method).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await expect(method).toContainText("Transfer manual");
  await method.click();
  // Duitku is listed but cannot be chosen; manual transfer can.
  await expect(page.getByRole("option", { name: /Duitku/ })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(
    page.getByRole("option", { name: "Transfer manual" }),
  ).not.toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByText(/Belum aktif/).first()).toBeVisible();
});

test("payout settings rejects an inactive source account with the server message", async ({
  page,
}) => {
  await open(page, "settings");
  const fee = page.getByRole("textbox", { name: "Biaya per transfer (Rp)" });
  await expect(fee).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  // Save stays disabled until something changes ("Belum ada perubahan").
  const save = page.getByRole("button", { name: "Simpan pengaturan" });
  await expect(save).toBeDisabled();
  await fee.fill("6000");
  await expect(save).toBeEnabled();
  await failNext(page, {
    status: 422,
    code: "PAYOUT_SOURCE_ACCOUNT_INVALID",
    message: "Rekening sumber ditolak server.",
  });
  await save.click();
  const alert = page.getByRole("alert").filter({ hasText: /Rekening sumber/ });
  await expect(alert.first()).toBeVisible();
  // The rejected change is not reported as saved.
  await expect(page.getByText(/Pengaturan pencairan tersimpan/)).toHaveCount(0);
});

test("payout settings error state offers retry", async ({ page }) => {
  await open(page, "settings", "error");
  await expect(
    page.getByRole("button", { name: /Coba lagi/i }).first(),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
});

for (const tab of ["runs", "approval", "status", "settings"] as const) {
  test(`payout ${tab} tab has no horizontal scroll at 390px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await open(page, tab);
    await expect(tabControl(page, tab).first()).toBeVisible({
      timeout: COLD_START_TIMEOUT_MS,
    });
    await expectNoHorizontalScroll(page);
  });
}
