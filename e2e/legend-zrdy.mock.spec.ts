// Web idempotency keys without a secure context (bead legend-zrdy). The edge
// node may serve the app over plain http on a LAN address, where
// crypto.randomUUID does not exist; every save must still mint a key through
// the shared helper instead of throwing.
import { expect, test } from "@playwright/test";
import { waitForHydration } from "./hydration.ts";

test("legend-zrdy payment routing saves when crypto.randomUUID is unavailable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    // An insecure origin exposes getRandomValues but not randomUUID.
    Object.defineProperty(Crypto.prototype, "randomUUID", {
      value: undefined,
      configurable: true,
    });
  });
  await page.goto("/kelola/pembayaran?mock=normal", {
    waitUntil: "networkidle",
  });
  await waitForHydration(page);
  await page.getByRole("tab", { name: "Routing gateway" }).click();
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe("undefined");

  const row = page
    .getByRole("tabpanel", { name: "Routing gateway" })
    .locator("li")
    .filter({ has: page.getByText("QRIS", { exact: true }) })
    .first();
  await row.getByRole("switch").click();
  await row.getByRole("button", { name: "Simpan" }).click();
  await expect(page.getByText("Routing QRIS tersimpan.").first()).toBeVisible();
});
