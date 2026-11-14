import { expect, test } from "@playwright/test";

// Payment back office (bead legend-sgg, PRD §3 F13) against mock mode:
// gateway routing, EDC terminals and cashier defaults, refunds with approval,
// unallocated funds and settlement reconciliation. Every response is validated
// by the same contract the API will use. Acceptance IDs live in the test names.
//
// Run with `pnpm test:e2e:mock e2e/legend-sgg.mock.spec.ts` (web only,
// VITE_API_MOCK=true, no API or database).

const NAV = { waitUntil: "networkidle" as const };

test("F13 routing: per-tenant default and per-outlet override save without redeploy", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/kelola/pembayaran?mock=normal", NAV);
  await expect(
    page.getByRole("heading", { name: "Routing gateway" }),
  ).toBeVisible();

  // The tenant default routes every online method through DOIT.
  const panel = page.getByRole("tabpanel", { name: "Routing gateway" });
  for (const method of [
    "QRIS",
    "Virtual Account",
    "E-wallet",
    "Kartu",
    "Transfer bank",
    "Paylater",
  ])
    await expect(panel.getByText(method, { exact: true })).toBeVisible();

  // Disabling one method saves just that row.
  const qrisRow = panel.locator("li").filter({ hasText: "QRIS" }).first();
  await qrisRow.getByRole("switch").click();
  await qrisRow.getByRole("button", { name: "Simpan" }).click();
  await expect(page.getByText("Routing QRIS tersimpan.").first()).toBeVisible();

  // An outlet override is scoped and says whether it inherits the tenant row.
  await panel.getByRole("radio", { name: "Outlet tertentu" }).click();
  await expect(panel.getByRole("combobox", { name: "Outlet" })).toBeVisible();
  await expect(panel.getByText("Ikut default tenant").first()).toBeVisible();
  await expect(panel.getByText("Ditimpa outlet").first()).toBeVisible();
  // No fallback is offered before a second gateway is active (PRD Failover).
  await expect(
    panel.getByText(/Gateway cadangan baru bisa dipakai/),
  ).toBeVisible();

  expect(errors).toEqual([]);
});

test("EDC-07 two banks stay active and a new terminal can be registered", async ({
  page,
}) => {
  await page.goto("/kelola/pembayaran?mock=normal", NAV);
  await page.getByRole("tab", { name: "EDC & kasir" }).click();

  // Two banks active side by side in one outlet (EDC-07).
  const bcaRow = page.getByRole("row").filter({ hasText: "BCA" });
  const mandiriRow = page.getByRole("row").filter({ hasText: "Mandiri" });
  const bniRow = page.getByRole("row").filter({ hasText: "BNI" });
  await expect(bcaRow.getByText("Aktif").last()).toBeVisible();
  await expect(mandiriRow.getByText("Aktif").last()).toBeVisible();
  await expect(bniRow.getByText("Nonaktif").last()).toBeVisible();

  // Cashier default tenders are per cashier, not per outlet.
  await expect(page.getByText("Rina Kasir")).toBeVisible();
  await expect(page.getByText("Dodi Kasir")).toBeVisible();
  await expect(page.getByText("Sari Kasir")).toBeVisible();

  await page.getByRole("button", { name: "Tambah terminal" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Terminal ID").fill("TID-9900112");
  await dialog.getByLabel("Merchant ID").fill("MID-7001123");
  await dialog.getByLabel("Model").fill("Ingenico Desk 5000");
  await dialog.getByRole("button", { name: "Simpan terminal" }).click();

  await expect(
    page.getByText("Terminal TID-9900112 ditambahkan.").first(),
  ).toBeVisible();
  await expect(page.getByText("TID-9900112").first()).toBeVisible();
});

test("PAY-04 a refund is requested and approved before processing", async ({
  page,
}) => {
  await page.goto("/kelola/pembayaran?mock=normal", NAV);
  await page.getByRole("tab", { name: "Refund" }).click();
  await page.getByRole("button", { name: "Buat refund" }).click();

  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Pembayaran lunas" }).click();
  await page.getByRole("option", { name: /A03-0412/ }).click();
  // The dialog prefills what is still refundable: the pending 50.000 refund
  // already reserves its share of the 144.375 payment.
  await expect(dialog.getByLabel("Nominal refund")).toHaveValue("94375");
  await dialog
    .getByLabel("Alasan refund")
    .fill("Pesanan dibatalkan setelah pembayaran.");
  await dialog.getByRole("button", { name: "Ajukan refund" }).click();

  await expect(
    page.getByText("Refund diajukan dan menunggu approval.").first(),
  ).toBeVisible();

  // The requester cannot approve their own refund (approver ≠ requester).
  const own = page
    .getByRole("listitem")
    .filter({ hasText: /A03-0412/ })
    .filter({ hasText: "Budi Supervisor" });
  await expect(own.getByText("Menunggu persetujuan")).toBeVisible();
  await own.getByRole("button", { name: "Tinjau" }).click();
  const ownReview = page.getByRole("dialog");
  await expect(ownReview.getByText("Budi Supervisor")).toBeVisible();
  await expect(
    ownReview.getByRole("button", { name: "Setujui refund" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(ownReview).toBeHidden();

  // A cashier's pending refund is approved by the supervisor for processing.
  const pending = page
    .getByRole("listitem")
    .filter({ hasText: /A03-0412/ })
    .filter({ hasText: "Rina Kasir" });
  await pending.getByRole("button", { name: "Tinjau" }).click();
  const pendingReview = page.getByRole("dialog");
  await expect(pendingReview.getByText("Rina Kasir")).toBeVisible();
  await pendingReview.getByRole("button", { name: "Setujui refund" }).click();
  const approveDialog = page.getByRole("dialog");
  await approveDialog
    .getByLabel("Catatan approval")
    .fill("Cek pesanan selesai.");
  await approveDialog.getByRole("button", { name: "Setujui" }).click();
  await expect(
    page.getByText(/Refund A03-0412 disetujui/).first(),
  ).toBeVisible();
  await expect(pending.getByText("Disetujui, diproses")).toBeVisible();
  await pending.getByRole("button", { name: "Tinjau" }).click();
  await expect(
    page.getByRole("dialog").getByText("Menunggu penyedia"),
  ).toBeVisible();
});

test("PAY-04 an overpayment is closed by a guest credit with an approval note", async ({
  page,
}) => {
  await page.goto("/kelola/pembayaran?mock=normal", NAV);
  await page.getByRole("tab", { name: "Dana belum teralokasi" }).click();

  // A double payment shows the received money, the bill and the excess.
  await expect(page.getByText("A05-0421")).toBeVisible();
  await expect(page.getByText("Rp 144.375").first()).toBeVisible();

  await page.getByRole("button", { name: "Selesaikan" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: "Kredit untuk tamu" }).click();
  await dialog
    .getByLabel("Catatan approval")
    .fill("Kredit dicatat untuk kunjungan berikutnya.");
  await dialog.getByRole("button", { name: "Simpan penyelesaian" }).click();

  await expect(
    page.getByText("Dana Rp 144.375 diselesaikan.").first(),
  ).toBeVisible();
  await expect(page.getByText("Selesai").first()).toBeVisible();
});

test("EDC-06 every settlement difference becomes a reconciliation case", async ({
  page,
}) => {
  await page.goto("/kelola/pembayaran?mock=normal", NAV);
  await page.getByRole("tab", { name: "Rekonsiliasi" }).click();

  // Automatic matching summary plus one case per difference (gateway + EDC).
  await expect(page.getByText("Baris cocok")).toBeVisible();
  await expect(page.getByText("128")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Kasus selisih" }),
  ).toBeVisible();
  await expect(page.getByText("EDC · BCA")).toBeVisible();
  await expect(page.getByText("EDC · Mandiri")).toBeVisible();
  await expect(page.getByText("Gateway").first()).toBeVisible();

  const openCase = page
    .getByRole("listitem")
    .filter({ hasText: "BCA batch 2026-11-01 / TID-8841201" })
    .first();
  await openCase.getByRole("button", { name: "Tutup kasus" }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Catatan penyelesaian")
    .fill("Konfirmasi ke bank: MDR dikoreksi pada batch besok.");
  await dialog.getByRole("button", { name: "Tutup kasus" }).click();

  await expect(
    page
      .getByText(
        /Penutupan kasus BCA batch 2026-11-01 \/ TID-8841201 diajukan, menunggu persetujuan\./,
      )
      .first(),
  ).toBeVisible();
  // Closing needs another person's approval: the case is not resolved yet.
  await expect(openCase.getByText("Menunggu persetujuan")).toBeVisible();
});

test("F13 payment admin screens have empty and error states", async ({
  page,
}) => {
  await page.goto("/kelola/pembayaran?mock=empty", NAV);
  await page.getByRole("tab", { name: "Refund" }).click();
  await expect(page.getByText("Belum ada refund")).toBeVisible();
  await page.getByRole("tab", { name: "Dana belum teralokasi" }).click();
  await expect(page.getByText("Tidak ada dana belum teralokasi")).toBeVisible();
  await page.getByRole("tab", { name: "Rekonsiliasi" }).click();
  await expect(page.getByText("Tidak ada kasus rekonsiliasi")).toBeVisible();

  await page.goto("/kelola/pembayaran?mock=error", NAV);
  await expect(
    page.getByText("Data pembayaran tidak dapat dimuat").first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Coba lagi" }).first(),
  ).toBeVisible();

  // Offline: the same honest error state, with a retry once the network is back.
  await page.goto("/kelola/pembayaran?mock=offline", NAV);
  await expect(
    page.getByText("Data pembayaran tidak dapat dimuat").first(),
  ).toBeVisible();
});
