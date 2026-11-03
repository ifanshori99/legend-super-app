// Audit log viewer + settings hub (WS-11 FE, bead legend-max2; PRD v1.7 §3 F36
// "Audit Log Viewer", "Pengaturan"). Runs against the FE mock runtime
// (VITE_API_MOCK=true): `GET /api/audit/events` is served from the deterministic
// events of features/ws11-audit/mock.ts. Screenshots go through
// e2e/screenshots.ts and only reach the tracked evidence folder when
// LEGEND_CAPTURE_SCREENSHOTS=1.
import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";

const MOCK_URL =
  process.env.LEGEND_MOCK_WEB_URL ??
  process.env.E2E_MOCK_BASE_URL ??
  process.env.LEGEND_MOCK_URL;

test.skip(
  !MOCK_URL,
  "Needs a VITE_API_MOCK=true server (pnpm test:e2e:mock); see the header of this file.",
);

declare global {
  interface Window {
    __legendMock?: { setScenario: (scenario: string) => void };
  }
}

/** A cold Vite dev server paints server HTML before React hydrates. */
async function waitForHydration(page: Page) {
  await page.waitForFunction(
    () => {
      // The hub has only links inside <main>; the shell header always has a
      // button, so any interactive element with a React fiber proves hydration.
      const control = document.querySelector("button, a[href]");
      return (
        control !== null &&
        Object.keys(control).some((key) => key.startsWith("__reactFiber$"))
      );
    },
    undefined,
    { timeout: 60_000 },
  );
}

async function openAudit(page: Page) {
  await page.goto("/audit", { waitUntil: "networkidle" });
  await waitForHydration(page);
}

const rows = (page: Page) =>
  page
    .getByRole("list", { name: "Daftar catatan audit" })
    .getByRole("listitem");

test("AUDIT-VIEW-01: the log shows who, what, when and where for every actor kind", async ({
  page,
}) => {
  await openAudit(page);
  await expect(rows(page).first()).toBeVisible();
  await expect(rows(page)).toHaveCount(25);

  // Actor kinds are icon + text badges with a name.
  for (const [kind, name] of [
    ["Pengguna", "Rina Wulandari"],
    ["Asisten AI", "Asisten Operasional"],
    ["Klien MCP", "Klien MCP Laporan"],
    ["Perangkat", "Tablet Kasir 1"],
  ] as const) {
    const row = rows(page).filter({ hasText: name }).first();
    await expect(row).toBeVisible();
    await expect(row.getByText(kind, { exact: true })).toBeVisible();
  }
  await expect(rows(page).filter({ hasText: "Sistem" }).first()).toBeVisible();
  // What + where.
  await expect(page.getByText("Pengaturan diubah").first()).toBeVisible();
  // Scoped to the list: the outlet filter also holds a hidden <option>.
  await expect(
    rows(page).getByText("Cafe Legend Bandung").first(),
  ).toBeVisible();
  await expect(rows(page).getByText("Laptop Kantor").first()).toBeVisible();
});

test("AUDIT-VIEW-01: filters narrow the list by actor kind and action; reset restores it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAudit(page);

  await page.getByLabel("Jenis pelaku").click();
  await page.getByRole("option", { name: "Asisten AI" }).click();
  await page.getByRole("button", { name: "Terapkan", exact: true }).click();
  await expect(rows(page).first()).toContainText("Asisten Operasional");
  const aiRows = await rows(page).count();
  expect(aiRows).toBeGreaterThan(0);
  expect(aiRows).toBeLessThan(25);
  await expect(rows(page).filter({ hasText: "Rina Wulandari" })).toHaveCount(0);

  await page.getByRole("button", { name: "Atur ulang" }).click();
  await expect(rows(page)).toHaveCount(25);

  // Enter applies the action filter; a bad code says how to fix it.
  await page.getByLabel("Aksi").fill("Role Updated");
  await page.getByLabel("Aksi").press("Enter");
  await expect(
    page.getByText(/huruf kecil dan titik, mis\. role\.updated/),
  ).toBeVisible();
  await page.getByLabel("Aksi").fill("order.voided");
  await page.getByLabel("Aksi").press("Enter");
  await expect(rows(page).first()).toContainText("Pesanan dibatalkan");
  await expect(rows(page).filter({ hasText: "Harga menu diubah" })).toHaveCount(
    0,
  );
});

test("AUDIT-VIEW-01: 'Muat lebih banyak' appends the next cursor page", async ({
  page,
}) => {
  await openAudit(page);
  await expect(rows(page)).toHaveCount(25);
  await page.getByRole("button", { name: "Muat lebih banyak" }).click();
  await expect(rows(page)).toHaveCount(50);
  await page.getByRole("button", { name: "Muat lebih banyak" }).click();
  await expect(rows(page)).toHaveCount(70);
  await expect(page.getByText("Semua catatan sudah tampil.")).toBeVisible();
});

test("AUDIT-VIEW-03: the detail panel shows the masked diff, the IP trace as a hash and the reason", async ({
  page,
}) => {
  await openAudit(page);
  await rows(page)
    .filter({ hasText: "Peran ditugaskan" })
    .first()
    .getByRole("button")
    .click();
  const panel = page.getByRole("dialog", { name: "Detail catatan audit" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Rina Wulandari")).toBeVisible();
  await expect(panel.getByText("role.assigned")).toBeVisible();
  // Masked personal field, plain business field.
  await expect(
    panel.getByRole("cell", { name: "Disamarkan" }).first(),
  ).toBeVisible();
  await expect(
    panel.getByRole("cell", { name: "outlet_manager" }),
  ).toBeVisible();
  await expect(panel.getByText("081234567890")).toHaveCount(0);
  // IP never shown raw: hash prefix only.
  await expect(panel.getByText(/Hash [0-9a-f]{8}…/)).toBeVisible();
  await expect(
    panel.getByText(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});

test("AUDIT-VIEW-02: empty, error and offline states say what to do", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("legend-mock-scenario", "empty"),
  );
  await openAudit(page);
  await expect(page.getByText("Belum ada catatan audit")).toBeVisible();

  await page.evaluate(() => window.__legendMock?.setScenario("error"));
  await page.getByRole("button", { name: "Muat ulang" }).click();
  await expect(page.getByText("Log audit gagal dimuat")).toBeVisible();
  await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();

  await page.evaluate(() => window.__legendMock?.setScenario("offline"));
  await page.getByRole("button", { name: "Coba lagi" }).click();
  await expect(page.getByText("Anda sedang offline")).toBeVisible();

  await page.evaluate(() => window.__legendMock?.setScenario("normal"));
  await page.getByRole("button", { name: "Coba lagi" }).click();
  await expect(rows(page).first()).toBeVisible();
});

test("SETTINGS-HUB-01: the hub links existing tenant, brand and outlet screens only", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/kelola/pengaturan", { waitUntil: "networkidle" });
  await waitForHydration(page);
  for (const name of ["Tenant", "Brand", "Outlet"])
    await expect(
      page.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
  await expect(page.locator('#main-content a[href="/audit"]')).toBeVisible();
  await expect(
    page.locator('#main-content a[href="/kelola/pajak"]'),
  ).toBeVisible();
  await expect(
    page.locator('#main-content a[href="/kelola/menu"]'),
  ).toBeVisible();
  await expect(
    page.locator('#main-content a[href="/kelola/meja"]'),
  ).toBeVisible();
  await page.locator('#main-content a[href="/audit"]').click();
  await expect(page).toHaveURL(/\/audit$/);
});

test("AUDIT-VIEW-01: the audit log and the hub are usable at 390px with no page scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  for (const path of ["/audit", "/kelola/pengaturan"]) {
    await page.goto(path, { waitUntil: "networkidle" });
    await waitForHydration(page);
    const overflow = await page.evaluate(() => {
      const main = document.querySelector("#main-content");
      return Math.max(
        document.documentElement.scrollWidth - window.innerWidth,
        main === null ? 0 : main.scrollWidth - main.clientWidth,
      );
    });
    expect(overflow).toBeLessThanOrEqual(0);
  }
});

for (const width of [390, 1440]) {
  for (const theme of ["light", "dark"]) {
    test(`legend-max2 visual ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (value) => localStorage.setItem("legend-theme", value),
        theme,
      );

      await openAudit(page);
      await expect(rows(page).first()).toBeVisible();
      await page.waitForTimeout(250);
      await captureScreenshot(page, `legend-max2/audit-${width}-${theme}.png`);

      await rows(page).first().getByRole("button").click();
      await expect(
        page.getByRole("dialog", { name: "Detail catatan audit" }),
      ).toBeVisible();
      await page.waitForTimeout(350);
      await captureScreenshot(
        page,
        `legend-max2/audit-detail-${width}-${theme}.png`,
      );

      await page.goto("/kelola/pengaturan", { waitUntil: "networkidle" });
      await waitForHydration(page);
      await page.waitForTimeout(250);
      await captureScreenshot(
        page,
        `legend-max2/pengaturan-${width}-${theme}.png`,
      );
    });
  }
}

for (const width of [390, 1440]) {
  test(`AUDIT-VIEW-02: empty and error states are honest at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() =>
      localStorage.setItem("legend-mock-scenario", "empty"),
    );
    await openAudit(page);
    await expect(page.getByText("Belum ada catatan audit")).toBeVisible();
    await captureScreenshot(page, `legend-max2/audit-${width}-empty.png`);

    await page.evaluate(() => window.__legendMock?.setScenario("error"));
    await page.getByRole("button", { name: "Muat ulang" }).click();
    await expect(page.getByText("Log audit gagal dimuat")).toBeVisible();
    await captureScreenshot(page, `legend-max2/audit-${width}-error.png`);

    await page.evaluate(() => window.__legendMock?.setScenario("normal"));
  });
}
