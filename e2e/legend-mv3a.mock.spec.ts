// Reservation desk with the new DP object (bead legend-mv3a; PRD v1.7 §3.22
// "Reservasi & Event", acceptance RSV-02). The guest gets a hosted DP link
// (`reservationDepositLinkSchema`), so the intent appears only after payment:
// a pending booking has a DP status but no intent, and a later WS-05 refund
// keeps the settled DP valid. Runs against mock mode (`pnpm test:e2e:mock`).
import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";

const baseURL =
  process.env.LEGEND_MOCK_WEB_URL ?? process.env.E2E_MOCK_BASE_URL;

test.skip(
  !baseURL,
  "Mock runner not started: use pnpm test:e2e:mock (playwright.mock.config.ts).",
);
test.use({ baseURL });

const DESK = "/pos/reservasi";
/** Mock-only rows seeded by features/ws08-reservation/mock.ts on 5 Nov 2026. */
const DAY = "2026-11-05";
const REFUNDED_DP_ROW = "00000000-0000-4000-8000-000000005007";
const AWAITING_DP_ROW = "00000000-0000-4000-8000-000000005008";

test("RSV-02 a refunded DP is labelled and the guest can still be seated", async ({
  page,
}) => {
  await page.goto(`${DESK}?date=${DAY}`, { waitUntil: "networkidle" });
  await expect(
    page.getByRole("heading", { level: 1, name: "Reservasi" }),
  ).toBeVisible();

  // A confirmed booking whose DP was refunded afterwards keeps its settled DP.
  const refunded = page.locator(`[data-reservation-id="${REFUNDED_DP_ROW}"]`);
  await expect(refunded).toContainText("Laras Ayu Pramesti");
  await expect(refunded).toContainText("Terkonfirmasi");
  await expect(refunded).toContainText("DP dikembalikan");

  // The pending row has no payment intent yet: the desk must not imply one.
  const awaiting = page.locator(`[data-reservation-id="${AWAITING_DP_ROW}"]`);
  await expect(awaiting).toContainText("Nadia Puspita");
  await expect(awaiting).toContainText("Menunggu pembayaran DP");

  await page
    .getByRole("button", { name: "Buka reservasi Laras Ayu Pramesti" })
    .click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("DP dikembalikan")).toBeVisible();
  // The contract rule: a settled DP keeps the seat action, a refund included.
  await dialog.getByRole("button", { name: "Dudukkan tamu" }).click();

  await expect(
    page.getByText("Tamu didudukkan dan sesi meja dibuka.", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText("Duduk", { exact: true })).toBeVisible();
  await expect(
    page.locator(`[data-reservation-id="${REFUNDED_DP_ROW}"]`),
  ).toHaveAttribute("data-status", "seated");
});

for (const [width, theme] of [
  [390, "light"],
  [390, "dark"],
  [1440, "light"],
] as const) {
  test(`RSV-02 reservation desk DP states ${width} ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(
      (value) => localStorage.setItem("legend-theme", value),
      theme,
    );
    await page.goto(`${DESK}?date=${DAY}`, { waitUntil: "networkidle" });
    await expect(
      page.locator(`[data-reservation-id="${REFUNDED_DP_ROW}"]`),
    ).toContainText("DP dikembalikan");
    await expect(
      page.locator(`[data-reservation-id="${AWAITING_DP_ROW}"]`),
    ).toContainText("Menunggu pembayaran DP");
    await captureScreenshot(
      page,
      `legend-mv3a/reservasi-${width}-${theme}.png`,
    );
  });
}
