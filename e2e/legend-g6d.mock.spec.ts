import { expect, test } from "@playwright/test";

// RBAC admin happy paths (bead legend-g6d; PRD v1.7 §3 F7 "RBAC, Organisasi &
// Matriks Approval"; TEN-03 outlet scope, AUTH-06 distinct approver) against
// the FE mock runtime: roles, custom roles, scoped/time-bound grants with a
// re-authentication step, and the approval matrix. No API and no database; the
// screens read @starter/shared/access and identity fixtures via
// VITE_API_MOCK=true.
//
// How to run: `pnpm test:e2e:mock` (bead legend-n2sp) starts a mock-mode web
// server and names it in LEGEND_MOCK_WEB_URL. The production e2e config ignores
// `*.mock.spec.ts`, and with no variable set every test skips.
const MOCK_URL = process.env.LEGEND_MOCK_WEB_URL;

test.skip(
  !MOCK_URL,
  "Needs a VITE_API_MOCK=true server (pnpm test:e2e:mock); see the header of this file.",
);

const NAV = { waitUntil: "networkidle" as const };

// Dialogs and selects animate in; DESIGN.md turns every duration off under
// prefers-reduced-motion, so the interactions land on the final position.
test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test("TEN-03 · roles list opens a template read-only and keeps the access tabs", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/kelola/akses?mock=normal`, NAV);
  await expect(
    page.getByRole("heading", { name: "Akses & peran" }).first(),
  ).toBeVisible();

  const tabs = page.getByRole("navigation", { name: "Akses & peran" });
  await expect(tabs.locator('a[aria-current="page"]')).toHaveText("Peran");

  const table = page.getByRole("table");
  await expect(
    table.getByRole("row").filter({ hasText: "Kasir" }).first(),
  ).toBeVisible();
  // Fixture template: Admin Tenant can manage roles but cannot change a
  // template's permission set (PRD §3 F7 "Template Role").
  await table.getByRole("link", { name: "Kasir", exact: true }).first().click();
  await expect(
    page.getByRole("heading", { name: "Kasir", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Template bawaan: izinnya ditetapkan kontrak."),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Katalog izin" }),
  ).toBeVisible();
});

test("AUTH-05 · a custom role built from the catalog is created and opens its detail", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/kelola/akses/baru?mock=normal`, NAV);
  await expect(
    page.getByRole("heading", { name: "Peran khusus baru" }).first(),
  ).toBeVisible();

  await page
    .getByLabel("Nama peran", { exact: false })
    .fill("Supervisor Malam");
  // Outlet scope is preselected; keep it and pick a permission from the catalog.
  await page
    .getByRole("searchbox", { name: "Cari izin…" })
    .fill("Setujui void");
  await page
    .getByRole("checkbox", { name: /Setujui void/ })
    .first()
    .check();
  await expect(page.getByText("1 izin dipilih")).toBeVisible();

  // The mock viewer (Admin Tenant) does not hold pos.void.approve, so adding
  // it asks for a second-factor check first (RBAC grant rule). The first save
  // surfaces the step; the role is created only after the code is verified.
  await page.getByRole("button", { name: "Buat peran" }).click();
  await expect(
    page.getByText("Verifikasi ulang diperlukan.").first(),
  ).toBeVisible();
  await expect(page.getByText("Peran khusus dibuat.")).toHaveCount(0);
  await page.getByLabel("Kode autentikator").fill("123456");
  await page.getByRole("button", { name: "Verifikasi kode" }).click();
  await expect(page.getByLabel("Kode autentikator")).toBeDisabled();

  await page.getByRole("button", { name: "Buat peran" }).click();
  await expect(page.getByText("Peran khusus dibuat.").first()).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Supervisor Malam" }),
  ).toBeVisible();
  await expect(page.getByText("pos.void.approve").first()).toBeVisible();
});

test("TEN-03 · a role is granted with an outlet scope and validity after re-authentication", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/kelola/akses/penugasan?mock=normal`, NAV);
  await expect(
    page.getByRole("heading", { name: "Penugasan peran" }).first(),
  ).toBeVisible();

  await page.getByRole("button", { name: "Beri peran" }).first().click();
  await expect(page.getByRole("heading", { name: "Beri peran" })).toBeVisible();

  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox").nth(0).click();
  await page.getByRole("option", { name: "Nina Marlina" }).click();
  await dialog.getByRole("combobox").nth(1).click();
  await page.getByRole("option", { name: "Kasir", exact: true }).click();
  await dialog.getByRole("button", { name: "Lanjut" }).click();

  // Cashier may only be granted at outlet scope (ROLE_SCOPE_NOT_ALLOWED).
  await expect(page.getByRole("radio", { name: "Outlet" })).toBeChecked();
  await dialog.getByRole("combobox").first().click();
  await page
    .getByRole("option", { name: "Cafe Legend Bandung", exact: true })
    .click();
  // A time-bound grant: 30 days from now is enough for the fixture flow.
  const until = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const untilLocal = until.toISOString().slice(0, 16);
  await page.getByLabel("Berlaku sampai", { exact: false }).fill(untilLocal);
  await dialog.getByRole("button", { name: "Lanjut" }).click();

  await expect(dialog.getByLabel("Kode autentikator")).toBeVisible();
  await dialog.getByLabel("Kode autentikator").fill("123456");
  await dialog.getByRole("button", { name: "Verifikasi kode" }).click();
  await expect(
    page.getByText("Verifikasi berhasil. Lanjutkan untuk memberi peran."),
  ).toBeVisible();

  await dialog.getByRole("button", { name: "Beri peran" }).click();
  await expect(page.getByText("Peran diberikan.").first()).toBeVisible();
});

test("AUTH-06 · the matrix states the distinct-approver rule and saves a new tier", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/kelola/akses/matriks-approval?mock=normal`, NAV);
  await expect(
    page.getByRole("heading", { name: "Akses & peran" }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("Penyetuju selalu berbeda dari pemohon (AUTH-06).", {
      exact: true,
    }),
  ).toBeVisible();
  // Fixture matrix: 14 of the 31 approval actions have a policy.
  await expect(
    page.getByText("14 dari 31 tindakan memiliki kebijakan."),
  ).toBeVisible();

  // Reimbursement has no policy yet: it is denied until a tier exists.
  const uncovered = page
    .getByRole("listitem")
    .filter({ hasText: "Reimbursement" })
    .first();
  await uncovered.getByRole("button", { name: "Atur" }).click();

  // The matrix rows are CardShell (data-slot="card-shell") after the v3 shells;
  // accept both slots so the heading still scopes the row.
  const card = page
    .getByRole("heading", { name: "Reimbursement" })
    .locator(
      "xpath=ancestor::*[@data-slot='card' or @data-slot='card-shell'][1]",
    );
  await card.getByRole("combobox", { name: "Penyetuju" }).click();
  await page
    .getByRole("option", { name: "Supervisor / Captain", exact: true })
    .click();

  await page.getByRole("button", { name: "Simpan matriks" }).click();
  await expect(
    page.getByText("Matriks approval disimpan.").first(),
  ).toBeVisible();
  await expect(
    page.getByText("15 dari 31 tindakan memiliki kebijakan."),
  ).toBeVisible();
});

test("legend-g6d · empty and error scenarios render the honest states", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}/kelola/akses?mock=empty`, NAV);
  await expect(page.getByText("Belum ada peran")).toBeVisible();

  await page.goto(`${MOCK_URL}/kelola/akses?mock=error`, NAV);
  await expect(page.getByText("Data tidak dapat dimuat")).toBeVisible({
    timeout: 15_000,
  });
});
