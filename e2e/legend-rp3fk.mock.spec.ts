// legend-rp3fk: the email switch of the security category is locked on
// (PRD §3 notifications; legend-307w3 contract `isEmailMandatory`; mockup
// design/mockups/platform/notification-preferences-rp3fk.html).
// Locked means: on, disabled, and explained by an icon + the word "Wajib" plus
// the hint, never by colour alone; saving never sends email=false for it (the
// mock answers 422 if it does, so a successful save is the proof).
//
// ASSUMPTION: the preferences live on the "Preferensi" tab of
// /kelola/notifikasi; the switch has id `notification-<category>-<channel>`.
// Run: pnpm test:e2e:mock e2e/legend-rp3fk.mock.spec.ts
import { expect, test, type Page } from "@playwright/test";
import { failNextCall } from "./mock-fail-next.ts";

const COLD_START_TIMEOUT_MS = 30_000;
const securityEmail = (page: Page) =>
  page.locator("#notification-security-email");

async function openPreferences(page: Page, query = "") {
  await page.goto(`/kelola/notifikasi${query}`);
  const tab = page.getByRole("tab", { name: "Preferensi" });
  await expect(tab).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  // A click before hydration is lost: retry until the tab is selected.
  await expect(async () => {
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true", {
      timeout: 1_500,
    });
  }).toPass({ timeout: COLD_START_TIMEOUT_MS });
}

test("security email is on, disabled and explained in words", async ({
  page,
}) => {
  await openPreferences(page);
  const sw = securityEmail(page);
  await expect(sw).toBeVisible();
  await expect(sw).toBeChecked();
  await expect(sw).toBeDisabled();
  const locked = page.getByTestId("notification-security-email-locked");
  await expect(locked).toBeVisible();
  await expect(locked).toContainText("Wajib");
  await expect(
    page.locator("#notification-security-email-locked-hint"),
  ).toBeVisible();
  // The hint is what assistive tech reads for the locked switch.
  await expect(sw).toHaveAccessibleDescription(
    "Email wajib aktif untuk pemberitahuan keamanan.",
  );
});

test("the locked switch cannot be turned off by click or keyboard", async ({
  page,
}) => {
  await openPreferences(page);
  const sw = securityEmail(page);
  await sw.click({ force: true });
  await expect(sw).toBeChecked();
  await sw.dispatchEvent("keydown", { key: " " });
  await sw.dispatchEvent("keyup", { key: " " });
  await expect(sw).toBeChecked();
  // The page-level save stays idle: nothing was changed.
  await expect(
    page.getByRole("button", { name: "Simpan preferensi" }),
  ).toBeVisible();
});

test("other categories keep a free email switch and a save succeeds with security email on", async ({
  page,
}) => {
  await openPreferences(page);
  const emergency = page.locator("#notification-emergency-email");
  await expect(emergency).toBeEnabled();
  await emergency.click();
  await page.getByRole("button", { name: "Simpan preferensi" }).click();
  await expect(
    page.getByText("Preferensi notifikasi tersimpan."),
  ).toBeVisible();
  await expect(securityEmail(page)).toBeChecked();
  await expect(securityEmail(page)).toBeDisabled();
});

test("loading shows a busy placeholder", async ({ page }) => {
  await openPreferences(page, "?mock=slow");
  await expect(page.locator('[aria-busy="true"]').first()).toBeVisible();
});

test("an untouched account shows the empty state, then the form with the lock", async ({
  page,
}) => {
  await openPreferences(page, "?mock=empty");
  await expect(page.getByText("Belum ada preferensi tersimpan")).toBeVisible();
  await page.getByRole("button", { name: "Atur preferensi" }).click();
  await expect(securityEmail(page)).toBeChecked();
  await expect(securityEmail(page)).toBeDisabled();
});

test("a failed load offers 'Coba lagi' that recovers", async ({ page }) => {
  await openPreferences(page, "?mock=error");
  await expect(page.getByText("Preferensi tidak dapat dimuat")).toBeVisible();
  await page.evaluate(() =>
    (
      window as unknown as {
        __legendMock: { setScenario: (s: string) => void };
      }
    ).__legendMock.setScenario("normal"),
  );
  await page.getByRole("button", { name: "Coba lagi" }).click();
  await expect(securityEmail(page)).toBeVisible();
});

test("quiet hours with the same start and end are refused", async ({
  page,
}) => {
  await openPreferences(page);
  const quiet = page.getByRole("switch", { name: "Aktifkan jam tenang" });
  if (!(await quiet.isChecked())) await quiet.click();
  await page.getByLabel("Mulai").fill("21:00");
  await page.getByLabel("Selesai").fill("21:00");
  await page.getByRole("button", { name: "Simpan preferensi" }).click();
  await expect(
    page.getByText("Jam mulai dan selesai tidak boleh sama."),
  ).toBeVisible();
});

test("a failed save says so and keeps the form", async ({ page }) => {
  await openPreferences(page);
  await page.locator("#notification-emergency-email").click();
  await failNextCall(page, "PUT /api/notifications/preferences", {
    status: 500,
    code: "INTERNAL_ERROR",
  });
  await page.getByRole("button", { name: "Simpan preferensi" }).click();
  await expect(page.getByText("Preferensi belum tersimpan.")).toBeVisible();
  await expect(securityEmail(page)).toBeChecked();
  // Retry succeeds.
  await page.getByRole("button", { name: "Simpan preferensi" }).click();
  await expect(
    page.getByText("Preferensi notifikasi tersimpan."),
  ).toBeVisible();
});

test("on a phone the lock stays readable without sideways scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPreferences(page);
  await expect(
    page.getByTestId("notification-security-email-locked"),
  ).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
