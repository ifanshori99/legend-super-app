// WS-10 payroll configuration (bead legend-r1bu; PRD v1.7 §3 F30 "Payroll",
// PAYR-02 "Perubahan tarif BPJS/PTKP/TER/lembur/THR selalu menjadi versi baru
// dengan tanggal efektif: draf → terbit → arsip; versi terbit tidak pernah
// diubah di tempat").
//
// Mock-mode spec: `pnpm test:e2e:mock e2e/legend-r1bu.mock.spec.ts` starts the
// web dev server with VITE_API_MOCK=true (playwright.mock.config.ts), so the
// Cafe Legend payroll fixtures answer without an API and without a database.
// Without LEGEND_MOCK_WEB_URL every test skips, so `pnpm test:e2e` (production
// build, mock compiled out) never fails on it.
//
// `/kelola/payroll/pengaturan` is not on e2e/mock-global-setup.ts WARM_ROUTES
// (a shared file this bead must not edit), so the first assertion on the route
// allows for a cold Vite compile (the frontend standard, "Browser specs in
// mock mode").
import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";

const base = process.env.LEGEND_MOCK_WEB_URL;
test.skip(
  !base,
  "Set LEGEND_MOCK_WEB_URL (pnpm test:e2e:mock) to a web server running VITE_API_MOCK.",
);

const COLD_START_TIMEOUT_MS = 30_000;
const ROUTE = "/kelola/payroll/pengaturan";

// The first load of this route compiles it on a cold Vite server (20-35 s on a
// loaded machine); every later test on the route is warm.
test.describe.configure({ timeout: 90_000 });

// Fixture ids (cafeLegendPayrollFixtures; stable by construction): the BPJS
// Kesehatan v2 draft that the replay test publishes.
const BPJS_KES_V2_DRAFT_ID = "00000000-0000-4000-8000-000000005011";
const REPLAY_KEY = "legend-r1bu-replay-0001";

type Theme = "light" | "dark";

/** Shape of a statutory version on the wire, for the replay assertions. */
type WireStatutoryVersion = {
  id: string;
  type: string;
  version: number;
  status: "draft" | "published" | "archived";
};

/** The dev-only mock control the feature registers (features/ws10-payroll-config/mock.ts). */
type PayrollMockControl = {
  publishStatutoryVersion: (
    versionId: string,
    idempotencyKey: string,
  ) => Promise<{ data: WireStatutoryVersion }>;
  listStatutoryTables: (type?: string) => Promise<{
    data: WireStatutoryVersion[];
  }>;
};

async function openSection(
  page: Page,
  tab: "policies" | "components" | "statutory" | "thr",
  theme: Theme = "light",
) {
  await page.addInitScript(
    (value) => localStorage.setItem("legend-theme", value),
    theme,
  );
  await page.goto(`${base}${ROUTE}?tab=${tab}`, {
    waitUntil: "networkidle",
    timeout: 60_000,
  });
}

/** The management topbar owns the page h1 (DESIGN.md v3 §5). */
async function expectShellTitle(page: Page) {
  await expect(
    page.getByRole("heading", { name: "Pengaturan Payroll", level: 1 }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
}

/**
 * The toast viewport is fixed above dialogs (z-60) and pauses its timer on
 * hover, so a click aimed at a dialog footer can be intercepted indefinitely.
 * Close the confirmation toasts between steps of a multi-dialog journey.
 */
async function dismissToasts(page: Page) {
  const dismiss = page.getByRole("button", { name: "Tutup notifikasi" });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if ((await dismiss.count()) === 0) return;
    await dismiss
      .first()
      .click({ timeout: 2_000 })
      .catch(() => undefined);
    await page.waitForTimeout(100);
  }
}

test.describe("payroll configuration", () => {
  test("PAYR-02: the ?tab= links render policies, components, statutory tables and THR fixtures", async ({
    page,
  }) => {
    await openSection(page, "policies");
    await expectShellTitle(page);

    // Policies: the two fixture groups with their cycle summary. Every list
    // renders a table (desktop) and a compact list (390px); the table role
    // only matches the visible one, so no strict-mode or hidden-element trap.
    const policiesTable = page.getByRole("table");
    await expect(
      page.getByRole("heading", { name: "Kebijakan payroll", level: 2 }),
    ).toBeVisible();
    await expect(
      policiesTable.getByText("Payroll Bulanan Cafe Legend"),
    ).toBeVisible();
    await expect(
      policiesTable.getByText("Karyawan Bulanan · MONTHLY"),
    ).toBeVisible();
    await expect(
      policiesTable.getByText("Potong tgl 25, bayar tgl 28 bulan yang sama"),
    ).toBeVisible();
    await expect(
      policiesTable.getByText("Payroll Harian Cafe Legend"),
    ).toBeVisible();
    // The overtime formula is not a policy field: it comes from the published
    // statutory table, so the policies tab states the version in force.
    await expect(
      page.getByText("Rumus lembur: 173 jam/bulan, pengali 1,5 · 2."),
    ).toBeVisible();

    // Components: system components with their tax/BPJS bases.
    const tabs = page.getByRole("navigation", {
      name: "Bagian konfigurasi payroll",
    });
    await tabs.getByRole("link", { name: "Komponen" }).click();
    await expect(page).toHaveURL(/tab=components/);
    await expect(
      page.getByRole("heading", { name: "Komponen gaji", level: 2 }),
    ).toBeVisible();
    const componentsTable = page.getByRole("table");
    await expect(componentsTable.getByText(/^BASIC/)).toBeVisible();
    await expect(
      componentsTable.getByText("Gaji Pokok", { exact: true }),
    ).toBeVisible();
    await expect(componentsTable.getByText("Dasar BPJS").first()).toBeVisible();

    // Statutory tables: published versions plus the one fixture draft.
    await tabs.getByRole("link", { name: "Tabel ketentuan" }).click();
    await expect(page).toHaveURL(/tab=statutory/);
    await expect(
      page.getByRole("heading", { name: "Tabel tarif berversi", level: 2 }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Tidak ada tanggal efektif yang bertumpang tindih pada tabel yang sama.",
      ),
    ).toBeVisible();
    const statutoryTable = page.getByRole("table");
    await expect(
      statutoryTable
        .getByRole("row")
        .filter({ hasText: "BPJS Kesehatan" })
        .filter({ hasText: "Versi 1" }),
    ).toBeVisible();
    await expect(
      statutoryTable
        .getByRole("row")
        .filter({ hasText: "BPJS Kesehatan" })
        .filter({ hasText: "Versi 2" })
        .getByText("Draf", { exact: true }),
    ).toBeVisible();
    // PTKP and TER are versioned tables too, not screens of their own.
    await expect(
      statutoryTable.getByText("PTKP", { exact: true }),
    ).toBeVisible();
    await expect(
      statutoryTable.getByText("PPh 21 TER", { exact: true }),
    ).toBeVisible();

    // THR: the 2027 Idul Fitri schedule with its tenure reference date.
    await tabs.getByRole("link", { name: "THR" }).click();
    await expect(page).toHaveURL(/tab=thr/);
    await expect(
      page.getByRole("heading", { name: "Jadwal THR", level: 2 }),
    ).toBeVisible();
    const thrTable = page.getByRole("table");
    await expect(thrTable.getByText("THR Idul Fitri 2027")).toBeVisible();
    await expect(
      thrTable.getByText("Idul Fitri", { exact: true }),
    ).toBeVisible();
    await expect(thrTable.getByText("10 Mar 2027").first()).toBeVisible();
    await expect(
      thrTable.getByText("Terjadwal", { exact: true }),
    ).toBeVisible();
    // The tenure rule is exact-date arithmetic, not calendar months.
    await expect(
      page.getByText(/31 Januari sampai 28 Februari = 0 bulan/),
    ).toBeVisible();
  });

  test("PAYR-02: creating a pay component adds it to the catalog table", async ({
    page,
  }) => {
    await openSection(page, "components");
    await expectShellTitle(page);
    await expect(
      page.getByRole("heading", { name: "Komponen gaji", level: 2 }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Komponen baru" }).click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Komponen gaji baru" }),
    ).toBeVisible();
    await dialog.getByLabel("Kode", { exact: true }).fill("SHIFT_MEAL");
    await dialog.getByLabel("Nama komponen").fill("Uang shift malam");
    // Flags are editable: this component is taxable and counts toward BPJS.
    await dialog.getByRole("switch", { name: "Dasar BPJS" }).click();
    await dialog.getByRole("button", { name: "Simpan" }).click();

    await expect(page.getByText("Komponen gaji dibuat.").first()).toBeVisible();
    const row = page
      .getByRole("row")
      .filter({ hasText: "SHIFT_MEAL" })
      .filter({ hasText: "Uang shift malam" });
    await expect(row).toBeVisible();
    await expect(row.getByText("Kena PPh 21")).toBeVisible();
    await expect(row.getByText("Dasar BPJS")).toBeVisible();
    // A new component is an admin-made earning, not a system row.
    await expect(row.getByText("Sistem")).toHaveCount(0);
  });

  test("PAYR-02: a statutory draft is created, edited, published and compared with its previous version", async ({
    page,
  }) => {
    await openSection(page, "statutory");
    await expectShellTitle(page);
    const statutoryTable = page.getByRole("table");

    // Create: copy the JHT v1 table into a v2 draft.
    await page.getByRole("button", { name: "Versi draf baru" }).click();
    let dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Draf versi baru · BPJS Kesehatan" }),
    ).toBeVisible();
    await dialog.getByRole("combobox").first().click();
    await page.getByRole("option", { name: "JHT", exact: true }).click();
    await expect(
      dialog.getByRole("heading", { name: "Draf versi baru · JHT" }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Simpan draf" }).click();
    await expect(
      page.getByText("Draf tabel tarif dibuat.").first(),
    ).toBeVisible();
    await dismissToasts(page);

    const draftRow = statutoryTable
      .getByRole("row")
      .filter({ hasText: "JHT" })
      .filter({ hasText: "Versi 2" });
    await expect(draftRow.getByText("Draf", { exact: true })).toBeVisible();

    // Edit the draft: the employer rate becomes 4% (fixture v1 is 3,7%).
    await draftRow.getByRole("button", { name: "Ubah draf JHT" }).click();
    dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Ubah draf · JHT versi 2" }),
    ).toBeVisible();
    await dialog.getByLabel("Tarif pemberi kerja (%)").fill("4");
    await dialog.getByRole("button", { name: "Simpan draf" }).click();
    await expect(
      page.getByText("Draf tabel tarif disimpan.").first(),
    ).toBeVisible();
    await dismissToasts(page);

    // Publish: the status pill flips from Draf to Terbit; the version stays 2.
    await draftRow.getByRole("button", { name: "Terbitkan JHT" }).click();
    dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Terbitkan JHT versi 2?" }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Terbitkan versi" }).click();
    await expect(
      page.getByText("Versi tabel tarif diterbitkan.").first(),
    ).toBeVisible();
    await dismissToasts(page);
    await expect(draftRow.getByText("Terbit", { exact: true })).toBeVisible();
    await expect(draftRow.getByText("Draf", { exact: true })).toHaveCount(0);
    await expect(
      statutoryTable
        .getByRole("row")
        .filter({ hasText: "JHT" })
        .filter({ hasText: "Versi 2" }),
    ).toHaveCount(1);

    // Compare with the previous version: the changed rate is flagged.
    await draftRow
      .getByRole("button", { name: "Bandingkan versi JHT" })
      .click();
    dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Bandingkan JHT" }),
    ).toBeVisible();
    await expect(dialog.getByText("Berubah").first()).toBeVisible();
    await expect(dialog.getByText("4%", { exact: true })).toBeVisible();
    await expect(dialog.getByText("3,7%", { exact: true })).toBeVisible();
    // Escape closes it: the dialog also has a built-in "Tutup" icon button, so
    // a name lookup would be ambiguous.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // Archive: a draft that should never apply is archived, not deleted.
    await page.getByRole("button", { name: "Versi draf baru" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox").first().click();
    await page.getByRole("option", { name: "JKM", exact: true }).click();
    await dialog.getByRole("button", { name: "Simpan draf" }).click();
    await expect(
      page.getByText("Draf tabel tarif dibuat.").first(),
    ).toBeVisible();
    await dismissToasts(page);
    const jkmRow = statutoryTable
      .getByRole("row")
      .filter({ hasText: "JKM" })
      .filter({ hasText: "Versi 2" });
    await expect(jkmRow.getByText("Draf", { exact: true })).toBeVisible();
    await jkmRow.getByRole("button", { name: "Arsipkan JKM" }).click();
    dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Arsipkan draf JKM versi 2?" }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Arsipkan draf" }).click();
    await expect(
      page.getByText("Draf tabel tarif diarsipkan.").first(),
    ).toBeVisible();
    await dismissToasts(page);
    await expect(jkmRow.getByText("Diarsipkan", { exact: true })).toBeVisible();
  });

  test("PAYR-02: replaying a publish with the same idempotency key returns the recorded version, not a duplicate", async ({
    page,
  }) => {
    await openSection(page, "statutory");
    await expectShellTitle(page);
    // The control is installed when the browser's mock module graph loads,
    // which happens with hydration, after the SSR HTML is already painted.
    await page.waitForFunction(() =>
      Boolean(
        (window as unknown as { __legendPayrollConfigMock?: unknown })
          .__legendPayrollConfigMock,
      ),
    );

    const result = await page.evaluate(
      async ({ versionId, key }) => {
        const mock = (
          window as unknown as {
            __legendPayrollConfigMock?: PayrollMockControl;
          }
        ).__legendPayrollConfigMock;
        if (!mock) throw new Error("payroll mock control is not installed");
        const first = await mock.publishStatutoryVersion(versionId, key);
        // Same key, same body: the mock must replay the recorded answer.
        const second = await mock.publishStatutoryVersion(versionId, key);
        const listed = await mock.listStatutoryTables("bpjs_kes");
        return { first, second, rows: listed.data };
      },
      { versionId: BPJS_KES_V2_DRAFT_ID, key: REPLAY_KEY },
    );

    expect(result.second).toEqual(result.first);
    expect(result.first.data.id).toBe(BPJS_KES_V2_DRAFT_ID);
    expect(result.first.data.status).toBe("published");
    expect(result.first.data.version).toBe(2);
    const rows = result.rows.filter((row) => row.id === BPJS_KES_V2_DRAFT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("published");
  });

  test("PAYR-02: setting an employee pay component appends a dated amount", async ({
    page,
  }) => {
    await openSection(page, "components");
    await expectShellTitle(page);
    await expect(
      page.getByRole("heading", { name: "Komponen gaji", level: 2 }),
    ).toBeVisible();

    const panel = page
      .locator('[data-slot="card"]')
      .filter({ hasText: "Komponen gaji karyawan" });
    await panel.getByLabel("Cari karyawan").fill("CL-1001");
    await page.getByRole("combobox").first().click();
    await page.getByRole("option", { name: /CL-1001/ }).click();

    await expect(
      panel.getByRole("heading", { name: /^Komponen tetap/ }),
    ).toBeVisible();
    await expect(panel.getByText(/Rp\s?12\.000\.000/)).toBeVisible();

    await panel.getByLabel("Nominal gaji").fill("13500000");
    await panel.getByRole("button", { name: "Simpan nominal" }).click();
    await expect(
      page.getByText("Nominal komponen gaji tersimpan.").first(),
    ).toBeVisible();

    // The contract closes the old row the day before and opens a new one; the
    // write-only field never echoes the saved amount back.
    await expect(panel.getByText(/Rp\s?13\.500\.000/)).toBeVisible();
    await expect(panel.getByText(/sekarang/).first()).toBeVisible();
    await expect(panel.getByLabel("Nominal gaji")).toHaveValue("");
  });

  test("PAYR-02: the empty scenario shows each list's empty state", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() =>
      localStorage.setItem("legend-theme", "light"),
    );
    await page.goto(`${base}${ROUTE}?tab=components&mock=empty`, {
      waitUntil: "networkidle",
      timeout: 60_000,
    });
    await expectShellTitle(page);
    await expect(
      page.getByText("Belum ada komponen gaji", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Komponen sistem muncul bersama fixture; komponen buatan admin dapat ditambahkan di sini.",
      ),
    ).toBeVisible();
    await captureScreenshot(page, "legend-r1bu/components-empty-390-light.png");
  });

  for (const [width, theme] of [
    [390, "light"],
    [390, "dark"],
    [1440, "light"],
  ] as const) {
    test(`PAYR-02: components tab renders at ${width}px in ${theme} mode`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await openSection(page, "components", theme);
      await expectShellTitle(page);
      // The table and the 390px list duplicate the rows; the pager footer is
      // outside both, so this assertion holds at every viewport. 15 = the 12
      // seeded components + TAX_ALLOWANCE, PPH21_REFUND and PPH21_RECEIVABLE.
      await expect(page.getByText("15 baris", { exact: true })).toBeVisible();
      await captureScreenshot(
        page,
        `legend-r1bu/components-${width}-${theme}.png`,
      );
    });
  }

  test("PAYR-02: the statutory version table renders at 1440px in light mode", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openSection(page, "statutory", "light");
    await expectShellTitle(page);
    const statutoryTable = page.getByRole("table");
    await expect(
      statutoryTable.getByText("BPJS Kesehatan").first(),
    ).toBeVisible();
    await expect(statutoryTable.getByText("Versi 2").first()).toBeVisible();
    await captureScreenshot(page, "legend-r1bu/statutory-1440-light.png");
  });
});
