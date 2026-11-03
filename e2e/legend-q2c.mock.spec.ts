import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots";

// Device registry panel (bead legend-q2c; PRD v1.7 §3 F5 "Registri
// Perangkat", "Mode Latihan"; EDG-03 UI) against the FE mock runtime
// (VITE_API_MOCK=true, `pnpm test:e2e:mock`, port 3305). Every test skips
// when LEGEND_MOCK_WEB_URL is unset.
const MOCK_URL = process.env.LEGEND_MOCK_WEB_URL;

test.skip(!MOCK_URL, "Needs a VITE_API_MOCK=true server (pnpm test:e2e:mock).");

const NAV = { waitUntil: "networkidle" as const };
const PATH = "/kelola/perangkat";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});

async function open(
  page: Page,
  scenario: string,
  theme: "light" | "dark",
  size: { width: number; height: number },
) {
  await page.setViewportSize(size);
  await page.addInitScript(
    (value) => localStorage.setItem("legend-theme", value),
    theme,
  );
  await page.goto(`${MOCK_URL}${PATH}?mock=${scenario}`, NAV);
}

test("EDG-03 · registry lists devices with heartbeat status and an outlet filter", async ({
  page,
}) => {
  await open(page, "normal", "light", { width: 1440, height: 900 });
  await expect(
    page.getByRole("heading", { name: "Perangkat terdaftar" }),
  ).toBeVisible();
  const table = page.getByRole("table");
  await expect(
    table.getByRole("row").filter({ hasText: "Printer Bar" }),
  ).toBeVisible();
  // The kitchen printer stopped reporting in the mock (EDG-05).
  const kitchen = table.getByRole("row").filter({ hasText: "Printer Dapur" });
  await expect(kitchen.locator('[data-heartbeat="offline"]')).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Outlet" })).toBeVisible();
  await captureScreenshot(page, "legend-q2c/registry-1440-light.png");

  await open(page, "normal", "dark", { width: 1440, height: 900 });
  await expect(page.getByRole("table")).toBeVisible();
  await captureScreenshot(page, "legend-q2c/registry-1440-dark.png");

  await open(page, "normal", "light", { width: 390, height: 844 });
  await expect(
    page.locator("li:visible", { hasText: "Printer Bar" }),
  ).toBeVisible();
  await captureScreenshot(page, "legend-q2c/registry-390-light.png");

  await open(page, "normal", "dark", { width: 390, height: 844 });
  await expect(
    page.locator("li:visible", { hasText: "Printer Bar" }),
  ).toBeVisible();
  await captureScreenshot(page, "legend-q2c/registry-390-dark.png");
});

test("EDG-03 · detail drawer shows the device and explains training mode", async ({
  page,
}) => {
  await open(page, "normal", "light", { width: 1440, height: 900 });
  await page.getByRole("button", { name: "Printer Bar", exact: true }).click();
  const drawer = page.getByRole("dialog");
  await expect(
    drawer
      .getByText("Detail perangkat")
      .or(drawer.getByText("Informasi perangkat")),
  ).toBeVisible();
  await expect(
    drawer.getByText("Apa yang berubah di mode latihan"),
  ).toBeVisible();
  await captureScreenshot(page, "legend-q2c/drawer-1440-light.png");
});

test("EDG-03 · training mode toggles per device after confirmation", async ({
  page,
}) => {
  await open(page, "normal", "light", { width: 1440, height: 900 });
  await page.getByRole("button", { name: "Printer Bar", exact: true }).click();
  const drawer = page.getByRole("dialog");
  await drawer
    .getByRole("switch", { name: /Mode latihan untuk Printer Bar/ })
    .click();
  const confirm = page.getByRole("dialog").last();
  await confirm.getByRole("button", { name: "Aktifkan" }).click();
  await expect(page.getByText("Mode latihan disimpan.").first()).toBeVisible();
});

test("EDG-03 · revoke needs the typed name and a reason, then marks the device revoked", async ({
  page,
}) => {
  await open(page, "normal", "light", { width: 1440, height: 900 });
  await page.getByRole("button", { name: "KDS Bar", exact: true }).click();
  await page.getByRole("button", { name: "Cabut perangkat" }).click();
  const dialog = page.getByRole("dialog").last();
  const submit = dialog.getByRole("button", { name: "Cabut perangkat" });
  await expect(submit).toBeDisabled();
  await dialog.getByLabel(/Ketik nama perangkat/).fill("KDS Bar");
  await dialog.getByLabel(/Alasan pencabutan/).fill("Perangkat hilang");
  await captureScreenshot(page, "legend-q2c/revoke-1440-light.png", {
    fullPage: false,
  });
  await submit.click();
  await expect(page.getByText("Perangkat dicabut.").first()).toBeVisible();
  const row = page
    .getByRole("table")
    .getByRole("row")
    .filter({ hasText: "KDS Bar" });
  await expect(row.locator('[data-heartbeat="revoked"]')).toBeVisible();
});

test("EDG-03 · empty and error states explain the next step", async ({
  page,
}) => {
  await open(page, "empty", "light", { width: 1440, height: 900 });
  await expect(page.getByText("Belum ada perangkat terdaftar")).toBeVisible();
  await captureScreenshot(page, "legend-q2c/empty-1440-light.png");
  await open(page, "error", "light", { width: 1440, height: 900 });
  await expect(page.getByRole("alert").first()).toBeVisible();
  await captureScreenshot(page, "legend-q2c/error-1440-light.png");
});
