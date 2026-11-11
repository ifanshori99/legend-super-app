import { expect, test, type Page } from "@playwright/test";

// Outlet attribution on manual and recurring journal lines (bead legend-5ac3;
// PRD v1.7 §3.19, ACC-03; mockup jurnal-outlet-5ac3.html). Each line has an
// optional "Outlet baris N" select; "Entitas · tanpa outlet" keeps the line at
// entity level (outletId null).
//
// Run: LEGEND_MOCK_WEB_URL=<mock server> pnpm test:e2e:mock e2e/legend-5ac3.mock.spec.ts
//
// Assumptions: the outlet select defaults to "Entitas · tanpa outlet"; fixture
// outlet names are not fixed, so the test picks the first outlet in the list;
// accounts 6109/1103 (manual) and 6105/2101 (recurring) exist as in
// legend-mzg.mock.spec.ts.
const base = process.env.LEGEND_MOCK_WEB_URL ?? "";
test.skip(base === "", "Set LEGEND_MOCK_WEB_URL (pnpm test:e2e:mock).");
test.describe.configure({ timeout: 90_000 });

const ENTITY = "Entitas · tanpa outlet";

async function open(page: Page, path: string) {
  await page.goto(`${base}${path}`);
  await page.waitForLoadState("networkidle");
}

async function pick(page: Page, name: string, option: string | RegExp) {
  await page.getByRole("combobox", { name }).click();
  await page.getByRole("option", { name: option }).first().click();
}

/** Picks the first real outlet on a line and returns its name. */
async function pickFirstOutlet(page: Page, line: number) {
  await page.getByRole("combobox", { name: `Outlet baris ${line}` }).click();
  const options = page.getByRole("option");
  await expect(options.first()).toHaveText(ENTITY);
  const outlet = options.nth(1);
  const name = (await outlet.innerText()).trim();
  await outlet.click();
  return name;
}

test.describe("legend-5ac3 outlet on journal lines", () => {
  test("a manual journal attributes one line to an outlet and keeps the other at entity level", async ({
    page,
  }) => {
    await open(page, "/kelola/akuntansi/jurnal-manual/baru");
    await expect(
      page.getByRole("heading", { name: "Jurnal manual baru" }),
    ).toBeVisible();
    await expect(
      page.getByText("Tanpa outlet, baris dicatat pada tingkat badan usaha."),
    ).toBeVisible();

    // Default keeps ACC-01 behavior: entity-level.
    await expect(
      page.getByRole("combobox", { name: "Outlet baris 1" }),
    ).toContainText(ENTITY);

    await page.getByLabel("Keterangan").fill("Uji 5ac3 alokasi sewa");
    await pick(page, "Akun baris 1", /6109/);
    await page.getByLabel("Debit baris 1").fill("500000");
    const outlet = await pickFirstOutlet(page, 1);
    await expect(
      page.getByRole("combobox", { name: "Outlet baris 1" }),
    ).toContainText(outlet);
    await pick(page, "Akun baris 2", /1103/);
    await page.getByLabel("Kredit baris 2").fill("500000");
    await expect(
      page.getByRole("combobox", { name: "Outlet baris 2" }),
    ).toContainText(ENTITY);

    await expect(
      page.getByText("Seimbang", { exact: true }).first(),
    ).toBeVisible();
    await page.getByRole("button", { name: "Simpan draf" }).click();
    await page.waitForURL(/jurnal-manual\/[0-9a-f-]{36}/);
  });

  test("a recurring template line can carry an outlet too", async ({
    page,
  }) => {
    await open(page, "/kelola/akuntansi/jurnal-berulang");
    await page.getByRole("button", { name: "Tambah templat" }).click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("combobox", { name: "Outlet baris 1" }),
    ).toContainText(ENTITY);

    await dialog.getByLabel("Keterangan").fill("Uji 5ac3 templat sewa");
    await pick(page, "Akun baris 1", /6105/);
    await dialog.getByLabel("Debit baris 1").fill("1000000");
    await pickFirstOutlet(page, 1);
    await pick(page, "Akun baris 2", /2101/);
    await dialog.getByLabel("Kredit baris 2").fill("1000000");
    await dialog.getByRole("button", { name: "Simpan templat" }).click();
    await expect(
      page.getByRole("table").getByText("Uji 5ac3 templat sewa"),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("an unbalanced journal still cannot be saved", async ({ page }) => {
    await open(page, "/kelola/akuntansi/jurnal-manual/baru");
    await page.getByLabel("Keterangan").fill("Uji 5ac3 tidak seimbang");
    await pick(page, "Akun baris 1", /6109/);
    await page.getByLabel("Debit baris 1").fill("500000");
    await pick(page, "Akun baris 2", /1103/);
    await page.getByLabel("Kredit baris 2").fill("400000");
    // Amounts group thousands while typing (value sent to the API stays whole rupiah).
    await expect(page.getByLabel("Debit baris 1")).toHaveValue("500.000");
    await expect(page.getByText(/Selisih Rp/)).toBeVisible();
    await expect(
      page.getByRole("alert").filter({ hasText: "Jurnal belum seimbang" }),
    ).toContainText("Debit lebih besar Rp");
    await expect(
      page.getByRole("button", { name: "Simpan draf" }),
    ).toBeDisabled();
  });

  test("the lines block shows its error state with a retry", async ({
    page,
  }) => {
    // ?mock=error fails every call, including the legal-entity list, so the
    // entity scope errors before the lines block exists. Fail only the account
    // list (a 4xx is not retried) and reach the form from the journal list.
    await open(page, "/kelola/akuntansi/jurnal-manual");
    await page.evaluate(() => {
      (
        window as unknown as {
          __legendMock: {
            failNext: (
              match: string,
              failure: { status: number; code: string },
            ) => void;
          };
        }
      ).__legendMock.failNext(
        "GET /api/accounting/legal-entities/:legalEntityId/accounts",
        { status: 404, code: "NOT_FOUND" },
      );
    });
    await page.getByRole("link", { name: "Jurnal manual baru" }).click();
    await expect(page.getByText("Data jurnal belum bisa dimuat")).toBeVisible();
    await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();

    // Retry loads the accounts and the editor appears.
    await page.getByRole("button", { name: "Coba lagi" }).click();
    await expect(
      page.getByRole("combobox", { name: "Akun baris 1" }),
    ).toBeVisible();
  });
});
