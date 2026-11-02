import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";

// Design-v3 sweep of the staff second-factor screen (bead legend-uxh6;
// DESIGN.md v3, PRD §3 F6 "Staf — Login Web", AUTH-05). The behaviour belongs
// to legend-9bh and stays untouched: this spec pins the v3 visual contract
// (Card + rounded-container surfaces, one filled accent CTA) and captures the
// evidence screenshots at 390/1440, light/dark plus the empty and error states.
//
// Mock data (features/ws01-auth/mock.ts): the demo owner owes a second factor
// and holds two devices, so /verifikasi renders the code challenge; ?mock=empty
// removes every factor (enrollment state), ?mock=error fails the auth read.

const VIEWPORTS = [390, 1440] as const;
const THEMES = ["light", "dark"] as const;

async function setTheme(page: Page, theme: (typeof THEMES)[number]) {
  await page.addInitScript(
    (value) => localStorage.setItem("legend-theme", value),
    theme,
  );
}

test("AUTH-05 (legend-uxh6): the verify card is a v3 Card with one filled CTA", async ({
  page,
}) => {
  await page.goto("/verifikasi");

  const card = page.locator('[data-slot="card"]').first();
  await expect(card).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 1, name: "Verifikasi dua langkah" }),
  ).toHaveClass(/type-title/);
  await expect(page.getByText(/Masuk sebagai/)).toBeVisible();
  await expect(page.getByText("Faktor kedua", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Tidak bisa memakai aplikasi autentikator?"),
  ).toBeVisible();

  // Q21 accent budget: the single Verifikasi submit is the only filled accent.
  await expect(page.locator('[data-variant="default"]')).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Verifikasi" }),
  ).toHaveAttribute("data-variant", "default");
});

for (const width of VIEWPORTS) {
  for (const theme of THEMES) {
    test(`AUTH-05 (legend-uxh6) visual ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await setTheme(page, theme);
      await page.goto("/verifikasi", { waitUntil: "networkidle" });
      await expect(
        page.getByRole("heading", { level: 1, name: "Verifikasi dua langkah" }),
      ).toBeVisible();
      await captureScreenshot(page, `legend-uxh6/verify-${width}-${theme}.png`);
    });
  }
}

for (const width of VIEWPORTS) {
  test(`AUTH-05 (legend-uxh6) visual ${width} enrollment`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setTheme(page, "light");
    await page.goto("/verifikasi?mock=empty", { waitUntil: "networkidle" });
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "Daftarkan faktor kedua dulu",
      }),
    ).toBeVisible();
    await captureScreenshot(
      page,
      `legend-uxh6/verify-enroll-${width}-light.png`,
    );
  });
}

test("AUTH-05 (legend-uxh6) visual 390 error", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await setTheme(page, "light");
  await page.goto("/verifikasi?mock=error", { waitUntil: "networkidle" });
  await expect(
    page.getByText("Status verifikasi tidak dapat dimuat"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();
  await captureScreenshot(page, "legend-uxh6/verify-error-390-light.png");
});
