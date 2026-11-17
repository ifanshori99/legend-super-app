// WS-06 HPP and food-cost reports (bead legend-5pe; PRD v1.7 §17 "Resep,
// Produksi & HPP", F17, INV-02, INV-04). Runs against the mock-mode web server
// (no API, no database): `pnpm test:e2e:mock`. Screenshots go through
// e2e/screenshots.ts and only reach tracked evidence with
// LEGEND_CAPTURE_SCREENSHOTS=1.
import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";

const baseURL =
  process.env.LEGEND_MOCK_WEB_URL ?? process.env.E2E_MOCK_BASE_URL;

test.skip(
  !baseURL,
  "Mock runner not started: use pnpm test:e2e:mock (playwright.mock.config.ts).",
);
test.use({ baseURL });

async function open(page: Page, path: string) {
  await page.goto(path, { waitUntil: "networkidle" });
  // The management topbar owns the area h1; the screen section is an h2.
  await expect(
    page.getByRole("heading", { level: 1, name: "Inventori" }),
  ).toBeVisible();
}

/**
 * Server-rendered controls drop a click that lands before hydration. Every
 * interaction below is idempotent, so retry it until React owns the control
 * (same pattern as e2e/legend-vxj.mock.spec.ts).
 */
async function retry(action: () => Promise<void>) {
  await expect(action).toPass({ timeout: 15_000 });
}

async function openTab(page: Page, label: string) {
  await retry(async () => {
    await page.getByRole("tab", { name: label }).click();
    await expect(page.getByRole("tab", { name: label })).toHaveAttribute(
      "aria-selected",
      "true",
      { timeout: 1000 },
    );
  });
}

test("F17 HPP per menu shows theoretical cost, selling price and gross margin", async ({
  page,
}) => {
  await open(page, "/kelola/inventori/hpp");
  await expect(
    page.getByRole("heading", { level: 2, name: "HPP & food cost" }),
  ).toBeVisible();

  const table = page.getByRole("table");
  const kopi = table.getByRole("row", { name: /Kopi Susu Aren/ });
  await expect(kopi).toBeVisible();
  await expect(kopi).toContainText("32.000");
  await expect(kopi).toContainText("10.860");
  await expect(kopi).toContainText("66,06%");

  // A menu without a complete recipe keeps its price but has no cost/margin
  // (PRD §17 "Kelengkapan Resep"); it must never show Rp 0.
  const croissant = table.getByRole("row", { name: /Croissant Mentega/ });
  await expect(croissant).toContainText("35.000");
  await expect(croissant).toContainText("Resep belum lengkap");
  await expect(croissant).toContainText("—");
  await expect(croissant).not.toContainText(/Rp\s*0/);
});

test("INV-02 F17 nested recipe cost is the theoretical HPP of the menu", async ({
  page,
}) => {
  await open(page, "/kelola/inventori/hpp");
  const table = page.getByRole("table");
  // Both menus cost from a multi-level recipe (e.g. Kopi Susu's syrup), not
  // from a placeholder: the fixture's nested BOM cost is what renders.
  const kopi = table.getByRole("row", { name: /Kopi Susu Aren/ });
  await expect(kopi).toContainText("10.860");
  await expect(kopi).toContainText("Resep lengkap");

  const coldBrew = table.getByRole("row", { name: /Cold Brew/ });
  await expect(coldBrew).toContainText("5.480");
  await expect(coldBrew).toContainText("Resep lengkap");
});

test("INV-04 F17 HPP rows carry the time the theoretical cost was computed", async ({
  page,
}) => {
  await open(page, "/kelola/inventori/hpp");
  await expect(
    page.getByRole("columnheader", { name: "Dihitung" }),
  ).toBeVisible();
  // The cost is recomputed by the report pipeline when ingredient prices
  // change; the screen shows the endpoint's computedAt and never caches its
  // own figure (INV-04 is a server guarantee, this is its freshness signal).
  await expect(page.getByRole("row", { name: /Kopi Susu Aren/ })).toContainText(
    "1 Nov 2026",
  );
});

test("F17 actual vs theoretical food cost explains the variance in a chart and a table", async ({
  page,
}) => {
  await open(page, "/kelola/inventori/hpp");
  await expect(page.getByText("3,63%", { exact: true })).toBeVisible();
  // The summary labels its figures with the comparison's own dates, not the
  // 30-day selector window that merely overlaps them.
  await expect(
    page
      .getByRole("region", { name: "Ringkasan food cost periode ini" })
      .getByText("1 Okt 2026 – 31 Okt 2026")
      .first(),
  ).toBeVisible();

  await openTab(page, "Aktual vs teoretis");
  await expect(
    page.getByRole("img", {
      name: /Grafik batang food cost periode 1 Okt 2026 – 31 Okt 2026: teoretis Rp\s?18\.450\.000, aktual Rp\s?19\.120\.000/,
    }),
  ).toBeVisible();

  const table = page.getByRole("table");
  await expect(table).toContainText("1 Okt 2026 – 31 Okt 2026");
  await expect(table).toContainText(/18\.450\.000/);
  await expect(table).toContainText(/19\.120\.000/);
  await expect(table).toContainText(/670\.000/);
  await expect(table).toContainText(/410\.000/);
  await expect(table).toContainText(/95\.000/);
  await expect(table).toContainText(/165\.000/);
  await expect(
    page.getByText("Selisih = waste + penyesuaian + pemakaian di luar resep."),
  ).toBeVisible();
});

test("F17 menu engineering matrix classifies menus and filters the table", async ({
  page,
}) => {
  await open(page, "/kelola/inventori/hpp");
  await openTab(page, "Menu engineering");

  const matrix = page.getByRole("group", { name: "Matriks menu engineering" });
  await expect(matrix).toBeVisible();
  for (const label of ["Star", "Plowhorse", "Puzzle", "Dog"]) {
    await expect(
      matrix.getByRole("button", { name: new RegExp(`^${label}`) }),
    ).toContainText("1 menu");
  }

  const table = page.getByRole("table");
  await expect(table.getByRole("row")).toHaveCount(5);

  const star = matrix.getByRole("button", { name: /^Star/ });
  await retry(async () => {
    await star.click();
    await expect(table.getByRole("row")).toHaveCount(2, { timeout: 1000 });
  });
  await expect(table).toContainText("Kopi Susu Aren");
  await expect(table).not.toContainText("Nasi Goreng Kampung");
  await expect(page.getByText("Klasifikasi: Star")).toBeVisible();

  await page.getByRole("button", { name: "Tampilkan semua" }).click();
  await expect(table.getByRole("row")).toHaveCount(5);
});

test("F17 recipe coverage groups menus by status and flags missing recipes", async ({
  page,
}) => {
  await open(page, "/kelola/inventori/hpp");
  await openTab(page, "Kelengkapan resep");

  await expect(page.getByText("Lengkap · 4")).toBeVisible();
  await expect(page.getByText("Tanpa resep · 57")).toBeVisible();

  const noRecipe = page.getByRole("region", { name: "Tanpa resep" });
  await expect(noRecipe).toBeVisible();
  await expect(
    noRecipe.getByRole("row", { name: /Croissant Mentega/ }),
  ).toBeVisible();

  const complete = page.getByRole("region", { name: "Lengkap" });
  await expect(
    complete.getByRole("row", { name: /Kopi Susu Aren/ }),
  ).toContainText("10.860");
});

test("F17 period filter scopes the two period reports", async ({ page }) => {
  await open(page, "/kelola/inventori/hpp");
  // The fixture comparison is October 2026; moving the window to September
  // must empty the summary and the actual-vs-theoretical view, not keep stale
  // figures. Filling both dates also exercises the from/to controls.
  await retry(async () => {
    await page.getByLabel("Dari tanggal").fill("2026-09-01");
    await page.getByLabel("Sampai tanggal").fill("2026-09-30");
    await expect(page.getByText("Belum ada data food cost")).toBeVisible({
      timeout: 1000,
    });
  });
});

test("F17 empty and error states are reachable in mock mode", async ({
  page,
}) => {
  await open(page, "/kelola/inventori/hpp?mock=empty");
  await expect(page.getByText("Belum ada data food cost")).toBeVisible();
  await expect(page.getByText("Belum ada data HPP menu")).toBeVisible();

  await openTab(page, "Aktual vs teoretis");
  await expect(
    page.getByText("Belum ada perbandingan pada periode ini"),
  ).toBeVisible();

  await openTab(page, "Menu engineering");
  await expect(page.getByText("Belum ada data menu engineering")).toBeVisible();

  await openTab(page, "Kelengkapan resep");
  await expect(
    page.getByText("Belum ada data kelengkapan resep"),
  ).toBeVisible();

  await open(page, "/kelola/inventori/hpp?mock=error");
  await expect(page.getByRole("alert").first()).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Coba lagi" }).first(),
  ).toBeVisible();
});

test("F17 offline notice appears when the device goes offline", async ({
  page,
}) => {
  await open(page, "/kelola/inventori/hpp");
  // The page reads navigator.onLine through a useSyncExternalStore hook; stub
  // the browser signal and fire the same event a real disconnect fires.
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => false,
    });
    window.dispatchEvent(new Event("offline"));
  });
  await expect(page.getByText(/Kamu sedang offline/)).toBeVisible();
});

const VIEWS = [
  { label: "HPP per menu", file: "hpp-menu" },
  { label: "Aktual vs teoretis", file: "hpp-food-cost" },
  { label: "Menu engineering", file: "hpp-engineering" },
  { label: "Kelengkapan resep", file: "hpp-coverage" },
] as const;

for (const width of [390, 1440]) {
  test(`F17 HPP views capture at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page, "/kelola/inventori/hpp");
    for (const view of VIEWS) {
      await openTab(page, view.label);
      await page.waitForTimeout(250);
      await captureScreenshot(page, `legend-5pe/${view.file}-${width}.png`);
    }
  });
}

// Dark mode evidence (DESIGN.md §1 warm dark): the same view with the theme
// pinned before paint, at both widths. Tokens carry it; no dark: overrides.
for (const width of [390, 1440]) {
  test(`F17 HPP captures in dark mode at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() =>
      localStorage.setItem("legend-theme", "dark"),
    );
    await open(page, "/kelola/inventori/hpp");
    await expect(
      page.getByRole("heading", { name: "HPP per menu" }),
    ).toBeVisible();
    await captureScreenshot(page, `legend-5pe/hpp-menu-${width}-dark.png`);
  });
}
