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

// ---------------------------------------------------------------------------
// legend-gthgq wiring: account snapshot (A), evidence upload (B), paged
// batch list (C). Sub-brief: docs/briefs/740-sub-payout-wiring.md.
//
// ASSUMPTIONS (spec is silent, the catalog texts and the brief are the source):
// - `normal` fixture: the approval batch shows masked account "****1234" from
//   the item snapshot (bank items) and no "noSnapshot" warning.
// - `mock=legacy-account`: a pending-approval batch with a bank item whose
//   snapshot is null. The approve button stays disabled even after the review
//   checkbox is ticked and the reason (count of employees) is shown.
// - Status tab, `normal` fixture: the single "exported" manual item has the
//   row action "Catat hasil manual" that opens the result dialog. In the
//   mock, a step-up (MFA/password) prompt is not triggered.
// - The PDF rejection may happen on file choice or on submit; the test picks
//   the file, fills the note and submits, then expects the message either way.
// - `mock=batches-paged`: batches of the shown runs load by themselves (pages
//   1 and 2); page 2 holds an older history batch and a nextCursor, so "Muat
//   pencairan berikutnya" shows; after loading page 3 the button is gone.
// - `mock=batches-paged-open`: the pending-approval batch sits on page 2; the
//   Persetujuan tab still opens it without any click.
// ---------------------------------------------------------------------------

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==",
  "base64",
);

async function openRecordDialog(page: Page) {
  await open(page, "status");
  const action = page.getByRole("button", { name: "Catat hasil manual" });
  await expect(action).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await action.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

test("payout approval shows the recorded account from the batch snapshot", async ({
  page,
}) => {
  await open(page, "approval");
  await expect(page.getByText(/\*{4}1234/).first()).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
  await expect(page.getByText("Rekening belum tercatat di batch")).toHaveCount(
    0,
  );
  await expect(
    page.getByText(/belum punya rekening tercatat di batch ini/),
  ).toHaveCount(0);
});

test("payout approval blocks a legacy batch without a recorded account", async ({
  page,
}) => {
  await open(page, "approval", "legacy-account");
  const approve = page.getByRole("button", { name: /Verifikasi & setujui/i });
  await expect(approve).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await expect(
    page.getByText("Rekening belum tercatat di batch").first(),
  ).toBeVisible();
  await expect(
    page.getByText(/1 karyawan transfer bank belum punya rekening tercatat/),
  ).toBeVisible();
  // Even after the review checkbox, money cannot be approved.
  await page.getByRole("checkbox").first().check();
  await expect(approve).toBeDisabled();
});

test("payout status offers Gagal and Tidak terkirim with a required evidence file and note", async ({
  page,
}) => {
  const dialog = await openRecordDialog(page);
  const failed = dialog.getByRole("radio", { name: "Gagal" });
  const notSent = dialog.getByRole("radio", { name: "Tidak terkirim" });
  await expect(failed).toBeEnabled();
  await expect(notSent).toBeEnabled();
  // The old "not available yet" notice is gone.
  await expect(
    page.getByText("Gagal dan Tidak terkirim belum bisa dipilih"),
  ).toHaveCount(0);
  await failed.click();
  await expect(dialog.getByText("Berkas bukti dari bank")).toBeVisible();
  await dialog.getByRole("button", { name: "Simpan hasil" }).click();
  await expect(dialog.getByText("Pilih berkas bukti dulu.")).toBeVisible();
  await expect(dialog.getByText("Catatan wajib diisi.")).toBeVisible();
  // Nothing was recorded.
  await expect(page.getByText(/Usulan tercatat/)).toHaveCount(0);
});

test("payout status marks a transfer failed with an uploaded PNG and says a second person is needed", async ({
  page,
}) => {
  const dialog = await openRecordDialog(page);
  await dialog.getByRole("radio", { name: "Gagal" }).click();
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "bukti-bank.png",
    mimeType: "image/png",
    buffer: PNG_1X1,
  });
  await dialog
    .getByLabel("Catatan", { exact: true })
    .fill("Ditolak bank: rekening tidak aktif.");
  await dialog.getByRole("button", { name: "Simpan hasil" }).click();
  await expect(page.getByText(/Usulan tercatat\./).first()).toBeVisible();
  await expect(
    page.getByText(/Orang lain perlu menandai hasil yang sama/).first(),
  ).toBeVisible();
  // One person alone does not release the slip for re-payment.
  await expect(
    page.getByText(/Slip gaji ini bisa dicairkan ulang/),
  ).toHaveCount(0);
});

test("payout status rejects a PDF as evidence and asks for a photo or screenshot", async ({
  page,
}) => {
  const dialog = await openRecordDialog(page);
  await dialog.getByRole("radio", { name: "Tidak terkirim" }).click();
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "bukti-bank.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n%mock\n"),
  });
  await dialog
    .getByLabel("Catatan", { exact: true })
    .fill("Transfer tidak sampai ke bank.");
  await dialog.getByRole("button", { name: "Simpan hasil" }).click();
  await expect(
    page.getByText(/Unggah foto atau screenshot bukti/).first(),
  ).toBeVisible();
  await expect(page.getByText(/Usulan tercatat/)).toHaveCount(0);
});

test("payout runs tab loads the next page of batches on demand", async ({
  page,
}) => {
  await open(page, "runs", "batches-paged");
  const more = page.getByRole("button", { name: "Muat pencairan berikutnya" });
  await expect(more).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await more.click();
  // Last page loaded: no further page to ask for, and no error shown.
  await expect(more).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Coba lagi/i })).toHaveCount(0);
});

test("payout approval opens a pending batch that sits on the second page", async ({
  page,
}) => {
  await open(page, "approval", "batches-paged-open");
  await expect(page.getByText("Alya Putri").first()).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
  await expect(
    page.getByRole("button", { name: /Verifikasi & setujui/i }),
  ).toBeVisible();
});

test("payout runs tab shows no load-more button when everything fits one page", async ({
  page,
}) => {
  await open(page, "runs");
  await expect(page.getByText("PAY-2026-11-01").first()).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
  await expect(
    page.getByRole("button", { name: "Muat pencairan berikutnya" }),
  ).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Putaran 4 (T2): first-person proposal shown to the second person.
// Brief: docs/briefs/740-sub-payout-wiring.md "Putaran 4".
//
// ASSUMPTIONS (UI copy not built yet; texts come from the brief and the
// existing catalog "result.resolved"):
// - `mock=resolve-proposal`: the exported manual item on the status tab has a
//   resolve proposal (Gagal) by another user, so "Catat hasil manual" opens the
//   dialog in second-person mode.
// - The panel is titled "Usulan orang pertama", shows the outcome "Gagal", the
//   proposer (not "Anda", as the proposer is another user), the note, and a
//   "Lihat bukti" button or link.
// - Second person has no file upload, and the outcome is locked to the proposal
//   (asserted only as: no upload input). Saving needs only the own note.
// - Success text is the catalog's "Hasil tercatat. Slip gaji ini bisa
//   dicairkan ulang."
// - "Lihat bukti" opens the signed URL in a new tab (popup event).
// ---------------------------------------------------------------------------

async function openProposalDialog(page: Page) {
  await open(page, "status", "resolve-proposal");
  const action = page.getByRole("button", { name: "Catat hasil manual" });
  await expect(action.first()).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await action.first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

test("payout status row marks an item that waits for the second person", async ({
  page,
}) => {
  await open(page, "status", "resolve-proposal");
  await expect(page.getByText("Menunggu orang kedua").first()).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
});

test("payout status normal scenario shows no waiting-for-second-person marker", async ({
  page,
}) => {
  await open(page, "status");
  await expect(page.getByText("Alya Putri").first()).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
  await expect(page.getByText("Menunggu orang kedua")).toHaveCount(0);
});

test("payout resolve dialog shows the first person's proposal with evidence link and no upload", async ({
  page,
}) => {
  const dialog = await openProposalDialog(page);
  await expect(
    dialog
      .getByTestId("payout-proposal-panel")
      .getByText("Usulan orang pertama"),
  ).toBeVisible();
  await expect(dialog.getByText("Gagal").first()).toBeVisible();
  // Proposer is another user, so it is not labelled as the current user.
  await expect(dialog.getByText("Anda", { exact: true })).toHaveCount(0);
  await expect(
    dialog
      .getByRole("button", { name: "Lihat bukti" })
      .or(dialog.getByRole("link", { name: "Lihat bukti" })),
  ).toBeVisible();
  // The second person reuses the proposal's evidence: nothing to upload.
  await expect(dialog.locator('input[type="file"]')).toHaveCount(0);
  await expect(dialog.getByText("Berkas bukti dari bank")).toHaveCount(0);
});

test("payout resolve dialog opens the proposal evidence in a new tab", async ({
  page,
}) => {
  const dialog = await openProposalDialog(page);
  const evidence = dialog
    .getByRole("button", { name: "Lihat bukti" })
    .or(dialog.getByRole("link", { name: "Lihat bukti" }));
  const popupPromise = page.waitForEvent("popup");
  await evidence.click();
  const popup = await popupPromise;
  expect(popup).toBeTruthy();
  // The dialog stays open and no result was recorded by merely viewing proof.
  await expect(dialog).toBeVisible();
  await expect(page.getByText(/Hasil tercatat/)).toHaveCount(0);
});

test("payout resolve second person confirms the proposal with only their own note", async ({
  page,
}) => {
  const dialog = await openProposalDialog(page);
  await expect(dialog.locator('input[type="file"]')).toHaveCount(0);
  await dialog
    .getByLabel("Catatan", { exact: true })
    .fill("Sudah saya cek, bukti sesuai.");
  await dialog.getByRole("button", { name: "Simpan hasil" }).click();
  await expect(page.getByText(/Hasil tercatat\./).first()).toBeVisible();
  await expect(
    page.getByText(/Slip gaji ini bisa dicairkan ulang/).first(),
  ).toBeVisible();
});

test("payout resolve second person still needs their own note", async ({
  page,
}) => {
  const dialog = await openProposalDialog(page);
  await dialog.getByRole("button", { name: "Simpan hasil" }).click();
  await expect(dialog.getByText("Catatan wajib diisi.")).toBeVisible();
  await expect(page.getByText(/Hasil tercatat/)).toHaveCount(0);
});

test("payout resolve shows a clear message when the server says the evidence differs from the proposal", async ({
  page,
}) => {
  const dialog = await openProposalDialog(page);
  await dialog.getByLabel("Catatan", { exact: true }).fill("Cek ulang bukti.");
  await failNext(page, {
    status: 409,
    code: "PAYOUT_RESOLVE_EVIDENCE_MISMATCH",
    message: "mismatch",
  });
  await dialog.getByRole("button", { name: "Simpan hasil" }).click();
  await expect(
    page.getByText(/Bukti berbeda dari usulan orang pertama/).first(),
  ).toBeVisible();
  // Nothing was recorded.
  await expect(page.getByText(/Hasil tercatat/)).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// legend-uzd4t: the approval confirmation belongs to one batch.
// Bug: moving from batch A to batch B (same PT, same source account) with the
// approval tab still mounted kept the ticked review checkbox and the open
// MFA panel of A on screen for B, so B could be approved with A's confirmation.
//
// ASSUMPTIONS (spec is silent):
// - `?mock=two-pending` adds batch 203 (Rp3.500.000, asked by finance) next to
//   batch 201 (Rp21.500.000). The approve mock logs every call it receives in
//   window.__payoutApproveCalls (batch ids); failNext errors do not reach it.
// - The move is a same-document history step (pushState + popstate, then the
//   browser's back/forward), never a reload: a reload resets state and would
//   hide the bug.
// - After the move the person must tick again: checkbox unticked, no
//   verification panel, approve button disabled, no approve request sent for
//   either batch (the money-limiting rule).
// ---------------------------------------------------------------------------

const TWO_PENDING = {
  a: "00000000-0000-4000-8000-000000000201",
  b: "00000000-0000-4000-8000-000000000203",
} as const;

const approvalUrl = (batch: string) =>
  `${ROUTE}?tab=approval&batch=${batch}&mock=two-pending`;

/** Same-document navigation, as the router's own history steps do. */
async function stepToBatch(page: Page, batch: string) {
  await page.evaluate((url) => {
    window.history.pushState(window.history.state, "", url);
    window.dispatchEvent(
      new PopStateEvent("popstate", { state: window.history.state }),
    );
  }, approvalUrl(batch));
  await expect(page).toHaveURL(new RegExp(`batch=${batch}`));
}

async function approveCalls(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { __payoutApproveCalls?: string[] })
        .__payoutApproveCalls ?? [],
  );
}

/** Loads A, visits B once (so both are cached), then returns to A. */
async function openBatchAWithBCached(page: Page) {
  await page.goto(approvalUrl(TWO_PENDING.a), { waitUntil: "networkidle" });
  await expect(page.getByText(/Rp\s?21\.500\.000/).first()).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
  await stepToBatch(page, TWO_PENDING.b);
  await expect(page.getByText(/Rp\s?3\.500\.000/).first()).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`batch=${TWO_PENDING.a}`));
  await expect(page.getByText(/Rp\s?21\.500\.000/).first()).toBeVisible();
}

test("legend-uzd4t: the ticked check and the MFA panel of batch A do not carry over to batch B", async ({
  page,
}) => {
  await openBatchAWithBCached(page);
  const approve = page.getByRole("button", { name: /Verifikasi & setujui/i });
  await page.getByRole("checkbox").first().check();
  await expect(approve).toBeEnabled();
  await failNext(page, {
    status: 401,
    code: "MFA_REQUIRED",
    message: "Verifikasi MFA diperlukan.",
  });
  await approve.click();
  await expect(page.getByTestId("payout-verify")).toBeVisible();

  // Forward to B, still on the approval tab.
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`batch=${TWO_PENDING.b}`));
  await expect(page.getByText(/Rp\s?3\.500\.000/).first()).toBeVisible();

  await expect(page.getByTestId("payout-verify")).toHaveCount(0);
  await expect(page.getByRole("checkbox").first()).not.toBeChecked();
  await expect(approve).toBeDisabled();
  await expect(page.getByText(/berhasil disetujui/i)).toHaveCount(0);
  expect(await approveCalls(page)).toEqual([]);

  // B can still be approved, but only after its own tick: the button wakes up.
  await page.getByRole("checkbox").first().check();
  await expect(approve).toBeEnabled();
  expect(await approveCalls(page)).toEqual([]);
});

test("legend-uzd4t: a stale batch hash asks for a new check instead of resending the old one", async ({
  page,
}) => {
  await openBatchAWithBCached(page);
  const approve = page.getByRole("button", { name: /Verifikasi & setujui/i });
  await page.getByRole("checkbox").first().check();
  await expect(approve).toBeEnabled();
  await failNext(page, {
    status: 409,
    code: "PAYOUT_HASH_MISMATCH",
    message: "Isi batch berubah. Muat ulang lalu periksa lagi.",
  });
  await approve.click();
  await expect(page.getByText(/Isi pencairan berubah/i).first()).toBeVisible();
  // The old confirmation is gone: unticked, button off, nothing was approved.
  await expect(page.getByRole("checkbox").first()).not.toBeChecked();
  await expect(approve).toBeDisabled();
  await expect(page.getByTestId("payout-verify")).toHaveCount(0);
});

test("legend-uzd4t: a verification still running for batch A approves nothing once the person is on batch B", async ({
  page,
}) => {
  await openBatchAWithBCached(page);
  const approve = page.getByRole("button", { name: /Verifikasi & setujui/i });
  await page.getByRole("checkbox").first().check();
  await failNext(page, {
    status: 401,
    code: "MFA_REQUIRED",
    message: "Verifikasi MFA diperlukan.",
  });
  await approve.click();
  const panel = page.getByTestId("payout-verify");
  await expect(panel).toBeVisible();

  // Slow every answer, send the code of A, and move to B before it returns.
  await page.evaluate(() =>
    (
      window as unknown as {
        __legendMock: { setLatencyMs: (ms: number) => void };
      }
    ).__legendMock.setLatencyMs(500),
  );
  // The panel also holds the password field (step-up by password, legend-caobb):
  // the code of the authenticator app goes in the one-time-code input.
  const code = panel.locator('input[autocomplete="one-time-code"]');
  await code.fill("123456");
  await code.press("Enter");
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`batch=${TWO_PENDING.b}`));
  await expect(page.getByText(/Rp\s?3\.500\.000/).first()).toBeVisible();

  // The slow answer would land well inside this window (verify 500 ms, then an
  // approve request 500 ms). Waiting is the only way to observe "nothing sent".
  await page.waitForTimeout(2500);
  expect(await approveCalls(page)).toEqual([]);
  await expect(page.getByText(/berhasil disetujui/i)).toHaveCount(0);
  await expect(page.getByTestId("approval-done")).toHaveCount(0);
  await expect(approve).toBeDisabled();
});
