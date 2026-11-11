import { expect, test, type Page } from "@playwright/test";
import { waitForHydration } from "./hydration.ts";

// Receipt-run alert on the edge status screen (bead legend-s7szu; mockup
// receipt-run-s7szu.html). When the edge node reports a repeated receipt run
// rotation, the screen shows the alert, the node, when it was recorded and the
// restore procedure for the technical administrator (reset
// edge_nodes.instance_id). "Perbarui status" re-reads the status.
//
// Run: LEGEND_MOCK_WEB_URL=<mock server> pnpm test:e2e:mock e2e/legend-s7szu.mock.spec.ts
//
// Assumptions: the screen is /operasional/koneksi (the edge status UI); the
// alert is raised through the edge mock's runtime control
// window.__legendEdgeMock.setReceiptRunAlert(true) followed by "Perbarui
// status"; the mock node's id is not asserted.
const base = process.env.LEGEND_MOCK_WEB_URL ?? "";
test.skip(base === "", "Set LEGEND_MOCK_WEB_URL (pnpm test:e2e:mock).");

declare global {
  interface Window {
    __legendEdgeMock?: { setReceiptRunAlert: (on: boolean) => void };
  }
}

// The mock runtime loads lazily on the first API call, so the control exists
// only after the status request started. Wait for it: calling it through `?.`
// before that would silently do nothing and the alert would never appear.
async function setReceiptRunAlert(page: Page, on: boolean) {
  await page.waitForFunction(() => window.__legendEdgeMock !== undefined);
  await page.evaluate(
    (value) => window.__legendEdgeMock?.setReceiptRunAlert(value),
    on,
  );
}

test.describe("legend-s7szu receipt run alert", () => {
  test("no alert is shown while the node reports none", async ({ page }) => {
    test.slow();
    await page.goto(`${base}/operasional/koneksi`);
    await waitForHydration(page);
    await expect(
      page.getByRole("button", { name: "Perbarui status" }),
    ).toBeVisible();
    await expect(page.getByText("Rotasi nomor struk berulang")).toHaveCount(0);
  });

  test("a reported alert shows the node, time and restore procedure", async ({
    page,
  }) => {
    test.slow();
    await page.goto(`${base}/operasional/koneksi`);
    await waitForHydration(page);
    await setReceiptRunAlert(page, true);
    await page.getByRole("button", { name: "Perbarui status" }).click();

    const alert = page.getByRole("alert").filter({
      hasText: "Rotasi nomor struk berulang",
    });
    await expect(alert).toBeVisible();
    await expect(
      alert.getByText(
        "Node edge melaporkan rotasi nomor struk berulang. Hubungi administrator teknis untuk memeriksa pemulihan node.",
      ),
    ).toBeVisible();
    await expect(alert.getByText("Node edge:")).toBeVisible();
    await expect(alert.getByText("Peringatan tercatat:")).toBeVisible();
    await expect(alert).toContainText("WIB");

    // The restore procedure is a collapsible guide for the technical admin.
    await alert.getByText("Petunjuk untuk administrator teknis").click();
    await expect(alert.getByText("edge_nodes.instance_id")).toBeVisible();
    await expect(
      alert.getByText(
        "Identifikasi node yang tercantum dan periksa penyebab pemulihan atau duplikasi node sebelum melakukan perubahan.",
      ),
    ).toBeVisible();
    await expect(
      alert.getByText(
        "Perbarui status dan periksa kembali peringatan setelah pemulihan.",
      ),
    ).toBeVisible();
  });

  test("refreshing after recovery clears the alert and confirms it", async ({
    page,
  }) => {
    test.slow();
    await page.goto(`${base}/operasional/koneksi`);
    await waitForHydration(page);
    await setReceiptRunAlert(page, true);
    await page.getByRole("button", { name: "Perbarui status" }).click();
    await expect(page.getByText("Rotasi nomor struk berulang")).toBeVisible();

    await setReceiptRunAlert(page, false);
    await page.getByRole("button", { name: "Perbarui status" }).click();
    await expect(
      page.getByText(
        "Status berhasil diperbarui. Tidak ada peringatan rotasi nomor struk pada node ini.",
      ),
    ).toBeVisible();
    await expect(page.getByText("Rotasi nomor struk berulang")).toHaveCount(0);
  });
});
