// Public website sitemap + reservation accent budget (bead legend-d6g5).
// /member needs sign-in and robots.txt disallows it, so it is not submitted;
// on /reservation only "Kirim lewat WhatsApp" is a filled accent.
import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    /** Declared by the mock runtime; other specs widen it the same way. */
    __legendMock?: { setScenario: (scenario: string) => void };
    __TSR_ROUTER__?: { navigate: (options: { to: string }) => Promise<void> };
  }
}

/** A mock scenario applies to the client fetch, never to SSR (legend-qflm). */
async function navigateClient(
  page: import("@playwright/test").Page,
  to: string,
) {
  await page.waitForFunction(() => Boolean(window.__TSR_ROUTER__));
  await page.waitForTimeout(800);
  await page.evaluate(
    (path) => window.__TSR_ROUTER__?.navigate({ to: path }),
    to,
  );
}

test("legend-d6g5 /reservation keeps one filled button: Daftar member is outline", async ({
  page,
}) => {
  await page.goto("/reservation", { waitUntil: "networkidle" });
  await expect(
    page.getByRole("link", { name: "Kirim lewat WhatsApp" }),
  ).toHaveAttribute("data-variant", "default");
  await expect(
    page.getByRole("link", { name: "Daftar member" }),
  ).toHaveAttribute("data-variant", "outline");
  await expect(
    page.getByRole("link", { name: "Masuk", exact: true }),
  ).toHaveAttribute("data-variant", "outline");
});

for (const width of [390, 1440]) {
  for (const theme of ["light", "dark"]) {
    test(`legend-d6g5 visual ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (value) => localStorage.setItem("legend-theme", value),
        theme,
      );
      await page.goto("/reservation", { waitUntil: "networkidle" });
      await expect(
        page.getByRole("heading", { level: 1, name: "Reservasi meja" }),
      ).toBeVisible();
      await page.screenshot({
        path: `docs/design/screenshots/legend-d6g5/reservation-${width}-${theme}.png`,
        fullPage: true,
      });
    });
  }
}

for (const [state, scenario, text] of [
  ["empty", "empty", "Reservasi online belum dibuka"],
  ["error", "offline", "Kamu sedang offline"],
] as const) {
  test(`legend-d6g5 visual ${state}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.addInitScript(
      (value) => localStorage.setItem("legend-mock-scenario", value),
      scenario,
    );
    // Start where nothing fetches the site payload, then navigate on the client
    // so the failure lands on /reservation itself.
    await page.goto("/masuk");
    await navigateClient(page, "/reservation");
    await expect(page.getByText(text)).toBeVisible();
    await page.screenshot({
      path: `docs/design/screenshots/legend-d6g5/reservation-390-${state}.png`,
      fullPage: true,
    });
    await page.evaluate(() => window.__legendMock?.setScenario("normal"));
  });
}
