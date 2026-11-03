// Design-system evidence for two hygiene beads:
// - legend-9p37: the toast region announces the catalog label ("Notifikasi"),
//   not Radix's English default "Notifications (F8)".
// - legend-miof: the skeleton fill clears 3:1 against the page, and a toast on
//   a customer route sits above the bottom navigation.
// Run: pnpm test:e2e:mock e2e/legend-miof.mock.spec.ts — mock mode only, no API
// and no DB. Screenshots go through captureScreenshot; tracked evidence is
// only rewritten with LEGEND_CAPTURE_SCREENSHOTS=1.
import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";

const freeTable = `v1.${"C".repeat(40)}.${"D".repeat(43)}`; // A01, pay-first table
const PAYMENTS = "/kelola/pembayaran?mock=normal";
const VIEWPORT_LABEL = "Notifikasi";

async function joinTable(page: Page) {
  await page.goto(`/t/${freeTable}`);
  // The guest-count dialog opens on the first visit (PRD §3 "Scan & Sesi Meja").
  await page.getByRole("button", { name: "Mulai pesan" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
}

function channels(color: string): [number, number, number] {
  const match = color.match(/rgba?\(([^)]+)\)/);
  if (!match) throw new Error(`Not an rgb colour: ${color}`);
  const [r, g, b] = match[1]!.split(",").map((part) => Number(part.trim()));
  return [r!, g!, b!];
}

/** WCAG relative luminance (sRGB). */
function luminance(color: string): number {
  const [r, g, b] = channels(color).map((value) => {
    const srgb = value / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
}

test("9p37 the toast viewport carries the catalog region label", async ({
  page,
}) => {
  await page.goto(PAYMENTS);
  const row = page
    .getByRole("tabpanel", { name: "Routing gateway" })
    .locator("li")
    .filter({ hasText: "QRIS" })
    .first();
  await row.getByRole("switch").click();
  await row.getByRole("button", { name: "Simpan" }).click();

  // The viewport is an empty placeholder between toasts (zero height), so
  // assert its accessible name rather than its visibility: Radix's own default
  // would announce an English region name even when no toast is showing.
  const viewport = page.locator(`[aria-label="${VIEWPORT_LABEL}"]`);
  await expect(viewport).toHaveCount(1);
  await expect(page.locator('[aria-label*="Notifications"]')).toHaveCount(0);
});

test("miof the skeleton fill clears 3:1 against the page in both themes", async ({
  page,
}) => {
  for (const theme of ["light", "dark"] as const) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(
      (value) => localStorage.setItem("legend-theme", value),
      theme,
    );
    await page.goto("/kelola?mock=slow");
    const skeleton = page.locator('[data-slot="skeleton"]').first();
    await expect(skeleton).toBeVisible();

    const { fill, pageBackground, token } = await skeleton.evaluate((node) => ({
      fill: getComputedStyle(node).backgroundColor,
      pageBackground: getComputedStyle(document.body).backgroundColor,
      token: getComputedStyle(document.documentElement)
        .getPropertyValue("--skeleton")
        .trim(),
    }));
    // The fill comes from the dedicated token (hex -> rgb), not surface-3.
    const [r, g, b] = [1, 3, 5].map((i) =>
      Number.parseInt(token.slice(i, i + 2), 16),
    ) as [number, number, number];
    expect(fill).toBe(`rgb(${r}, ${g}, ${b})`);
    // WCAG 1.4.11 non-text contrast: a loading placeholder must be perceivable.
    expect(contrastRatio(fill, pageBackground)).toBeGreaterThanOrEqual(3);

    await captureScreenshot(page, `legend-miof/skeleton-390-${theme}.png`);
  }
});

test("miof a toast on a customer route sits above the bottom nav", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await joinTable(page);
  const nav = page.getByRole("navigation", { name: "Navigasi utama" });
  await expect(nav).toBeVisible();

  await page.getByRole("button", { name: "Lihat detail Espresso" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("radio", { name: /Dingin/ }).click();
  await sheet.getByRole("radio", { name: "Normal" }).click();
  await sheet.getByRole("button", { name: "Tambah ke keranjang" }).click();
  // Client-only controls drop a click that lands before hydration (see
  // e2e/legend-vxj.mock.spec.ts); retry the add until the toast shows.
  await expect(page.getByText(/masuk keranjang/).first()).toBeVisible({
    timeout: 15_000,
  });

  const toast = page.getByText(/masuk keranjang/).first();
  await expect(toast).toBeVisible();
  // The shell publishes the bar height, and the toast viewport bottom lands on
  // it, so the toast itself never covers a tab.
  const inset = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue(
      "--toast-inset-bottom",
    ),
  );
  expect(inset.trim()).toContain("calc(");

  const [toastBox, navBox] = await Promise.all([
    toast.boundingBox(),
    nav.boundingBox(),
  ]);
  expect(toastBox).not.toBeNull();
  expect(navBox).not.toBeNull();
  expect(toastBox!.y + toastBox!.height).toBeLessThanOrEqual(navBox!.y + 1);
  await captureScreenshot(page, "legend-miof/toast-above-nav-390-light.png");
});
