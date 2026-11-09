import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./screenshot-width.ts";

// Read-only support session (bead legend-cg071; TEN-04) against the FE mock
// runtime. The cookie `legend-mock-support=read_only` simulates a Super Admin
// impersonating a tenant user under a read_only grant: the notice shows and
// submit buttons are disabled. Screen: /kelola/pengaturan/open-bill (a form
// with a plain submit button).
// Mock port for this bead: LEGEND_MOCK_PORT=3391 pnpm test:e2e:mock.
const MOCK_URL = process.env.LEGEND_MOCK_WEB_URL;

test.skip(
  !MOCK_URL,
  "Needs a VITE_API_MOCK=true server (pnpm test:e2e:mock); see the header of this file.",
);

const PATH = "/kelola/pengaturan/open-bill";
const NAV = { waitUntil: "networkidle" as const };
const NOTICE = "Sesi dukungan · Hanya baca. Perubahan dinonaktifkan.";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});

async function setSupportCookie(page: import("@playwright/test").Page) {
  await page
    .context()
    .addCookies([
      { name: "legend-mock-support", value: "read_only", url: MOCK_URL! },
    ]);
}

test("TEN-04 · a normal session has no notice and can submit", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}${PATH}`, NAV);
  const save = page.getByRole("button", { name: "Simpan kebijakan" });
  await expect(save).toBeVisible();
  await expect(save).toBeEnabled();
  await expect(page.getByText(NOTICE)).toHaveCount(0);
});

test("TEN-04 · a read-only support session shows the notice and disables submit", async ({
  page,
}) => {
  await setSupportCookie(page);
  await page.goto(`${MOCK_URL}${PATH}`, NAV);
  await expect(page.getByText(NOTICE)).toBeVisible();
  await expect(page.getByRole("button", { name: "Akhiri sesi" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Simpan kebijakan" }),
  ).toBeDisabled();
});

for (const [width, height] of [
  [390, 844],
  [1440, 900],
] as const) {
  test(`TEN-04 · visual read-only support session ${width} light`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.addInitScript(
      (value) => localStorage.setItem("legend-theme", value),
      "light",
    );
    await setSupportCookie(page);
    await page.goto(`${MOCK_URL}${PATH}`, NAV);
    await expect(page.getByText(NOTICE)).toBeVisible();
    await captureScreenshot(
      page,
      `legend-cg071/kelola-readonly-${width}-light.png`,
    );
  });
}
