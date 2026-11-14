// Guest reservation flow (bead legend-xm4y; PRD v1.7 §3.22 "Reservasi & Event",
// §4 Alur H, RSV-02/RSV-03): booking with table availability, the DP payment
// link, the frozen policy snapshot on the confirmation, the availability empty
// and error states, and the walk-in waitlist. Runs against the mock-mode web
// server (no API, no database): `pnpm test:e2e:mock`.
//
// The DP link is the contract's `/bayar/<token>` path; the spec asserts the
// href starts with `/bayar/` and never builds the URL itself.
import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";

const baseURL =
  process.env.LEGEND_MOCK_WEB_URL ?? process.env.E2E_MOCK_BASE_URL;

test.skip(
  !baseURL,
  "Mock runner not started: use pnpm test:e2e:mock (playwright.mock.config.ts).",
);
test.use({ baseURL });

/**
 * Server-rendered controls drop a click that lands before hydration. Every
 * action below is safe to retry, so retry until React owns the control (same
 * pattern as e2e/legend-vxj.mock.spec.ts).
 */
async function retry(action: () => Promise<void>) {
  await expect(action).toPass({ timeout: 15_000 });
}

async function openBooking(page: Page, query = "") {
  await page.goto(`/reservasi${query}`, { waitUntil: "networkidle" });
  await expect(
    page.getByRole("heading", { level: 1, name: "Reservasi meja" }),
  ).toBeVisible();
}

/** Picks the first offered start time and waits for the pressed state. */
async function chooseFirstSlot(page: Page) {
  const slot = page.getByRole("button", { name: /kursi/ }).first();
  await expect(slot).toBeVisible();
  await retry(async () => {
    await slot.click();
    await expect(slot).toHaveAttribute("aria-pressed", "true", {
      timeout: 1000,
    });
  });
}

async function fillGuest(page: Page, name = "Ayu Prameswari") {
  await retry(async () => {
    await page.getByLabel("Nama tamu").fill(name);
    await expect(page.getByLabel("Nama tamu")).toHaveValue(name, {
      timeout: 1000,
    });
  });
  await retry(async () => {
    await page.getByLabel("Nomor WhatsApp").fill("081234567890");
    await expect(page.getByLabel("Nomor WhatsApp")).toHaveValue(
      "081234567890",
      { timeout: 1000 },
    );
  });
}

async function submitBooking(page: Page) {
  await retry(async () => {
    await page.getByRole("button", { name: "Lanjutkan reservasi" }).click();
    await expect(
      page.getByRole("heading", { name: "Reservasi diterima" }),
    ).toBeVisible({ timeout: 2000 });
  });
}

test("§3.22 RSV-02 a booked slot returns the DP link, and RSV-03 shows the frozen policy", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await openBooking(page);
  // RSV-01 read model: the slot buttons carry their free seats.
  await chooseFirstSlot(page);
  await fillGuest(page);
  await submitBooking(page);

  // RSV-02: the reservation waits for its DP and carries the payment link.
  await expect(page.getByText("Menunggu DP")).toBeVisible();
  await expect(
    page.getByText(/DP diperhitungkan ke tagihan saat Anda datang/),
  ).toBeVisible();
  const payDeposit = page.getByRole("link", { name: "Bayar DP" });
  await expect(payDeposit).toBeVisible();
  const href = await payDeposit.getAttribute("href");
  expect(href?.startsWith("/bayar/")).toBe(true);

  // RSV-03: the confirmation prints the policy captured with the reservation.
  await expect(page.getByText("Kebijakan reservasi Anda")).toBeVisible();
  await expect(
    page.getByText(/Batal minimal 24 jam sebelum kedatangan: DP kembali penuh/),
  ).toBeVisible();
  await expect(page.getByText(/Tidak datang: DP kembali 0%/)).toBeVisible();

  // The confirmation survives a reload through sessionStorage (no route param).
  await page.reload({ waitUntil: "networkidle" });
  await expect(
    page.getByRole("heading", { name: "Reservasi diterima" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Bayar DP" })).toBeVisible();

  await captureScreenshot(page, "legend-xm4y/konfirmasi-390-light.png");
});

test("§3.22 RSV-03 the private-room booking shows its own DP, minimum spend and 48-hour window", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await openBooking(page);

  await retry(async () => {
    await page.getByRole("combobox", { name: "Zona" }).click();
    const option = page.getByRole("option", { name: "Private Room Nusantara" });
    await expect(option).toBeVisible({ timeout: 1000 });
    await option.click();
    await expect(page.getByRole("combobox", { name: "Zona" })).toContainText(
      "Private Room",
      {
        timeout: 1000,
      },
    );
  });
  await chooseFirstSlot(page);
  await fillGuest(page, "Rangga Pratama");
  await submitBooking(page);

  // The zone's snapshot, not the regular one: Rp100.000 DP and Rp500.000
  // minimum spend frozen for this booking (RSV-03).
  await expect(page.getByText(/DP Rp\s?100\.000/).first()).toBeVisible();
  await expect(
    page.getByText(/Batal minimal 48 jam sebelum kedatangan: DP kembali penuh/),
  ).toBeVisible();
  await expect(page.getByText(/Minimum belanja Rp\s?500\.000/)).toBeVisible();
});

test("d6d1 a reloaded booking DP link opens payment and returns a paid confirmation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await openBooking(page);
  await chooseFirstSlot(page);
  await fillGuest(page);
  await submitBooking(page);
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("link", { name: "Bayar DP" }).click();
  await expect(page.getByRole("radio", { name: /QRIS/ })).toBeVisible();
  await page.getByRole("radio", { name: /QRIS/ }).check();
  await page.getByRole("button", { name: "Lanjutkan pembayaran" }).click();
  await expect(page.getByText("Pembayaran berhasil")).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("link", { name: "Selesai", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Reservasi terkonfirmasi" }),
  ).toBeVisible();
  await expect(page.getByText("Menunggu DP")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Bayar DP" })).toHaveCount(0);
  await page.reload({ waitUntil: "networkidle" });
  await expect(
    page.getByRole("heading", { name: "Reservasi terkonfirmasi" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Bayar DP" })).toHaveCount(0);
});

test("§3.22 availability empty state offers the walk-in waitlist", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await openBooking(page, "?mock=empty");
  await expect(page.getByText("Belum ada meja kosong")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Gabung daftar tunggu" }),
  ).toBeVisible();
  await captureScreenshot(page, "legend-xm4y/reservasi-390-empty.png");
});

test("§3.22 availability error state gives a retry way forward", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/reservasi?mock=error", { waitUntil: "networkidle" });
  await expect(page.getByRole("alert").first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: /Coba lagi/ })).toBeVisible();
  await captureScreenshot(page, "legend-xm4y/reservasi-390-error.png");
});

test("§3.22 walk-in waitlist joins with a quoted estimate and the on-site call", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/reservasi?mode=antre", { waitUntil: "networkidle" });
  await expect(
    page.getByRole("heading", { name: "Daftar tunggu" }),
  ).toBeVisible();
  await captureScreenshot(page, "legend-xm4y/antre-390-light.png");

  await fillGuest(page, "Hendra Wijaya");
  await retry(async () => {
    await page.getByRole("button", { name: "Gabung daftar tunggu" }).click();
    await expect(page.getByText("Anda masuk daftar tunggu")).toBeVisible({
      timeout: 2000,
    });
  });
  await expect(page.getByText(/Perkiraan tunggu \d+ menit/)).toBeVisible();
  await expect(
    page.getByText(/Staf akan memanggil nama Anda saat meja siap/),
  ).toBeVisible();
});

for (const [width, theme] of [
  [390, "light"],
  [390, "dark"],
  [1440, "light"],
] as const) {
  test(`§3.22 RSV-02 booking page visual ${width} ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(
      (value) => localStorage.setItem("legend-theme", value),
      theme,
    );
    await openBooking(page);
    await expect(
      page.getByRole("button", { name: /kursi/ }).first(),
    ).toBeVisible();
    await captureScreenshot(
      page,
      `legend-xm4y/reservasi-${width}-${theme}.png`,
    );
  });
}
