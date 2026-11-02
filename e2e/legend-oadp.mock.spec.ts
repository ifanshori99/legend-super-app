import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots";

// Promo admin (bead legend-oadp; PRD v1.7 §3 F21 / §3.21 "Promo Engine", "ROI
// Promo") against the FE mock runtime: no API, no database. Screens read the
// @starter/shared/crm promotion and voucher fixtures through VITE_API_MOCK=true.
//
// How to run: `LEGEND_MOCK_PORT=3295 pnpm test:e2e:mock e2e/legend-oadp.mock.spec.ts`
// starts a mock-mode web server and names it in LEGEND_MOCK_WEB_URL. The
// production e2e config ignores `*.mock.spec.ts`, and with no variable set
// every test skips. `LEGEND_CAPTURE_SCREENSHOTS=1` refreshes
// docs/design/screenshots/legend-oadp/.
const MOCK_URL = process.env.LEGEND_MOCK_WEB_URL;

test.skip(
  !MOCK_URL,
  "Needs a VITE_API_MOCK=true server (pnpm test:e2e:mock); see the header of this file.",
);

const NAV = { waitUntil: "networkidle" as const };

async function tab(page: Page, name: string) {
  await page
    .getByRole("navigation", { name: "Promo & voucher" })
    .getByRole("link", { name, exact: true })
    .click();
}

test("PRD §3.21 List: promotions show status, benefit in words, quota and budget; the status filter narrows them", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(`${MOCK_URL}/kelola/promo?mock=normal`, NAV);
  await expect(page.getByRole("heading", { name: "Promo & voucher" })).toBeVisible();

  const current = page
    .getByRole("navigation", { name: "Promo & voucher" })
    .locator('a[aria-current="page"]');
  await expect(current).toHaveCount(1);
  await expect(current).toHaveText("Promo");

  const row = page
    .getByRole("table")
    .getByRole("row")
    .filter({ hasText: "Diskon 10% Semua Menu" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("diskon 10%");
  await expect(row).toContainText("Aktif");
  // Budget spent vs budget: Rp1.250.000 of Rp5.000.000 = 25%.
  await expect(row.getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "25",
  );
  await expect(
    page.getByRole("table").getByText("Promo Ramadan (draft)"),
  ).toBeVisible();

  await page.getByRole("combobox", { name: "Filter status promo" }).click();
  await page.getByRole("option", { name: "Draf" }).click();
  await expect(
    page.getByRole("table").getByText("Promo Ramadan (draft)"),
  ).toBeVisible();
  await expect(
    page.getByRole("table").getByText("Diskon 10% Semua Menu"),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("PRD §3.21 Rule builder: a percent promo with minimum spend gets a plain-language summary, a conflict warning and saves to the list", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/kelola/promo?mock=normal`, NAV);
  await page.getByRole("link", { name: "Buat promo" }).click();
  await expect(page.getByRole("button", { name: "Simpan promo" })).toBeVisible();

  // Validation first: an empty form says what to fix and sends nothing.
  await page.getByRole("button", { name: "Simpan promo" }).click();
  await expect(page.getByText("Isi nama promo.")).toBeVisible();

  await page.getByLabel("Nama promo").fill("Kopi Pagi 15%");
  await page.getByLabel("Minimum belanja", { exact: true }).click();
  await page.getByLabel("Minimum belanja (Rp)").fill("50000");
  await page.getByLabel("Diskon (%)").fill("15");

  const summary = page.getByTestId("promo-summary");
  await expect(summary).toContainText("diskon 15%");
  await expect(summary).toContainText(/belanja minimal Rp\s*50\.000/);
  await expect(summary).toContainText("Berlaku");

  // Default policy is exclusive: the new promo competes with the active ones.
  await expect(page.getByTestId("promo-conflicts")).toContainText(
    "Kebijakan saat ini eksklusif",
  );

  await page.getByRole("button", { name: "Simpan promo" }).click();
  await expect(page.getByText("Promo Kopi Pagi 15% dibuat.").first()).toBeVisible();
  await expect(
    page.getByRole("table").getByText("Kopi Pagi 15%"),
  ).toBeVisible();
});

test("PRD §3.21 Rule types: every benefit and condition of the contract can be built, and buy-X-get-Y without a buy condition is flagged", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/kelola/promo/baru?mock=normal`, NAV);

  for (const label of [
    "Minimum belanja",
    "Kanal penjualan",
    "Member / tier",
    "Jam & hari (happy hour)",
    "Jumlah item tertentu",
    "Paket item",
  ]) {
    await page.getByLabel(label, { exact: true }).click();
  }
  await expect(page.getByText("Kanal yang berlaku")).toBeVisible();
  await expect(page.getByText("Hari berlaku")).toBeVisible();
  await expect(page.getByLabel("Jam mulai")).toBeVisible();
  await expect(page.getByText("Item dalam paket (minimal 2)").first()).toBeVisible();

  const kinds: [string, string][] = [
    ["Potongan nominal", "Potongan (Rp)"],
    ["Beli X gratis Y", "Jumlah gratis per kelipatan"],
    ["Harga paket", "Harga paket (Rp)"],
    ["Akses fasilitas", "ID produk fasilitas"],
    ["Diskon persen", "Batas diskon (Rp)"],
  ];
  for (const [option, field] of kinds) {
    await page.getByRole("combobox", { name: "Jenis manfaat" }).click();
    await page.getByRole("option", { name: option }).click();
    await expect(page.getByLabel(field)).toBeVisible();
  }

  // Buy X get Y needs the "Jumlah item tertentu" condition (here it is on).
  await page.getByRole("combobox", { name: "Jenis manfaat" }).click();
  await page.getByRole("option", { name: "Beli X gratis Y" }).click();
  await page.getByLabel("Jumlah item tertentu", { exact: true }).click();
  await expect(
    page.getByText('Beli X gratis Y butuh syarat "Jumlah item tertentu"'),
  ).toBeVisible();
});

test("PRD §3.21 Stacking (owner Q20): 10% then 20% of Rp100.000 is Rp28.000 and the policy saves", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/kelola/promo/tumpang-tindih?mock=normal`, NAV);
  await expect(page.getByText("Kebijakan tumpang tindih").first()).toBeVisible();
  await expect(page.getByTestId("stack-total")).toContainText(/28\.000/);
  await expect(page.getByTestId("stack-total")).not.toContainText(/30\.000/);

  await page.getByRole("radio", { name: "Bisa digabung" }).click();
  await page.getByLabel("Maksimal promo digabung").fill("3");
  await page.getByRole("button", { name: "Simpan kebijakan" }).click();
  await expect(
    page.getByText("Kebijakan tumpang tindih tersimpan.").first(),
  ).toBeVisible();

  // The rule builder now warns about same-group promotions under the new policy.
  await tab(page, "Promo");
  await page.getByRole("link", { name: "Buat promo" }).click();
  await page.getByLabel("Nama promo").fill("Uji grup");
  await page.getByLabel("Diskon (%)").fill("5");
  await expect(page.getByTestId("promo-conflicts")).toContainText("Satu grup");
});

test("PRD §3.21 Vouchers: issue a code once, validate it like the cashier, and see a used voucher rejected", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/kelola/promo/voucher?mock=normal`, NAV);
  await expect(page.getByRole("table").getByText("Dipakai").first()).toBeVisible();

  await page.getByRole("button", { name: "Terbitkan voucher" }).click();
  await page.getByLabel("Nilai (Rp)").fill("20000");
  await page.getByRole("button", { name: "Terbitkan", exact: true }).click();
  const code = (await page.getByTestId("issued-code").textContent())?.trim();
  expect(code).toMatch(/^[A-Z0-9]{6,32}$/);
  await page.getByRole("button", { name: "Selesai" }).click();

  await page.getByLabel("Kode voucher", { exact: true }).fill(code ?? "");
  await page.getByRole("button", { name: "Cek kode" }).click();
  await expect(page.getByText(/Kode valid\. Pratinjau diskon Rp\s*20\.000/)).toBeVisible();

  await page.getByLabel("Kode voucher", { exact: true }).fill("MAAFRINA50");
  await page.getByRole("button", { name: "Cek kode" }).click();
  await expect(page.getByText("Voucher sudah dipakai.")).toBeVisible();
});

test("PRD §3.21 ROI: totals in a stat strip and one row per promotion", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/kelola/promo/roi?mock=normal`, NAV);
  const strip = page.getByRole("region", { name: "Ringkasan ROI promo" });
  await expect(strip.getByText("Biaya diskon", { exact: true })).toBeVisible();
  await expect(strip.getByText("Omzet berpromo", { exact: true })).toBeVisible();
  await expect(strip.getByText("Margin bersih", { exact: true })).toBeVisible();
  await expect(strip.getByText("ROI keseluruhan", { exact: true })).toBeVisible();
  const row = page
    .getByRole("table")
    .getByRole("row")
    .filter({ hasText: "Diskon 10% Semua Menu" });
  await expect(row).toContainText(/1\.250\.000/);
  await expect(row).toContainText(/700%/);
});

test("States: empty and error say what to do next; going offline is announced", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/kelola/promo?mock=empty`, NAV);
  await expect(page.getByText("Belum ada promo")).toBeVisible();

  await page.goto(`${MOCK_URL}/kelola/promo?mock=error`, NAV);
  await expect(page.getByRole("alert").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();

  await page.goto(`${MOCK_URL}/kelola/promo?mock=normal`, NAV);
  await page.context().setOffline(true);
  await expect(page.getByText("Tidak ada koneksi")).toBeVisible();
  await page.context().setOffline(false);
});

const SHOTS = [
  ["promo", "/kelola/promo"],
  ["editor", "/kelola/promo/baru"],
  ["tumpang-tindih", "/kelola/promo/tumpang-tindih"],
  ["voucher", "/kelola/promo/voucher"],
  ["roi", "/kelola/promo/roi"],
] as const;

for (const [name, path] of SHOTS) {
  for (const width of [390, 1440]) {
    for (const theme of ["light", "dark"]) {
      test(`visual ${name} ${width} ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript(
          (value) => localStorage.setItem("legend-theme", value),
          theme,
        );
        await page.goto(`${MOCK_URL}${path}?mock=normal`, NAV);
        await expect(
          page.getByRole("heading", { name: "Promo & voucher" }),
        ).toBeVisible();
        // No horizontal page scroll at any width.
        const overflow = await page.evaluate(
          () =>
            document.documentElement.scrollWidth >
            document.documentElement.clientWidth,
        );
        expect(overflow).toBe(false);
        await captureScreenshot(page, `legend-oadp/${name}-${width}-${theme}.png`);
      });
    }
  }
}

for (const [state, scenario] of [
  ["empty", "empty"],
  ["error", "error"],
] as const) {
  test(`visual list ${state} 390`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(`${MOCK_URL}/kelola/promo?mock=${scenario}`, NAV);
    await expect(
      page.getByRole("heading", { name: "Promo & voucher" }),
    ).toBeVisible();
    await captureScreenshot(page, `legend-oadp/promo-${state}-390-light.png`);
  });
}
