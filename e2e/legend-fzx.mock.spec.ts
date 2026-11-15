// WS-06 stock opname and waste (bead legend-fzx · PRD v1.7 §3 F16, §4 Alur J,
// INV-03). Runs against the mock-mode web server (no API, no database):
// `LEGEND_MOCK_PORT=3244 pnpm test:e2e:mock e2e/legend-fzx.mock.spec.ts`.
import { expect, test, type Page } from "@playwright/test";
import { waitForHydration } from "./hydration.ts";

const baseURL =
  process.env.LEGEND_MOCK_WEB_URL ?? process.env.E2E_MOCK_BASE_URL;

test.skip(
  !baseURL,
  "Mock runner not started: use pnpm test:e2e:mock (playwright.mock.config.ts).",
);
test.use({ baseURL });

/** Clicks a button that opens a dialog, retrying a lost pre-hydration click. */
async function openDialog(page: Page, name: string) {
  const dialog = page.getByRole("dialog");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.getByRole("button", { name }).first().click();
    try {
      await dialog.waitFor({ state: "visible", timeout: 2000 });
      return dialog;
    } catch {
      // The click landed before hydration; try again.
    }
  }
  throw new Error(`Dialog did not open after clicking "${name}".`);
}

async function openCounts(page: Page) {
  await page.goto("/kelola/inventori/opname");
  await waitForHydration(page);
  // v3 (legend-vvth): the management topbar owns the page h1; the page body
  // no longer repeats it (DESIGN.md v3 §5).
  await expect(
    page.getByRole("heading", { level: 1, name: "Inventori" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Sesi stok opname" }),
  ).toBeVisible();
}

async function createCycleCount(page: Page) {
  const dialog = await openDialog(page, "Mulai opname");
  await dialog.getByRole("radio", { name: "Hitung siklus" }).click();
  // Two items keep the phone count short and assertable.
  const checkboxes = dialog.getByRole("checkbox");
  await expect(checkboxes.first()).toBeVisible();
  await checkboxes.nth(0).click();
  await checkboxes.nth(1).click();
  await dialog.getByRole("button", { name: "Buat sesi" }).click();
  await expect(page).toHaveURL(/\/kelola\/inventori\/opname\/[0-9a-f-]+$/);
  await expect(
    page.getByRole("heading", { name: "Hitung siklus" }),
  ).toBeVisible();
  await expect(page.getByText("Draf", { exact: true })).toBeVisible();
}

async function startAndCount(page: Page, quantities: string[]) {
  const dialog = await openDialog(page, "Mulai hitung");
  await dialog.getByRole("button", { name: "Mulai hitung" }).click();
  await expect(
    page.getByText("Sedang dihitung", { exact: true }),
  ).toBeVisible();

  const inputs = page.getByRole("textbox", { name: /^Jumlah fisik/ });
  await expect(inputs).toHaveCount(quantities.length);
  for (const [index, quantity] of quantities.entries()) {
    await inputs.nth(index).fill(quantity);
    await inputs.nth(index).blur();
  }
  return inputs;
}

test("INV-03 blind count hides the system quantity while the counter is counting", async ({
  page,
}) => {
  await openCounts(page);
  await page.goto("/kelola/inventori/opname");
  await waitForHydration(page);
  await createCycleCount(page);

  const dialog = await openDialog(page, "Mulai hitung");
  await dialog.getByRole("button", { name: "Mulai hitung" }).click();
  await expect(
    page.getByText("Sedang dihitung", { exact: true }),
  ).toBeVisible();

  // PRD §16 "hitung buta": no system number on the counting screen.
  await expect(page.getByText(/^Sistem:/)).toHaveCount(0);
  await expect(page.getByText("Sesi hitung buta")).toBeVisible();
});

test("INV-03 opname flow: create, count blind, submit, approve by another person, post", async ({
  page,
}) => {
  await openCounts(page);
  await createCycleCount(page);
  await startAndCount(page, ["5", "4"]);

  // The counter submits; the adjustment is not booked yet (INV-03).
  await page.getByRole("button", { name: "Kirim untuk persetujuan" }).click();
  await expect(
    page.getByText("Menunggu persetujuan", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Total nilai selisih")).toBeVisible();
  await expect(
    page.getByText("Penyesuaian sudah dibukukan ke kartu stok."),
  ).toHaveCount(0);

  // A different person (the mock outlet manager) approves.
  await page.getByRole("button", { name: "Setujui hitungan" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Setujui" })
    .click();
  await expect(page.getByText("Disetujui", { exact: true })).toBeVisible();

  // Posting is the step that writes the adjustment rows.
  await page.getByRole("button", { name: "Bukukan penyesuaian" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Bukukan" })
    .click();
  await expect(
    page.getByText("Sudah dibukukan", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Penyesuaian sudah dibukukan ke kartu stok."),
  ).toBeVisible();
});

test("INV-03 waste log records reason, rupiah loss and the optional photo", async ({
  page,
}) => {
  await page.goto("/kelola/inventori/waste");
  await waitForHydration(page);
  await expect(
    page.getByRole("heading", { name: "Catatan waste" }),
  ).toBeVisible();
  await expect(page.getByText("Nilai kerugian")).toBeVisible();

  const dialog = await openDialog(page, "Catat waste");

  await dialog.locator("#waste-target").click();
  const option = page.getByRole("option").first();
  const targetName = (await option.textContent())?.trim() ?? "";
  await option.click();

  await dialog.getByLabel("Kuantitas").fill("1");
  await dialog.locator("#waste-reason").click();
  await page.getByRole("option", { name: "Kedaluwarsa" }).click();

  await dialog
    .locator('input[type="file"]')
    .setInputFiles("apps/web/demo/sample/menu/croissant-mentega.jpg");
  await expect(dialog.getByAltText("Pratinjau foto bukti")).toBeVisible();
  await expect(dialog.getByAltText("Pratinjau foto bukti")).toHaveAttribute(
    "src",
    /^blob:/,
  );
  await expect(
    dialog.getByRole("button", { name: "Simpan catatan" }),
  ).toBeEnabled();

  await dialog.getByRole("button", { name: "Simpan catatan" }).click();
  await expect(
    page.getByText("Catatan waste tersimpan", { exact: true }).first(),
  ).toBeVisible();

  const row = page
    .getByRole("listitem")
    .filter({ hasText: targetName })
    .filter({ hasText: "Kedaluwarsa" })
    .first();
  await expect(row).toBeVisible();
  await expect(row.getByText("Foto")).toBeVisible();
});

test("INV-03 opname list shows its empty and error states", async ({
  page,
}) => {
  await page.goto("/kelola/inventori/opname?mock=empty");
  await waitForHydration(page);
  await expect(page.getByText("Belum ada sesi opname")).toBeVisible();

  await page.goto("/kelola/inventori/opname?mock=error");
  await expect(page.getByRole("alert")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();
});
