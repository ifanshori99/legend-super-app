// WS-10 employee master (bead legend-zueb; PRD v1.7 §3 F24, HR-03): the
// directory, one employee's profile with masked PII and the write-only edit
// flow, the locked state for a role without `hr.employee.view`, and the org
// chart. Runs against the mock-mode web server (no API, no database):
//
//   pnpm test:e2e:mock e2e/legend-zueb.mock.spec.ts
import { expect, test, type Page } from "@playwright/test";
import { waitForHydration } from "./hydration.ts";
import { captureScreenshot } from "./screenshots.ts";

const base = process.env.LEGEND_MOCK_WEB_URL;

test.skip(
  !base,
  "Mock runner not started: use pnpm test:e2e:mock (playwright.mock.config.ts).",
);
test.use({ baseURL: base });

/** Vite compiles a route on its first request: the first assertion waits. */
const COLD_START_TIMEOUT_MS = 30_000;

/** CL-1001 Rizky Pratama, the fixture employee with full PII and a contract. */
const EMPLOYEE_ID = "00000000-0000-4000-8000-000000001001";

async function openDirectory(page: Page, timeout?: number) {
  await page.goto("/kelola/karyawan?mock=normal");
  await waitForHydration(page);
  // The management topbar owns the page h1 (DESIGN.md §5).
  await expect(
    page.getByRole("heading", { level: 1, name: "Karyawan" }),
  ).toBeVisible({ timeout });
}

async function openProfile(page: Page, timeout?: number) {
  await page.goto(`/kelola/karyawan/${EMPLOYEE_ID}?mock=normal`);
  await waitForHydration(page);
  await expect(
    page.getByRole("heading", { name: "Profil karyawan" }),
  ).toBeVisible({ timeout });
}

test("HR-03 directory lists the fixture employees with NIP, position and status", async ({
  page,
}) => {
  await openDirectory(page, COLD_START_TIMEOUT_MS);

  // The table paginates; assert a first-page row, then prove search reaches the rest.
  await expect(
    page.getByText("Agus Setiawan").filter({ visible: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("CL-1005").filter({ visible: true }).first(),
  ).toBeVisible();
  // The four kepegawaian metrics, not decorative deltas.
  await expect(page.getByText("Karyawan aktif")).toBeVisible();
  await expect(page.getByText("Kontrak berakhir ≤30 hari")).toBeVisible();

  // Filters run over the whole catalog in memory (name or NIP).
  await page.getByLabel("Cari nama atau NIP").fill("Dewi");
  await expect(page.getByText("1 baris")).toBeVisible();
  await expect(
    page.getByText("Dewi Lestari").filter({ visible: true }).first(),
  ).toBeVisible();
});

test("HR-03 profile shows masked PII for a role with hr.employee.view", async ({
  page,
}) => {
  await openProfile(page, COLD_START_TIMEOUT_MS);

  await expect(page.getByText("Rizky Pratama").first()).toBeVisible();
  await expect(page.getByText("CL-1001").first()).toBeVisible();
  await expect(page.getByText("Data pribadi (HR-03)")).toBeVisible();

  // Masked forms only: the fixture NIK is "3273011505900001".
  await expect(page.getByText("****0001").first()).toBeVisible();
  await expect(page.getByText("Sri W***").first()).toBeVisible();
  await expect(page.getByText("3273011505900001")).toHaveCount(0);

  // The contracts tab uses the contract's own reminder window (F24).
  await expect(
    page.getByRole("heading", { name: "Kontrak kerja" }),
  ).toBeVisible();
});

test("HR-03 edit flow stores a PII value write-only and shows the new masked form", async ({
  page,
}) => {
  await openProfile(page);

  await page.getByRole("button", { name: "Ubah data pribadi" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: /Ubah data pribadi/ }),
  ).toBeVisible();

  // The fixture NPWP masks to ****7000; the new one must mask to ****7123.
  await dialog.getByLabel("NPWP").fill("09.254.001.8-407.123");
  await dialog.getByRole("button", { name: "Simpan data pribadi" }).click();

  await expect(page.getByText("Data pribadi tersimpan").first()).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Refetched from the guarded endpoint: masked, never the raw input.
  await expect(page.getByText("****7123").first()).toBeVisible();
  await expect(page.getByText("09.254.001.8-407.123")).toHaveCount(0);
});

test("HR-03 a role without hr.employee.view sees the locked profile, not PII", async ({
  page,
}) => {
  // tenant_admin reaches the kelola area (dashboard.management.view) but holds
  // no hr.employee.view, so the profile must not render employee data.
  await page
    .context()
    .addCookies([
      { name: "legend-mock-role", value: "tenant_admin", url: base! },
    ]);

  await page.goto(`/kelola/karyawan/${EMPLOYEE_ID}?mock=normal`);
  await waitForHydration(page);

  await expect(page.getByText("Profil karyawan terkunci")).toBeVisible();
  await expect(page.getByText("Data pribadi (HR-03)")).toHaveCount(0);
  await expect(page.getByText("****0001")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Ubah data pribadi" }),
  ).toHaveCount(0);
});

test("HR-03 a manager role with hr.employee.view still gets no NIK, bank or salary", async ({
  page,
}) => {
  // outlet_manager holds hr.employee.view (directory, profile) but its viewer
  // kind is `supervisor`: HRIS_PII_VISIBILITY hides identity, tax, BPJS, bank,
  // emergency contact and salary. The mock serves what the API would.
  await page
    .context()
    .addCookies([
      { name: "legend-mock-role", value: "outlet_manager", url: base! },
    ]);
  await openProfile(page, COLD_START_TIMEOUT_MS);

  await expect(page.getByText("Data pribadi (HR-03)")).toBeVisible();
  await expect(
    page.getByText(/Peran Anda tidak termasuk HR atau payroll/),
  ).toBeVisible();
  await expect(page.getByText("****0001")).toHaveCount(0);
  await expect(page.getByText("Sri W***")).toHaveCount(0);
  // No hr.employee.manage: no write-only edit flow either.
  await expect(
    page.getByRole("button", { name: "Ubah data pribadi" }),
  ).toHaveCount(0);
  // The contract row renders, its salary snapshot does not.
  await expect(
    page.getByRole("heading", { name: "Kontrak kerja" }),
  ).toBeVisible();
  await expect(page.getByText("PKWTT").first()).toBeVisible();
  await expect(page.getByText("****0000")).toHaveCount(0);
});

test("HR-03 organisation chart renders units, positions and headcount", async ({
  page,
}) => {
  await page.goto("/kelola/organisasi?mock=normal");
  await waitForHydration(page);

  await expect(
    page.getByRole("heading", { level: 1, name: "Struktur Organisasi" }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await expect(
    page.getByRole("heading", { name: "Bagan organisasi" }),
  ).toBeVisible();
  await expect(page.getByText("Operasional Outlet").first()).toBeVisible();
  await expect(page.getByText("Bar", { exact: true }).first()).toBeVisible();
  // Positions per unit, with the grade and service-charge points table.
  await expect(
    page.getByRole("heading", { name: "Jabatan per unit" }),
  ).toBeVisible();
  await expect(page.getByText("Barista").first()).toBeVisible();
  await expect(page.getByText("Poin service charge").first()).toBeVisible();
});

test("HR-03 directory empty state is honest", async ({ page }) => {
  await page.goto("/kelola/karyawan?mock=empty");
  await waitForHydration(page);
  await expect(page.getByText("Belum ada karyawan")).toBeVisible();
  await captureScreenshot(page, "legend-zueb/directory-390-empty.png");
});

for (const width of [390, 1440]) {
  for (const theme of ["light", "dark"]) {
    test(`HR-03 directory visual ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (value) => localStorage.setItem("legend-theme", value),
        theme,
      );
      await openDirectory(page);
      await expect(
        page.getByText("Agus Setiawan").filter({ visible: true }).first(),
      ).toBeVisible();
      await captureScreenshot(
        page,
        `legend-zueb/directory-${width}-${theme}.png`,
      );
    });
  }
}

for (const width of [390, 1440]) {
  for (const theme of ["light", "dark"]) {
    test(`HR-03 profile visual ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (value) => localStorage.setItem("legend-theme", value),
        theme,
      );
      await openProfile(page);
      await expect(page.getByText("****0001").first()).toBeVisible();
      await captureScreenshot(
        page,
        `legend-zueb/profile-${width}-${theme}.png`,
      );
    });
  }
}
