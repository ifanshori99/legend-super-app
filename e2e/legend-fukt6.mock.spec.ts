// Cash out approval goes through the inbox (bead legend-fukt6). A pending cash
// out always has an approval chain; the direct approve answers
// CASH_OUT_CHAIN_OPEN/MISSING until the chain is done, so the row offers a link
// to the approval inbox instead of a direct "Setujui". Tolak stays.
//
// Run: LEGEND_MOCK_WEB_URL=<mock server> pnpm test:e2e:mock e2e/legend-fukt6.mock.spec.ts
import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";

const base = process.env.LEGEND_MOCK_WEB_URL;

test.describe.configure({ timeout: 60_000 });
test.skip(
  !base,
  "Set LEGEND_MOCK_WEB_URL to a web server running VITE_API_MOCK.",
);

const FIXTURE_NOW = new Date("2026-11-03T12:00:00.000+07:00");

async function openEntries(page: Page) {
  await page.clock.setFixedTime(FIXTURE_NOW);
  await page.goto("/kelola/akuntansi/kas-bank?mock=normal", {
    waitUntil: "networkidle",
  });
  await expect(
    page.getByText("Pembelian peralatan dapur").locator("visible=true").first(),
  ).toBeVisible({ timeout: 30_000 });
}

for (const [name, width, height] of [
  ["360", 360, 900],
  ["1280", 1280, 900],
] as const) {
  test(`legend-fukt6 pending cash out links to the inbox at ${name}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await openEntries(page);
    const row = page.locator("li, tr").filter({
      hasText: "Pembelian peralatan dapur",
      visible: true,
    } as never);
    const scope = row.first();
    await expect(
      scope.getByRole("link", { name: /^Ke kotak persetujuan/ }),
    ).toHaveAttribute("href", "/kelola/persetujuan");
    await expect(scope.getByRole("button", { name: /^Setujui / })).toHaveCount(
      0,
    );
    await expect(scope.getByRole("button", { name: /^Tolak / })).toBeVisible();
    await captureScreenshot(page, `legend-fukt6/${name}.png`);
  });
}
