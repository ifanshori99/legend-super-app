// Design v3 sweep evidence for the customer surfaces (bead legend-6liv,
// DESIGN.md v3 §3–§5): member PWA, Wi-Fi portal, facility journey, karyawan PWA
// and the customer sign-in screens.
//
// Runs against the mock-mode web server (no API, no database):
//   LEGEND_MOCK_PORT=3251 pnpm test:e2e:mock e2e/legend-6liv.mock.spec.ts
// Tracked evidence (docs/design/screenshots/legend-6liv/):
//   LEGEND_CAPTURE_SCREENSHOTS=1 pnpm test:e2e:mock e2e/legend-6liv.mock.spec.ts
import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";

const baseURL =
  process.env.LEGEND_MOCK_WEB_URL ?? process.env.E2E_MOCK_BASE_URL;

test.skip(
  !baseURL,
  "Mock runner not started: use pnpm test:e2e:mock (playwright.mock.config.ts).",
);
test.use({ baseURL });

/** Facility fixture ids from @starter/shared/facility (stable by construction). */
const SHOWER = "00000000-0000-4000-8000-000000009001";
/** Open facility type: the shower booking page is deferred (1269 F0). */
const WFC = "00000000-0000-4000-8000-000000009002";
const TICKET = "01JBQ7Z8K3M4N5P6Q7R8S9T0VX";
const WIFI_ZONE = "00000000-0000-4000-8000-000000009401";

type Shot = {
  name: string;
  path: string;
  /** Karyawan area: the mock grants the employee role by cookie. */
  employee?: boolean;
};

const PAGES: Shot[] = [
  { name: "member", path: "/member" },
  { name: "member-poin", path: "/member/poin" },
  { name: "member-daftar", path: "/member/daftar" },
  { name: "member-fasilitas", path: "/member/fasilitas" },
  {
    name: "member-langganan",
    path: `/member/fasilitas/langganan?facility=${SHOWER}`,
  },
  { name: "member-tiket", path: `/member/fasilitas/${TICKET}` },
  { name: "wifi", path: "/wifi" },
  { name: "wifi-zone", path: `/wifi?zone=${WIFI_ZONE}` },
  { name: "facility-booking", path: `/f/${WFC}` },
  { name: "karyawan", path: "/karyawan", employee: true },
  { name: "karyawan-absensi", path: "/karyawan/absensi", employee: true },
  { name: "masuk", path: "/masuk" },
  { name: "masuk-email", path: "/masuk/email" },
];

const SIZES = [
  { width: 390, height: 900 },
  { width: 1440, height: 900 },
] as const;

async function open(
  page: Page,
  shot: Shot,
  theme: "light" | "dark",
  size: { width: number; height: number },
) {
  await page.setViewportSize(size);
  await page.addInitScript(
    (value) => localStorage.setItem("legend-theme", value),
    theme,
  );
  if (shot.employee && baseURL) {
    await page
      .context()
      .addCookies([
        { name: "legend-mock-role", value: "employee", url: baseURL },
      ]);
  }
  await page.goto(shot.path, { waitUntil: "networkidle" });
  await page.waitForSelector("h1", { timeout: 60_000 });
  await page.waitForTimeout(400);
}

test.describe("legend-6liv · customer v3 sweep", () => {
  for (const theme of ["light", "dark"] as const) {
    for (const size of SIZES) {
      test(`TIV every swept screen keeps one h1 and no sideways scroll (${size.width} ${theme})`, async ({
        page,
      }) => {
        test.setTimeout(240_000);
        for (const shot of PAGES) {
          await open(page, shot, theme, size);
          await expect(
            page.getByRole("heading", { level: 1 }),
            `${shot.name} has exactly one h1`,
          ).toHaveCount(1);
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - window.innerWidth,
          );
          expect(
            overflow,
            `${shot.name} does not scroll sideways`,
          ).toBeLessThanOrEqual(1);
          await captureScreenshot(
            page,
            `legend-6liv/after-${shot.name}-${size.width}-${theme}.png`,
            { fullPage: false },
          );
        }
      });
    }
  }

  test("TIV empty and error states stay legible", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.addInitScript(() =>
      localStorage.setItem("legend-theme", "light"),
    );

    // The link prompt's "sign in first" state.
    await page.goto("/masuk/hubungkan?mock=empty", {
      waitUntil: "networkidle",
    });
    await expect(page.getByText("Masuk dulu")).toBeVisible();
    await captureScreenshot(
      page,
      "legend-6liv/after-empty-state-390-light.png",
      {
        fullPage: false,
      },
    );

    // A sign-in start that the API refuses explains the fix next to the CTA.
    await page.goto("/masuk?mock=error", { waitUntil: "networkidle" });
    await page
      .getByRole("button", { name: "Masuk dengan WhatsApp" })
      .click({ timeout: 30_000 });
    await expect(page.getByRole("alert").first()).toContainText(
      "Masuk belum bisa diproses. Coba lagi sebentar lagi.",
    );
    await captureScreenshot(
      page,
      "legend-6liv/after-error-state-390-light.png",
      {
        fullPage: false,
      },
    );
  });
});
