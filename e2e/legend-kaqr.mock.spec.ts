import { expect, test } from "@playwright/test";

// Customer facility journey (WS-09, beads legend-kaqr + legend-gr3j) against
// the FE mock runtime: no API, no database. The whole journey runs on
// @starter/shared/facility fixtures through VITE_API_MOCK=true, the way the
// bead was built (docs/frontend.md, "Typed endpoints and mock mode").
//
// How to run: `pnpm test:e2e:mock` (bead legend-n2sp) starts a VITE_API_MOCK
// web server and names it in `LEGEND_MOCK_WEB_URL`. Before that runner is
// merged, start one yourself and pass the same variable:
//
//   VITE_API_MOCK=true WEB_URL=http://localhost:3210 pnpm --filter @starter/web dev
//   LEGEND_MOCK_WEB_URL=http://localhost:3210 pnpm exec playwright test e2e/legend-kaqr.mock.spec.ts
//
// With none of the variables set every test skips, so the production-build
// runner stays green (the real API wiring is bead legend-x1yh).
const MOCK_URL =
  process.env.LEGEND_MOCK_WEB_URL ??
  process.env.E2E_MOCK_BASE_URL ??
  process.env.LEGEND_MOCK_URL;

/** Facility id of the shared shower-room fixture (the QR entry segment). */
const FACILITY = "00000000-0000-4000-8000-000000009001";
/** In-use fixture ticket, 4 minutes from its session end at the mock clock. */
const TICKET_IN_USE = "01JBQ7Z8K3M4N5P6Q7R8S9T0VX";

test.skip(
  !MOCK_URL,
  "Needs a VITE_API_MOCK=true server (pnpm test:e2e:mock); see the header of this file.",
);

/**
 * The first hit on a cold Vite dev server paints the server HTML before React
 * hydrates; keystrokes typed into a controlled input in that window are lost.
 * React attests a hydrated node with an internal `__reactFiber$…` property, so
 * wait for that before driving the form.
 */
async function waitForHydration(page: import("@playwright/test").Page) {
  await page.waitForFunction(
    () => {
      const field = document.querySelector("#main-content form input");
      return (
        field !== null &&
        Object.keys(field).some((key) => key.startsWith("__reactFiber$"))
      );
    },
    undefined,
    { timeout: 60_000 },
  );
}

/** Types like a guest, after hydration, and checks the field kept the text. */
async function typeInto(
  page: import("@playwright/test").Page,
  label: string,
  text: string,
) {
  const field = page.getByLabel(label);
  await field.click();
  await page.keyboard.type(text, { delay: 20 });
  await expect(field).toHaveValue(text);
}

async function passWhatsAppGate(page: import("@playwright/test").Page) {
  await typeInto(page, "Nomor WhatsApp", "081234567890");
  await page.getByRole("button", { name: "Kirim kode WhatsApp" }).click();
  await typeInto(page, "Kode verifikasi 6 digit", "123456");
  await page.getByRole("button", { name: "Verifikasi nomor" }).click();
  await expect(
    page.getByRole("heading", { name: "Pilih area dan waktu" }),
  ).toBeVisible();
}

test("FAC-04/FAC-05: a guest books a shower with QRIS and gets a ticket with QR and PIN", async ({
  page,
}) => {
  // A cold Vite dev server compiles the route on the first hit.
  test.slow();
  await page.goto(`${MOCK_URL}/f/${FACILITY}`);
  await waitForHydration(page);

  // PRD §3 F22 Titik Masuk: booking requires a verified WhatsApp number.
  await expect(
    page.getByRole("heading", { name: "Masuk dengan WhatsApp" }),
  ).toBeVisible();
  await passWhatsAppGate(page);

  // Area and timing: the area is recorded on the ticket only (FAC-09), and the
  // unit that cannot be booked is never offered (FAC-06).
  await page
    .getByRole("radiogroup", { name: "Area" })
    .getByText("Area Pria")
    .click();
  await page
    .getByRole("radiogroup", { name: "Waktu kunjungan" })
    .getByText("Masuk sekarang")
    .click();
  await expect(page.getByText(/bilik siap/)).toBeVisible();
  await page.getByRole("button", { name: "Berikutnya" }).click();

  // Product and add-ons (PRD §3 F22 Produk & Hak Akses, Add-on Opsional).
  await expect(
    page.getByRole("heading", { name: "Produk dan tambahan" }),
  ).toBeVisible();
  await page.getByText("Shower Sekali Pakai").click();
  await page.getByText("Handuk", { exact: true }).click();
  await page.getByRole("button", { name: "Bayar tiket" }).click();

  // Payment: the mock settles the QRIS payment and the ticket is issued.
  await expect(
    page.getByRole("heading", { name: "Periksa pesanan" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Bayar dengan QRIS" }).click();
  await expect(
    page.getByRole("heading", { name: "Tiket terbit" }),
  ).toBeVisible();

  // The credential is shown once at issue: QR plus a 6-digit PIN (FAC-01).
  const pin = page.locator("text=/^\\d{6}$/").first();
  await expect(pin).toBeVisible();
  await expect(page.getByRole("img", { name: /QR tiket bilik/ })).toBeVisible();

  // The ticket screen keeps the credential on this device and runs the timer.
  await page.getByRole("link", { name: "Buka tiket" }).click();
  await expect(
    page.getByRole("heading", { name: "Tiket akses" }),
  ).toBeVisible();
  await expect(page.getByRole("img", { name: /QR tiket bilik/ })).toBeVisible();
  await expect(page.getByText("Sisa sesi")).toBeVisible();

  // Fasilitas Saya lists it as an active ticket (alur T langkah 3).
  await page.getByRole("link", { name: "Ke Fasilitas Saya" }).first().click();
  await expect(
    page.getByRole("heading", { name: "Fasilitas Saya" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Tiket aktif" }),
  ).toBeVisible();
});

test("FAC-01: the ticket shows the session timer and the 5-minute reminder", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/member/fasilitas/${TICKET_IN_USE}`);
  await expect(
    page.getByRole("heading", { name: "Tiket akses" }),
  ).toBeVisible();
  await expect(page.getByText("Sisa sesi")).toBeVisible();
  await expect(
    page.getByText(/Sesi berakhir dalam 5 menit/).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Batalkan tiket" }),
  ).toHaveCount(0);
});

test("FAC-07: the subscription page shows the quota and stops from the member page", async ({
  page,
}) => {
  await page.goto(
    `${MOCK_URL}/member/fasilitas/langganan?facility=${FACILITY}`,
  );
  await expect(
    page.getByRole("heading", { name: "Langganan Shower" }),
  ).toBeVisible();
  await expect(page.getByText("sesi tersisa")).toBeVisible();
  await expect(page.getByText("Kuota siap dipakai.")).toBeVisible();

  // Pausing is a customer action (alur U langkah 6): confirm, then the state
  // reads as paused and the quota is no longer offered.
  await page.getByRole("button", { name: "Jeda langganan" }).click();
  await page.getByRole("button", { name: "Ya, jeda" }).click();
  await expect(page.getByText("Langganan sedang dijeda.")).toBeVisible();
});
