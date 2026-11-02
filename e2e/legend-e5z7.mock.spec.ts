// Design v2 (bead legend-e5z7, owner Q30): every kelola page uses the
// management shell's content area instead of adding its own outer padding, and
// related page metrics share one StatStrip with hairline dividers.
//
// Runs against the mock-mode web server (no API, no database):
//   LEGEND_MOCK_PORT=3240 pnpm test:e2e:mock e2e/legend-e5z7.mock.spec.ts
import { expect, test, type Page } from "@playwright/test";

const baseURL =
  process.env.LEGEND_MOCK_WEB_URL ?? process.env.E2E_MOCK_BASE_URL;

test.skip(
  !baseURL,
  "Mock runner not started: use pnpm test:e2e:mock (playwright.mock.config.ts).",
);
test.use({ baseURL });

const KELOLA_PAGES = [
  "/kelola/menu",
  "/kelola/pajak",
  "/kelola/meja",
  "/kelola/notifikasi",
  "/kelola/inventori",
  "/kelola/akuntansi",
  "/kelola/pembayaran",
  "/kelola/loyalty",
  "/kelola/dapur",
  "/kelola/akses",
  "/kelola/pengadaan",
] as const;

async function open(page: Page, path: string) {
  await page.goto(path, { waitUntil: "networkidle" });
  await expect(page.locator("#main-content")).toBeVisible();
}

/** The shell content wrapper: the only child of the management scroll area. */
const CONTENT = "#main-content > div";

test.describe("legend-e5z7 · kelola page gutter", () => {
  test("E5Z7 every kelola page leaves the outer gutter to the shell", async ({
    page,
  }) => {
    for (const path of KELOLA_PAGES) {
      await open(page, path);
      const padding = await page.evaluate((selector) => {
        const content = document.querySelector(selector);
        if (!content) throw new Error("shell content missing");
        // The page frame is the last child (banners/warnings render before it).
        const frame = content.lastElementChild;
        if (!frame)
          throw new Error(`page frame missing on ${location.pathname}`);
        const style = getComputedStyle(frame);
        return {
          left: parseFloat(style.paddingLeft),
          top: parseFloat(style.paddingTop),
          path: location.pathname,
        };
      }, CONTENT);
      expect(padding, `${path} must not add its own outer padding`).toEqual({
        left: 0,
        top: 0,
        path,
      });
    }
  });

  test("E5Z7 phone content aligns to the shell gutter, not twice it", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, "/kelola/menu");
    const metrics = await page.evaluate((selector) => {
      const content = document.querySelector(selector);
      if (!content) throw new Error("shell content missing");
      // v3 (legend-tqnd): the page title moved into the ManagementShell
      // topbar, so measure the first thing the page frame renders instead.
      const frame = content.lastElementChild;
      const first = frame?.firstElementChild ?? frame;
      if (!first) throw new Error("page frame missing");
      return {
        gutter: parseFloat(getComputedStyle(content).paddingLeft),
        offset:
          first.getBoundingClientRect().left -
          content.getBoundingClientRect().left,
      };
    }, CONTENT);
    // 24px is the management (padat) gutter; the old page added another 24px.
    expect(metrics.gutter).toBe(24);
    expect(metrics.offset).toBe(metrics.gutter);
  });

  test("E5Z7 desktop content aligns to the shell gutter, not twice it", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, "/kelola/pajak");
    const metrics = await page.evaluate((selector) => {
      const content = document.querySelector(selector);
      const heading = document.querySelector("#main-content h1");
      if (!content || !heading) throw new Error("content or heading missing");
      return {
        gutter: parseFloat(getComputedStyle(content).paddingLeft),
        offset:
          heading.getBoundingClientRect().left -
          content.getBoundingClientRect().left,
      };
    }, CONTENT);
    expect(metrics.gutter).toBe(24);
    expect(metrics.offset).toBe(metrics.gutter);
  });
});

test.describe("legend-e5z7 · page stats in one StatStrip", () => {
  async function expectStrip(page: Page, tiles: number) {
    const strip = page.locator('[data-slot="stat-strip"]');
    await expect(strip).toHaveCount(1);
    await expect(strip.locator('[data-slot="stat-tile"]')).toHaveCount(tiles);
    // One container, hairline dividers: the tiles themselves are borderless.
    const widths = await strip
      .locator('[data-slot="stat-tile"]')
      .evaluateAll((nodes) =>
        nodes.map((node) => getComputedStyle(node).borderTopWidth),
      );
    expect(widths).toEqual(Array.from({ length: tiles }, () => "0px"));
  }

  test("E5Z7 PBJT report metrics share one strip", async ({ page }) => {
    await open(page, "/kelola/pajak/laporan");
    await expect(page.getByText("Total pajak")).toBeVisible();
    await expectStrip(page, 3);
  });

  test("E5Z7 stock balance metrics share one strip", async ({ page }) => {
    await open(page, "/kelola/inventori/saldo");
    await expect(
      page.getByText("Item di bawah par", { exact: true }),
    ).toBeVisible();
    await expectStrip(page, 3);
  });

  test("E5Z7 settlement reconciliation metrics share one strip", async ({
    page,
  }) => {
    await open(page, "/kelola/pembayaran");
    await page.getByRole("tab", { name: "Rekonsiliasi" }).click();
    await expect(page.getByText("Baris cocok")).toBeVisible();
    await expectStrip(page, 5);
  });
});
