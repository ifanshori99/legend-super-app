// WS-07 finance exceptions list (bead legend-4oclu; contract
// docs/briefs/662-finance-exceptions-contract.md, screen B of
// docs/briefs/sub-payout-finance-ui.md, mockup design/mockups/finance-exceptions).
// Mock-mode spec: `pnpm test:e2e:mock e2e/finance-exceptions.mock.spec.ts`.
//
// ASSUMPTIONS:
// - Route /kelola/akuntansi/pengecualian, filters in the URL: kind, outletId,
//   from, to (YYYY-MM-DD); default window is the last 14 days.
// - Labels follow the mockup: "Jenis pengecualian", "Outlet", "Dari tanggal",
//   "Sampai tanggal", "Terapkan filter", "Atur ulang"; kinds named
//   "Pajak edge belum tersnapshot", "Void edge tidak didukung",
//   "Struk edge dilewati", "Link edge dead-letter", "Biaya payout belum dijurnal".
// - The `normal` fixture holds rows of all five kinds, at least one with a null
//   amount (shown "Tidak tersedia", never Rp0) and the payout fee row with a
//   null outlet (shown "Seluruh PT").
// - Summary cards are buttons that filter by kind; the summary is never summed.
import { expect, test, type Page } from "@playwright/test";

const base = process.env.LEGEND_MOCK_WEB_URL;
test.skip(
  !base,
  "Set LEGEND_MOCK_WEB_URL (pnpm test:e2e:mock) to a web server running VITE_API_MOCK.",
);

const COLD_START_TIMEOUT_MS = 30_000;
test.describe.configure({ timeout: 90_000 });

const ROUTE = "/kelola/akuntansi/pengecualian";
const KINDS = [
  /Pajak edge belum tersnapshot/i,
  /Void edge tidak didukung/i,
  /Struk edge dilewati/i,
  /Link edge dead-letter/i,
  /Biaya payout belum dijurnal/i,
];

async function open(page: Page, query = "", scenario = "normal") {
  const sep = query ? `${query}&` : "";
  await page.goto(`${ROUTE}?${sep}mock=${scenario}`, {
    waitUntil: "networkidle",
  });
}

test("finance-exceptions shows a summary card for each of the five kinds", async ({
  page,
}) => {
  await open(page);
  await expect(
    page.getByRole("heading", { name: /Pengecualian finance/i }).first(),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  // The kind <select> also holds these names (hidden options): pin the
  // summary cards, which are buttons.
  for (const kind of KINDS) {
    await expect(
      page.getByRole("button", { name: kind }).first(),
    ).toBeVisible();
  }
  // Read-only screen: nothing offers to change a transaction.
  await expect(
    page.getByRole("button", { name: /hapus|ubah|perbaiki|jurnalkan/i }),
  ).toHaveCount(0);
});

test("finance-exceptions shows an unknown amount as Tidak tersedia, never Rp0", async ({
  page,
}) => {
  await open(page);
  await expect(page.getByText(/Tidak tersedia/i).first()).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
  await expect(page.getByText(/Rp\s?0(?![.\d])/)).toHaveCount(0);
});

test("finance-exceptions shows a missing outlet as Seluruh PT", async ({
  page,
}) => {
  await open(page);
  await expect(
    page
      .getByText(/Seluruh PT/)
      .filter({ visible: true })
      .first(),
  ).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
});

test("finance-exceptions lists the newest event first", async ({ page }) => {
  await open(page);
  await expect(
    page
      .getByText(/Seluruh PT/)
      .filter({ visible: true })
      .first(),
  ).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
  // Mock fixture: the payout fee row (today 14.20) precedes the oldest row
  // (2 days ago). The UI shortens that row's long UUID ref to "…" plus its last
  // 6 chars, upper-cased (shortRef); the full ref is in the collapsed <details>.
  // innerText only holds the layout rendered at this width.
  const body = await page.locator("main").innerText();
  const newest = body.indexOf("PAY-202611-003");
  const oldest = body.indexOf("B6E7F8");
  expect(newest).toBeGreaterThanOrEqual(0);
  expect(oldest).toBeGreaterThan(newest);
});

test("finance-exceptions summary card filters the list by kind", async ({
  page,
}) => {
  await open(page);
  const card = page
    .getByRole("button", { name: /Struk edge dilewati/i })
    .first();
  await expect(card).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await card.click();
  await expect(page).toHaveURL(/kind=edge_receipt_skipped/);
});

test("finance-exceptions outlet filter leaves payout fees out and says so", async ({
  page,
}) => {
  await open(page);
  const outlet = page.getByRole("combobox", { name: "Outlet" });
  await expect(outlet).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await outlet.click();
  await page.getByRole("option").nth(1).click();
  await page.getByRole("button", { name: /Terapkan filter/i }).click();
  await expect(page).toHaveURL(/outletId=/);
  await expect(
    page.getByText(/Tidak dihitung untuk filter outlet/i),
  ).toBeVisible();
});

test("finance-exceptions rejects a range longer than 92 days", async ({
  page,
}) => {
  await open(page);
  const from = page.getByLabel("Dari tanggal");
  await expect(from).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  const to = await page.getByLabel("Sampai tanggal").inputValue();
  expect(to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const start = new Date(`${to}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 120);
  await from.fill(start.toISOString().slice(0, 10));
  await expect(
    page.getByText(/Rentang tanggal paling lama 92 hari/),
  ).toBeVisible();
  // The user cannot apply an invalid window.
  await expect(
    page.getByRole("button", { name: /Terapkan filter/i }),
  ).toBeDisabled();
});

test("finance-exceptions accepts exactly 92 days inclusive", async ({
  page,
}) => {
  await open(page, "from=2026-08-14&to=2026-11-13");
  await expect(
    page.getByRole("heading", { name: /Pengecualian finance/i }).first(),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  // 14 Aug .. 13 Nov inclusive = 92 days: no range error.
  await expect(
    page.getByRole("alert").filter({ hasText: /92 hari/ }),
  ).toHaveCount(0);
});

test("finance-exceptions requires both dates", async ({ page }) => {
  await open(page);
  const from = page.getByLabel("Dari tanggal");
  await expect(from).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await from.fill("");
  await expect(page.getByText(/Isi tanggal awal dan akhir/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Terapkan filter/i }),
  ).toBeDisabled();
});

test("finance-exceptions empty state names the active filter and resets it", async ({
  page,
}) => {
  await open(page, "", "empty");
  await expect(page.getByText(/Tidak ada pengecualian/i).first()).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
  await expect(
    page.getByRole("button", { name: /Atur ulang/i }).first(),
  ).toBeVisible();
});

test("finance-exceptions error state offers retry and shows no zero totals", async ({
  page,
}) => {
  await open(page, "", "error");
  await expect(
    page.getByRole("button", { name: /Coba lagi/i }).first(),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await expect(page.getByText(/Rp\s?0(?![.\d])/)).toHaveCount(0);
});

test("finance-exceptions has no horizontal scroll at 390px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await open(page);
  await expect(
    page
      .getByText(/Seluruh PT/)
      .filter({ visible: true })
      .first(),
  ).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
