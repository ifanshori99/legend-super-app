import { expect, test } from "@playwright/test";

// Mock scenarios exercise the screen's feedback without an API or database.
test("KDS mock shows empty, error and offline states", async ({ page }) => {
  await page.goto("/kds?mock=empty");
  await expect(page.getByText("Belum ada tiket", { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  await page.goto("/kds?mock=error");
  await expect(
    page.getByText("Papan dapur tidak dapat dimuat", { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();

  await page.goto("/kds?mock=offline");
  await expect(page.getByText("Koneksi terputus", { exact: true })).toBeVisible(
    { timeout: 15_000 },
  );
});
