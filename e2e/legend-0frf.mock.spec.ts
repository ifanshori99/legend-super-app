import { expect, test, type Page } from "@playwright/test";
import { waitForHydration } from "./hydration.ts";

// Menu item editor: station type per item and optional outlet-only station
// override (bead legend-0frf; mockup menu-stasiun-0frf.html). Brand-level
// "Tipe stasiun" is required; "Stasiun khusus" applies only in the chosen
// outlet and is optional.
//
// Run: LEGEND_MOCK_WEB_URL=<mock server> pnpm test:e2e:mock e2e/legend-0frf.mock.spec.ts
//
// Assumptions: the required-type error is reached through the create form
// (/kelola/menu/baru), where no type is preselected; the station section is
// visible on the editor without opening another tab.
const base = process.env.LEGEND_MOCK_WEB_URL ?? "";
test.skip(base === "", "Set LEGEND_MOCK_WEB_URL (pnpm test:e2e:mock).");

const ESPRESSO_ID = "00000000-0000-4000-8000-000000001000"; // fixture item

async function open(page: Page, path: string) {
  await page.goto(`${base}${path}`, { waitUntil: "networkidle" });
  await waitForHydration(page);
}

async function choose(page: Page, label: string, option: string | RegExp) {
  await page.getByRole("combobox", { name: label }).click();
  await page.getByRole("option", { name: option }).first().click();
}

test.describe("legend-0frf station routing on the item editor", () => {
  test("an admin sets the station type and sees where the outlet will route", async ({
    page,
  }) => {
    test.slow();
    await open(page, `/kelola/menu/${ESPRESSO_ID}?mock=normal`);

    await expect(
      page.getByRole("heading", { name: "Routing stasiun" }),
    ).toBeVisible();
    await expect(page.getByText("Item merek")).toBeVisible();
    await expect(page.getByText("Stasiun khusus outlet")).toBeVisible();

    await choose(page, "Tipe stasiun", "Dapur panas");
    // The fixture item already carries an outlet-only station, which wins over
    // the type until it is cleared.
    await expect(page.getByText(/^Stasiun khusus: /)).toBeVisible();
    await choose(page, "Stasiun khusus (opsional)", "Gunakan tipe stasiun");
    await expect(page.getByText("Mengikuti tipe: Dapur panas")).toBeVisible();
    await expect(page.getByText(/^Tujuan untuk /)).toBeVisible();

    await page.getByRole("button", { name: "Simpan item" }).click();
    await expect(
      page.getByText("Pengaturan item berhasil disimpan.").first(),
    ).toBeVisible();
  });

  test("an outlet-only station override replaces the type for that outlet", async ({
    page,
  }) => {
    test.slow();
    await open(page, `/kelola/menu/${ESPRESSO_ID}?mock=normal`);

    const override = page.getByRole("combobox", { name: /^Stasiun khusus/ });
    await override.click();
    // First real station after "Gunakan tipe stasiun".
    const options = page.getByRole("option");
    await expect(options.first()).toHaveText("Gunakan tipe stasiun");
    const station = options.nth(1);
    const name = (await station.innerText()).trim();
    await station.click();

    await expect(page.getByText(`Stasiun khusus: ${name}`)).toBeVisible();
    await expect(
      page.getByText("Pilihan ini hanya berlaku di outlet yang dipilih."),
    ).toBeVisible();

    // Back to "follow the type".
    await choose(page, "Stasiun khusus (opsional)", "Gunakan tipe stasiun");
    await expect(page.getByText(/^Mengikuti tipe: /)).toBeVisible();
  });

  test("a new item cannot be saved without a station type", async ({
    page,
  }) => {
    test.slow();
    await open(page, "/kelola/menu/baru?mock=normal");
    await expect(
      page.getByRole("combobox", { name: "Tipe stasiun" }),
    ).toContainText("Pilih tipe stasiun");
    await expect(page.getByText("Mengikuti tipe: belum dipilih")).toBeVisible();

    await page.getByRole("button", { name: "Simpan item" }).click();
    await expect(
      page.getByText("Pilih tipe stasiun untuk item ini."),
    ).toBeVisible();
  });
});
