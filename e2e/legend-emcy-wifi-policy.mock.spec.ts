// WS-09 Wi-Fi & WFC policy admin (bead legend-emcy; PRD v1.7 §25, FAC-14:
// "kebijakan Wi-Fi dan minimum spend dapat diubah tanpa redeploy").
//
// Mock-mode spec: `pnpm test:e2e:mock e2e/legend-emcy-wifi-policy.mock.spec.ts`
// starts a web dev server with VITE_API_MOCK=true (no API, no database). The
// "Wi-Fi & WFC" tab (features/facility-admin/components/wifi-tab.tsx) reads the
// policies through GET /api/facility/config and writes through PUT
// /api/facility/wifi-policies/:policyId (features/facility-admin/mock.ts).
//
// Assumptions:
// - "Reload" in mock mode keeps state only in browser memory, so a full
//   page.reload() would reset the mock store. The refetch is therefore done
//   in-app: leave the config editor (the "Kembali ke daftar fasilitas" link; not
//   history back, which reloads the document) and open it again. This depends on S3 (legend-wbwl): the config read must
//   serve the admin store, otherwise the saved value is lost on refetch.
// - Both fixture policies show on every facility; the spec edits the one
//   labelled "Zona WFC" (it has a minimum spend, the regular zone has none).
// - Invalid input is rejected client-side with a field message plus the form
//   summary "Periksa N isian yang ditandai."; the dialog stays open and the
//   stored policy is unchanged.
import { expect, test, type Locator, type Page } from "@playwright/test";

const mockWebUrl = process.env.LEGEND_MOCK_WEB_URL;
test.skip(!mockWebUrl, "Requires the mock-mode web server");
test.use({ baseURL: mockWebUrl ?? "http://localhost:3320" });

/** The first test on a new route pays Vite's cold compile (frontend guide §6). */
const COLD_START_TIMEOUT_MS = 30_000;
const WFC_FACILITY_NAME = "Zona WFC Legend";

function facilityRow(page: Page, name: string) {
  return page.getByRole("row").filter({ hasText: name });
}

/**
 * The SSR HTML paints the form before React hydrates. Filling a controlled
 * input in that window is lost when hydration mounts the initial state.
 */
async function waitForHydration(page: Page) {
  await page.waitForFunction(
    () => {
      const element = document.querySelector(
        "main a[href], #main-content a[href], main button, #main-content button",
      );
      return (
        element !== null &&
        Object.keys(element).some((key) => key.startsWith("__reactFiber$"))
      );
    },
    undefined,
    { timeout: 60_000 },
  );
}

async function openConfig(page: Page, name = WFC_FACILITY_NAME) {
  await facilityRow(page, name)
    .getByRole("link", { name: "Buka konfigurasi" })
    .click();
  await expect(page.getByRole("heading", { level: 2, name })).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
  await waitForHydration(page);
}

async function openWifiTab(page: Page) {
  await page.getByRole("tab", { name: "Wi-Fi & WFC" }).click();
  await expect(
    page.getByRole("button", { name: "Ubah kebijakan Zona WFC" }),
  ).toBeVisible();
}

function wfcCard(page: Page) {
  return page
    .locator('[data-slot="wifi-policy"]')
    .filter({ hasText: "Zona WFC" });
}

async function openWfcDialog(page: Page) {
  await page.getByRole("button", { name: "Ubah kebijakan Zona WFC" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Ubah kebijakan Zona WFC",
  });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Label match anchored at the start: optional fields add "(opsional)". */
function field(dialog: Locator, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return dialog.getByLabel(new RegExp(`^${escaped}`));
}

async function gotoWifiTab(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/kelola/fasilitas?mock=normal`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Fasilitas" }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await openConfig(page);
  await openWifiTab(page);
}

test("legend-emcy FAC-14: the Wi-Fi tab lists the current WFC and regular zone policies", async ({
  page,
}) => {
  await gotoWifiTab(page);

  const wfc = wfcCard(page);
  await expect(wfc).toContainText("120 menit gratis/hari");
  await expect(wfc).toContainText("60 menit saat jam ramai");
  await expect(wfc).toContainText("2 perangkat per akun");
  await expect(wfc).toContainText(/Minimum belanja Rp\s?30\.000\/jam/);

  const regular = page
    .locator('[data-slot="wifi-policy"]')
    .filter({ hasText: "Zona reguler" });
  await expect(regular).toContainText("Tanpa minimum belanja");
});

test("legend-emcy FAC-14: peak hours, minimum spend and quota are saved and survive a refetch", async ({
  page,
}) => {
  await gotoWifiTab(page);
  const dialog = await openWfcDialog(page);

  // Quota.
  await field(dialog, "Menit gratis per hari").fill("150");
  // Minimum spend (WFC).
  await field(dialog, "Minimum belanja per jam (Rp)").fill("45000");
  // Peak hours: first window moves from 11.30-14.00 to 12.00-15.00.
  await field(dialog, "Mulai jam ramai 1").fill("12:00");
  await field(dialog, "Selesai jam ramai 1").fill("15:00");

  await dialog.getByRole("button", { name: "Simpan kebijakan" }).click();

  await expect(
    page.getByText("Kebijakan Wi-Fi diperbarui.", { exact: true }),
  ).toBeVisible();
  await expect(dialog).toBeHidden();
  const wfc = wfcCard(page);
  await expect(wfc).toContainText("150 menit gratis/hari");
  await expect(wfc).toContainText(/Minimum belanja Rp\s?45\.000\/jam/);

  // Refetch: back to the facility list through the in-app link (no document
  // reload, which would reset the in-memory mock store), then open the config
  // again.
  await page
    .getByRole("link", { name: "Kembali ke daftar fasilitas" })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Fasilitas" }),
  ).toBeVisible();
  await openConfig(page);
  await openWifiTab(page);

  const reloaded = wfcCard(page);
  await expect(reloaded).toContainText("150 menit gratis/hari");
  await expect(reloaded).toContainText(/Minimum belanja Rp\s?45\.000\/jam/);

  const reopened = await openWfcDialog(page);
  await expect(field(reopened, "Menit gratis per hari")).toHaveValue("150");
  await expect(field(reopened, "Minimum belanja per jam (Rp)")).toHaveValue(
    "45000",
  );
  await expect(field(reopened, "Mulai jam ramai 1")).toHaveValue("12:00");
  await expect(field(reopened, "Selesai jam ramai 1")).toHaveValue("15:00");
});

test("legend-emcy FAC-14: a peak end time before the start time is rejected with a message", async ({
  page,
}) => {
  await gotoWifiTab(page);
  const dialog = await openWfcDialog(page);

  await field(dialog, "Mulai jam ramai 1").fill("14:00");
  await field(dialog, "Selesai jam ramai 1").fill("11:00");
  await dialog.getByRole("button", { name: "Simpan kebijakan" }).click();

  await expect(
    dialog.getByText("Jam selesai harus setelah jam mulai."),
  ).toBeVisible();
  await expect(dialog.getByRole("alert")).toContainText(
    "Periksa 1 isian yang ditandai.",
  );
  // Nothing saved: the dialog stays open and no success toast shows.
  await expect(dialog).toBeVisible();
  await expect(page.getByText("Kebijakan Wi-Fi diperbarui.")).toHaveCount(0);

  // Cancel leaves the stored policy unchanged.
  await dialog.getByRole("button", { name: "Batal" }).click();
  await expect(dialog).toBeHidden();
  await expect(wfcCard(page)).toContainText("120 menit gratis/hari");
});

test("legend-emcy FAC-14: a negative quota or minimum spend is rejected with a message", async ({
  page,
}) => {
  await gotoWifiTab(page);
  const dialog = await openWfcDialog(page);

  await field(dialog, "Menit gratis per hari").fill("-5");
  await field(dialog, "Minimum belanja per jam (Rp)").fill("-1000");
  await dialog.getByRole("button", { name: "Simpan kebijakan" }).click();

  await expect(
    dialog.getByText("Menit gratis per hari harus berupa angka bulat."),
  ).toBeVisible();
  await expect(
    dialog.getByText("Minimum belanja per jam (Rp) harus berupa angka bulat."),
  ).toBeVisible();
  await expect(dialog.getByRole("alert")).toContainText(
    "Periksa 2 isian yang ditandai.",
  );
  await expect(dialog).toBeVisible();
  await expect(page.getByText("Kebijakan Wi-Fi diperbarui.")).toHaveCount(0);

  await dialog.getByRole("button", { name: "Batal" }).click();
  await expect(dialog).toBeHidden();
  await expect(wfcCard(page)).toContainText(
    /Minimum belanja Rp\s?30\.000\/jam/,
  );
});

test("legend-emcy FAC-14: a peak allowance above the daily quota is rejected", async ({
  page,
}) => {
  await gotoWifiTab(page);
  const dialog = await openWfcDialog(page);

  await field(dialog, "Menit gratis saat jam ramai").fill("200");
  await dialog.getByRole("button", { name: "Simpan kebijakan" }).click();

  await expect(
    dialog.getByText(
      "Menit gratis jam ramai tidak boleh melebihi menit gratis harian.",
    ),
  ).toBeVisible();
  await expect(dialog).toBeVisible();
});
