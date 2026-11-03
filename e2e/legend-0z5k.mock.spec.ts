// WS-10 rotating attendance QR display (F27) and supervisor selfie sampling
// review (F25), bead legend-0z5k. Mock-mode spec: `pnpm test:e2e:mock
// e2e/legend-0z5k.mock.spec.ts` starts a web dev server with VITE_API_MOCK=true
// (no API, no database); the token comes from features/ws10-attendance-qr/mock.ts
// and the review logs from the shared HRIS mock directory.
//
// The review screen names "today" in the outlet time zone, so its test freezes
// the browser clock on the fixture day (2026-10-26, WIB) — otherwise the
// fixtures are a past day and the list is honestly empty. The QR test installs
// a fake clock, advances it across the 30-second window, and asserts the token
// changed. Screenshots go through e2e/screenshots.ts (tracked evidence only
// with LEGEND_CAPTURE_SCREENSHOTS=1).
import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";

const base = process.env.LEGEND_MOCK_WEB_URL;
test.skip(
  !base,
  "Set LEGEND_MOCK_WEB_URL (pnpm test:e2e:mock) to a web server running VITE_API_MOCK.",
);

const COLD_START_TIMEOUT_MS = 30_000;
/** 17:00 WIB: every fixture log of the day is already in the past. */
const REVIEW_CLOCK = new Date("2026-10-26T10:00:00.000Z");
/** 09:59:40 WIB: 20 seconds before the current 30-second QR slot ends. */
const QR_CLOCK = new Date("2026-10-26T09:59:40.000Z");
const TOKEN_PATTERN = /^QR-BDG01-OUTLET-/;

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.addInitScript(
    (value) => localStorage.setItem("legend-theme", value),
    theme,
  );
}

/** The first token of the display. Fake timers freeze even setTimeout(0). */
async function waitForFirstQrToken(page: Page) {
  const token = page.getByText(TOKEN_PATTERN);
  await expect(async () => {
    await page.clock.runFor(1_000);
    await expect(token).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: COLD_START_TIMEOUT_MS });
  return token;
}

test("F27 (legend-0z5k): the outlet QR rotates after its 30 second window", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await setTheme(page, "light");
  await page.clock.install({ time: QR_CLOCK });
  await page.goto(`${base}/kelola/absensi/qr`);

  // The ManagementShell topbar owns the page title (DESIGN.md v3).
  await expect(
    page.getByRole("heading", { level: 1, name: "QR Absensi" }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  const token = await waitForFirstQrToken(page);

  await expect(
    page.getByRole("img", { name: "QR absensi Cafe Legend Bandung" }),
  ).toBeVisible();
  await expect(
    page.getByRole("progressbar", { name: "Sisa waktu kode QR" }),
  ).toBeVisible();
  await expect(page.getByText("Terbit", { exact: true })).toBeVisible();
  await expect(page.getByText("Berlaku sampai", { exact: true })).toBeVisible();
  await expect(page.getByText("QR aktif")).toBeVisible();

  // F27: the code is only valid for the 30-second slot it was minted in. The
  // expired code is never left on screen, so wait for the NEXT visible token.
  const firstToken = await token.innerText();
  await page.clock.runFor(31_000);
  await expect(async () => {
    await page.clock.runFor(1_000);
    await expect(token).toBeVisible({ timeout: 1_000 });
    expect(await token.innerText()).not.toBe(firstToken);
  }).toPass({ timeout: 10_000 });
  await expect(page.getByText("QR aktif")).toBeVisible();

  await captureScreenshot(page, "legend-0z5k/qr-390-light.png");
});

test("F27 (legend-0z5k) visual 390 dark", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await setTheme(page, "dark");
  await page.goto(`${base}/kelola/absensi/qr`);
  await expect(page.getByText(TOKEN_PATTERN)).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
  await expect(page.getByText("QR aktif")).toBeVisible();
  await captureScreenshot(page, "legend-0z5k/qr-390-dark.png");
});

test("F27 (legend-0z5k) visual 1440 light", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await setTheme(page, "light");
  await page.goto(`${base}/kelola/absensi/qr`);
  await expect(page.getByText(TOKEN_PATTERN)).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
  await expect(page.getByText("QR aktif")).toBeVisible();
  await captureScreenshot(page, "legend-0z5k/qr-1440-light.png");
});

test("F25 (legend-0z5k): a supervisor reviews a flagged selfie sample and the decision persists in the session", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await setTheme(page, "light");
  // The dialog screenshot must not catch the enter animation mid-fade.
  await page.emulateMedia({ reducedMotion: "reduce" });
  // Fixture selfies point at a reserved `.example` host: answer 404 so the
  // signed-link fallback renders deterministically, without a DNS lookup.
  await page.route("https://files.cafelegend.example/**", (route) =>
    route.fulfill({ status: 404, body: "" }),
  );
  await page.clock.setFixedTime(REVIEW_CLOCK);
  await page.goto(`${base}/kelola/absensi/selfie`);

  await expect(
    page.getByRole("heading", { level: 1, name: "Review Selfie" }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await expect(
    page.getByRole("heading", { level: 2, name: "Log absensi" }),
  ).toBeVisible();
  // Fixture day: employee 1006's clock-in is flagged (420 m outside the fence).
  const row = page
    .getByRole("row")
    .filter({ hasText: "Putri Ramadhani" })
    .filter({ hasText: "Selfie & GPS" });
  await expect(row).toBeVisible();
  await expect(row.getByText("Ditandai", { exact: true })).toBeVisible();

  await captureScreenshot(page, "legend-0z5k/selfie-review-390-light.png");

  await row.getByRole("button", { name: "Tinjau" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Review selfie Putri Ramadhani" }),
  ).toBeVisible();
  await expect(dialog.getByText("Selfie & GPS")).toBeVisible();
  await expect(dialog.getByText("420 m")).toBeVisible();
  // An expired/unreachable signed link degrades to the private-storage note.
  await expect(
    dialog.getByText("Tersimpan di penyimpanan privat"),
  ).toBeVisible();
  await expect(dialog.getByRole("img")).toHaveCount(0);
  await expect(
    dialog.getByText("Ditandai", { exact: true }).first(),
  ).toBeVisible();
  await captureScreenshot(
    page,
    "legend-0z5k/selfie-review-dialog-390-light.png",
  );

  await dialog.getByRole("button", { name: "Sesuai", exact: true }).click();
  await expect(
    page.getByText("Sampel Putri Ramadhani dicatat sesuai di sesi ini."),
  ).toBeVisible();
  await expect(row.getByText("Sesuai (sesi ini)")).toBeVisible();
  // The session decision never overrides the server's validity.
  await expect(row.getByText("Ditandai", { exact: true })).toBeVisible();

  // Session persistence: reopening the sample shows the stored decision, and
  // the action is now "Tinjau ulang" (not a second, fresh decision).
  await row.getByRole("button", { name: "Tinjau ulang" }).click();
  await expect(
    page.getByRole("dialog").getByText("Sesuai (sesi ini)"),
  ).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Tutup" })
    .first()
    .click();
});

test("F25 (legend-0z5k): the review list is honest when there are no logs today", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await setTheme(page, "light");
  await page.clock.setFixedTime(REVIEW_CLOCK);
  await page.goto(`${base}/kelola/absensi/selfie?mock=empty`);

  await expect(
    page.getByRole("heading", { level: 1, name: "Review Selfie" }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await expect(page.getByText("Belum ada log absensi hari ini")).toBeVisible();
  await captureScreenshot(
    page,
    "legend-0z5k/selfie-review-empty-390-light.png",
  );
});
