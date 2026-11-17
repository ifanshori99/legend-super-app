// Owner dashboard, part 1 (WS-11 FE, bead legend-k8fk; PRD v1.7 §3 F34,
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
  ["realtime_summary", "Ringkasan"],
  ["operations", "Operasional"],
  ["shower", "Shower"],
  ["seats_wfc", "Kursi & WFC"],
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

async function openOwnerBoard(page: Page) {
  await page.goto("/owner", { waitUntil: "networkidle" });
  await waitForHydration(page);
  // The ManagementShell topbar owns the page title (DESIGN.md v3).
  await expect(page.getByRole("heading", { name: "Owner" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Ringkasan" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
}

test("DASH-01: the owner dashboard shows today's sales against the target, traceable to its source report", async ({
  page,
}) => {
  await openOwnerBoard(page);

  // Values come from the sales.target run (DASH-02), the period from the
  // dashboard layout's open business day.
  await expect(page.getByText("Penjualan hari ini")).toBeVisible();
  await expect(page.getByText(/7\.420\.000/)).toBeVisible();
  await expect(page.getByText("Target penjualan")).toBeVisible();
  await expect(page.getByText(/24\.000\.000/)).toBeVisible();
  const progress = page.getByRole("progressbar", {
    name: "Pencapaian target penjualan",
  });
  await expect(progress).toHaveAttribute("aria-valuenow", "31");

  // DASH-01: the estimate label. The source-report path (same period and
  // outlet scope as the run) is unit-tested in tests/ws11-owner-dashboard.
  // Source viewers now include traffic and operations as well as sales.
  // Every link must still point to the source report of a displayed tile.
  await expect(page.getByText("Estimasi", { exact: true })).toBeVisible();
  const reportLinks = page.locator('a[href^="/reports"]');
  expect(await reportLinks.count()).toBeGreaterThan(0);
  for (const href of await reportLinks.evaluateAll((links) =>
    links.map((link) => link.getAttribute("href")),
  )) {
    expect([
      "/reports/sales/target",
      "/reports/traffic/pax",
      "/reports/sales/transactions",
      "/reports/operations/table-turnover",
      "/reports/sales/per-channel",
    ]).toContain(href);
  }

  // One StatStrip for the related KPIs (DESIGN.md v3 / Q30), not separate cards.
  const strip = page.getByRole("region", {
    name: "Tamu, transaksi, dan okupansi meja",
  });
  await expect(strip).toBeVisible();
  await expect(strip.getByText("Tamu", { exact: true })).toBeVisible();
  await expect(strip.getByText("148", { exact: true })).toBeVisible();
  await expect(strip.getByText("96", { exact: true })).toBeVisible();
  await expect(strip.getByText("Okupansi meja")).toBeVisible();
  await expect(strip.getByText("62,5%", { exact: true })).toBeVisible();

  // The channel split is the same sales.per_channel report, one row per channel.
  await expect(
    page.getByRole("heading", { name: "Penjualan per kanal" }),
  ).toBeVisible();
  await expect(page.getByRole("cell", { name: "QR meja" })).toBeVisible();
  await expect(page.getByText(/4\.150\.000/)).toBeVisible();
});

test("DASH-01: operations, shower, and seats tabs show their report-backed tiles", async ({
  page,
}) => {
  await openOwnerBoard(page);

  await page.getByRole("tab", { name: "Operasional" }).click();
  await expect(
    page.getByRole("heading", { name: "Antrean dapur saat ini" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Menu terlaris" }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "Kopi Susu Aren" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Waktu saji per stasiun" }),
  ).toBeVisible();
  await expect(page.getByText("4,6/5", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Ulasan terbaru" }),
  ).toBeVisible();
  await expect(
    page.getByText("Kopi susu arennya konsisten dan pelayanan cepat."),
  ).toBeVisible();

  await page.getByRole("tab", { name: "Shower" }).click();
  await expect(page.getByText("Status bilik saat ini")).toBeVisible();
  await expect(page.getByText("Utilisasi bilik")).toBeVisible();
  await expect(page.getByText("56,3%", { exact: true })).toBeVisible();
  // These sources are explicitly unavailable: show no invented revenue,
  // subscriptions or F&B conversion while retaining real occupancy above.
  for (const label of [
    "Pendapatan fasilitas",
    "Langganan aktif",
    "Konversi ke F&B",
  ]) {
    const tile = page.locator('[data-slot="stat-tile"]').filter({
      has: page.getByRole("paragraph").filter({ hasText: label }),
    });
    await expect(tile.getByText("—", { exact: true })).toBeVisible();
    await expect(tile.getByText(/Rp/)).toHaveCount(0);
  }
  await expect(page.getByText(/1\.350\.000|61,1%/)).toHaveCount(0);

  await page.getByRole("tab", { name: "Kursi & WFC" }).click();
  await expect(
    page.getByRole("heading", { name: "Okupansi kursi per zona" }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "Indoor Reguler" }).first(),
  ).toBeVisible();
  const zoneOccupancy = page.getByRole("region", {
    name: "Okupansi kursi per zona",
  });
  await expect(
    zoneOccupancy
      .getByRole("row")
      .filter({ hasText: "Indoor Reguler" })
      .getByRole("cell"),
  ).toHaveText(["Indoor Reguler", "—", "—"]);
  await expect(page.getByText("68,8%", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Durasi duduk dan belanja" }),
  ).toBeVisible();
  await expect(page.getByText("Pemakaian Wi-Fi")).toBeVisible();
  const wifi = page.locator('[data-slot="stat-tile"]').filter({
    has: page.getByRole("paragraph").filter({ hasText: /^Pemakaian Wi-Fi$/ }),
  });
  await expect(wifi.getByText("—", { exact: true })).toBeVisible();
  await expect(wifi.getByText(/210/)).toHaveCount(0);
});

test("DASH-03: the owner dashboard is fully usable at 360px with no page scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await openOwnerBoard(page);

  const pageOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(pageOverflow).toBeLessThanOrEqual(0);

  for (const [, label] of TABS) {
    await page.getByRole("tab", { name: label }).click();
    await expect(page.getByRole("tab", { name: label })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // The shell's work area is its own scroll container: a wide table must
    // scroll inside its card, never expand the canvas (DESIGN.md §5 gotcha).
    const shellOverflow = await page.evaluate(() => {
      const main = document.querySelector("#main-content");
      return main === null ? 0 : main.scrollWidth - main.clientWidth;
    });
    expect(shellOverflow).toBeLessThanOrEqual(0);
  }
});

for (const width of [390, 1440]) {
  for (const theme of ["light", "dark"]) {
    test(`legend-k8fk visual ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (value) => localStorage.setItem("legend-theme", value),
        theme,
      );
      await page.goto("/owner", { waitUntil: "networkidle" });
      await waitForHydration(page);

      for (const [value, label] of TABS) {
        // Reset to the review viewport so a short tab does not inherit the
        // height of the previous, longer one.
        await page.setViewportSize({ width, height: 900 });
        await page.getByRole("tab", { name: label }).click();
        await expect(page.getByRole("tab", { name: label })).toHaveAttribute(
          "aria-selected",
          "true",
        );
        // ManagementShell scrolls its work area, so grow the viewport to the
        // tab's full height before the (document) screenshot.
        const contentHeight = await page.evaluate(
          () => document.querySelector("#main-content")?.scrollHeight ?? 900,
        );
        await page.setViewportSize({
          width,
          height: Math.min(5200, Math.max(900, contentHeight + 32)),
        });
        // Let the tab chip's 120ms colour transition settle before capturing.
        await page.waitForTimeout(250);
        await captureScreenshot(
          page,
          `legend-k8fk/owner-${value}-${width}-${theme}.png`,
        );
      }
    });
  }
}

for (const width of [390, 1440]) {
  test(`DASH-03: empty and error states are honest at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });

    // Empty: the layout still arrives (SSR), the report runs carry no rows.
    await page.addInitScript(() =>
      localStorage.setItem("legend-mock-scenario", "empty"),
    );
    await page.goto("/owner", { waitUntil: "networkidle" });
    await waitForHydration(page);
    await expect(
      page.getByText("Belum ada data hari ini").first(),
    ).toBeVisible();
    await captureScreenshot(
      page,
      `legend-k8fk/owner-realtime-${width}-empty.png`,
    );

    // Error: the layout is cached from SSR; the report calls fail, and every
    // failed region keeps its own retry.
    await page.evaluate(() => window.__legendMock?.setScenario("error"));
    await page.getByRole("button", { name: "Muat ulang" }).click();
    await expect(page.getByText("Gagal dimuat").first()).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Coba lagi" }).first(),
    ).toBeVisible();
    await captureScreenshot(
      page,
      `legend-k8fk/owner-realtime-${width}-error.png`,
    );

    await page.evaluate(() => window.__legendMock?.setScenario("normal"));
  });
}
