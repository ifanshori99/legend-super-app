// WS-06 stock-control screens (bead legend-vxj; PRD v1.7 §16 "Inventori &
// Gudang", INV-01, AI-08). Runs against the mock-mode web server (no API, no
// database): `pnpm test:e2e:mock`.
import { expect, test, type Page } from "@playwright/test";

const baseURL =
  process.env.LEGEND_MOCK_WEB_URL ?? process.env.E2E_MOCK_BASE_URL;

test.skip(
  !baseURL,
  "Mock runner not started: use pnpm test:e2e:mock (playwright.mock.config.ts).",
);
test.use({ baseURL });

async function open(page: Page, path: string) {
  await page.goto(path, { waitUntil: "networkidle" });
  // v3 (legend-tqnd/legend-vvth): the management topbar owns the area h1, so
  // it sits outside #main-content; the body shows the section as an h2.
  await expect(
    page.getByRole("heading", { level: 1, name: "Inventori" }),
  ).toBeVisible();
}

/**
 * Server-rendered controls drop a click that lands before hydration. Every
 * interaction below is idempotent, so retry it until React owns the control
 * (same pattern as e2e/legend-c3lm.mock.spec.ts).
 */
async function retry(action: () => Promise<void>) {
  await expect(action).toPass({ timeout: 15_000 });
}

test("INV-01 stock card lists append-only movements with source documents", async ({
  page,
}) => {
  await open(page, "/kelola/inventori/stok");
  await expect(
    page.getByRole("heading", { name: "Kartu stok", exact: true }),
  ).toBeVisible();

  const table = page.getByRole("table");
  await expect(table.getByRole("row").nth(1)).toBeVisible();
  // INV-01: a correction is an adjustment row that points at its source.
  await expect(table.getByText("Penyesuaian").first()).toBeVisible();
  await expect(table.getByText("Stok opname").first()).toBeVisible();

  // The ledger is read-only: no row action can rewrite a posted movement.
  await expect(page.getByRole("button", { name: "Ubah" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Hapus" })).toHaveCount(0);

  // A source document links every line it produced.
  await retry(async () => {
    await table.getByRole("button").first().click();
    await expect(page.getByText(/^Sumber:/)).toBeVisible({ timeout: 1000 });
  });
  await page.getByRole("button", { name: "Hapus filter sumber" }).click();
  await expect(page.getByText(/^Sumber:/)).toHaveCount(0);
});

test("F16 balances per location show par status and critical alerts", async ({
  page,
}) => {
  await open(page, "/kelola/inventori/saldo");

  await expect(
    page.getByRole("heading", { name: "Peringatan stok kritis" }),
  ).toBeVisible();
  await expect(page.getByText("Kopi Arabika Gayo").first()).toBeVisible();
  await expect(page.getByText("Di bawah minimum").first()).toBeVisible();

  await expect(
    page.getByRole("heading", { name: "Saldo per lokasi" }),
  ).toBeVisible();
  await expect(page.getByText("Nilai stok")).toBeVisible();
  await expect(
    page.getByRole("table").getByText("Gudang Utama").first(),
  ).toBeVisible();
});

test("F16 batches follow FEFO and the status filter narrows the table", async ({
  page,
}) => {
  await open(page, "/kelola/inventori/kedaluwarsa");
  await expect(
    page.getByRole("heading", { name: "Gunakan lebih dulu" }),
  ).toBeVisible();

  const table = page.getByRole("table");
  await expect(table.getByRole("row").nth(1)).toContainText("SUSU-1101-A");

  await retry(async () => {
    await page.getByRole("radio", { name: "Tanpa tanggal" }).click();
    await expect(table.getByRole("row").nth(1)).toContainText("ROAST-1101", {
      timeout: 1000,
    });
  });
  await expect(table.getByText("SUSU-1101-A")).toHaveCount(0);
});

test("AI-08 purchase suggestions create a draft purchase request", async ({
  page,
}) => {
  await open(page, "/kelola/inventori/saran");
  await expect(
    page.getByRole("heading", { name: "Saran pembelian", level: 2 }),
  ).toBeVisible();
  await expect(page.getByText("Saran beli").first()).toBeVisible();

  await retry(async () => {
    await page.getByRole("button", { name: "Pilih semua" }).click();
    await expect(page.getByText("3 item dipilih")).toBeVisible({
      timeout: 1000,
    });
  });

  await page.getByRole("button", { name: "Buat draf PR", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Buat draf permintaan pembelian" }),
  ).toBeVisible();
  await expect(dialog).toContainText("3 baris dari saran pembelian");

  await dialog.getByRole("button", { name: "Buat draf", exact: true }).click();

  await expect(
    page.getByText("Draf permintaan pembelian dibuat"),
  ).toBeVisible();
  await expect(
    page.getByText("Draf PR dibuat.", { exact: true }),
  ).toBeVisible();
  // Susu UHT is short in two locations: one outlet-level PR line (review fix).
  await expect(page.getByText("2 baris", { exact: true })).toBeVisible();
});

test("F16 empty and error states are reachable in mock mode", async ({
  page,
}) => {
  await page.goto("/kelola/inventori/saldo?mock=empty");
  await expect(page.getByText("Belum ada saldo stok")).toBeVisible();

  await page.goto("/kelola/inventori/stok?mock=error");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Coba lagi" }).first(),
  ).toBeVisible();
});
