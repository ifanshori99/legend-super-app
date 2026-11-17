// Shareholder dashboard (WS-11 FE, bead legend-ik9g; PRD v1.7 §3 F35, §4 Alur
// O; SH-01, SH-02, DASH-03). Runs against the FE mock runtime
// (VITE_API_MOCK=true): layout, report runs, profit share and documents come
// from features/ws11-shareholder/mock.ts. The session is the mock shareholder
// role (cookie legend-mock-role). Screenshots go through e2e/screenshots.ts.
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

const TABS = [
  ["business", "Kondisi bisnis"],
  ["profit", "Bagi hasil saya"],
  ["documents", "Dokumen"],
] as const;

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([
    {
      name: "legend-mock-role",
      value: "shareholder",
      url: baseURL ?? MOCK_URL!,
    },
  ]);
});

async function waitForHydration(page: Page) {
  await page.waitForFunction(
    () => {
      const tab = document.querySelector('[role="tab"]');
      return (
        tab !== null &&
        Object.keys(tab).some((key) => key.startsWith("__reactFiber$"))
      );
    },
    undefined,
    { timeout: 60_000 },
  );
}

async function openDashboard(page: Page) {
  await page.goto("/shareholder", { waitUntil: "networkidle" });
  await waitForHydration(page);
  await expect(
    page.getByRole("tab", { name: "Kondisi bisnis" }),
  ).toHaveAttribute("aria-selected", "true");
}

test("SH-01: closed period figures are official and the running period is labelled estimate", async ({
  page,
}) => {
  await openDashboard(page);

  await expect(page.getByText("Oktober 2026").first()).toBeVisible();
  await expect(page.getByText("Resmi", { exact: true })).toBeVisible();
  // One strip for the closed period (DESIGN.md §12).
  const strip = page.getByRole("region", { name: "Ringkasan periode tutup" });
  await expect(page.locator('[data-slot="stat-strip"]')).toHaveCount(1);
  await expect(
    strip.getByRole("paragraph").filter({ hasText: /^Omzet$/ }),
  ).toBeVisible();
  await expect(strip.getByText(/412\.800\.000/)).toBeVisible();
  await expect(
    strip.getByRole("paragraph").filter({ hasText: /^Laba bersih$/ }),
  ).toBeVisible();
  // DASH-02: the strip's guests and gross profit equal the source reports'
  // (report viewer sales.per_pax and the owner income statement, October).
  // The metric registry answers avg_spend_per_pax `unavailable`, so the tile
  // shows no number instead of a figure the source report does not serve.
  await expect(strip.getByText("8.222", { exact: true })).toBeVisible();
  await expect(strip.getByText(/50\.207/)).toHaveCount(0);
  await expect(strip.getByText("Belanja per tamu")).toBeVisible();
  await expect(strip.getByText(/273\.686\.400/)).toBeVisible();
  await expect(page.getByText(/8\.222/)).toHaveCount(2);
  await expect(page.getByText(/7\.920|52\.121/)).toHaveCount(0);
  await expect(page.getByText("KPI year-to-date")).toBeVisible();

  // The running period sits in its own card with the estimate badge, and its
  // figures never appear among the official strips.
  const running = page.getByText("Periode berjalan", { exact: true });
  await expect(running).toBeVisible();
  await expect(
    page.getByText("Estimasi", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText(/Estimasi sampai pembukuan/)).toBeVisible();
  // The running month-to-date net sales (Rp7.420.000, the owner board's day).
  await expect(strip.getByText(/7\.420\.000/)).toHaveCount(0);

  // SH-01: shareholders may open the aggregate report allowlist (legend-5bjh),
  // while employee, customer and member detail reports remain unavailable.
  const allowedReportPaths = [
    "/reports/sales/daily",
    "/reports/sales/per-pax",
    "/reports/traffic/pax",
    "/reports/finance/gross-margin",
    "/reports/finance/ebitda",
    "/reports/finance/income-statement",
    "/reports/finance/cash-position",
  ];
  const reportLinks = page.locator('a[href^="/reports"]');
  expect(await reportLinks.count()).toBeGreaterThan(0);
  for (const href of await reportLinks.evaluateAll((links) =>
    links.map((link) => link.getAttribute("href")),
  )) {
    expect(allowedReportPaths).toContain(href);
  }
});

test("SH-02: the profit share tab shows only the shareholder's own history, estimate labelled", async ({
  page,
}) => {
  await openDashboard(page);
  await page.getByRole("tab", { name: "Bagi hasil saya" }).click();

  await expect(
    page.getByRole("heading", { name: "Estimasi bagi hasil berjalan" }),
  ).toBeVisible();
  await expect(
    page.getByText("Estimasi", { exact: true }).first(),
  ).toBeVisible();
  // MTD estimate: 25% of the running month's net profit Rp1.025.000 (legend-zc3g).
  await expect(page.getByText(/256\.250/).first()).toBeVisible();

  await expect(page.getByRole("heading", { name: "Porsi saya" })).toBeVisible();
  await expect(
    page.getByRole("cell", { name: /PT Sultan Solusi Nusantara/ }).first(),
  ).toBeVisible();
  await expect(page.getByRole("cell", { name: "25%" }).first()).toBeVisible();

  const history = page.getByRole("region", { name: "Riwayat bagi hasil" });
  await expect(
    page.getByRole("heading", { name: "Riwayat bagi hasil" }),
  ).toBeVisible();
  // Distributed statements come from closed periods: official (SH-01).
  await expect(history.getByText("Resmi", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("cell", { name: /Oktober 2026/ }).first(),
  ).toBeVisible();
  await expect(page.getByText(/33\.412\.500/).first()).toBeVisible();
  await expect(page.getByText("Penyesuaian").first()).toBeVisible();
  await expect(
    page.getByText("Belum dibayar").filter({ visible: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Riwayat perubahan porsi" }),
  ).toBeVisible();

  // Own data only: no other holder of the fixture appears (SH-02).
  await expect(
    page.getByText(/Raka Pratama|Angkasa Modal|Nur Aisyah/),
  ).toHaveCount(0);
});

test("SH-02: documents lists only what is published for shareholders", async ({
  page,
}) => {
  await openDashboard(page);
  await page.getByRole("tab", { name: "Dokumen" }).click();
  await expect(page.getByText("Laporan Bulanan Oktober 2026")).toBeVisible();
  await expect(page.getByText("Notulen RUPS Tahunan 2026")).toHaveCount(0);
  await expect(
    page.getByText("Draf Laporan Kinerja Outlet Bandung"),
  ).toHaveCount(0);
});

test("DASH-03: the shareholder dashboard is usable at 360px with no page scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await openDashboard(page);
  for (const [, label] of TABS) {
    await page.getByRole("tab", { name: label }).click();
    await expect(page.getByRole("tab", { name: label })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.waitForTimeout(400);
    const pageOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(pageOverflow).toBeLessThanOrEqual(0);
    const shellOverflow = await page.evaluate(() => {
      const main = document.querySelector("#main-content");
      return main === null ? 0 : main.scrollWidth - main.clientWidth;
    });
    expect(shellOverflow).toBeLessThanOrEqual(0);
  }
});

for (const width of [390, 1440]) {
  for (const theme of ["light", "dark"]) {
    test(`legend-ik9g visual ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (value) => localStorage.setItem("legend-theme", value),
        theme,
      );
      await page.goto("/shareholder", { waitUntil: "networkidle" });
      await waitForHydration(page);
      for (const [value, label] of TABS) {
        await page.setViewportSize({ width, height: 900 });
        await page.getByRole("tab", { name: label }).click();
        await expect(page.getByRole("tab", { name: label })).toHaveAttribute(
          "aria-selected",
          "true",
        );
        await page.waitForTimeout(500);
        const contentHeight = await page.evaluate(
          () => document.querySelector("#main-content")?.scrollHeight ?? 900,
        );
        await page.setViewportSize({
          width,
          height: Math.min(5200, Math.max(900, contentHeight + 32)),
        });
        await page.waitForTimeout(250);
        await captureScreenshot(
          page,
          `legend-ik9g/shareholder-${value}-${width}-${theme}.png`,
        );
      }
    });
  }
}

for (const width of [390, 1440]) {
  test(`DASH-03: empty, error and offline states are honest at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });

    await page.addInitScript(() =>
      localStorage.setItem("legend-mock-scenario", "empty"),
    );
    await page.goto("/shareholder", { waitUntil: "networkidle" });
    await waitForHydration(page);
    await expect(page.getByText("Belum ada data periode tutup")).toBeVisible();
    await captureScreenshot(
      page,
      `legend-ik9g/shareholder-business-${width}-empty.png`,
    );
    await page.getByRole("tab", { name: "Bagi hasil saya" }).click();
    await expect(page.getByText("Belum ada data bagi hasil")).toBeVisible();
    await page.getByRole("tab", { name: "Dokumen" }).click();
    await expect(page.getByText("Belum ada dokumen")).toBeVisible();

    await page.evaluate(() => window.__legendMock?.setScenario("error"));
    await page.getByRole("button", { name: "Muat ulang" }).click();
    await expect(
      page.getByText("Data tidak dapat dimuat").first(),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Coba lagi" }).first(),
    ).toBeVisible();
    await captureScreenshot(
      page,
      `legend-ik9g/shareholder-documents-${width}-error.png`,
    );

    await page.evaluate(() => window.__legendMock?.setScenario("offline"));
    await page.getByRole("button", { name: "Muat ulang" }).click();
    await expect(page.getByText("Anda sedang offline").first()).toBeVisible();

    await page.evaluate(() => window.__legendMock?.setScenario("normal"));
  });
}
