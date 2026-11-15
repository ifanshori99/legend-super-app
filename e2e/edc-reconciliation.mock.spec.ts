// EDC reconciliation screen (bead legend-khi8n; brief docs/briefs/sub-865-edc-recon-ui.md,
// mockup design/mockups/payments/edc-reconciliation). Mock-mode spec:
// `pnpm test:e2e:mock e2e/edc-reconciliation.mock.spec.ts`.
//
// Copy and fixtures follow the final catalogs (messages/edc-recon-queue.ts and
// edc-recon-resolve.ts) and the mock queue in
// apps/web/src/features/edc-reconciliation/mock.ts.
//
// ASSUMPTIONS:
// - Route /kelola/pembayaran/edc-rekonsiliasi, URL state: tx, outletId, status, q.
// - The `normal` mock queue holds five rows (Cafe Legend sample data), oldest first:
//   EDC-1048 unknown 42 min (Senopati, Dimas, Rp425.000, bill INV-1511-084),
//   EDC-1052 approved + flagged (Kemang, Rani, Rp280.000),
//   EDC-1057 declined + flagged (Senopati, Sari, Rp175.000),
//   EDC-1063 unknown dispatched 4 min ago: "Belum bisa diperiksa" (too early),
//   EDC-1061 unknown with the terminal call still open: "Menunggu terminal".
// - A row is opened with its "Periksa transaksi <id>" button. On desktop the detail
//   renders under the table; below 768 px it replaces the list ("Kembali ke daftar").
// - The outcome that the status allows is pre-selected when it is the only one; the
//   other outcome stays visible but disabled with an explanation.
// - The evidence source defaults to "Struk terminal"; nothing else is prefilled.
// - A successful resolve keeps a success dialog ("Selesai") open; closing it clears
//   the selection, the row leaves the queue and focus goes to the page title.
// - The mock resolve needs no MFA step-up unless the next call is forced to fail
//   with MFA_REQUIRED.
import { expect, test, type Page } from "@playwright/test";
import { waitForHydration } from "./hydration";

const base = process.env.LEGEND_MOCK_WEB_URL;
test.skip(
  !base,
  "Set LEGEND_MOCK_WEB_URL (pnpm test:e2e:mock) to a web server running VITE_API_MOCK.",
);

const COLD_START_TIMEOUT_MS = 30_000;
test.describe.configure({ timeout: 90_000 });

const ROUTE = "/kelola/pembayaran/edc-rekonsiliasi";

async function open(page: Page, scenario = "normal", query = "") {
  const sep = query ? `${query}&` : "";
  await page.goto(`${ROUTE}?${sep}mock=${scenario}`, {
    waitUntil: "domcontentloaded",
  });
  await waitForHydration(page);
}

/** The visible table row (desktop) or card (mobile) of one transaction. */
const rowOf = (page: Page, id: string) =>
  page
    .locator("tr, li")
    .filter({ hasText: id })
    .filter({ visible: true })
    .first();

const inspectButton = (page: Page, id: string) =>
  page.getByRole("button", { name: `Periksa transaksi ${id}` });

async function inspect(page: Page, id: string) {
  const button = inspectButton(page, id);
  await expect(button).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await button.click();
  await expect(page.getByRole("heading", { name: id, level: 3 })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Ringkasan & bukti" }),
  ).toBeVisible();
}

const note = (page: Page) => page.getByLabel(/Catatan pemeriksaan/);
const amount = (page: Page) => page.getByLabel(/Nominal pada bukti/);
const review = (page: Page) =>
  page.getByRole("button", { name: "Tinjau penyelesaian" });
const locked = (page: Page) =>
  page.getByRole("button", { name: "Penyelesaian terkunci" });
const receipt = (page: Page) =>
  page.getByRole("region", { name: "Struk terminal" });
const dialogOf = (page: Page) =>
  page.getByRole("dialog", { name: "Konfirmasi rekonsiliasi" });
const radio = (page: Page, outcome: "Approved" | "Declined") =>
  page.getByRole("radio", { name: new RegExp(outcome) });

const SAVED_NOTE = "Struk terminal cocok: trace 004821, kode 082416.";

/** Picks the evidence source from the custom select. */
async function pickSource(page: Page, label: string) {
  await page.getByRole("combobox", { name: /Sumber bukti/ }).click();
  await page.getByRole("option", { name: label }).click();
}

/** Fills a valid approved resolution for the unknown EDC-1048 (Rp425.000). */
async function fillApproved(page: Page) {
  await radio(page, "Approved").check();
  await pickSource(page, "Struk terminal");
  await amount(page).fill("425000");
  await note(page).fill(SAVED_NOTE);
}

/** Opens the review dialog with the confirmation box still unchecked. */
async function openDialog(page: Page) {
  await inspect(page, "EDC-1048");
  await fillApproved(page);
  await review(page).click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

const confirmBox = (page: Page) =>
  dialogOf(page).getByRole("checkbox", {
    name: /Saya telah memeriksa bukti/,
  });

async function failNext(
  page: Page,
  failure: { status: number; code: string; message: string },
) {
  await page.evaluate(
    (value) =>
      (
        window as unknown as {
          __legendMock: { failNext: (path: string, f: object) => void };
        }
      ).__legendMock.failNext("*", value),
    failure,
  );
}

test("edc-reconciliation lists every flagged transaction with outlet, cashier, amount, status and age", async ({
  page,
}) => {
  await open(page);
  await expect(
    page.getByRole("heading", { name: "Rekonsiliasi EDC", level: 2 }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await expect(
    page.getByRole("heading", { name: "Transaksi ditandai" }),
  ).toBeVisible();
  await expect(
    page.getByText("5 transaksi · Terlama lebih dulu"),
  ).toBeVisible();
  const table = page.getByRole("table", { name: "Transaksi EDC ditandai" });
  // Header row, then the oldest sale first.
  await expect(table.getByRole("row")).toHaveCount(6);
  await expect(table.getByRole("row")).toContainText([
    /Transaksi \/ outlet/,
    "EDC-1048",
    "EDC-1052",
    "EDC-1057",
    "EDC-1063",
    "EDC-1061",
  ]);
  const first = rowOf(page, "EDC-1048");
  await expect(first).toContainText("Cafe Legend Senopati");
  await expect(first).toContainText("Dimas");
  await expect(first).toContainText(/Rp\s?425\.000/);
  await expect(first).toContainText("Unknown");
  await expect(first).toContainText(/4[1-5] menit/);
  await expect(rowOf(page, "EDC-1052")).toContainText("Approved");
  await expect(rowOf(page, "EDC-1052")).toContainText("Cafe Legend Kemang");
  await expect(rowOf(page, "EDC-1057")).toContainText("Declined");
  // Mock mode says the data is a sample.
  await expect(page.getByText("Contoh data", { exact: true })).toBeVisible();
});

test("edc-reconciliation marks a sale whose terminal call is still open as waiting", async ({
  page,
}) => {
  await open(page);
  await expect(rowOf(page, "EDC-1061")).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
  await expect(rowOf(page, "EDC-1061")).toContainText("Menunggu terminal");
  // Still listed, and still shows the amount.
  await expect(rowOf(page, "EDC-1061")).toContainText(/Rp\s?320\.000/);
});

test("edc-reconciliation tells a too-early unknown sale when it can be checked", async ({
  page,
}) => {
  await open(page);
  await expect(rowOf(page, "EDC-1063")).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
  await expect(rowOf(page, "EDC-1063")).toContainText("Belum bisa diperiksa");
  await expect(rowOf(page, "EDC-1063")).toContainText(
    /Bisa diperiksa pukul \d{2}\.\d{2}/,
  );
});

test("edc-reconciliation empty state explains and offers a reload", async ({
  page,
}) => {
  await open(page, "empty");
  await expect(page.getByText("Tidak ada transaksi yang ditandai")).toBeVisible(
    {
      timeout: COLD_START_TIMEOUT_MS,
    },
  );
  await expect(
    page.getByText(/Transaksi yang memerlukan pemeriksaan akan muncul di sini/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Muat ulang daftar" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Periksa transaksi/ }),
  ).toHaveCount(0);
});

test("edc-reconciliation error state offers a retry and shows no amounts", async ({
  page,
}) => {
  await open(page, "error");
  await expect(page.getByText("Daftar belum dapat dimuat")).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
  await expect(
    page.getByText(/Status pembayaran belum dapat dipastikan dari layar ini/),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();
  await expect(page.getByText(/Rp\s?\d/)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Periksa transaksi/ }),
  ).toHaveCount(0);
});

test("edc-reconciliation detail of an unknown sale shows evidence and both outcomes", async ({
  page,
}) => {
  await open(page);
  await inspect(page, "EDC-1048");
  await expect(page).toHaveURL(/tx=/);
  await expect(
    page.getByText("Cafe Legend Senopati · Kasir Dimas").first(),
  ).toBeVisible();
  await expect(page.getByText("Hasil terminal belum diketahui")).toBeVisible();

  // Summary: the amount asked of the terminal, the open bill, the terminal.
  const summary = page.getByRole("region", { name: "Ringkasan & bukti" });
  await expect(summary).toContainText("Nominal permintaan");
  await expect(summary).toContainText(/Rp\s?425\.000/);
  await expect(summary).toContainText("Sisa tagihan");
  await expect(summary).toContainText("INV-1511-084");
  await expect(summary).toContainText("EDC-SNP-02 · BCA");

  // The receipt is built from the request: the amount row says "requested" and
  // the system status is not presented as a printed result.
  await expect(receipt(page)).toBeVisible();
  await expect(receipt(page)).toContainText("Nominal permintaan");
  await expect(receipt(page)).toContainText("Status sistem");
  await expect(receipt(page)).toContainText("Unknown");
  await expect(receipt(page)).toContainText(
    "Status sistem masih unknown; cocokkan nominal dan trace sebelum menentukan hasil.",
  );
  await expect(page.getByText("Hasil pada struk")).toHaveCount(0);

  // Terminal trace is collapsed until opened.
  await page.getByText("Lihat jejak terminal").click();
  await expect(page.getByText("Jumlah penelusuran")).toBeVisible();

  // Unknown is not proof of a decline: both outcomes are open.
  await expect(radio(page, "Approved")).toBeEnabled();
  await expect(radio(page, "Declined")).toBeEnabled();
  await expect(
    page.getByRole("combobox", { name: /Sumber bukti/ }),
  ).toBeEnabled();
  await expect(note(page)).toBeEnabled();
  await expect(review(page)).toBeEnabled();
});

test("edc-reconciliation an approved sale can only be settled approved", async ({
  page,
}) => {
  await open(page);
  await inspect(page, "EDC-1052");
  await expect(page.getByText("Terminal menyatakan approved")).toBeVisible();
  await expect(receipt(page)).toContainText("A48213");
  await expect(receipt(page)).toContainText("318200041052");
  await expect(receipt(page)).toContainText("Approved");
  await expect(radio(page, "Approved")).toBeChecked();
  await expect(radio(page, "Declined")).toBeDisabled();
  await expect(
    page.getByText(
      "Declined · Ditolak tidak dapat ditetapkan untuk transaksi ini.",
    ),
  ).toBeVisible();
  // The evidence amount is still asked for an approved sale.
  await expect(amount(page)).toBeVisible();
});

test("edc-reconciliation a declined sale can only be settled declined", async ({
  page,
}) => {
  await open(page);
  await inspect(page, "EDC-1057");
  await expect(page.getByText("Terminal menyatakan declined")).toBeVisible();
  await expect(radio(page, "Declined")).toBeChecked();
  await expect(radio(page, "Approved")).toBeDisabled();
  await expect(
    page.getByText(
      "Approved · Disetujui tidak dapat ditetapkan untuk transaksi ini.",
    ),
  ).toBeVisible();
  // No evidence amount for a decline.
  await expect(amount(page)).toHaveCount(0);
  // The terminal's own refusal is in the trace.
  await page.getByText("Lihat jejak terminal").click();
  await expect(page.getByText("Ditolak bank penerbit")).toBeVisible();
});

test("edc-reconciliation locks the form while the terminal is still processing", async ({
  page,
}) => {
  await open(page);
  await inspect(page, "EDC-1061");
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Terminal masih memproses transaksi ini" }),
  ).toBeVisible();
  await expect(page.getByText("Respons terminal belum diterima")).toBeVisible();
  // No receipt to read while the terminal works, and evidence cannot unlock it.
  await expect(receipt(page)).toHaveCount(0);
  await expect(
    page.getByText(/Struk belum tersedia selama terminal memproses/),
  ).toBeVisible();
  await expect(radio(page, "Approved")).toBeDisabled();
  await expect(radio(page, "Declined")).toBeDisabled();
  await expect(note(page)).toBeDisabled();
  await expect(locked(page)).toBeDisabled();
  await expect(review(page)).toHaveCount(0);
});

test("edc-reconciliation locks a too-early unknown sale and says when it opens", async ({
  page,
}) => {
  await open(page);
  await inspect(page, "EDC-1063");
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: /Bisa diperiksa pukul \d{2}\.\d{2} WIB/ }),
  ).toBeVisible();
  await expect(
    page.getByText(
      /Penyelesaian dikunci sampai 10 menit setelah permintaan dikirim/,
    ),
  ).toBeVisible();
  await expect(note(page)).toBeDisabled();
  await expect(locked(page)).toBeDisabled();
});

test("edc-reconciliation requires a note before the review step", async ({
  page,
}) => {
  await open(page);
  await inspect(page, "EDC-1048");
  await radio(page, "Declined").check();
  await review(page).click();
  await expect(note(page)).toHaveAttribute("aria-invalid", "true");
  await expect(
    page.getByText("Catatan pemeriksaan wajib diisi."),
  ).toBeVisible();
  await expect(
    page.getByText("Periksa isian yang ditandai sebelum melanjutkan."),
  ).toBeVisible();
  // The first invalid field takes focus.
  await expect(note(page)).toBeFocused();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("edc-reconciliation asks for the printed amount when approving", async ({
  page,
}) => {
  await open(page);
  await inspect(page, "EDC-1048");
  await radio(page, "Approved").check();
  await amount(page).focus();
  await amount(page).blur();
  await expect(amount(page)).toHaveAttribute("aria-invalid", "true");
  await expect(
    page.getByText("Isi nominal yang tercetak pada bukti."),
  ).toBeVisible();
});

test("edc-reconciliation refuses an evidence amount that differs from the request without revealing the expected figure", async ({
  page,
}) => {
  await open(page);
  await inspect(page, "EDC-1048");
  await fillApproved(page);
  await amount(page).fill("400000");
  await amount(page).blur();
  await expect(amount(page)).toHaveAttribute("aria-invalid", "true");
  const message = page.getByText(
    "Nominal tidak sama dengan nominal permintaan. Periksa kembali angka pada bukti.",
  );
  await expect(message).toBeVisible();
  // Neutral copy: it does not print the amount to type.
  await expect(message).not.toContainText(/\d/);
  await review(page).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("edc-reconciliation refuses a card number in the note", async ({
  page,
}) => {
  await open(page);
  await inspect(page, "EDC-1048");
  await fillApproved(page);
  await note(page).fill("Kartu 4111111111111111 terpotong.");
  await note(page).blur();
  await expect(note(page)).toHaveAttribute("aria-invalid", "true");
  await expect(
    page.getByText("Catatan tidak boleh memuat nomor kartu."),
  ).toBeVisible();
});

test("edc-reconciliation confirm dialog warns it does not settle the bill and needs a checkbox", async ({
  page,
}) => {
  await open(page);
  const dialog = await openDialog(page);
  const summary = dialog.getByRole("region", {
    name: "Ringkasan penyelesaian",
  });
  await expect(summary).toContainText("EDC-1048 · Cafe Legend Senopati");
  await expect(summary).toContainText(/Rp\s?425\.000/);
  await expect(summary).toContainText("INV-1511-084");
  await expect(summary).toContainText("Hasil: Approved · Disetujui");
  await expect(summary).toContainText("Bukti: Struk terminal · Trace 004821");
  await expect(summary).toContainText(/Nominal pada bukti:\s*Rp\s?425\.000/);
  await expect(
    dialog.getByText(
      "Keputusan rekonsiliasi tidak langsung melunasi tagihan. Pencatatan pembayaran mengikuti proses kasir.",
    ),
  ).toBeVisible();
  const confirm = dialog.getByRole("button", { name: "Selesaikan approved" });
  await expect(confirm).toBeDisabled();
  await confirmBox(page).check();
  await expect(confirm).toBeEnabled();
  // Going back keeps what the user typed.
  await dialog.getByRole("button", { name: "Kembali periksa" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(note(page)).toHaveValue(SAVED_NOTE);
  await expect(amount(page)).toHaveValue("425000");
});

test("edc-reconciliation settling a sale confirms it and removes it from the queue", async ({
  page,
}) => {
  await open(page);
  const dialog = await openDialog(page);
  await confirmBox(page).check();
  await dialog.getByRole("button", { name: "Selesaikan approved" }).click();
  const success = dialog.getByRole("status");
  await expect(success).toContainText("Rekonsiliasi diselesaikan · EDC-1048", {
    timeout: COLD_START_TIMEOUT_MS,
  });
  await expect(success).toContainText("tagihan belum otomatis lunas");
  await dialog.getByRole("button", { name: "Selesai" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(rowOf(page, "EDC-1048")).toHaveCount(0);
  await expect(rowOf(page, "EDC-1052")).toBeVisible();
  await expect(
    page.getByText("4 transaksi · Terlama lebih dulu"),
  ).toBeVisible();
  await expect(page).not.toHaveURL(/tx=/);
  await expect(
    page.getByRole("heading", { name: /^EDC-1048$/, level: 3 }),
  ).toHaveCount(0);
  // Focus lands on the page title, not on a removed control.
  await expect(
    page.getByRole("heading", { name: "Rekonsiliasi EDC", level: 2 }),
  ).toBeFocused();
});

test("edc-reconciliation settles a declined sale", async ({ page }) => {
  await open(page);
  await inspect(page, "EDC-1057");
  await pickSource(page, "Struk terminal");
  await note(page).fill(
    "Struk terminal menunjukkan declined, tidak ada debit.",
  );
  await review(page).click();
  const dialog = dialogOf(page);
  await expect(dialog.getByText("Hasil: Declined · Ditolak")).toBeVisible();
  await expect(dialog.getByText(/Nominal pada bukti/)).toHaveCount(0);
  await confirmBox(page).check();
  await dialog.getByRole("button", { name: "Selesaikan declined" }).click();
  await expect(dialog.getByRole("status")).toContainText(
    "Rekonsiliasi diselesaikan · EDC-1057",
    { timeout: COLD_START_TIMEOUT_MS },
  );
  await dialog.getByRole("button", { name: "Selesai" }).click();
  await expect(rowOf(page, "EDC-1057")).toHaveCount(0);
});

// Post-resolve banner (queue-page.tsx, catalog `resolvedBanner`: "<ID> diselesaikan:
// <Approved|Declined>"). ASSUMPTION: it is a role=status line above the list with a
// close button labelled "Tutup" (common.close); it appears once the success dialog
// is closed and the row has left the queue.
const banner = (page: Page, text: string) =>
  page.getByRole("status").filter({ hasText: text });

/** Settles EDC-1048 as approved and closes the success dialog. */
async function settleApproved(page: Page) {
  const dialog = await openDialog(page);
  await confirmBox(page).check();
  await dialog.getByRole("button", { name: "Selesaikan approved" }).click();
  await expect(dialog.getByRole("status")).toContainText(
    "Rekonsiliasi diselesaikan · EDC-1048",
    { timeout: COLD_START_TIMEOUT_MS },
  );
  await dialog.getByRole("button", { name: "Selesai" }).click();
  await expect(dialog).toHaveCount(0);
}

test("edc-reconciliation shows a banner naming the sale and the approved outcome after settling", async ({
  page,
}) => {
  await open(page);
  await expect(banner(page, "diselesaikan")).toHaveCount(0);
  await settleApproved(page);
  await expect(banner(page, "EDC-1048 diselesaikan: Approved")).toBeVisible();
  await expect(rowOf(page, "EDC-1048")).toHaveCount(0);
});

test("edc-reconciliation shows a banner naming the declined outcome after settling a decline", async ({
  page,
}) => {
  await open(page);
  await inspect(page, "EDC-1057");
  await pickSource(page, "Struk terminal");
  await note(page).fill(
    "Struk terminal menunjukkan declined, tidak ada debit.",
  );
  await review(page).click();
  const dialog = dialogOf(page);
  await confirmBox(page).check();
  await dialog.getByRole("button", { name: "Selesaikan declined" }).click();
  await expect(dialog.getByRole("status")).toContainText(
    "Rekonsiliasi diselesaikan · EDC-1057",
    { timeout: COLD_START_TIMEOUT_MS },
  );
  await dialog.getByRole("button", { name: "Selesai" }).click();
  await expect(banner(page, "EDC-1057 diselesaikan: Declined")).toBeVisible();
});

test("edc-reconciliation banner can be dismissed", async ({ page }) => {
  await open(page);
  await settleApproved(page);
  const line = banner(page, "EDC-1048 diselesaikan: Approved");
  await expect(line).toBeVisible();
  await line.getByRole("button", { name: "Tutup" }).click();
  await expect(line).toHaveCount(0);
  // Dismissing the banner does not bring the settled sale back.
  await expect(rowOf(page, "EDC-1048")).toHaveCount(0);
  await expect(rowOf(page, "EDC-1052")).toBeVisible();
});

test("edc-reconciliation banner clears when another sale is selected", async ({
  page,
}) => {
  await open(page);
  await settleApproved(page);
  await expect(banner(page, "EDC-1048 diselesaikan: Approved")).toBeVisible();
  await inspect(page, "EDC-1052");
  await expect(banner(page, "diselesaikan:")).toHaveCount(0);
});

test("edc-reconciliation shows a server refusal in the dialog, keeps the form and offers a reload", async ({
  page,
}) => {
  await open(page);
  const dialog = await openDialog(page);
  await confirmBox(page).check();
  await failNext(page, {
    status: 409,
    code: "CONFLICT",
    message: "Terminal masih memproses transaksi ini.",
  });
  await dialog.getByRole("button", { name: "Selesaikan approved" }).click();
  await expect(
    dialog
      .getByRole("alert")
      .filter({ hasText: "Transaksi tidak dapat diselesaikan sekarang" }),
  ).toContainText("Terminal masih memproses transaksi ini.", {
    timeout: COLD_START_TIMEOUT_MS,
  });
  // The queue may have moved on: the dialog offers to reload it.
  await expect(
    dialog.getByRole("button", { name: "Muat ulang daftar" }),
  ).toBeVisible();
  // Nothing was lost and the row is still queued.
  await dialog.getByRole("button", { name: "Kembali periksa" }).click();
  await expect(note(page)).toHaveValue(SAVED_NOTE);
  await expect(rowOf(page, "EDC-1048")).toBeVisible();
});

test("edc-reconciliation explains an amount refusal from the server in neutral words", async ({
  page,
}) => {
  await open(page);
  const dialog = await openDialog(page);
  await confirmBox(page).check();
  // The API answers this refusal as a plain CONFLICT with this sentence.
  await failNext(page, {
    status: 409,
    code: "CONFLICT",
    message: "Nominal di terminal EDC tidak sama dengan tagihan.",
  });
  await dialog.getByRole("button", { name: "Selesaikan approved" }).click();
  const alert = dialog.getByRole("alert");
  await expect(alert).toHaveText(
    "Nominal tidak sama dengan permintaan atau tagihan sudah berubah. Periksa ulang bukti dan status tagihan.",
    { timeout: COLD_START_TIMEOUT_MS },
  );
  await expect(alert).not.toContainText(/\d/);
  // Reloading the list closes the dialog; the typed values stay in the form.
  await dialog.getByRole("button", { name: "Muat ulang daftar" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(note(page)).toHaveValue(SAVED_NOTE);
  await expect(rowOf(page, "EDC-1048")).toBeVisible();
});

test("edc-reconciliation shows a generic message for an unexpected failure", async ({
  page,
}) => {
  await open(page);
  const dialog = await openDialog(page);
  await confirmBox(page).check();
  await failNext(page, {
    status: 500,
    code: "INTERNAL_ERROR",
    message: "Terjadi kesalahan.",
  });
  await dialog.getByRole("button", { name: "Selesaikan approved" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Penyelesaian belum berhasil disimpan. Periksa isian, lalu coba lagi.",
    { timeout: COLD_START_TIMEOUT_MS },
  );
  // Nothing was settled and the user can try again.
  await expect(
    dialog.getByRole("button", { name: "Selesaikan approved" }),
  ).toBeEnabled();
});

test("edc-reconciliation asks for a second factor in its own words when the server requires MFA", async ({
  page,
}) => {
  await open(page);
  const dialog = await openDialog(page);
  await confirmBox(page).check();
  await failNext(page, {
    status: 403,
    code: "MFA_REQUIRED",
    message: "Verifikasi dua langkah diperlukan.",
  });
  await dialog.getByRole("button", { name: "Selesaikan approved" }).click();
  await expect(dialog.getByText("Verifikasi identitas")).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
  await expect(
    dialog.getByText(
      "Penyelesaian rekonsiliasi meminta kode dari aplikasi autentikator Anda sebelum disimpan.",
    ),
  ).toBeVisible();
  // Not the payout wording of the shared step-up panel.
  await expect(dialog).not.toContainText(/pencairan/i);
  // While the step-up is open the plain confirm button is not offered.
  await expect(
    dialog.getByRole("button", { name: "Selesaikan approved" }),
  ).toHaveCount(0);
});

test("edc-reconciliation filters the queue by search text", async ({
  page,
}) => {
  await open(page);
  const search = page.getByRole("searchbox", {
    name: "Cari transaksi atau kasir",
  });
  await expect(search).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await search.fill("EDC-1052");
  await expect(page).toHaveURL(/q=EDC-1052/);
  await expect(rowOf(page, "EDC-1052")).toBeVisible();
  await expect(rowOf(page, "EDC-1048")).toHaveCount(0);
  // A search that finds nothing shows the empty state.
  await search.fill("zzz-tidak-ada");
  await expect(
    page.getByText("Tidak ada transaksi yang ditandai"),
  ).toBeVisible();
});

test("edc-reconciliation filters the queue by terminal status", async ({
  page,
}) => {
  await open(page);
  await expect(rowOf(page, "EDC-1048")).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
  await page.getByRole("combobox", { name: "Status terminal" }).click();
  await page.getByRole("option", { name: "Approved" }).click();
  await expect(page).toHaveURL(/status=approved/);
  await expect(rowOf(page, "EDC-1052")).toBeVisible();
  await expect(rowOf(page, "EDC-1048")).toHaveCount(0);
  await expect(rowOf(page, "EDC-1057")).toHaveCount(0);
});

test.describe("at 390px", () => {
  test.use({ viewport: { width: 390, height: 900 } });

  const overflow = (page: Page) =>
    page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );

  test("edc-reconciliation list has no horizontal scroll and labels each card", async ({
    page,
  }) => {
    await open(page);
    await expect(rowOf(page, "EDC-1048")).toBeVisible({
      timeout: COLD_START_TIMEOUT_MS,
    });
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    const card = rowOf(page, "EDC-1048");
    await expect(card).toContainText("Cafe Legend Senopati");
    await expect(card).toContainText("Nominal");
    await expect(card).toContainText("Kasir");
    await expect(card).toContainText("Jam (WIB)");
    await expect(card).toContainText("Umur");
    await expect(card).toContainText("Unknown");
    await expect(rowOf(page, "EDC-1061")).toContainText("Menunggu terminal");
    await expect(rowOf(page, "EDC-1063")).toContainText("Belum bisa diperiksa");
  });

  test("edc-reconciliation detail replaces the list and Kembali ke daftar returns", async ({
    page,
  }) => {
    await open(page);
    await inspect(page, "EDC-1048");
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await expect(rowOf(page, "EDC-1052")).toHaveCount(0);
    await page.getByRole("button", { name: "Kembali ke daftar" }).click();
    await expect(rowOf(page, "EDC-1052")).toBeVisible();
    await expect(page).not.toHaveURL(/tx=/);
  });

  test("edc-reconciliation confirm dialog fits the screen", async ({
    page,
  }) => {
    await open(page);
    await openDialog(page);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    const box = await dialogOf(page).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  });
});

test.describe("at 320px", () => {
  test.use({ viewport: { width: 320, height: 700 } });

  // Cards (status pills included) stay inside the screen, also for the
  // longest status labels.
  test("edc-reconciliation status pills do not overflow the cards", async ({
    page,
  }) => {
    await open(page);
    await expect(rowOf(page, "EDC-1061")).toBeVisible({
      timeout: COLD_START_TIMEOUT_MS,
    });
    for (const id of ["EDC-1048", "EDC-1061", "EDC-1063"]) {
      const fits = await rowOf(page, id).evaluate((el) => {
        const right = el.getBoundingClientRect().right;
        return (
          el.scrollWidth <= el.clientWidth + 1 && right <= window.innerWidth
        );
      });
      expect(fits, `${id} card fits 320px`).toBe(true);
    }
  });
});
