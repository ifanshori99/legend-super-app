// Reservation desk (bead legend-oye8) against mock mode: the schedule, table
// assignment on the floor plan, seating with the DP, cancellation under the
// frozen policy, the waitlist call and the event packages. Acceptance IDs live
// in the test names (PRD v1.7 RSV-01..RSV-03, §3.22 "Reservasi & Event").
import { expect, test } from "@playwright/test";

const DESK = "/pos/reservasi";

// The mock server's fixtures are dated around 1 Nov 2026 and the desk filters
// "upcoming" by the browser's today, so the clock is pinned to the fixture day
// (pattern: legend-nv3y). Without it these specs fail once the real date moves.
const FIXTURE_NOW = new Date("2026-11-01T12:10:00.000+07:00");

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXTURE_NOW);
});

test("RSV-01 the desk lists upcoming reservations grouped by day", async ({
  page,
}) => {
  await page.goto(DESK);

  await expect(
    page.getByRole("heading", { level: 1, name: "Reservasi" }),
  ).toBeVisible();
  // Fixtures: two bookings on 7 Nov and a cancelled one on 8 Nov, both ahead
  // of the fixture "today" (1 Nov).
  await expect(page.getByText("Dewi Lestari")).toBeVisible();
  await expect(page.getByText("Rangga Pratama")).toBeVisible();
  await expect(page.getByText("Intan Permata")).toBeVisible();
  // Grouped by business day, with the real counts.
  await expect(
    page.getByText(/Sabtu, 7 November 2026 \(2 reservasi\)/),
  ).toBeVisible();
  await expect(
    page.getByText(/Minggu, 8 November 2026 \(1 reservasi\)/),
  ).toBeVisible();
  await expect(page.getByRole("tab", { name: "Jadwal" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // A business-date filter narrows the day; 1 Nov holds the seated and closed
  // fixtures.
  await page.goto(`${DESK}?date=2026-11-01`);
  await expect(page.getByText("Sari Wulandari")).toBeVisible();
  await expect(page.getByText("Bayu Anggara")).toBeVisible();
  await expect(page.getByText("Dewi Lestari")).toHaveCount(0);
});

test("RSV-01 a conflicting table is highlighted and locked, a free one can be saved", async ({
  page,
}) => {
  await page.goto(`${DESK}?date=2026-11-07`);
  await page
    .getByRole("button", { name: "Buka reservasi Dewi Lestari" })
    .click();

  await expect(
    page.getByRole("dialog").getByRole("heading", { name: "Dewi Lestari" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Atur meja" }).click();

  const picker = page.getByRole("dialog").filter({ hasText: "Atur meja" });
  await expect(picker.getByText("Bentrok", { exact: true })).toBeVisible();
  // P1 is held by Rangga's private-room dinner in the same slot.
  await expect(
    picker.getByRole("button", { name: /Meja P1, 10 kursi, bentrok/ }),
  ).toBeDisabled();
  await expect(
    picker.getByRole("button", { name: /Meja A01, 2 kursi, tersedia/ }),
  ).toBeEnabled();

  await picker.getByRole("button", { name: /Meja A01, 2 kursi/ }).click();
  await expect(picker.getByText("1 meja dipilih")).toBeVisible();
  await picker.getByRole("button", { name: "Simpan meja" }).click();

  await expect(
    page.getByText("Meja reservasi diperbarui.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog").getByText("A01").first()).toBeVisible();
});

test("RSV-02 seating a confirmed guest opens the table session", async ({
  page,
}) => {
  await page.goto(
    `${DESK}?date=2026-11-07&reservationId=00000000-0000-4000-8000-000000005002`,
  );

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Rangga Pratama")).toBeVisible();
  await expect(dialog.getByText("DP lunas")).toBeVisible();
  await dialog.getByRole("button", { name: "Dudukkan tamu" }).click();

  await expect(
    page.getByText("Tamu didudukkan dan sesi meja dibuka.", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText("Duduk", { exact: true })).toBeVisible();
});

test("RSV-03 closing a reservation reports what the frozen policy does with the DP", async ({
  page,
}) => {
  // No-show outcome comes from the snapshot's noShowRefundBp (0), so the
  // amounts do not depend on when this spec runs.
  await page.goto(`${DESK}?date=2026-11-07`);
  await page
    .getByRole("button", { name: "Buka reservasi Rangga Pratama" })
    .click();
  await page.getByRole("button", { name: "Tandai tidak datang" }).click();

  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Tandai tidak datang" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Tandai tidak datang" }).click();

  await expect(
    page.getByText("Reservasi ditandai tidak datang.", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText("Hasil DP", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Dikembalikan", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Hangus", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Rp100.000", { exact: true })).toBeVisible();

  // A cancelled booking without a paid DP says so plainly.
  await page.goto(`${DESK}?reservationId=00000000-0000-4000-8000-000000005001`);
  const pendingDialog = page.getByRole("dialog");
  // The open reservation's row is the selected row: accent tint + start rule
  // (DESIGN.md §4 Table, owner Q29).
  await expect(
    page.locator(
      '[data-reservation-id="00000000-0000-4000-8000-000000005001"]',
    ),
  ).toHaveAttribute("data-state", "selected");
  await pendingDialog.getByRole("button", { name: "Batalkan" }).click();
  await pendingDialog
    .getByLabel("Alasan pembatalan")
    .fill("Tamu menelepon dan mengubah rencana.");
  await pendingDialog
    .getByRole("button", { name: "Batalkan reservasi" })
    .click();
  await expect(
    page.getByText("Belum ada DP yang dibayar.", { exact: true }),
  ).toBeVisible();
});

test("the waitlist calls a guest and seats a called party", async ({
  page,
}) => {
  await page.goto(`${DESK}?tab=waitlist`);

  await expect(
    page.getByRole("heading", { name: "Antrean hari ini" }),
  ).toBeVisible();
  await expect(page.getByText("Ayu Kusuma")).toBeVisible();
  await expect(page.getByText("Estimasi 20 menit")).toBeVisible();

  await page.getByRole("button", { name: "Panggil tamu Ayu Kusuma" }).click();
  await expect(
    page.getByText("Tamu dipanggil lewat notifikasi browser.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Dipanggil", { exact: true })).toHaveCount(2);

  // Hendra is already called; seat him on a free table.
  const hendra = page.locator(
    '[data-waitlist-id="00000000-0000-4000-8000-000000005202"]',
  );
  await hendra.getByRole("button", { name: "Dudukkan" }).click();
  const picker = page.getByRole("dialog").filter({ hasText: "Dudukkan" });
  // Hendra booked 4 guests; A04 seats 4.
  await picker.getByRole("button", { name: /Meja A04, 4 kursi/ }).click();
  await picker.getByRole("button", { name: "Dudukkan" }).click();

  await expect(
    page.getByText("Daftar tunggu diperbarui.", { exact: true }),
  ).toBeVisible();
  await expect(hendra.getByText("Duduk", { exact: true })).toBeVisible();
});

test("the event packages tab shows the package catalogue", async ({ page }) => {
  await page.goto(`${DESK}?tab=packages`);

  await expect(page.getByRole("tab", { name: "Paket event" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByText("Paket Kopi & Pastry Rombongan")).toBeVisible();
  await expect(page.getByText("Paket Makan Malam Keluarga")).toBeVisible();
  await expect(page.getByText("Rp85.000")).toBeVisible();
  await expect(page.getByText("Pesan ≥ 24 jam sebelum hari H")).toBeVisible();
});

test("the schedule has honest empty and error states", async ({ page }) => {
  // A day without bookings is the real empty state (the global `?mock=empty`
  // scenario also empties the outlet list, which is its own honest state).
  await page.goto(`${DESK}?date=2026-11-03`);
  await expect(page.getByText("Belum ada reservasi")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Hapus filter" }),
  ).toBeVisible();

  await page.goto(`${DESK}?mock=error`);
  await expect(page.getByText("Reservasi belum bisa dimuat")).toBeVisible();
  await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();
});
