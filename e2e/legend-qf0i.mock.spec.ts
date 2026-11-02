import { expect, test, type Page } from "@playwright/test";

// Q23 (owner) end-to-end, bead legend-qf0i: a legacy menu item — active,
// sellable, created before the photo rule — must stay visible in the back
// office (with the "Foto wajib" badge, refused when it is republished) while
// every guest read hides it.
//
// Every demo item has a photo now (legend-4pki/legend-qury), so the state has
// its own mock scenario: `?mock=photo-missing` adds one legacy row
// (`legacyPhotoMissingItem` in the shared menu fixtures). The scenario is kept
// in localStorage, so the guest navigation after the back office still sees it.
//
// Run: LEGEND_MOCK_PORT=3240 pnpm test:e2e:mock e2e/legend-qf0i.mock.spec.ts

const NAV = { waitUntil: "networkidle" as const };
const LEGACY = "Es Kopi Legacy";
// A03 — the sample table the QR mock resolves (same token as legend-h16t).
const TABLE_TOKEN = `v1.${"A".repeat(40)}.${"B".repeat(43)}`;
const PHOTO_REQUIRED = "Unggah foto item sebelum menampilkannya di menu.";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      sessionStorage.clear();
      localStorage.setItem("legend-theme", "light");
    } catch {
      // storage blocked: the test still runs
    }
  });
});

async function openAvailability(page: Page, action: string) {
  const row = page.getByRole("row").filter({ hasText: LEGACY }).first();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: action }).click();
  await page.getByRole("dialog").getByRole("button", { name: action }).click();
  return row;
}

test("Q23 legend-qf0i: the back office badges a legacy photo-less item and refuses to republish it", async ({
  page,
}) => {
  await page.goto("/kelola/menu?mock=photo-missing", NAV);
  const row = page.getByRole("row").filter({ hasText: LEGACY }).first();
  await expect(row).toBeVisible();
  // The item is active and sellable, but it has no photo: the badge says so.
  await expect(row.getByText("Foto wajib")).toBeVisible();

  // Republishing runs through the 86 window: sell out (allowed) then restore
  // (refused) — a restore publishes the item again, so it needs its photo.
  await page.goto("/kelola/menu/ketersediaan?mock=photo-missing", NAV);
  const availabilityRow = await openAvailability(page, "Tandai habis");
  await expect(availabilityRow.getByText("Habis (86)")).toBeVisible();
  await openAvailability(page, "Aktifkan lagi");
  await expect(page.getByText(PHOTO_REQUIRED).first()).toBeVisible();
  // The refusal changed nothing: dismiss the dialog, the row stays sold out.
  await page.getByRole("dialog").getByRole("button", { name: "Batal" }).click();
  await expect(availabilityRow.getByText("Habis (86)")).toBeVisible();
});

test("Q23 legend-qf0i: the guest QR menu hides the legacy row", async ({
  page,
}) => {
  // Prime the scenario, then walk to the table as a guest.
  await page.goto("/kelola/menu?mock=photo-missing", NAV);
  await page.goto(`/t/${TABLE_TOKEN}`, NAV);
  await page.getByRole("button", { name: "Mulai pesan" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  // The photo-first menu still lists the photographed items…
  await expect(page.getByText("Cappuccino").first()).toBeVisible();
  // …and never the active item without a photo, even though it is sellable.
  await expect(page.getByText(LEGACY)).toHaveCount(0);
});
