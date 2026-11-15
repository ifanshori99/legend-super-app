import { expect, test } from "@playwright/test";

// legend-1iyup: the loading rules must hydrate without a block Skeleton
// nested inside a paragraph. Keep the slow response so both placeholders
// are exercised before the published overtime and THR rules replace them.
const base = process.env.LEGEND_MOCK_WEB_URL ?? "";
test.skip(base === "", "Set LEGEND_MOCK_WEB_URL (pnpm test:e2e:mock).");

test.describe("payroll policies hydration", () => {
  test.describe.configure({ timeout: 90_000 });

  for (const width of [390, 1280]) {
    test(`loading rules hydrate at ${width}px without nesting diagnostics`, async ({
      page,
    }) => {
      const diagnostics: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error" || message.type() === "warning")
          diagnostics.push(message.text());
      });
      page.on("pageerror", (error) => diagnostics.push(error.message));
      await page.setViewportSize({ width, height: 900 });
      await page.goto(
        `${base}/kelola/payroll/pengaturan?tab=policies&mock=slow`,
        { waitUntil: "domcontentloaded", timeout: 60_000 },
      );

      const rules = page.locator('[data-slot="card"]').filter({
        has: page.getByRole("heading", { name: "Aturan yang berlaku" }),
      });
      await expect(rules.locator('[data-slot="skeleton"]')).toHaveCount(2);
      await expect(
        rules.getByText("Rumus lembur: 173 jam/bulan, pengali 1,5 · 2."),
      ).toBeVisible({ timeout: 30_000 });
      await expect(rules.getByText(/^THR:/)).toBeVisible();
      await expect(rules.locator('[data-slot="skeleton"]')).toHaveCount(0);

      expect(
        diagnostics.filter((message) =>
          /hydrat|cannot be a descendant|cannot contain a nested|validateDOMNesting/i.test(
            message,
          ),
        ),
      ).toEqual([]);
    });
  }
});
