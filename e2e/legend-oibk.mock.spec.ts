import { expect, test, type Page } from "@playwright/test";

// Member PWA bottom nav (bead legend-oibk): DESIGN.md v2 §5 caps the
// CustomerShell bar at five slots, so the member area's extra destinations
// (Misi, Fasilitas, Wi-Fi) live in the "Lainnya" sheet. The fixtures come from
// @starter/shared in mock mode, like the other member specs.

/**
 * The sheet trigger is client-only: SSR ships the button before hydration, and
 * a click in that window is dropped. Retry until the dialog shows up.
 */
async function openMore(page: Page) {
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __TSR_ROUTER__?: unknown }).__TSR_ROUTER__),
  );
  const more = page.getByRole("button", { name: "Lainnya" });
  await expect(async () => {
    await more.click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  return page.getByRole("dialog");
}

test("member bottom nav stays at five 390px slots (legend-oibk)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/member");
  const nav = page.getByRole("navigation", { name: "Navigasi utama" });
  await expect(nav.locator("ul > li")).toHaveCount(5);
  for (const label of ["Member", "Poin", "Hadiah", "Voucher"]) {
    await expect(
      nav.getByRole("link", { name: label, exact: true }),
    ).toBeVisible();
  }
  await expect(
    nav.getByRole("button", { name: "Lainnya", exact: true }),
  ).toBeVisible();
  // Four destinations replaced seven: no label is squeezed together.
  const slots = await nav
    .locator("ul > li")
    .evaluateAll((items) => items.map((item) => item.getBoundingClientRect()));
  for (const slot of slots) {
    expect(slot.width).toBeGreaterThan(70);
    expect(slot.right).toBeLessThanOrEqual(390);
  }
});

test("Lainnya lists the overflow destinations and closes after navigating (legend-oibk)", async ({
  page,
}) => {
  await page.goto("/member");
  const sheet = await openMore(page);
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("link")).toHaveCount(3);
  for (const label of ["Misi", "Fasilitas", "Wi-Fi"]) {
    await expect(
      sheet.getByRole("link", { name: label, exact: true }),
    ).toBeVisible();
  }

  await sheet.getByRole("link", { name: "Misi" }).click();
  await expect(page.getByRole("heading", { name: "Misi saya" })).toBeVisible();
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("Lainnya carries the active state on an overflow screen (legend-oibk)", async ({
  page,
}) => {
  await page.goto("/member/fasilitas");
  const more = page.getByRole("button", { name: "Lainnya" });
  await expect(more).toHaveAttribute("aria-current", "page");

  const sheet = await openMore(page);
  await expect(
    sheet.getByRole("link", { name: "Fasilitas", exact: true }),
  ).toHaveAttribute("aria-current", "page");
});
