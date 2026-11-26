// O4 evidence in mock mode (bead legend-wasr7.8, Keputusan CTO 27 Nov, option
// B): the scenes mock mode can show. The offline queue does not run in mock
// mode (no kit), so offline is the "no kit" banner; the supervisor force close
// runs on the mock engine (`?demo=tutup-paksa*`, legend-7mlf). The queued sale
// scenes (pay, saved, queue, close, sign-out) move to O5 over the real API.
//
//   heavy --browser pnpm test:e2e:mock e2e/o4-offline.mock.spec.ts
//
// Output: test-results/screenshots/legend-wasr7.8/o4-<scene>-<390|1280>.png
// (the review copies them to docs/review/img/).
import { expect as baseExpect, test, type Page } from "@playwright/test";
import { waitForHydration } from "./hydration.ts";
import { captureScreenshot } from "./screenshots.ts";

const expect = baseExpect.configure({ timeout: 15_000 });
const DEMO_SHIFT_ID = "0c0c0001-0000-4000-8000-000000000001";
const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
];

test.describe.configure({ timeout: 90_000 });

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await waitForHydration(page);
}

async function shot(page: Page, scene: string): Promise<void> {
  // The mock tenant has an active support-access session; a real cashier
  // session has none, so hide that banner in the evidence only.
  await page.addStyleTag({
    content: '[data-slot="support-session-bar"]{display:none !important}',
  });
  await captureScreenshot(
    page,
    `legend-wasr7.8/o4-${scene}-${page.viewportSize()?.width ?? 0}.png`,
    { fullPage: false },
  );
}

/** The supervisor screen of the demo shift, opened at its force close. */
async function forceClose(page: Page, seed: string): Promise<void> {
  await open(page, `/pos/supervisor/shift/${DEMO_SHIFT_ID}?demo=${seed}`);
  await page.getByRole("button", { name: "Tutup paksa shift" }).first().click();
  await expect(
    page
      .getByRole("heading", { name: /Penutupan paksa|Menunggu|Siap/ })
      .first(),
  ).toBeVisible();
}

for (const viewport of VIEWPORTS) {
  test.describe(`O4 mock scenes ${viewport.width}`, () => {
    test.use({ viewport });

    test("offline without a kit: the banner says sales cannot be taken", async ({
      page,
      context,
    }) => {
      await open(page, "/pos/kasir");
      await context.setOffline(true);
      await expect(
        page.getByText("Offline · penjualan offline tidak tersedia").first(),
      ).toBeVisible();
      await shot(page, "banner-tanpa-bekal");
      await context.setOffline(false);
    });

    test("force close, count: the supervisor counts the drawer", async ({
      page,
    }) => {
      await forceClose(page, "tutup-paksa");
      await expect(
        page.getByText("Hitung ulang uang di laci").first(),
      ).toBeVisible();
      await shot(page, "paksa-hitung");
    });

    test("force close, witness: a third person approves the count", async ({
      page,
    }) => {
      await forceClose(page, "tutup-paksa-menunggu");
      await expect(
        page.getByText("Persetujuan supervisor lain").first(),
      ).toBeVisible();
      await shot(page, "paksa-saksi");
    });

    test("force close, ready and closed: the written reason closes the shift", async ({
      page,
    }) => {
      await forceClose(page, "tutup-paksa-siap");
      await expect(page.getByText("Siap tutup paksa").first()).toBeVisible();
      await shot(page, "paksa-siap");
      await page
        .getByLabel("Alasan penutupan paksa")
        .fill("Tablet kasir rusak, antrean offline belum terkirim");
      await page
        .getByRole("button", { name: "Tutup paksa shift" })
        .last()
        .click();
      await expect(page.getByText("Shift ditutup paksa").first()).toBeVisible();
      await shot(page, "paksa-selesai");
    });
  });
}
