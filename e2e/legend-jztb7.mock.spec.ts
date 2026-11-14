// Panic alert wiring in the facility staff shell (bead legend-jztb7) against the
// FE mock runtime (VITE_API_MOCK=true): no API, no database. The mock socket
// plays the scenario stored in localStorage["legend.mock.panic"].
//
// Safety feature under test: an emergency alert must not disappear when staff
// move to another facility page or reload the browser.
//
// Assumptions (the brief leaves them open):
//  - While an alert is open its dialog is modal, so the tab links are inert.
//    "Moving to another page" is therefore done as a client-side route change
//    (history.pushState + popstate, which the router listens to) instead of a
//    click, and never as a full page load.
//  - The first mock alert ("incoming" and "restore") is for unit P2.
//  - The tab is named "Darurat" and sits in the staff sub navigation.
//
// Run: pnpm test:e2e:mock e2e/legend-jztb7.mock.spec.ts — mock mode only.
import { expect, test, type Page } from "@playwright/test";

const mockWebUrl = process.env.LEGEND_MOCK_WEB_URL;
test.skip(!mockWebUrl, "Requires the mock-mode web server");
test.use({ baseURL: mockWebUrl ?? "http://localhost:3320" });

const COLD_START_TIMEOUT_MS = 30_000;
const PANIC_STORAGE_KEY = "legend.mock.panic";

function coldStart(page: Page) {
  test.setTimeout(120_000);
  page.setDefaultTimeout(COLD_START_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(60_000);
}

/** Sets the mock socket scenario before any page script runs (survives reload). */
async function useScenario(page: Page, scenario: string) {
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [PANIC_STORAGE_KEY, scenario] as const,
  );
}

test("FAC-08 an alert shows on the board and stays, as one dialog, when staff move to another page", async ({
  page,
}) => {
  coldStart(page);
  await useScenario(page, "incoming");
  await page.goto("/fasilitas?mock=normal");

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await expect(dialog).toContainText("P2");
  await expect(
    dialog.getByRole("button", { name: "Saya tangani" }),
  ).toBeVisible();

  // Client-side route change (no reload) to the cleaning page.
  await page.evaluate(() => {
    window.history.pushState({}, "", "/fasilitas/kebersihan?mock=normal");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page).toHaveURL(/\/fasilitas\/kebersihan/);
  // The page content is behind the modal dialog, so check it is attached.
  await expect(
    page.locator("h1", { hasText: "Kebersihan bilik" }),
  ).toBeAttached({ timeout: COLD_START_TIMEOUT_MS });

  // Still the same single alert dialog, not a second one and not gone.
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(page.getByRole("dialog")).toContainText("P2");
  await expect(
    page.getByRole("dialog").getByRole("button", { name: "Saya tangani" }),
  ).toBeVisible();
});

test("FAC-08 an alert a colleague already took is shown as handled by name", async ({
  page,
}) => {
  coldStart(page);
  await useScenario(page, "taken-remote");
  await page.goto("/fasilitas?mock=normal");

  const dialog = page.getByRole("dialog");
  // Alert first, then (a few seconds later) the colleague's acknowledgement.
  await expect(
    dialog.getByRole("button", { name: "Saya tangani" }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await expect(dialog.getByText(/Sudah ditangani Rina/)).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Saya tangani" }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Kembali ke pemantauan" }),
  ).toBeVisible();
});

test("FAC-08 open alerts come back after the page is reloaded", async ({
  page,
}) => {
  coldStart(page);
  await useScenario(page, "restore");
  await page.goto("/fasilitas?mock=normal");

  // The mock socket sends no frame in this scenario: the alert can only come
  // from the open-alerts list.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await expect(dialog).toContainText("P2");
  await expect(
    dialog.getByRole("button", { name: /Saya tangani/ }).first(),
  ).toBeVisible();

  await page.reload();

  const afterReload = page.getByRole("dialog");
  await expect(afterReload).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await expect(afterReload).toContainText("P2");
  await expect(
    afterReload.getByRole("button", { name: /Saya tangani/ }).first(),
  ).toBeVisible();
});

test("FAC-08 at 390 px the Darurat tab is fully visible and not cut off", async ({
  page,
}) => {
  coldStart(page);
  await page.setViewportSize({ width: 390, height: 844 });
  // "idle" keeps the alert dialog away so the tabs can be measured and used.
  await useScenario(page, "idle");
  await page.goto("/fasilitas?mock=normal");

  const tab = page.getByRole("link", { name: "Darurat", exact: true });
  await expect(tab).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await tab.scrollIntoViewIfNeeded();

  const box = await tab.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);

  // No ancestor scroll container (or overflow clip) hides part of the tab.
  const clipped = await tab.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    for (
      let parent = element.parentElement;
      parent;
      parent = parent.parentElement
    ) {
      const style = getComputedStyle(parent);
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        const bounds = parent.getBoundingClientRect();
        if (rect.left < bounds.left - 0.5 || rect.right > bounds.right + 0.5) {
          return true;
        }
      }
    }
    return false;
  });
  expect(clipped).toBe(false);
});
