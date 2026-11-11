// legend-wpqs: the first payroll policy and the first THR schedule take their
// legal entity from the organisation's own list (mockup
// design/mockups/hris/payroll-wpqs.html), so a tenant with no policy yet can
// create one. Only the entity picker is new: payroll maths is untouched.
//
// ASSUMPTIONS: page /kelola/payroll/pengaturan (tab=thr for THR); the picker is
// a field labelled "Badan usaha" (native select or combobox) listing the org
// entities; new-item buttons are "Kebijakan baru" / "Jadwal THR baru".
// NOT covered: "Belum ada badan usaha" (empty org list) and the "Pilih badan
// usaha" validation - the mock org always has ONE entity, which the picker
// preselects, and there is no switch to empty it (unit tests cover "required").
// Run: pnpm test:e2e:mock e2e/legend-wpqs.mock.spec.ts
import { expect, test, type Locator, type Page } from "@playwright/test";
import { waitForHydration } from "./hydration.ts";
import { failFirstCall, failNextCall } from "./mock-fail-next.ts";

const COLD_START_TIMEOUT_MS = 30_000;
const ENTITIES_ENDPOINT = "GET /api/org/legal-entities";

async function openPolicies(page: Page, query = "") {
  await page.goto(`/kelola/payroll/pengaturan${query}`);
  await expect(
    page
      .getByRole("button", { name: "Kebijakan baru" })
      .or(page.getByText("Belum ada kebijakan payroll"))
      .first(),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
}

async function openThr(page: Page, query = "") {
  await page.goto(`/kelola/payroll/pengaturan?tab=thr${query}`);
  await expect(
    page.getByRole("button", { name: "Jadwal THR baru" }).first(),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
}

async function openDialog(page: Page, button: string): Promise<Locator> {
  await waitForHydration(page);
  await page.getByRole("button", { name: button }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * The mock org has ONE legal entity and the picker preselects a lone entity.
 * Choose from the list only when nothing is selected yet.
 */
async function ensureEntity(dialog: Locator, page: Page) {
  const field = dialog.getByRole("combobox", { name: /Badan usaha/ });
  await expect(field).toBeEnabled();
  if ((await field.innerText()).includes("Pilih badan usaha")) {
    await field.click();
    await page.getByRole("option").first().click();
  }
  await expect(field).not.toContainText("Pilih badan usaha");
}

async function fillPolicy(dialog: Locator) {
  await dialog.getByLabel("Nama kebijakan").fill("Karyawan bulanan");
  await dialog.getByLabel("Kode kelompok").fill("TETAP");
  await dialog.getByLabel("Nama kelompok").fill("Karyawan tetap");
  await dialog.getByLabel("Tanggal potong absensi").fill("25");
  await dialog.getByRole("textbox", { name: /^Tanggal bayar/ }).fill("28");
}

const saveButton = (dialog: Locator) =>
  dialog.getByRole("button", { name: /^Simpan|^Buat/ }).last();

test("with no policy yet, the org's entity is offered for a first policy", async ({
  page,
}) => {
  await openPolicies(page, "?mock=empty");
  await expect(page.getByText("Belum ada kebijakan payroll")).toBeVisible();
  const dialog = await openDialog(page, "Kebijakan baru");
  await expect(dialog.getByLabel("Badan usaha")).toBeVisible();
  await expect(
    dialog.getByText("Daftar badan usaha berasal dari pengaturan organisasi."),
  ).toBeVisible();
  // The only org entity is preselected; the list itself has that entity.
  await dialog.getByRole("combobox", { name: /Badan usaha/ }).click();
  await expect(page.getByRole("option")).toHaveCount(1);
});

test("a first policy is created for the org's entity", async ({ page }) => {
  await openPolicies(page, "?mock=empty");
  const dialog = await openDialog(page, "Kebijakan baru");
  await ensureEntity(dialog, page);
  await fillPolicy(dialog);
  await saveButton(dialog).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByText("Kebijakan payroll dibuat.", { exact: true }),
  ).toBeVisible();
  // ?mock=empty keeps the list empty, so the success message is the proof here.
});

test("a failed save keeps the form and says so", async ({ page }) => {
  await openPolicies(page, "?mock=empty");
  const dialog = await openDialog(page, "Kebijakan baru");
  await ensureEntity(dialog, page);
  await fillPolicy(dialog);
  await failNextCall(page, "POST /api/hris/payroll/policies", {
    status: 500,
    code: "INTERNAL_ERROR",
  });
  await saveButton(dialog).click();
  await expect(
    dialog.getByText(/Belum berhasil disimpan|Gagal menyimpan/),
  ).toBeVisible();
  await expect(dialog.getByLabel("Nama kebijakan")).toHaveValue(
    "Karyawan bulanan",
  );
});

test("an entity list that fails to load shows 'Coba lagi' that recovers", async ({
  page,
}) => {
  await failFirstCall(page, ENTITIES_ENDPOINT, {
    status: 409,
    code: "CONFLICT",
  });
  await openPolicies(page, "?mock=empty");
  const dialog = await openDialog(page, "Kebijakan baru");
  await expect(
    dialog.getByText("Daftar badan usaha tidak dapat dimuat"),
  ).toBeVisible();
  await expect(
    dialog.getByText("Periksa koneksi dan coba lagi."),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Coba lagi" }).click();
  await expect(dialog.getByLabel("Badan usaha")).toBeVisible();
});

test("a first THR schedule takes the entity from the org list too", async ({
  page,
}) => {
  await openThr(page, "&mock=empty");
  await expect(page.getByText("Belum ada jadwal THR")).toBeVisible();
  const dialog = await openDialog(page, "Jadwal THR baru");
  await ensureEntity(dialog, page);
  await dialog.getByLabel("Nama jadwal").fill("THR Idul Fitri 2027");
  await dialog.getByLabel("Nama hari libur").fill("Idul Fitri");
  await dialog.getByLabel("Tanggal libur").fill("2027-03-10");
  await dialog
    .getByRole("textbox", { name: /^Tanggal bayar/ })
    .fill("2027-03-03");
  await dialog.getByLabel("Tanggal acuan masa kerja").fill("2027-03-03");
  await saveButton(dialog).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByText("Jadwal THR dibuat.", { exact: true }),
  ).toBeVisible();
});

test("the policy form fits a 390 and a 320 px screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPolicies(page, "?mock=empty");
  const dialog = await openDialog(page, "Kebijakan baru");
  await expect(dialog.getByLabel("Badan usaha")).toBeVisible();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  }
});
