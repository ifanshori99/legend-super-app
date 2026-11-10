import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./screenshot-width.ts";

// Read-only support session (bead legend-cg071; TEN-04) against the FE mock
// runtime. The cookie `legend-mock-support=read_only` simulates a Super Admin
// impersonating a tenant user under a read_only grant: the session bar shows
// and submit buttons are aria-disabled (focusable, click blocked). Screen: /kelola/pengaturan/open-bill (a form
// with a plain submit button).
// Mock port for this bead: LEGEND_MOCK_PORT=3391 pnpm test:e2e:mock.
const MOCK_URL = process.env.LEGEND_MOCK_WEB_URL;

test.skip(
  !MOCK_URL,
  "Needs a VITE_API_MOCK=true server (pnpm test:e2e:mock); see the header of this file.",
);

const PATH = "/kelola/pengaturan/open-bill";
const NAV = { waitUntil: "networkidle" as const };
const BAR = '[data-slot="support-session-bar"]';

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

test("TEN-04 · a normal session is not read-only and can submit", async ({
  page,
}) => {
  await page.goto(`${MOCK_URL}${PATH}`, NAV);
  const save = page.getByRole("button", { name: "Simpan kebijakan" });
  await expect(save).toBeVisible();
  await expect(save).toBeEnabled();
  await expect(save).not.toHaveAttribute("aria-disabled", "true");
  // The mock tenant has an active org grant, so the bar may render; it must
  // not offer to end a support session, and submit must show no read-only state.
  await expect(
    page.locator(BAR).getByRole("button", { name: "Akhiri sesi" }),
  ).toHaveCount(0);
  await expect(save).not.toHaveAttribute("aria-disabled");
  await expect(save.locator(".lucide-lock")).toHaveCount(0);
});

test("TEN-04 · a read-only support session shows the bar and blocks submit", async ({
  page,
}) => {
  await setSupportCookie(page);
  await page.goto(`${MOCK_URL}${PATH}`, NAV);
  const bar = page.locator(BAR);
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute("role", "status");
  await expect(bar.getByRole("button", { name: "Akhiri sesi" })).toBeVisible();

  const save = page.getByRole("button", { name: "Simpan kebijakan" });
  await expect(save).toHaveAttribute("aria-disabled", "true");
  await expect(save).not.toHaveAttribute("disabled");
  await expect(save).toHaveAccessibleDescription(
    "Tidak bisa menyimpan di sesi dukungan (hanya baca)",
  );
  await save.focus();
  await expect(save).toBeFocused();

  let submitted = false;
  page.on("request", (request) => {
    if (request.method() !== "GET") submitted = true;
  });
  // force: Playwright treats aria-disabled as not enabled and would wait;
  // a real pointer click still reaches the button's handler.
  await save.click({ force: true });
  await expect(
    page.getByText("Sesi dukungan hanya baca: perubahan tidak disimpan.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(submitted).toBe(false);
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
    await expect(page.locator(BAR)).toBeVisible();
    await captureScreenshot(
      page,
      `legend-cg071/kelola-readonly-${width}-light.png`,
    );
  });
}
