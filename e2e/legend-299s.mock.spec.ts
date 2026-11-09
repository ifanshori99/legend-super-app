// WS-10 shift templates and weekly roster calendar (bead legend-299s; PRD v1.7
// §3 Kelompok D 28 "Penjadwalan Shift", F26, HR-05, AI-13).
//
// Mock-mode spec: `pnpm test:e2e:mock e2e/legend-299s.mock.spec.ts` starts the
// web dev server with VITE_API_MOCK=true, so the HRIS fixtures answer without
// an API or database. The fixture roster lives on the week of 2026-10-26
// (`weekOne` in packages/shared/src/hris/fixtures.ts); every roster test pins
// `?week=` so the screen never depends on the machine clock.
//
// Writes are LOCAL drafts (the contract has no assignment write endpoint yet)
// and publishing goes through the contract's `publishRoster`, registered by
// `features/ws10-roster/mock.ts`. `?mock=normal` always resets the remembered
// scenario before a functional test.
//
// `/kelola/roster` is not in e2e/mock-global-setup.ts WARM_ROUTES (a shared
// file this bead must not edit), so the first assertion of the first test on
// each route allows for a cold Vite compile (frontend.md "Browser specs
// in mock mode").
import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";
import { waitForHydration } from "./hydration.ts";

const base = process.env.LEGEND_MOCK_WEB_URL;
test.skip(
  !base,
  "Set LEGEND_MOCK_WEB_URL (pnpm test:e2e:mock) to a web server running VITE_API_MOCK.",
);
const web = base!;

const COLD_START_TIMEOUT_MS = 30_000;
/** Fixture week (`weekOne`): published rows plus two drafts for CL-1006. */
const FIXTURE_WEEK = "2026-10-26";
const NEXT_WEEK = "2026-11-02";
const ROSTER_PATH = `/kelola/roster?week=${FIXTURE_WEEK}&mock=normal`;

type Theme = "light" | "dark";

async function openRoster(page: Page, path = ROSTER_PATH) {
  // Cold SSR of an unwarmed route can pass Playwright's 30 s navigation
  // timeout; the first assertion still gets COLD_START_TIMEOUT_MS.
  page.setDefaultNavigationTimeout(60_000);
  await page.goto(`${web}${path}`, { waitUntil: "networkidle" });
  await waitForHydration(page);
}

/** One employee's grid row; the sticky first cell carries the full name. */
function employeeRow(page: Page, name: string) {
  return page.getByRole("row").filter({ hasText: name });
}

async function setTheme(page: Page, theme: Theme) {
  await page.addInitScript(
    (value) => localStorage.setItem("legend-theme", value),
    theme,
  );
}

test("HR-05 F26 the weekly grid renders the fixture roster per employee and day", async ({
  page,
}) => {
  await openRoster(page);
  await expect(
    page.getByRole("heading", { name: /Roster 26 Okt/, level: 2 }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });

  // The fixture week mixes published rows with two drafts (CL-1006), so it
  // opens as a draft week and last week has nothing to copy.
  await expect(page.getByTestId("roster-week-status")).toHaveText("Draf");
  await expect(
    page.getByRole("columnheader", { name: /Sen, 26 Okt/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Salin minggu lalu" }),
  ).toBeDisabled();

  // CL-1003 Budi Santoso: Pagi 08.00–16.00 on Monday, Tuesday and Wednesday.
  const budi = employeeRow(page, "Budi Santoso");
  await expect(budi).toBeVisible();
  // The fixture week runs Mon 26 Oct – Sun 1 Nov, so Budi has four shifts.
  await expect(budi.getByText("08.00–16.00", { exact: true })).toHaveCount(4);
  await expect(budi.getByText("Terbit", { exact: true })).toHaveCount(4);

  // CL-1006 Putri Ramadhani: two draft Siang shifts (14.00–22.00).
  const putri = employeeRow(page, "Putri Ramadhani");
  await expect(putri.getByText("14.00–22.00", { exact: true })).toHaveCount(2);
  await expect(putri.getByText("Draf", { exact: true })).toHaveCount(2);

  // AI-13 panel: deterministic coverage-gap suggestions, never auto-assigned.
  await expect(
    page.getByRole("heading", { name: "Usulan AI-13", level: 2 }),
  ).toBeVisible();
  const accept = page.getByRole("button", { name: "Terima usulan" });
  await expect(accept.first()).toBeVisible();
  // Accepting the first suggestion (Putri, Wednesday) adds a local draft.
  const acceptedToast = page
    .getByText(/Draf Putri Ramadhani pada .* ditambahkan\./)
    .first();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await acceptedToast.isVisible().catch(() => false)) break;
    await accept.first().click();
    await page.waitForTimeout(400);
  }
  await expect(acceptedToast).toBeVisible({ timeout: 10_000 });
  await expect(putri.getByText("Draf", { exact: true })).toHaveCount(3);
});

test("HR-05 the position filter narrows the grid and the station filter reflects the fixtures", async ({
  page,
}) => {
  await openRoster(page);
  await expect(employeeRow(page, "Dewi Lestari")).toBeVisible();

  await page.getByLabel("Jabatan").click();
  await page.getByRole("option", { name: "Barista", exact: true }).click();

  // Barista rows stay (Dewi, Agus, Putri); Head Barista and Server rows leave.
  await expect(employeeRow(page, "Dewi Lestari")).toBeVisible();
  await expect(employeeRow(page, "Agus Setiawan")).toBeVisible();
  await expect(employeeRow(page, "Budi Santoso")).toHaveCount(0);
  await expect(employeeRow(page, "Rina Kartika")).toHaveCount(0);

  // The HRIS fixtures carry no stationId (their templates are outlet-wide), so
  // the station filter lists only "all" instead of inventing station options.
  await page.getByLabel("Stasiun").click();
  const stationList = page.getByRole("listbox");
  await expect(stationList.getByRole("option")).toHaveCount(1);
  await expect(
    stationList.getByRole("option", { name: "Semua stasiun", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
});

test("HR-05 F26 a draft shift added from the cell menu shows the contract compliance warning", async ({
  page,
}) => {
  await openRoster(page);
  const budi = employeeRow(page, "Budi Santoso");
  await expect(budi).toBeVisible();

  await budi
    .getByRole("button", {
      name: "Tambah shift untuk Budi Santoso pada Sen, 26 Okt",
    })
    .click();
  await page.getByRole("menuitem", { name: /Tambah Malam/ }).click();

  // Pagi ends 16.00 and Malam starts 22.00: 360 minutes of rest against the
  // tenant policy's 660 (PRD F26 "Kepatuhan"; `insufficient_rest`).
  await expect(budi.getByText("Draf", { exact: true })).toHaveCount(1);
  await expect(
    budi.getByText(/Istirahat antarshift kurang: 360 mnt/),
  ).toBeVisible();
});

test("HR-05 F26 publishing the week calls publishRoster and flips the badge to Terbit", async ({
  page,
}) => {
  await openRoster(page);
  const status = page.getByTestId("roster-week-status");
  await expect(status).toHaveText("Draf");

  await page.getByRole("button", { name: "Terbitkan", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Terbitkan roster minggu ini?" }),
  ).toBeVisible();
  await expect(dialog.getByText(/\d+ shift · \d+ karyawan/)).toBeVisible();

  await dialog.getByRole("button", { name: "Terbitkan jadwal" }).click();

  await expect(
    page.getByText("Roster minggu 26 Okt – 1 Nov 2026 diterbitkan.").first(),
  ).toBeVisible();
  await expect(status).toHaveText("Terbit");
  await expect(dialog).toHaveCount(0);

  // The mock persisted the contract publication for this outlet-week.
  const stored = await page.evaluate(() =>
    localStorage.getItem("legend-roster-local-v1"),
  );
  expect(stored).toContain(FIXTURE_WEEK);
});

test("HR-05 F26 copy previous week turns last week's published shifts into drafts", async ({
  page,
}) => {
  await openRoster(page, `/kelola/roster?week=${NEXT_WEEK}&mock=normal`);
  await expect(
    page.getByRole("heading", { name: /Roster 2 Nov/, level: 2 }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Salin minggu lalu" }).click();
  await expect(
    page.getByText(/\d+ shift disalin sebagai draf\./).first(),
  ).toBeVisible();
  await expect(page.getByTestId("roster-week-status")).toHaveText("Draf");
  await expect(
    employeeRow(page, "Budi Santoso")
      .getByText("Draf", { exact: true })
      .first(),
  ).toBeVisible();
});

test("HR-05 F26 copy previous week is idempotent: a second copy adds nothing", async ({
  page,
}) => {
  await openRoster(page, `/kelola/roster?week=${NEXT_WEEK}&mock=normal`);
  const copy = page.getByRole("button", { name: "Salin minggu lalu" });
  await expect(copy).toBeEnabled();
  await copy.click();
  await expect(
    page.getByText(/\d+ shift disalin sebagai draf\./).first(),
  ).toBeVisible();
  const budiDrafts = employeeRow(page, "Budi Santoso").getByText("Draf", {
    exact: true,
  });
  const before = await budiDrafts.count();

  await copy.click();
  await expect(
    page
      .getByText(
        "Semua shift minggu lalu sudah ada di minggu ini; tidak ada yang disalin.",
      )
      .first(),
  ).toBeVisible();
  await expect(budiDrafts).toHaveCount(before);
});

test("HR-05 F26 publishing needs confirmation: cancelling the dialog keeps the week as draft", async ({
  page,
}) => {
  await openRoster(page);
  const status = page.getByTestId("roster-week-status");
  await expect(status).toHaveText("Draf");

  await page.getByRole("button", { name: "Terbitkan", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Batal" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(status).toHaveText("Draf");
});

test("HR-05 F26 a shift can be added with the keyboard only", async ({
  page,
}) => {
  await openRoster(page);
  const agus = employeeRow(page, "Agus Setiawan");
  await expect(agus).toBeVisible();
  const drafts = agus.getByText("Draf", { exact: true });
  const before = await drafts.count();

  await agus
    .getByRole("button", {
      name: "Tambah shift untuk Agus Setiawan pada Min, 1 Nov",
    })
    .focus();
  await page.keyboard.press("Enter");
  const pagi = page.getByRole("menuitem", { name: /Tambah Pagi/ });
  await expect(pagi).toBeVisible();
  await pagi.focus();
  await page.keyboard.press("Enter");
  await expect(drafts).toHaveCount(before + 1);
});

test("HR-05 F26 the roster shows loading, empty, error and offline states", async ({
  page,
}) => {
  await page.goto(`${web}/kelola/roster?week=${FIXTURE_WEEK}&mock=slow`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.locator("[aria-busy='true']")).toBeVisible();
  await expect(employeeRow(page, "Budi Santoso")).toBeVisible({
    timeout: 15_000,
  });

  await openRoster(page, `/kelola/roster?week=${FIXTURE_WEEK}&mock=empty`);
  await expect(
    page.getByText("Belum ada karyawan aktif di outlet ini", { exact: true }),
  ).toBeVisible();

  await openRoster(page, `/kelola/roster?week=${FIXTURE_WEEK}&mock=error`);
  await expect(
    page.getByText("Roster tidak dapat dimuat", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();

  await openRoster(page, `/kelola/roster?week=${FIXTURE_WEEK}&mock=offline`);
  await expect(
    page.getByText(
      "Anda sedang offline. Sambungkan kembali untuk memuat roster.",
      { exact: true },
    ),
  ).toBeVisible();
});

for (const [width, theme] of [
  [390, "light"],
  [390, "dark"],
  [1440, "light"],
] as const) {
  test(`HR-05 visual roster ${width} ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setTheme(page, theme);
    await openRoster(page);
    await expect(employeeRow(page, "Budi Santoso")).toBeVisible();
    await captureScreenshot(page, `legend-299s/roster-${width}-${theme}.png`);
  });
}

test("HR-05 visual template 1440 light", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await setTheme(page, "light");
  // This route is cold in this spec (`/kelola/roster` was warmed by the first
  // test, its template child was not).
  page.setDefaultNavigationTimeout(60_000);
  await page.goto(`${web}/kelola/roster/template?mock=normal`, {
    waitUntil: "networkidle",
  });
  await expect(
    page.getByRole("heading", { name: "Template shift", level: 2 }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await expect(
    page.getByText("10.00–14.00, 17.00–21.00", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("2 segmen", { exact: true })).toBeVisible();
  await captureScreenshot(page, "legend-299s/template-1440-light.png");
});

test("HR-05 visual roster empty 390 light", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await setTheme(page, "light");
  await openRoster(page, `/kelola/roster?week=${FIXTURE_WEEK}&mock=empty`);
  await expect(
    page.getByText("Belum ada karyawan aktif di outlet ini", { exact: true }),
  ).toBeVisible();
  await captureScreenshot(page, "legend-299s/roster-empty-390-light.png");
});
