import { expect, test } from "@playwright/test";

// legend-f1mmf UI recheck: a full PIN typed while a settle field is still
// wrong does not jam the pad. The fields say what is missing, the dots empty,
// and the supervisor can type the PIN again to settle. Against the FE mock
// runtime. Run: pnpm test:e2e:mock e2e/legend-1272-f1mmf-resolve.mock.spec.ts
const mockWebUrl = process.env.LEGEND_MOCK_WEB_URL;
test.skip(!mockWebUrl, "Requires the mock-mode web server");
test.use({ baseURL: mockWebUrl ?? "http://localhost:3320" });
test.setTimeout(120_000);

const CHARGE = "3f0c1a2b-4d5e-4f60-8a71-92b3c4d5e6f7";
const WAIT = { timeout: 60_000 };

test("the PIN pad takes a new PIN after a full PIN met a wrong field", async ({
  page,
  baseURL,
}) => {
  await page
    .context()
    .addCookies([{ name: "legend-mock-role", value: "all", url: baseURL }]);
  await page.goto(`/pos/tagih-selisih/${CHARGE}?demo=selisih-edc-putus`);
  await page.getByText("EDC kartu", { exact: true }).click(WAIT);
  await page.getByRole("button", { name: /Kirim .* ke mesin EDC/ }).click();
  await expect(page.getByText("Hasil EDC belum pasti")).toBeVisible(WAIT);
  await page
    .getByRole("button", { name: "Minta supervisor", exact: true })
    .click();

  const dialog = page.getByRole("dialog");
  const dots = dialog.getByTestId("pin-dots").locator("[data-filled]");
  await dialog
    .getByRole("textbox", { name: /Alasan/ })
    .fill("Mesin menampilkan disetujui, slip tercetak");
  // No approver and no machine result yet: a full PIN only marks the fields.
  await dialog.getByRole("heading").first().click();
  await page.keyboard.type("123456");
  await expect(
    dialog.getByText("Pilih supervisor yang menyetujui."),
  ).toBeVisible();
  await expect(dots).toHaveCount(0);
  await expect(dialog).toBeVisible();

  await dialog.getByRole("combobox").nth(0).click();
  await page.getByRole("option", { name: "Supervisor 02" }).click();
  await dialog.getByRole("combobox").nth(1).click();
  await page.getByRole("option", { name: "Kartu terdebet, ada slip" }).click();
  await dialog.getByLabel(/RRN di slip/).fill("612345678901");
  await dialog.getByLabel(/Kode approval di slip/).fill("A1B2C3");
  await dialog.getByLabel(/Nominal di slip/).fill("10000");
  await dialog.getByRole("heading").first().click();
  await page.keyboard.type("123");
  await expect(dots).toHaveCount(3);
  await page.keyboard.type("456");
  await expect(page.getByText("Pembayaran tadi sudah tercatat")).toBeVisible(
    WAIT,
  );
});
