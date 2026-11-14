import { expect, test } from "@playwright/test";
import { waitForHydration } from "./hydration.ts";

const baseURL =
  process.env.LEGEND_MOCK_WEB_URL ?? process.env.E2E_MOCK_BASE_URL;
test.skip(!baseURL, "Requires the mock-mode web server");
test.use({ baseURL, viewport: { width: 390, height: 844 } });

test("Kelola's loading scroll region can be reached and scrolled by keyboard", async ({
  page,
}) => {
  await page.goto("/kelola/inventori", { waitUntil: "networkidle" });
  await waitForHydration(page);
  const main = page.locator("#main-content");
  // Reproduce a tall loading state without focusable descendants.
  await main.evaluate((element) => {
    element.innerHTML =
      '<div role="status" style="height: 1600px">Memuat…</div>';
  });
  await expect(main).toHaveAttribute("tabindex", "0");
  await expect(main).toHaveAccessibleName(/\S/);
  const skip = page.locator('a[href="#main-content"]');
  await skip.focus();
  await page.keyboard.press("Enter");
  await expect(main).toBeFocused();
  await expect(main).toHaveCSS("outline-style", "solid");
  expect(
    await main.evaluate((element) => element.matches(":focus-visible")),
  ).toBe(true);
  await page.keyboard.press("ArrowDown");
  await expect
    .poll(() => main.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);

  await page.locator("h1").first().click();
  await main.click({ position: { x: 10, y: 10 } });
  await expect(main).toBeFocused();
  expect(
    await main.evaluate((element) => element.matches(":focus-visible")),
  ).toBe(false);
  await expect(main).toHaveCSS("outline-style", "none");
});
