// Owner dashboard, part 2 (WS-11 FE, bead legend-gb03; PRD v1.7 §3 F34,
// DASH-01/DASH-03). Runs against the FE mock runtime: the owner layout and each
// tile's source-report run come from @starter/shared/dashboard fixtures through
// VITE_API_MOCK=true — no API, no database (frontend standard, browser specs
// in mock mode). Screenshots go through e2e/screenshots.ts and only reach the
// tracked evidence folder when LEGEND_CAPTURE_SCREENSHOTS=1.
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
  ["cost_margin", "Biaya"],
  ["service_quality", "Layanan"],
  ["finance", "Keuangan"],
  ["alerts", "Peringatan"],
  ["daily_summary", "Harian"],
  ["multi_outlet", "Outlet"],
] as const;

/** A cold Vite dev server paints server HTML before React hydrates. */
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

async function openTab(page: Page, label: string) {
  await page.goto("/owner", { waitUntil: "networkidle" });
  await waitForHydration(page);
  await page.getByRole("tab", { name: label }).click();
  await expect(page.getByRole("tab", { name: label })).toHaveAttribute(
    "aria-selected",
    "true",
  );
}

test("DASH-01: cost and margin shows the running month as an estimate against the last closed month", async ({
  page,
}) => {
  await openTab(page, "Biaya");
  const strip = page.getByRole("region", {
    name: "Food cost, labor cost, dan prime cost",
  });
  await expect(strip).toBeVisible();
  await expect(strip.getByText("31,2%", { exact: true })).toBeVisible();
  await expect(strip.getByText("58,7%", { exact: true })).toBeVisible();
  await expect(strip.getByText(/estimasi/).first()).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Grafik garis prime cost persen per bulan" }),
  ).toBeVisible();
  await expect(page.getByRole("cell", { name: /^Okt/ })).toBeVisible();
  // Cost and finance reports have no viewer route yet: no link to a 404.
  await expect(page.locator('a[href^="/reports"]')).toHaveCount(0);
});

test("DASH-01: service quality, finance, alerts, daily summary and multi-outlet show their report-backed numbers", async ({
  page,
}) => {
  await openTab(page, "Layanan");
  await expect(page.getByText("Item gagal", { exact: true })).toBeVisible();
  await expect(page.getByText("87,5%", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: "Keuangan" }).click();
  await expect(page.getByText(/96\.500\.000/)).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Laba rugi berjalan" }),
  ).toBeVisible();
  await expect(page.getByText("estimasi").first()).toBeVisible();

  await page.getByRole("tab", { name: "Peringatan" }).click();
  await expect(page.getByText("Stok kritis").first()).toBeVisible();
  await expect(page.getByText("Rincian peringatan")).toBeVisible();

  await page.getByRole("tab", { name: "Harian" }).click();
  await expect(page.getByText("Belum ada ringkasan tertulis")).toBeVisible();
  await expect(page.getByText(/7\.420\.000/).first()).toBeVisible();

  await page.getByRole("tab", { name: "Outlet" }).click();
  await expect(
    page.getByRole("heading", { name: "Perbandingan antar-outlet" }),
  ).toBeVisible();
  await expect(page.getByRole("cell", { name: "Outlet 1" })).toBeVisible();
  // Same day as the real-time channel table: its four channels add up here.
  await expect(page.getByText(/7\.420\.000/).first()).toBeVisible();
});

test("DASH-03: the part-2 tabs fit 360px with no page scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await openTab(page, "Biaya");
  for (const [, label] of TABS) {
    await page.getByRole("tab", { name: label }).click();
    const overflow = await page.evaluate(() => {
      const main = document.querySelector("#main-content");
      return main === null ? 0 : main.scrollWidth - main.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(0);
  }
});

for (const width of [390, 1440]) {
  for (const theme of ["light", "dark"]) {
    test(`legend-gb03 visual ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (value) => localStorage.setItem("legend-theme", value),
        theme,
      );
      await page.goto("/owner", { waitUntil: "networkidle" });
      await waitForHydration(page);
      for (const [value, label] of TABS) {
        await page.setViewportSize({ width, height: 900 });
        await page.getByRole("tab", { name: label }).click();
        await expect(page.getByRole("tab", { name: label })).toHaveAttribute(
          "aria-selected",
          "true",
        );
        await page.waitForTimeout(250);
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
          `legend-gb03/owner-${value}-${width}-${theme}.png`,
        );
      }
    });
  }
}

for (const width of [390, 1440]) {
  test(`DASH-03: part-2 empty and error states are honest at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() =>
      localStorage.setItem("legend-mock-scenario", "empty"),
    );
    await openTab(page, "Biaya");
    await expect(
      page.getByText("Belum ada data hari ini").first(),
    ).toBeVisible();
    await captureScreenshot(page, `legend-gb03/owner-cost-${width}-empty.png`);

    await page.evaluate(() => window.__legendMock?.setScenario("error"));
    await page.getByRole("button", { name: "Muat ulang" }).click();
    await expect(
      page.getByText("Data tidak dapat dimuat").first(),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Coba lagi" }).first(),
    ).toBeVisible();
    await captureScreenshot(page, `legend-gb03/owner-cost-${width}-error.png`);

    await page.evaluate(() => window.__legendMock?.setScenario("normal"));
  });
}
