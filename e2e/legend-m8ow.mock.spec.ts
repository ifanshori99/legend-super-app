import { expect, test } from "@playwright/test";

// Loyalty back office happy path (bead legend-m8ow; PRD v1.7 §3.20 "Loyalty &
// Membership": earn ratio, tiers + benefits, rewards stock/validity, missions
// and stamp cards) against the FE mock runtime: no API, no database. Screens
// read @starter/shared/crm fixtures through VITE_API_MOCK=true.
//
// How to run: `pnpm test:e2e:mock` (bead legend-n2sp) starts a mock-mode web
// server and names it in LEGEND_MOCK_WEB_URL. The production e2e config ignores
// `*.mock.spec.ts`, and with no variable set every test skips.
const MOCK_URL = process.env.LEGEND_MOCK_WEB_URL;

test.skip(
  !MOCK_URL,
  "Needs a VITE_API_MOCK=true server (pnpm test:e2e:mock); see the header of this file.",
);

const NAV = { waitUntil: "networkidle" as const };

test("PRD §3.20 Program: the program screen shows and saves the earn ratio, expiry policy and point value", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/kelola/loyalty?mock=normal`, NAV);
  await expect(
    page.getByRole("heading", { name: "Loyalty & member" }),
  ).toBeVisible();

  const current = page
    .getByRole("navigation", { name: "Loyalty & member" })
    .locator('a[aria-current="page"]');
  await expect(current).toHaveCount(1);
  await expect(current).toHaveText("Program");

  // Fixtures: Rp 10.000 = 1 poin, 12 months expiry, Rp 100 per point.
  await expect(page.getByLabel("Belanja per poin (Rp)")).toHaveValue("10000");
  await expect(page.getByLabel("Masa berlaku poin (bulan)")).toHaveValue("12");

  await page.getByLabel("Belanja per poin (Rp)").fill("15000");
  await page.getByLabel("Poin yang diperoleh").fill("2");
  await page.getByLabel("Belanja setelah diskon (Rp)").fill("100000");
  // 100.000 / 15.000 = 6 full blocks × 2 points = 12 points (rounded down).
  await expect(page.getByText("12 poin").first()).toBeVisible();

  await page.getByRole("button", { name: "Simpan program" }).click();
  await expect(
    page.getByText("Program loyalty tersimpan.").first(),
  ).toBeVisible();
});

test("PRD §3.20 Reward: a reward can be added with its own stock and validity window", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(`${MOCK_URL}/kelola/loyalty/reward?mock=normal`, NAV);
  const table = page.getByRole("table");
  const fixtureRow = table
    .getByRole("row")
    .filter({ hasText: "Kopi Susu Aren Gratis" })
    .first();
  await expect(fixtureRow).toBeVisible();
  await expect(fixtureRow).toContainText("40");

  await page.getByRole("button", { name: "Tambah reward" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  await dialog.getByLabel("Nama reward").fill("Voucher Uji");
  await dialog.getByRole("combobox", { name: "Jenis reward" }).click();
  await page.getByRole("option", { name: "Voucher" }).click();
  await dialog.getByLabel("Poin yang dibutuhkan").fill("120");
  await dialog.getByLabel("Stok").fill("5");
  await dialog.getByLabel("Berlaku mulai").fill("2026-11-01");
  await dialog.getByLabel("Berlaku sampai").fill("2026-12-31");
  await dialog.getByLabel("Nilai voucher (Rp)").fill("10000");
  await dialog.getByRole("button", { name: "Simpan reward" }).click();

  await expect(
    page.getByText("Reward Voucher Uji ditambahkan.").first(),
  ).toBeVisible();
  await expect(
    table.getByRole("row").filter({ hasText: "Voucher Uji" }).first(),
  ).toBeVisible();

  expect(errors).toEqual([]);
});

test("PRD §3.20 Tier: editing a tier saves its multiplier and birthday reward", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/kelola/loyalty/tier?mock=normal`, NAV);
  const goldRow = page
    .getByRole("table")
    .getByRole("row")
    .filter({ hasText: "Gold" })
    .first();
  await expect(goldRow).toBeVisible();

  await page.getByRole("button", { name: "Ubah Gold" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Pengali poin")).toHaveValue("1,5");
  await dialog.getByLabel("Pengali poin").fill("2");
  await dialog.getByLabel("Hadiah ulang tahun (poin)").fill("200");
  await dialog.getByRole("button", { name: "Simpan tier" }).click();

  await expect(page.getByText("Tier Gold diperbarui.").first()).toBeVisible();
  await expect(goldRow).toContainText("2×");
  await expect(goldRow).toContainText("200 poin");
});

test("PRD §3.20 Mission: a digital stamp card mission can be created", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/kelola/loyalty/misi?mock=normal`, NAV);
  await expect(
    page.getByRole("table").getByText("Stamp Card 10 Kopi"),
  ).toBeVisible();

  await page.getByRole("button", { name: "Tambah misi" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  await dialog.getByLabel("Nama misi").fill("Stamp Card 5 Kopi");
  await dialog.getByRole("combobox", { name: "Jenis misi" }).click();
  await page.getByRole("option", { name: "Stamp card" }).click();
  await dialog.getByLabel("Jumlah stempel").fill("5");
  await dialog.getByRole("button", { name: "Simpan misi" }).click();

  await expect(
    page.getByText("Misi Stamp Card 5 Kopi ditambahkan.").first(),
  ).toBeVisible();
  const row = page
    .getByRole("table")
    .getByRole("row")
    .filter({ hasText: "Stamp Card 5 Kopi" })
    .first();
  await expect(row).toContainText("5 stempel");
});

test("legend-m8ow: the loyalty lists show empty and error states", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/kelola/loyalty/reward?mock=empty`, NAV);
  await expect(page.getByText("Belum ada reward")).toBeVisible();

  await page.goto(`${MOCK_URL}/kelola/loyalty/tier?mock=error`, NAV);
  await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();
});

test("legend-m8ow: the nav entry opens the loyalty back office", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/kelola?mock=normal`, NAV);
  await page.getByRole("link", { name: "Loyalty" }).click();
  await expect(
    page.getByRole("heading", { name: "Loyalty & member" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/kelola\/loyalty$/);
});
