import { expect, test } from "@playwright/test";

for (const width of [390, 1280]) {
  test.describe(`legend-s3ex8 evidence mismatch at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("a resolved fund remains visible for review and cannot be resolved again", async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/kelola/pembayaran?mock=resolved-evidence-mismatch", {
        waitUntil: "networkidle",
      });
      await page.getByRole("tab", { name: "Dana belum teralokasi" }).click();
      const panel = page.getByRole("tabpanel", {
        name: "Dana belum teralokasi",
      });
      const resolved = panel
        .getByRole("listitem")
        .filter({ hasText: "B01-0342" });
      await expect(
        resolved.getByText("Selesai", { exact: true }),
      ).toBeVisible();
      await expect(
        resolved.getByText("Bukti berubah", { exact: true }),
      ).toBeVisible();
      await expect(
        resolved.getByRole("button", { name: "Selesaikan", exact: true }),
      ).toHaveCount(0);

      await panel.getByRole("combobox", { name: "Filter status dana" }).click();
      await page
        .getByRole("option", { name: "Perlu dicek", exact: true })
        .click();
      await expect(resolved).toBeVisible();
      await expect(
        resolved.getByText("Selesai", { exact: true }),
      ).toBeVisible();
      await expect(
        resolved.getByText("Bukti berubah", { exact: true }),
      ).toBeVisible();
      await expect(panel.getByText("A05-0421", { exact: true })).toHaveCount(0);
      await expect(
        panel.getByRole("button", { name: "Selesaikan", exact: true }),
      ).toHaveCount(0);
      await page.screenshot({
        path: `/tmp/859-s3ex8-p2-${width}.png`,
        fullPage: true,
      });

      await panel.getByRole("combobox", { name: "Filter status dana" }).click();
      await page.getByRole("option", { name: "Selesai", exact: true }).click();
      await expect(resolved).toBeVisible();
      await expect(
        resolved.getByRole("button", { name: "Selesaikan", exact: true }),
      ).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  });
}
