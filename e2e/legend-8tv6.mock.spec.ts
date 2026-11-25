import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";

test("legend-8tv6 routing saves after a failed attempt and retry", async ({
  page,
}) => {
  await page.goto("/kelola/pembayaran?mock=normal", {
    waitUntil: "networkidle",
  });
  const row = page
    .getByRole("tabpanel", { name: "Routing gateway" })
    .locator("li")
    .filter({ hasText: "QRIS" })
    .first();
  await row.getByRole("switch").click();
  await page.evaluate(() => {
    (
      window as unknown as {
        __legendMock: {
          failNext: (
            id: string,
            error: { status: number; code: string; message?: string },
          ) => void;
        };
      }
    ).__legendMock.failNext("PUT /api/payments/admin/routing/:method", {
      status: 500,
      code: "INTERNAL_ERROR",
      message: "Retry this attempt",
    });
  });
  await row.getByRole("button", { name: "Simpan" }).click();
  // The toast renders the message twice for assistive tech: the visible text
  // and its assertive announcement ("Notifikasi …"). Pin the visible one.
  await expect(
    page.getByText("Routing belum tersimpan. Coba lagi sebentar lagi.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(row.getByRole("button", { name: "Simpan" })).toBeEnabled();
  await row.getByRole("button", { name: "Simpan" }).click();
  await expect(page.getByText("Routing QRIS tersimpan.").first()).toBeVisible();
});

for (const width of [390, 1440]) {
  for (const theme of ["light", "dark"]) {
    test(`legend-8tv6 visual ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (value) => localStorage.setItem("legend-theme", value),
        theme,
      );
      await page.goto("/kelola/pembayaran?mock=normal", {
        waitUntil: "networkidle",
      });
      await expect(
        page.getByRole("heading", { name: "Routing gateway" }),
      ).toBeVisible();
      await captureScreenshot(page, `legend-8tv6/${width}-${theme}.png`);
    });
  }
}
for (const scenario of ["empty", "error"]) {
  test(`legend-8tv6 visual ${scenario}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(`/kelola/pembayaran?mock=${scenario}`, {
      waitUntil: "networkidle",
    });
    await expect(
      page
        .getByText(
          scenario === "error"
            ? "Data pembayaran tidak dapat dimuat"
            : "Belum ada metode yang dirutekan",
        )
        .first(),
    ).toBeVisible();
    await captureScreenshot(page, `legend-8tv6/390-${scenario}.png`);
  });
}
