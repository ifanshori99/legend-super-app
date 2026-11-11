import { expect, test, type Page } from "@playwright/test";
import { waitForHydration } from "./hydration.ts";

// Tax rule targets, outlet versions, discard draft (bead legend-woc1) and the
// warning before deactivating the only food_beverage rule (bead legend-d5pz).
// Mockups: tax-woc1.html, pajak-peringatan-d5pz.html. PRD v1.7 §3.14 "Aturan
// Pajak Berversi": a rule targets item classes, categories or items; an outlet
// version overrides the tenant-wide code; a published version is immutable.
//
// Run: LEGEND_MOCK_WEB_URL=<mock server> pnpm test:e2e:mock e2e/legend-woc1.mock.spec.ts
//
// Assumptions (the specs below depend on them):
// - Fixture: PBJT-FNB v1 published ("Berlaku sekarang", the only active
//   food_beverage rule) and PBJT-FNB v2 draft "(draf revisi)".
// - The settings tab (Opsi perhitungan) has no seeded draft in the fixture, so
//   the test creates one with "Versi baru" + "Simpan draf" when none exists.
// - There is no "Nonaktifkan" row button. Deactivating means: "Versi baru" on
//   the published row, switch "Aturan aktif" off, "Simpan draf"; because it is
//   the only active food_beverage rule, a confirm dialog opens with Batal /
//   Atur tarif 0% / Tetap nonaktifkan. The deactivation is saved as a draft
//   version (the published version stays "Berlaku sekarang" until published).
// - "Kategori menu" / "Item menu" are checkbox groups (fieldset legends, with
//   an "(Opsional)" suffix) fed by the menu fixture: category Kopi, item
//   Espresso.
// - The status badge reads "<status> · v<n>" in one chip (e.g. "Diterbitkan · v1",
//   "Draf · v2"), so status is matched by /^Draf · v\d+$/ rather than exact "Draf".
const base = process.env.LEGEND_MOCK_WEB_URL ?? "";
test.skip(base === "", "Set LEGEND_MOCK_WEB_URL (pnpm test:e2e:mock).");

async function open(page: Page, path = "/kelola/pajak") {
  await page.goto(`${base}${path}`);
  await waitForHydration(page);
}

const draftRow = (page: Page) =>
  page.getByRole("row").filter({ hasText: "draf revisi" });
const liveRow = (page: Page) =>
  page
    .getByRole("row")
    .filter({ hasText: "PBJT-FNB" })
    .filter({ hasText: "Berlaku sekarang" });

/** Ticks one checkbox inside a target group ("Kategori menu" / "Item menu"). */
async function tick(page: Page, group: string, option: string) {
  const box = page
    .getByRole("dialog")
    .getByRole("group", { name: new RegExp(`^${group}`) });
  await box.getByRole("checkbox", { name: option, exact: true }).check();
  await expect(box.getByText("1 dipilih")).toBeVisible();
}

/**
 * Opens the new-version dialog of the live PBJT-FNB rule, switches "Aturan
 * aktif" off and saves; returns the confirm dialog that must appear because
 * this is the only active food_beverage rule.
 */
async function startDeactivation(page: Page) {
  await liveRow(page).getByRole("button", { name: "Versi baru" }).click();
  const form = page.getByRole("dialog");
  await expect(
    form.getByRole("heading", { name: "Versi baru PBJT-FNB" }),
  ).toBeVisible();
  await form.getByRole("switch", { name: "Aturan aktif" }).click();
  await form.getByRole("button", { name: "Simpan draf" }).click();
  const confirm = page.getByRole("dialog");
  await expect(
    confirm.getByRole("heading", {
      name: "Nonaktifkan aturan pajak terakhir?",
    }),
  ).toBeVisible();
  return confirm;
}

test.describe("legend-woc1 tax rules", () => {
  test("a new rule targets categories and items of one outlet and is saved as a draft", async ({
    page,
  }) => {
    test.slow();
    await open(page);

    await page.getByRole("button", { name: "Buat aturan" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Buat aturan pajak" }),
    ).toBeVisible();
    await expect(
      dialog.getByText(
        "Aturan baru disimpan sebagai draf sebelum diterbitkan.",
      ),
    ).toBeVisible();

    await dialog.getByLabel("Kode aturan").fill("PBJT-WOC1");
    await dialog.getByLabel("Nama aturan").fill("PBJT khusus outlet");
    await dialog.getByLabel("Tarif (%)").fill("10");

    // Outlet override: "Semua outlet" is the default; pick a specific outlet.
    const outlet = dialog.getByLabel("Berlaku untuk outlet");
    await expect(outlet).toContainText("Semua outlet");
    await expect(
      dialog.getByText(
        "Versi outlet menggantikan aturan dengan kode yang sama untuk outlet ini.",
      ),
    ).toBeVisible();
    await outlet.click();
    const outletOption = page
      .getByRole("option")
      .filter({ hasNotText: "Semua outlet" })
      .first();
    const outletName = (await outletOption.innerText()).trim();
    await outletOption.click();

    // Targets come from the menu contract.
    await expect(
      dialog.getByText("Pilih satu atau lebih kategori dari menu."),
    ).toBeVisible();
    await tick(page, "Kategori menu", "Kopi");
    await tick(page, "Item menu", "Espresso");

    await dialog.getByRole("button", { name: "Simpan draf" }).click();
    await expect(
      page.getByText("Draf aturan pajak dibuat.", { exact: true }),
    ).toBeVisible();
    const row = page.getByRole("row").filter({ hasText: "PBJT-WOC1" });
    await expect(row).toContainText(outletName);
    await expect(row.getByText(/^Draf · v\d+$/)).toBeVisible();
  });

  test("a rule without a rate is refused with a message", async ({ page }) => {
    test.slow();
    await open(page);
    await page.getByRole("button", { name: "Buat aturan" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Kode aturan").fill("PBJT-KOSONG");
    await dialog.getByLabel("Nama aturan").fill("Tanpa tarif");
    await dialog.getByRole("button", { name: "Simpan draf" }).click();
    await expect(dialog.getByText(
        "Tulis angka 0–100, maksimal dua desimal (misalnya 10 atau 5,5).",
      )).toBeVisible();
    await expect(dialog).toBeVisible();
  });

  test("a rule draft can be discarded, a published version cannot", async ({
    page,
  }) => {
    test.slow();
    await open(page);

    // Published rows have no discard action.
    await expect(
      liveRow(page).getByRole("button", { name: /Buang draf/ }),
    ).toHaveCount(0);

    await draftRow(page)
      .getByRole("button", { name: /Buang draf/ })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Buang draf aturan pajak?" }),
    ).toBeVisible();
    await expect(
      dialog.getByText(
        "Draf versi 2 akan diarsipkan dan tidak dapat diterbitkan. Versi yang sudah diterbitkan tetap berlaku.",
      ),
    ).toBeVisible();

    // Cancel keeps the draft.
    await dialog.getByRole("button", { name: "Batal" }).click();
    await expect(draftRow(page)).toBeVisible();

    await draftRow(page)
      .getByRole("button", { name: /Buang draf/ })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Buang draf", exact: true })
      .click();
    await expect(
      // exact: the toast's screen-reader live region repeats it with a prefix.
      page.getByText(
        "Draf berhasil dibuang. Versi yang diterbitkan tetap berlaku.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(draftRow(page)).toHaveCount(0);
    await expect(liveRow(page)).toBeVisible();
  });

  test("a calculation-options draft can be edited and discarded", async ({
    page,
  }) => {
    test.slow();
    await open(page, "/kelola/pajak/opsi");
    await expect(page.getByText("Opsi yang berlaku")).toBeVisible();

    if (
      (await page.getByRole("button", { name: /Buang draf/ }).count()) === 0
    ) {
      await page.getByRole("button", { name: "Versi baru" }).first().click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Simpan draf" })
        .click();
      await expect(
        page.getByRole("button", { name: /Buang draf/ }).first(),
      ).toBeVisible();
    }

    // Edit: the draft opens in the "Ubah draf opsi perhitungan" dialog.
    await page.getByRole("button", { name: /^Ubah/ }).first().click();
    const edit = page.getByRole("dialog");
    await expect(
      edit.getByRole("heading", { name: "Ubah draf opsi perhitungan" }),
    ).toBeVisible();
    await expect(
      edit.getByRole("switch", { name: "Harga termasuk pajak" }),
    ).toBeVisible();
    await expect(edit.getByLabel("Pembulatan pajak")).toBeVisible();
    await expect(edit.getByLabel("Alokasi paket campuran")).toBeVisible();
    await edit.getByRole("button", { name: "Batal" }).click();

    await page
      .getByRole("button", { name: /Buang draf/ })
      .first()
      .click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Buang draf opsi perhitungan?" }),
    ).toBeVisible();
    await dialog
      .getByRole("button", { name: "Buang draf", exact: true })
      .click();
    await expect(
      // exact: the toast's screen-reader live region repeats it with a prefix.
      page.getByText(
        "Draf berhasil dibuang. Versi yang diterbitkan tetap berlaku.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /Buang draf/ })).toHaveCount(
      0,
    );
  });

  test("empty and error states explain what to do next", async ({ page }) => {
    test.slow();
    await open(page, "/kelola/pajak?mock=empty");
    await expect(page.getByText("Belum ada aturan pajak")).toBeVisible();
    await expect(
      page.getByText(
        "Buat aturan untuk menentukan pajak yang berlaku pada item atau kategori.",
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Buat aturan" }).first(),
    ).toBeVisible();

    await open(page, "/kelola/pajak?mock=error");
    await expect(page.getByText("Data tidak dapat dimuat")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();
  });
});

test.describe("legend-d5pz deactivate the only food_beverage rule", () => {
  test("warns that sales will fail and points to a 0% rule", async ({
    page,
  }) => {
    test.slow();
    await open(page);

    const dialog = await startDeactivation(page);
    await expect(dialog.getByText("Transaksi dapat gagal")).toBeVisible();
    await expect(
      dialog.getByText(
        /transaksi makanan dan minuman di POS dan pesanan QR tidak dapat dihitung/,
      ),
    ).toBeVisible();
    await expect(dialog.getByText("Untuk transaksi bebas pajak")).toBeVisible();
    await expect(
      dialog.getByText(/Tetapkan aturan aktif dengan tarif 0%/),
    ).toBeVisible();

    // Cancel changes nothing: back to the form, no draft was created.
    await dialog.getByRole("button", { name: "Batal" }).click();
    await expect(
      page.getByRole("heading", { name: "Nonaktifkan aturan pajak terakhir?" }),
    ).toBeHidden();
    await expect(
      page.getByRole("heading", { name: "Versi baru PBJT-FNB" }),
    ).toBeVisible();
    await expect(
      page.getByText("Draf aturan pajak dibuat.", { exact: true }),
    ).toHaveCount(0);
  });

  test("'Atur tarif 0%' returns to the form with an active 0% rate instead of deactivating", async ({
    page,
  }) => {
    test.slow();
    await open(page);
    const dialog = await startDeactivation(page);
    await dialog.getByRole("button", { name: "Atur tarif 0%" }).click();

    const form = page.getByRole("dialog");
    await expect(
      form.getByText(
        "Buat versi aturan aktif dengan tarif 0% untuk transaksi bebas pajak.",
      ),
    ).toBeVisible();
    await expect(form.getByLabel("Tarif (%)")).toHaveValue("0");
    await expect(form.getByRole("switch", { name: "Aturan aktif" })).toBeChecked();

    // Saving now needs no warning: the rule stays active.
    await form.getByRole("button", { name: "Simpan draf" }).click();
    await expect(
      page.getByText("Draf aturan pajak dibuat.", { exact: true }),
    ).toBeVisible();
    await expect(liveRow(page)).toBeVisible();
  });

  test("'Tetap nonaktifkan' saves the inactive version after the warning", async ({
    page,
  }) => {
    test.slow();
    await open(page);
    const dialog = await startDeactivation(page);
    await dialog.getByRole("button", { name: "Tetap nonaktifkan" }).click();

    await expect(
      page.getByText("Draf aturan pajak dibuat.", { exact: true }),
    ).toBeVisible();
    // The new inactive version is a second PBJT-FNB draft next to the seeded
    // revision; the published version keeps applying until it is published.
    await expect(
      page
        .getByRole("row")
        .filter({ hasText: "PBJT-FNB" })
        .getByText(/^Draf · v\d+$/),
    ).toHaveCount(2);
    await expect(liveRow(page)).toBeVisible();
  });
});
