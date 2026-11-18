import { expect, test, type Page } from "@playwright/test";

// Edge status screen, receipt-run alert per node (bead legend-n5u8w, S5).
// Screen: /kelola/status-edge, states from `?demo=` (features/ws02-edge/
// nodes-mock.ts). Screenshots go to design/screens/n5u8w/ at 360 and 1280 wide
// (full page).
//
// Run: pnpm test:e2e:mock e2e/legend-n5u8w.mock.spec.ts — mock mode only, no
// API and no DB.

/** Cold Vite dev server: the first SSR hit can take >20 s (legend-1336). */
const COLD_START_TIMEOUT_MS = 30_000;

const PATH = "/kelola/status-edge";
const WIDTHS = [360, 1280] as const;

const states = [
  // Default mock: one connected node with its receipt-run alert.
  { name: "normal", query: "", alerts: ["edge-jakarta-01"] },
  { name: "tanpa-banner", query: "?demo=normal", alerts: [] as string[] },
  {
    name: "dua-node-beralarm",
    query: "?demo=beralarm",
    alerts: ["edge-jakarta-01", "edge-bandung-01"],
  },
];

const receiptAlerts = (page: Page) =>
  page.getByRole("alert").filter({ hasText: "Rotasi nomor struk berulang" });

for (const state of states) {
  test(`Status edge ${state.name}: banner per node`, async ({ page }) => {
    for (const [index, width] of WIDTHS.entries()) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`${PATH}${state.query}`);
      await expect(
        page.getByRole("heading", { name: "Node outlet" }),
      ).toBeVisible({ timeout: index === 0 ? COLD_START_TIMEOUT_MS : 10_000 });

      const banners = receiptAlerts(page);
      await expect(banners).toHaveCount(state.alerts.length);
      for (const [i, node] of state.alerts.entries()) {
        await expect(banners.nth(i)).toContainText(node);
      }

      // No horizontal overflow at either width.
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      );
      expect(overflow).toBe(false);

      // The shell scrolls inside its own container, so `fullPage` alone would
      // cut at the viewport: grow the viewport to the tallest scroll height
      // outside the sidebar.
      const height = await page.evaluate(() =>
        Math.max(
          ...Array.from(document.querySelectorAll("*"))
            .filter((el) => !el.closest("aside, nav"))
            .map((el) => el.scrollHeight),
        ),
      );
      // +48: the scroll height leaves out the bottom padding of the content.
      await page.setViewportSize({ width, height: Math.max(800, height + 48) });
      await page.screenshot({
        path: `design/screens/n5u8w/${state.name}-${width}.png`,
        fullPage: true,
      });
    }
  });
}
