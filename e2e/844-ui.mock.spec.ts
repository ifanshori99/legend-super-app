import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";

test.skip(
  !process.env.LEGEND_MOCK_WEB_URL,
  "Requires the mock-mode web server",
);

for (const width of [390, 1280]) {
  test(`844 KDS station summary and layout at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    // Mock transport is in memory, so URL construction records its requests
    // without introducing network calls that production does not make.
    await page.addInitScript(() => {
      const OriginalURL = window.URL;
      const calls: string[] = [];
      Object.assign(window, { __844MockPaths: calls });
      window.URL = class extends OriginalURL {
        constructor(url: string | URL, base?: string | URL) {
          super(url, base);
          if (String(base) === "http://mock.invalid") calls.push(this.pathname);
        }
      };
    });
    await page.goto("/kds?mock=normal");
    await expect(page.getByRole("radio", { name: /^Dapur/ })).toBeVisible();
    await expect(page.getByRole("radio", { name: /^Kopi/ })).toBeVisible();
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (
              window as unknown as { __844MockPaths: string[] }
            ).__844MockPaths.filter((path) =>
              path.endsWith("/kitchen/station-summary"),
            ).length,
        ),
      )
      .toBeGreaterThan(0);
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            new Set(
              (
                window as unknown as { __844MockPaths: string[] }
              ).__844MockPaths.filter((path) =>
                /\/kitchen\/stations\/[^/]+\/board$/.test(path),
              ),
            ).size,
        ),
      )
      .toBe(1);
    const boards = await page.evaluate(() =>
      (window as unknown as { __844MockPaths: string[] }).__844MockPaths.filter(
        (path) => /\/kitchen\/stations\/[^/]+\/board$/.test(path),
      ),
    );
    expect(new Set(boards).size).toBe(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    ).toBeLessThanOrEqual(0);
    await captureScreenshot(page, `844/kds-${width}.png`);
  });

  test(`844 remake names and layout at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/kelola/dapur/remake");
    await expect(
      page.getByRole("heading", { name: "Log remake & comp" }),
    ).toBeVisible();
    await expect(
      page
        .getByText("Budi Santoso", { exact: true })
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
    await expect(
      page
        .getByText("Rina Pratama", { exact: false })
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    ).toBeLessThanOrEqual(0);
    await captureScreenshot(page, `844/remake-${width}.png`);
  });
}
