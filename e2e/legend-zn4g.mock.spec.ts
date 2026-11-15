// WS-10 payroll run wizard, approvals, exports and service-charge distribution
// (bead legend-zn4g; PRD v1.7 §3 D.30, §4 Alur K, PAYR-01/PAYR-04). Mock mode:
// `pnpm test:e2e:mock` starts the web dev server with VITE_API_MOCK=true and
// names it in LEGEND_MOCK_WEB_URL, so the payroll fixtures answer without an
// API or a database.
//
// Mock state lives in the browser runtime: every mutation runs in the page, and
// the second approver is switched mid-flow by rewriting the `legend-mock-role`
// cookie (the payload handler reads it per request), never by reloading — a
// reload re-seeds the in-memory mock store. `owner` maps to the fixture finance
// approver, which is a different person from the default HR approver.
//
// The payroll routes are not on e2e/mock-global-setup.ts WARM_ROUTES (a shared
// file this bead must not edit), so the first test on each route allows for a
// cold Vite compile (frontend.md "Browser specs in mock mode").
import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";

const base = process.env.LEGEND_MOCK_WEB_URL;
test.skip(
  !base,
  "Mock runner not started: use pnpm test:e2e:mock (playwright.mock.config.ts).",
);
test.use({ baseURL: base });

const COLD_START_TIMEOUT_MS = 30_000;
const NAV_TIMEOUT_MS = 90_000;
// November 2026 run (fixtures: 26 Oct – 25 Nov 2026, simulated).
const NOVEMBER_RUN_ID = "00000000-0000-4000-8000-000000005202";

type Theme = "light" | "dark";

async function open(page: Page, path: string, theme: Theme = "light") {
  await page.addInitScript(
    (value) => localStorage.setItem("legend-theme", value),
    theme,
  );
  await page.goto(path, {
    waitUntil: "networkidle",
    timeout: NAV_TIMEOUT_MS,
  });
}

function statusBand(page: Page) {
  return page.locator('[data-slot="status-band"]');
}

/** A confirm dialog is found by its title; its primary button repeats the action. */
async function submitDialog(page: Page, title: string, submitLabel: string) {
  const dialog = page.getByRole("dialog", { name: title });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: submitLabel, exact: true }).click();
}

test("PAYR-01 PAYR-04 the November run: delta review, two approvals, lock, paid, bank file and tax export", async ({
  page,
}) => {
  await open(page, "/kelola/payroll/run?mock=normal");

  // The list renders the three fixture runs (October paid, November simulated,
  // December draft) with their period links.
  await expect(
    page.getByRole("heading", { name: "Daftar payroll run" }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await expect(page.getByRole("link", { name: /26 Sep 2026/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /26 Okt 2026/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /26 Nov 2026/ })).toBeVisible();

  await page.getByRole("link", { name: /26 Okt 2026/ }).click();
  await expect(statusBand(page)).toContainText("Sudah disimulasikan", {
    timeout: COLD_START_TIMEOUT_MS,
  });

  // PAYR-01: simulation is repeatable and leaves the run simulated.
  await page.getByRole("button", { name: "Simulasi ulang" }).click();
  await submitDialog(page, "Jalankan simulasi", "Jalankan simulasi");
  await expect(page.getByText("Simulasi selesai.").first()).toBeVisible();
  await expect(statusBand(page)).toContainText("Sudah disimulasikan");

  // The per-employee review carries the change against October (the contract
  // supplies previousNetIdr/netChangeIdr; the delta is never recomputed here).
  await expect(
    page.getByRole("heading", { name: "Review per karyawan" }),
  ).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: "Selisih" }),
  ).toBeVisible();
  await expect(page.getByText(/[+−]Rp\s?[\d.]+/).first()).toBeVisible();

  await page.getByRole("button", { name: "Setujui HR", exact: true }).click();
  await submitDialog(page, "Setujui tahap HR", "Setujui HR");
  await expect(statusBand(page)).toContainText("Disetujui HR");

  // Same person cannot also be the final approver (PRD §3 Matriks Approval).
  await page
    .getByRole("button", { name: "Setujui final", exact: true })
    .click();
  const finalDialog = page.getByRole("dialog", { name: "Setujui final" });
  await finalDialog.getByRole("button", { name: "Setujui final" }).click();
  await expect(finalDialog.getByRole("alert")).toContainText(
    "Penyetuju harus berbeda",
  );
  await expect(statusBand(page)).toContainText("Disetujui HR");

  // A second approver (the mock's owner role acts as the finance fixture user).
  await page.evaluate(() => {
    document.cookie = "legend-mock-role=owner; path=/";
  });
  await finalDialog.getByRole("button", { name: "Setujui final" }).click();
  await expect(statusBand(page)).toContainText("Disetujui final");

  await page
    .getByRole("button", { name: "Kunci payroll", exact: true })
    .click();
  await submitDialog(page, "Kunci payroll", "Kunci payroll");
  await expect(statusBand(page)).toContainText("Terkunci");

  await page
    .getByRole("button", { name: "Tandai dibayar", exact: true })
    .click();
  await submitDialog(page, "Tandai sudah dibayar", "Tandai dibayar");
  await expect(statusBand(page)).toContainText("Sudah dibayar");

  // legend-66xzn: salary is paid only through an approved payout batch, so the
  // bank card links to the payout screen instead of offering the retired
  // bank-file button (the API answers 409 LEGACY_BANK_EXPORT_DISABLED).
  await expect(
    page.getByRole("button", { name: "Buat berkas transfer" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Buka pencairan gaji" }),
  ).toHaveAttribute("href", /\/kelola\/payroll\/pencairan\?.*tab=runs/);
  await expect(
    page.getByText("Belum ada arsip berkas transfer untuk run ini."),
  ).toBeVisible();

  await page.getByRole("button", { name: "Buat dokumen pajak" }).click();
  await expect(page.getByText("Dokumen 2026-11 siap diunduh")).toBeVisible();
});

test("PAYR-04 service charge: calculate, approve and reconcile the allocation totals", async ({
  page,
}) => {
  await open(page, "/kelola/payroll/service-charge?mock=normal");

  // November (2026-10-26 – 2026-11-25) is the newest pool and selected first.
  await expect(
    page.getByRole("heading", { name: "Pool service charge" }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  const novemberRow = page
    .getByRole("row")
    .filter({ hasText: "26 Okt 2026" })
    .first();
  await expect(novemberRow).toContainText("Sudah dihitung");

  // The fixture split adds up to the pool amount exactly.
  await expect(page.getByText("Alokasi cocok dengan pool")).toBeVisible();
  await expect(page.getByText("Total alokasi")).toBeVisible();
  await expect(page.getByText(/8\.450\.000/).first()).toBeVisible();

  await page.getByRole("button", { name: "Hitung pembagian" }).click();
  await submitDialog(page, "Hitung pembagian pool", "Hitung pembagian");
  await expect(
    page.getByText("Pembagian pool dihitung.").first(),
  ).toBeVisible();

  // The approve submit can lose a click to the refetch re-render; retry until
  // the success toast lands (the idempotency key makes a replay harmless).
  const approvedToast = page
    .getByText("Pool service charge disetujui.")
    .first();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await approvedToast.isVisible().catch(() => false)) break;
    const approveDialog = page.getByRole("dialog", { name: "Setujui pool" });
    if (await approveDialog.isVisible().catch(() => false)) {
      await approveDialog
        .getByRole("button", { name: "Setujui pool", exact: true })
        .click();
    } else {
      await page.getByRole("button", { name: "Setujui pool" }).click();
    }
    await page.waitForTimeout(500);
  }
  await expect(approvedToast).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByText("Pool disetujui; menunggu payroll run dikunci."),
  ).toBeVisible();
  await expect(page.getByText("Alokasi cocok dengan pool")).toBeVisible();
});

test("PAYR-01 the runs list has an honest empty state", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await open(page, "/kelola/payroll/run?mock=empty", "light");
  await expect(page.getByText("Belum ada payroll run")).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
  await captureScreenshot(page, "legend-zn4g/run-list-empty-390-light.png");
});

for (const shot of [
  { theme: "light" as const, width: 390 },
  { theme: "dark" as const, width: 390 },
  { theme: "light" as const, width: 1440 },
]) {
  test(`PAYR-01 run list evidence ${shot.width} ${shot.theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: shot.width, height: 900 });
    await open(page, "/kelola/payroll/run?mock=normal", shot.theme);
    await expect(
      page.getByRole("heading", { name: "Daftar payroll run" }),
    ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
    // The fixture rows must be painted, not the loading skeletons.
    await expect(page.getByRole("link", { name: /26 Okt 2026/ })).toBeVisible();
    await captureScreenshot(
      page,
      `legend-zn4g/run-list-${shot.width}-${shot.theme}.png`,
    );
  });
}

test("PAYR-01 wizard review evidence 1440 light", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(
    page,
    `/kelola/payroll/run/${NOVEMBER_RUN_ID}?mock=normal`,
    "light",
  );
  await expect(
    page.getByRole("heading", { name: "Review per karyawan" }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await expect(
    page.getByRole("columnheader", { name: "Selisih" }),
  ).toBeVisible();
  await expect(page.getByText(/[+−]Rp\s?[\d.]+/).first()).toBeVisible();
  await captureScreenshot(page, "legend-zn4g/wizard-review-1440-light.png");
});

test("PAYR-04 service charge evidence 1440 light", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, "/kelola/payroll/service-charge?mock=normal", "light");
  await expect(
    page.getByRole("heading", { name: "Pool service charge" }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  // Data, not skeletons: the fixture split reconciles with its pool.
  await expect(page.getByText("Alokasi cocok dengan pool")).toBeVisible();
  await captureScreenshot(page, "legend-zn4g/service-charge-1440-light.png");
});

async function signInAs(page: Page, role: string) {
  await page
    .context()
    .addCookies([{ name: "legend-mock-role", value: role, url: base! }]);
}

test("PAYR-01 legend-t3f5 finance reads the run without payroll.run; run actions stay disabled", async ({
  page,
}) => {
  // Finance holds payroll.view/approve/lock but not payroll.run: it may open
  // the list and the run (decision legend-t3f5), every payroll.run action stays
  // disabled, and its per-employee rows still load because it holds
  // payroll.view.
  await signInAs(page, "finance");
  await open(page, "/kelola/payroll/run?mock=normal");
  await expect(
    page.getByRole("heading", { name: "Daftar payroll run" }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await page.getByRole("link", { name: /26 Okt 2026/ }).click();
  await expect(statusBand(page)).toContainText("Sudah disimulasikan", {
    timeout: COLD_START_TIMEOUT_MS,
  });
  await expect(
    page.getByRole("button", { name: "Setujui HR", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Simulasi ulang" }),
  ).toBeDisabled();
});

test("PAYR-01 a role without payroll permissions cannot open the run", async ({
  page,
}) => {
  await signInAs(page, "cashier");
  await open(page, `/kelola/payroll/run/${NOVEMBER_RUN_ID}?mock=normal`);
  await expect(statusBand(page)).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Review per karyawan" }),
  ).toHaveCount(0);
});
