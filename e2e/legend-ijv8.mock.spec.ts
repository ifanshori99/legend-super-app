// legend-ijv8: breakfast ordered from the facility ticket (alur Z, PRD §3 F22
// "Sarapan Siap Saat Keluar Shower") and the 5-minute in-app reminder; mockup
// design/mockups/pos/pos-extra-ijv8-sarapan.html. Web push is out of scope.
//
// Seeded mock tickets (apps/web/src/features/facility/mock.ts): ...T0VW is
// issued (starts in an hour), ...T0VX is in use with 4 minutes left.
// ASSUMPTIONS: the section is headed "Pilih sarapan" on the ticket page; the
// first dish starts with one portion and "Tambah <dish>" adds one; delivery is
// "Antar ke meja" (needs a "Nomor meja") or "Ambil di pickup".
// Run: pnpm test:e2e:mock e2e/legend-ijv8.mock.spec.ts
import { expect, test, type Page } from "@playwright/test";
import { failFirstCall } from "./mock-fail-next.ts";

const COLD_START_TIMEOUT_MS = 30_000;
const ISSUED_TICKET = "01JBQ7Z8K3M4N5P6Q7R8S9T0VW";
const IN_USE_TICKET = "01JBQ7Z8K3M4N5P6Q7R8S9T0VX";
const ticketUrl = (id: string, query = "") => `/member/fasilitas/${id}${query}`;
const MENU_ENDPOINT = "GET /api/facility/tickets/:ticketId/breakfast-menu";

async function openBreakfast(page: Page, query = "") {
  await page.goto(ticketUrl(ISSUED_TICKET, query));
  await expect(
    page.getByRole("heading", { name: "Pilih sarapan" }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
}

const submit = (page: Page) =>
  page.getByRole("button", { name: "Pesan sarapan" });

/** At least one portion, whether or not the first dish starts pre-selected. */
async function addDish(page: Page) {
  const subtotal = page.getByTestId("breakfast-subtotal");
  const before = await subtotal.innerText();
  await page
    .getByRole("button", { name: /^Tambah / })
    .first()
    .click();
  await expect(subtotal).not.toHaveText(before);
}

/** The table is a dropdown: "Nomor meja". */
async function chooseTable(page: Page) {
  await page.getByRole("combobox", { name: /Nomor meja/ }).click();
  await page.getByRole("option").first().click();
}

test("the ticket page offers a breakfast order with a summary", async ({
  page,
}) => {
  await openBreakfast(page);
  await expect(
    page.getByText(
      "Bayar dulu, lalu pesanan dikirim ke dapur sesuai waktu persiapan, menjelang akhir sesi.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Ringkasan sarapan" }),
  ).toBeVisible();
  await expect(page.getByText("Subtotal sarapan")).toBeVisible();
  await expect(
    page.getByRole("radio", { name: "Antar ke meja" }),
  ).toBeChecked();
  await expect(
    page.getByRole("radio", { name: "Ambil di pickup" }),
  ).toBeVisible();
  await expect(submit(page)).toBeVisible();
});

test("adding a portion changes the subtotal", async ({ page }) => {
  await openBreakfast(page);
  const total = page.getByTestId("breakfast-subtotal");
  const before = await total.innerText();
  await page
    .getByRole("button", { name: /^Tambah / })
    .first()
    .click();
  await expect(total).not.toHaveText(before);
});

test("a table delivery without a table is refused with a message", async ({
  page,
}) => {
  await openBreakfast(page);
  await addDish(page);
  await submit(page).click();
  await expect(
    page.getByText("Pilih nomor meja untuk pengantaran."),
  ).toBeVisible();
  await expect(page.getByTestId("breakfast-success")).toHaveCount(0);
});

test("choosing a table, the order awaits payment before the kitchen time", async ({
  page,
}) => {
  await openBreakfast(page);
  await addDish(page);
  await chooseTable(page);
  await expect(
    page.getByText("Dikirim ke dapur", { exact: true }),
  ).toBeVisible();
  await submit(page).click();
  const success = page.getByTestId("breakfast-success");
  await expect(
    success.getByText("Pesanan sarapan menunggu pembayaran"),
  ).toBeVisible();
  await expect(
    success.getByText(/Pesanan yang belum lunas tidak dikirim/),
  ).toBeVisible();
  await expect(
    success.getByRole("button", { name: "Bayar sarapan" }),
  ).toBeVisible();
  await expect(success.getByText("Pesanan sarapan sudah lunas")).toHaveCount(0);
  await expect(
    success.getByText("Pesanan sarapan sudah dikirim ke dapur"),
  ).toHaveCount(0);
  await expect(submit(page)).toHaveCount(0);
  await success.getByRole("button", { name: "Bayar sarapan" }).click();
  await page.getByRole("radio", { name: /QRIS/ }).check();
  await page.getByRole("button", { name: "Lanjutkan pembayaran" }).click();
  await expect(page.getByText("Pembayaran berhasil")).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
  await page.goBack();
  await expect(success.getByText("Pesanan sarapan sudah lunas")).toBeVisible();
  await expect(
    success.getByText(/Pesanan akan dikirim otomatis ke dapur pukul/),
  ).toBeVisible();
});

test("pickup needs no table", async ({ page }) => {
  await openBreakfast(page);
  await addDish(page);
  await page.getByRole("radio", { name: "Ambil di pickup" }).click();
  await expect(page.getByText("Pilih nomor meja")).toHaveCount(0);
  await submit(page).click();
  const success = page.getByTestId("breakfast-success");
  await expect(
    success.getByText("Pesanan sarapan menunggu pembayaran"),
  ).toBeVisible();
  await expect(
    success.getByText(/Pesanan yang belum lunas tidak dikirim/),
  ).toBeVisible();
  await expect(
    success.getByRole("button", { name: "Bayar sarapan" }),
  ).toBeVisible();
  await expect(success.getByText("Pesanan sarapan sudah lunas")).toHaveCount(0);
  await expect(
    success.getByText("Pesanan sarapan sudah dikirim ke dapur"),
  ).toHaveCount(0);
});

test("an empty breakfast menu says so", async ({ page }) => {
  await page.goto(ticketUrl(ISSUED_TICKET, "?mock=empty"));
  await expect(page.getByText("Belum ada menu sarapan tersedia")).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
});

test("a menu that fails to load can be retried", async ({ page }) => {
  await failFirstCall(page, MENU_ENDPOINT, {
    status: 409,
    code: "CONFLICT",
  });
  await page.goto(ticketUrl(ISSUED_TICKET));
  await expect(page.getByText("Menu sarapan belum dapat dimuat")).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
  await page.getByRole("button", { name: "Coba lagi" }).click();
  await expect(submit(page)).toBeVisible();
});

test("loading shows a busy placeholder for the menu", async ({ page }) => {
  await page.goto(ticketUrl(ISSUED_TICKET, "?mock=slow"));
  await expect(page.getByText("Memuat menu sarapan…")).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
});

test("five minutes before the session ends the ticket page reminds the guest", async ({
  page,
}) => {
  await page.goto(ticketUrl(IN_USE_TICKET));
  const reminder = page.getByRole("status").filter({
    hasText: "Sesi berakhir dalam 5 menit",
  });
  await expect(reminder).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
});

test("no reminder on a session that has time left", async ({ page }) => {
  await openBreakfast(page);
  await expect(page.getByText("Sesi berakhir dalam 5 menit")).toHaveCount(0);
});

test("on a phone the breakfast form stays inside the screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openBreakfast(page);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.setViewportSize({ width: 320, height: 640 });
  const narrow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(narrow).toBeLessThanOrEqual(0);
});
