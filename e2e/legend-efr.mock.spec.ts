import { expect, test } from "@playwright/test";

// Tax & service-charge back office + monthly PBJT recap (bead legend-efr; PRD
// v1.7 §3.14 F11/D13, R21) against the FE mock runtime: no API, no database.
// The screens read @starter/shared/tax fixtures through VITE_API_MOCK=true, the
// way the bead was built (docs/frontend.md "Typed endpoints and mock mode").
//
// How to run: `pnpm test:e2e:mock e2e/legend-efr.mock.spec.ts`. With no mock
// server variable the whole file skips, so the production e2e runner stays
// green (real API wiring is the WS-05 integration bead).
const MOCK_URL =
  process.env.LEGEND_MOCK_WEB_URL ?? process.env.E2E_MOCK_BASE_URL;

test.skip(
  !MOCK_URL,
  "Needs a VITE_API_MOCK=true server (pnpm test:e2e:mock); see the header of this file.",
);

/**
 * The first hit on a cold Vite dev server paints the server HTML before React
 * hydrates; a click in that window is lost. React attests a hydrated node with
 * an internal `__reactFiber$…` property, so wait for that on the main region.
 */
async function waitForHydration(page: import("@playwright/test").Page) {
  await page.waitForFunction(
    () => {
      const main = document.querySelector("#main-content");
      return (
        main !== null &&
        Object.keys(main).some((key) => key.startsWith("__reactFiber$"))
      );
    },
    undefined,
    { timeout: 60_000 },
  );
}

// F11/D13: aturan pajak berversi, opsi perhitungan, service charge per zona.
test("F11 D13: config screens list versioned rules, service charge and calc options", async ({
  page,
}) => {
  test.slow();
  await page.goto(`${MOCK_URL}/kelola/pajak`);
  await waitForHydration(page);

  // Rule versions: the published 10% PBJT rule and its draft revision.
  // v3 (legend-vvth): the management topbar owns the page h1; the page body
  // shows the section title as an h2 (DESIGN.md v3 §5).
  await expect(
    page.getByRole("heading", { name: "Pajak & layanan", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("PBJT-FNB").first()).toBeVisible();
  await expect(page.getByText("10%").first()).toBeVisible();
  await expect(page.getByText("Berlaku sekarang").first()).toBeVisible();
  // The status badge reads "Diterbitkan · v1" (status and version in one chip).
  await expect(page.getByText(/^Diterbitkan · v\d+$/).first()).toBeVisible();

  // Service charge is a zone/order-type rule (PRD §3.14 "Service Charge").
  // The table and the phone list render the same row (one is hidden by CSS).
  await page.getByRole("link", { name: "Service charge", exact: true }).click();
  await expect(page.getByText("SC-PRIVATE-ROOM").first()).toBeVisible();
  await expect(page.getByText("5%").first()).toBeVisible();
  await expect(page.getByText("Private Room Nusantara").first()).toBeVisible();

  // Calculation options: the owner decision (menu prices exclude tax and
  // service charge) is what the tenant default shows.
  await page.getByRole("link", { name: "Opsi perhitungan" }).click();
  await expect(page.getByText("Opsi yang berlaku")).toBeVisible();
  await expect(
    page.getByRole("definition").filter({ hasText: "Belum termasuk" }),
  ).toBeVisible();
  await expect(
    page.getByText("Diskon → service charge → pajak").first(),
  ).toBeVisible();
});

// R21: a published version is immutable; a change is a new version with its
// own effective date. Creating a draft, publishing it, then starting the next
// version is the whole lifecycle.
test("R21: publish a new tax rule version and start its next version", async ({
  page,
}) => {
  test.slow();
  await page.goto(`${MOCK_URL}/kelola/pajak`);
  await waitForHydration(page);

  await page.getByRole("button", { name: "Buat aturan" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Kode aturan").fill("PBJT-E2E");
  await dialog.getByLabel("Nama aturan").fill("PBJT uji e2e");
  await dialog.getByLabel("Tarif (%)").fill("10");
  await dialog.getByRole("button", { name: "Simpan draf" }).click();
  await expect(
    page.getByText("Draf aturan pajak dibuat.", { exact: true }),
  ).toBeVisible();

  await page
    .getByRole("row")
    .filter({ hasText: "PBJT-E2E" })
    .getByRole("button", { name: "Terbitkan", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Terbitkan PBJT-E2E versi 1?" }),
  ).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Terbitkan", exact: true })
    .click();
  await expect(
    page.getByText("Aturan pajak diterbitkan.", { exact: true }),
  ).toBeVisible();

  // The published row now offers the next version, pre-dated after it.
  const row = page.getByRole("row").filter({ hasText: "PBJT-E2E" });
  await row.getByRole("button", { name: "Versi baru" }).click();
  await expect(
    page.getByRole("heading", { name: "Versi baru PBJT-E2E" }),
  ).toBeVisible();
  await expect(page.locator('input[type="date"]')).not.toHaveValue("");
  await page.getByRole("button", { name: "Batal" }).click();
});

// Laporan Pajak: the monthly recap is per outlet and exports the figures the
// regional filing needs; a month without transactions is an honest empty state.
test("F11 D13: PBJT monthly recap totals rows and exports a CSV", async ({
  page,
}) => {
  test.slow();
  await page.goto(`${MOCK_URL}/kelola/pajak/laporan?period=2026-11`);
  await waitForHydration(page);

  await expect(
    page.getByRole("heading", { name: "Rekap PBJT bulanan" }),
  ).toBeVisible();
  await expect(page.getByText("PBJT-FNB")).toBeVisible();
  await expect(page.getByText("PBJT-FASILITAS")).toBeVisible();
  await expect(page.getByText(/Rp\s?41\.996\.000/).first()).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Unduh CSV" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("pbjt-2026-11-6a2d4f80.csv");

  // Another month has no transactions yet.
  await page.getByLabel("Periode").fill("2026-12");
  await expect(
    page.getByText("Belum ada transaksi pada periode ini"),
  ).toBeVisible();
});

// Screens show real states, not blank pages (PRD: every list has loading,
// empty and error states). Mock scenarios switch them without a backend.
test("F11 D13: empty and error scenarios render their states", async ({
  page,
}) => {
  test.slow();
  await page.goto(`${MOCK_URL}/kelola/pajak?mock=empty`);
  await waitForHydration(page);
  await expect(page.getByText("Belum ada aturan pajak")).toBeVisible();

  await page.goto(`${MOCK_URL}/kelola/pajak/laporan?mock=error`);
  await waitForHydration(page);
  await expect(page.getByText("Data tidak dapat dimuat")).toBeVisible();
  await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();
});
