import { expect, test } from "@playwright/test";

// Kitchen config & analytics (bead legend-uq2, PRD v1.7 §3 F12) against mock
// mode: VITE_API_MOCK=true serves the @starter/shared/kitchen fixtures, so
// these flows need no API or database. `pnpm test:e2e:mock` starts that server
// and exports LEGEND_MOCK_WEB_URL; `pnpm test:e2e` skips this file.
const mockWebUrl = process.env.LEGEND_MOCK_WEB_URL;
test.skip(
  mockWebUrl === undefined,
  "Set LEGEND_MOCK_WEB_URL to a VITE_API_MOCK=true web server to run the mock-mode screens.",
);
test.use({ baseURL: mockWebUrl ?? "http://localhost:3000" });

test("KDS-05 · kitchen config replaces a station's capacity rules", async ({
  page,
}) => {
  await page.goto("/kelola/dapur");
  await expect(
    page.getByRole("heading", { name: "Dapur", level: 1 }).first(),
  ).toBeVisible();
  // The first mock-mode visit transforms the route on demand; give it room.
  await expect(
    page.getByRole("heading", { name: "Kopi", exact: true }),
  ).toBeVisible({ timeout: 20_000 });

  const station = page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name: "Kopi", exact: true }) });
  await expect(station).toContainText("29 dari 30 poin");
  await expect(station).toContainText("Peringatan 90%");

  await station.getByRole("button", { name: "Ubah kapasitas" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Kapasitas Kopi" }),
  ).toBeVisible();

  const capacity = dialog.getByLabel("Kapasitas (poin)");
  await capacity.fill("32");
  await dialog.getByRole("button", { name: "Simpan kapasitas" }).click();

  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("status").filter({ hasText: "Aturan kapasitas Kopi" }),
  ).toBeVisible();
  await expect(station).toContainText("29 dari 32 poin");
  await expect(station).toContainText("32 poin");
});

test("F12 · serving-time report groups by station, hour and staff", async ({
  page,
}) => {
  // The report defaults to the last 7 days and the kitchen fixtures are dated
  // 1 Nov 2026, so pin the browser clock to the fixture day (legend-nv3y).
  await page.clock.setFixedTime(new Date("2026-11-01T12:00:00.000+07:00"));
  await page.goto("/kelola/dapur/laporan");
  await expect(
    page.getByRole("heading", { name: "Analitik waktu saji" }),
  ).toBeVisible();
  await expect(page.getByText("Dapur", { exact: true }).last()).toBeVisible();
  await expect(
    page.getByText("12 mnt", { exact: false }).first(),
  ).toBeVisible();
  await expect(page.getByText("0%").first()).toBeVisible();

  await page.getByRole("radio", { name: "Jam" }).click();
  await expect(
    page.getByText("Jam 11:00", { exact: true }).first(),
  ).toBeVisible();

  await page.getByRole("radio", { name: "Staf" }).click();
  await expect(page.getByText("Pastry", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("100%", { exact: true }).first()).toBeVisible();
});

test("KDS-07 · remake and comp log shows reason, staff and ingredient cost", async ({
  page,
}) => {
  await page.goto("/kelola/dapur/remake");
  await expect(
    page.getByRole("heading", { name: "Log remake & comp" }),
  ).toBeVisible();

  const table = page.getByRole("table");
  await expect(table).toContainText("Terlambat");
  await expect(table).toContainText("Ayam kembali dingin saat disajikan");
  await expect(table).toContainText("Budi Santoso");
  await expect(table).toContainText("12.500");
  await expect(table).toContainText("Disetujui Rina Pratama");

  await page.getByRole("combobox", { name: "Jenis" }).click();
  await page.getByRole("option", { name: "Remake" }).click();
  await expect(table).toContainText("Terlambat");
  await expect(table).not.toContainText("Kualitas");

  await page.getByRole("combobox", { name: "Stasiun" }).click();
  await page.getByRole("option", { name: "Pastry" }).click();
  await expect(
    page.getByText("Tidak ada catatan untuk filter ini"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Hapus filter" }),
  ).toBeVisible();
});

test("KDS-07 · remake and comp log has loading, empty and error states", async ({
  page,
}) => {
  await page.goto("/kelola/dapur/remake?mock=empty");
  await expect(
    page.getByText("Belum ada remake atau comp", { exact: true }),
  ).toBeVisible();

  await page.goto("/kelola/dapur/remake?mock=error");
  await expect(
    page.getByText("Log tidak dapat dimuat", { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();
});
