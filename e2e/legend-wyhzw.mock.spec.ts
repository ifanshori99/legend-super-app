import { expect, test } from "@playwright/test";
import { waitForHydration } from "./hydration.ts";
import { captureScreenshot } from "./screenshots.ts";

const baseURL =
  process.env.LEGEND_MOCK_WEB_URL ?? process.env.E2E_MOCK_BASE_URL;
test.skip(!baseURL, "Requires the mock-mode web server");
test.use({ baseURL });

for (const width of [390, 1280]) {
  test(`Customer scroll region supports keyboard focus at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/member", { waitUntil: "networkidle" });
    await waitForHydration(page);
    const main = page.locator("#main-content");
    const title = await page
      .getByRole("navigation", { name: "Navigasi utama" })
      .locator('[aria-current="page"]')
      .innerText();
    await expect(main).toHaveAttribute("tabindex", "0");
    await expect(main).toHaveAccessibleName(title);
    await captureScreenshot(page, `legend-wyhzw/after-${width}.png`, {
      fullPage: false,
    });

    // A loading state can overflow before it contains any focusable controls.
    await main.evaluate((element) => {
      element.innerHTML =
        '<div role="status" style="height: 1600px">Memuat…</div>';
    });
    await page.locator('a[href="#main-content"]').focus();
    await page.keyboard.press("Enter");
    await expect(main).toBeFocused();
    expect(
      await main.evaluate((element) => element.matches(":focus-visible")),
    ).toBe(true);
    await expect(main).toHaveCSS("outline-style", "solid");
    await expect(main).toHaveCSS("outline-offset", "-2px");
    await captureScreenshot(page, `legend-wyhzw/focus-${width}.png`, {
      fullPage: false,
    });
    await page.keyboard.press("ArrowDown");
    await expect
      .poll(() => main.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);

    await page.locator("header").first().click();
    await main.click({ position: { x: 10, y: 10 } });
    await expect(main).toBeFocused();
    expect(
      await main.evaluate((element) => element.matches(":focus-visible")),
    ).toBe(false);
    await expect(main).toHaveCSS("outline-style", "none");
  });
}
