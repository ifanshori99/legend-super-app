// Reservation desk x outlet switch (bead legend-wpgfu) against mock mode with
// `?outlets=many`: a stale reservationId from another outlet must be cleared
// with a not-found notice, and a deep link with a valid
// reservationId must still open the dialog on first load.
//
// Assumptions: the picker defaults to the first outlet ("Cafe Legend Bandung");
// the second is "Cafe Legend Bandung 2 (contoh)" and has its own desk with
// Maya Anindita (5501) and Bagas Saputra (5502), both on 7 Nov 2026.
import { expect, test } from "@playwright/test";

const DESK = "/pos/reservasi?outlets=many";

// Fixtures are dated around 1 Nov 2026 and the desk filters "upcoming" by the
// browser's today, so the clock is pinned to the fixture day (pattern:
// legend-oye8).
const FIXTURE_NOW = new Date("2026-11-01T12:10:00.000+07:00");

// Outlet 1: Rangga Pratama's confirmed private-room dinner (same id legend-oye8
// deep-links to).
const OUTLET_1_RESERVATION_ID = "00000000-0000-4000-8000-000000005002";

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXTURE_NOW);
});

test("legend-wpgfu a stale outlet-1 reservationId reached after switching outlet is cleared with a not-found notice", async ({
  page,
}) => {
  // The picker is inert while the detail dialog is open, so the stale id can
  // only come back through history: open, close, switch outlet, go back.
  await page.goto(DESK);
  await expect(page.getByText("Dewi Lestari")).toBeVisible();

  await page
    .getByRole("button", { name: "Buka reservasi Dewi Lestari" })
    .click();
  await expect(page).toHaveURL(/reservationId=/);
  await expect(
    page.getByRole("dialog").getByRole("heading", { name: "Dewi Lestari" }),
  ).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).not.toHaveURL(/reservationId=/);

  await page.getByRole("combobox", { name: "Pilih outlet" }).click();
  await page
    .getByRole("option", {
      name: "Cafe Legend Bandung 2 (contoh)",
      exact: true,
    })
    .click();
  await expect(page.getByText("Maya Anindita")).toBeVisible();
  await expect(page.getByText("Dewi Lestari")).toHaveCount(0);

  // The old outlet-1 id returns in the URL while outlet 2 is active.
  await page.goBack();

  await expect(
    page.getByText("Reservasi tidak ditemukan.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).not.toHaveURL(/reservationId=/);

  // The second outlet's own desk is still what the user sees.
  await expect(page.getByText("Maya Anindita")).toBeVisible();
  await expect(page.getByText("Bagas Saputra")).toBeVisible();

  // The stale id was replaced, not pushed: Back goes on past it instead of
  // returning to it and raising the notice again.
  await page.goBack();
  await page.waitForTimeout(500);
  await expect(page).not.toHaveURL(/reservationId=/);
  await expect(
    page.getByText("Reservasi tidak ditemukan.", { exact: true }),
  ).toHaveCount(1);
});

test("legend-wpgfu a deep link with a valid reservationId still opens the dialog on first load", async ({
  page,
}) => {
  await page.goto(`${DESK}&reservationId=${OUTLET_1_RESERVATION_ID}`);

  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Rangga Pratama" }),
  ).toBeVisible();
  await expect(page).toHaveURL(
    /reservationId=00000000-0000-4000-8000-000000005002/,
  );
});
