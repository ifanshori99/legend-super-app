import { expect, test, type Page } from "@playwright/test";
import { waitForHydration } from "./hydration.ts";

// Settings hub links the tenant settings pages (bead legend-j0kd; mockup
// design/mockups/backoffice/settings-hub-j0kd.html). Each card is gated by the
// permission its page guard checks: Integrasi (org.integration.manage), Tema
// (org.theme.manage), Kamus istilah (Super Admin only), Konfigurasi
// (org.config.export).
//
// Run: LEGEND_MOCK_WEB_URL=<mock server> pnpm test:e2e:mock e2e/legend-j0kd.mock.spec.ts
//
// Assumptions: no role template holds only theme+config, so the mockup's
// "limited" state is exercised with tenant_admin (integration, theme and
// config, but not Super Admin, so no "Kamus istilah"). The empty state uses
// finance, a role with no tenant settings permission that can still open the
// back office; it still sees the permission-free cards, so the real hub has no
// reachable empty state.
const base = process.env.LEGEND_MOCK_WEB_URL ?? "";
test.skip(base === "", "Set LEGEND_MOCK_WEB_URL (pnpm test:e2e:mock).");

const ROLE_COOKIE = "legend-mock-role";
const HUB = "/kelola/pengaturan";

async function openAs(page: Page, role: string) {
  await page
    .context()
    .addCookies([{ name: ROLE_COOKIE, value: role, url: base }]);
  await page.goto(`${base}${HUB}`);
  await waitForHydration(page);
}

const card = (page: Page, name: string) =>
  page.locator("#main-content").getByRole("link", { name: new RegExp(name) });

test.describe("legend-j0kd settings hub", () => {
  test("a role without every permission sees only the cards it can open", async ({
    page,
  }) => {
    test.slow();
    await openAs(page, "tenant_admin");

    await expect(card(page, "Integrasi")).toHaveAttribute(
      "href",
      "/kelola/pengaturan/integrasi",
    );
    await expect(card(page, "Tema")).toHaveAttribute(
      "href",
      "/kelola/pengaturan/tema",
    );
    await expect(card(page, "Konfigurasi")).toHaveAttribute(
      "href",
      "/kelola/pengaturan/konfigurasi",
    );
    await expect(
      page.getByText("Atur warna, logo, dan font untuk tampilan tenant."),
    ).toBeVisible();
    // Kamus istilah is Super Admin only.
    await expect(card(page, "Kamus istilah")).toHaveCount(0);

    await card(page, "Tema").click();
    await expect(page).toHaveURL(/\/kelola\/pengaturan\/tema/);
  });

  test("a role with every permission also gets Kamus istilah", async ({
    page,
  }) => {
    test.slow();
    await openAs(page, "all");
    for (const [name, slug] of [
      ["Integrasi", "integrasi"],
      ["Tema", "tema"],
      ["Kamus istilah", "istilah"],
      ["Konfigurasi", "konfigurasi"],
    ] as const) {
      await expect(card(page, name)).toHaveAttribute(
        "href",
        `/kelola/pengaturan/${slug}`,
      );
    }
  });

  test("a role with no tenant settings permission gets none of the config cards", async ({
    page,
  }) => {
    test.slow();
    await openAs(page, "finance");
    // Keamanan akun and Notifikasi need no permission, so the hub is never
    // empty for anyone who can open the back office; the mockup's empty state
    // ("Belum ada pengaturan yang tersedia") only shows when no card at all
    // remains, which these two always prevent.
    await expect(card(page, "Keamanan akun")).toBeVisible();
    for (const name of [
      "Integrasi",
      "Tema",
      "Kamus istilah",
      "Konfigurasi",
    ] as const)
      await expect(card(page, name)).toHaveCount(0);
    await expect(
      page.getByText("Belum ada pengaturan yang tersedia"),
    ).toHaveCount(0);
  });

  test("the hub fits a 390px phone", async ({ page }) => {
    test.slow();
    await page.setViewportSize({ width: 390, height: 844 });
    await openAs(page, "tenant_admin");
    await expect(card(page, "Konfigurasi")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
});
