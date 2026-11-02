import { expect, test, type Page } from "@playwright/test";

// QR menu on mock mode (bead legend-h16t; DESIGN.md v2 §4 "Media", owner Q22
// photo-first cards and Q23 every item has a photo). The customer menu card is
// a borderless 1:1 MediaPlate, the item sheet opens on a full-bleed hero photo,
// the suggestions shelf is a 4:5 carousel, and a cart line carries a 72px
// thumb. Sample photos only exist in mock/demo data and the screen says so
// ("Contoh data", owner Q24).
//
// Run: LEGEND_MOCK_PORT=3247 pnpm test:e2e:mock e2e/legend-h16t.mock.spec.ts

const table = `v1.${"A".repeat(40)}.${"B".repeat(43)}`; // A03, sample menu

async function joinTable(page: Page) {
  await page.goto(`/t/${table}`);
  // The guest-count dialog opens on the first visit (PRD §3 "Scan & Sesi Meja").
  await page.getByRole("button", { name: "Mulai pesan" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
}

const cards = (page: Page) =>
  page.locator('section[aria-labelledby^="cat-"] li');

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

test("Q22 the menu card leads with a square photo plate and prints the sample label", async ({
  page,
}) => {
  await joinTable(page);
  await expect(page.getByText("Contoh data")).toBeVisible();

  const first = cards(page).first();
  const plate = first.locator('[data-slot="media-plate"]');
  await expect(plate).toBeVisible();
  // 1:1, the plate is the card (DESIGN.md v2 "Menu card").
  const box = await plate.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.abs((box?.width ?? 0) - (box?.height ?? 0))).toBeLessThan(2);

  // A demo item with a sample photo renders it, not a letter tile.
  const cappuccino = cards(page).filter({ hasText: "Cappuccino" });
  await expect(cappuccino.locator("img")).toHaveAttribute(
    "src",
    /\/sample\/menu\/cappuccino\.jpg$/,
  );
  // The name is still a link into the sheet, and the add button is its own
  // control on the photo.
  await expect(
    cappuccino.getByRole("button", { name: "Lihat detail Cappuccino" }),
  ).toBeVisible();
  await expect(
    cappuccino.getByRole("button", { name: /^Pilih opsi untuk Cappuccino$/ }),
  ).toBeVisible();

  // Every demo item has a sample photo (legend-4pki); Americano shares the
  // black-coffee glass. The quiet plate stays the real-outlet state for an item
  // without an upload and is no longer reachable in the sample catalogue.
  const americano = cards(page).filter({ hasText: "Americano" });
  await expect(americano.locator("img")).toHaveAttribute(
    "src",
    /\/sample\/menu\/espresso\.jpg$/,
  );
});

test("Q22 a sold-out card greys its photo, says Habis and offers no add button", async ({
  page,
}) => {
  await joinTable(page);
  await page.getByRole("searchbox", { name: "Cari menu" }).fill("Mie Kuah");

  const card = cards(page).filter({ hasText: "Mie Kuah" });
  await expect(card).toBeVisible();
  await expect(card.getByText("Habis")).toBeVisible();
  await expect(card.getByRole("button", { name: /^Tambah / })).toHaveCount(0);
  // Greyscale is what marks the photo as unavailable (DESIGN.md v2).
  await expect(card.locator("img")).toHaveClass(/grayscale/);
});

test("Q22 the item sheet opens on a full-bleed hero photo with the close on it", async ({
  page,
}) => {
  await joinTable(page);
  await cards(page)
    .filter({ hasText: "Cappuccino" })
    .getByRole("button", { name: "Lihat detail Cappuccino" })
    .click();

  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  const hero = sheet.locator('[data-slot="media-plate"]').first();
  await expect(hero.locator("img")).toHaveAttribute(
    "src",
    /\/sample\/menu\/cappuccino\.jpg$/,
  );
  // 3:2, and flush with the sheet edge (only the 1px border of the sheet is
  // allowed between them). The sheet animates open, and a measurement taken
  // mid-transition sees a narrower hero (seen once in a sharded run: 487 vs
  // 495), so retry the measurement until the geometry settles — the contract
  // below is unchanged.
  await expect(async () => {
    const [heroBox, sheetBox] = await Promise.all([
      hero.boundingBox(),
      sheet.boundingBox(),
    ]);
    expect(sheetBox?.width ?? 0).toBeGreaterThan(0);
    expect(heroBox?.width ?? 0).toBeGreaterThanOrEqual(
      (sheetBox?.width ?? 0) - 4,
    );
    expect(heroBox?.height ?? 0).toBeCloseTo(
      (heroBox?.width ?? 0) * (2 / 3),
      0,
    );
  }).toPass({ timeout: 5_000 });
  await expect(
    sheet.getByRole("button", { name: "Tutup", exact: true }),
  ).toBeVisible();
});

test("Q22 a cart line keeps a 72px photo plate next to its name", async ({
  page,
}) => {
  await joinTable(page);
  // Cappuccino needs a temperature choice, so it goes through the sheet.
  await cards(page)
    .filter({ hasText: "Cappuccino" })
    .getByRole("button", { name: /^Pilih opsi untuk Cappuccino$/ })
    .click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("radio", { name: "Panas" }).click();
  await sheet.getByRole("radio", { name: "Normal" }).click();
  await sheet.getByRole("button", { name: "Tambah ke keranjang" }).click();
  await expect(sheet).toBeHidden();

  await page.getByRole("link", { name: /^Keranjang/ }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Keranjang meja" }),
  ).toBeVisible();
  await expect(page.getByText("Contoh data")).toBeVisible();

  const row = page.getByRole("listitem").filter({ hasText: "Cappuccino" });
  const thumb = row.locator('[data-slot="media-plate"]');
  await expect(thumb.locator("img")).toHaveAttribute(
    "src",
    /\/sample\/menu\/cappuccino\.jpg$/,
  );
  const box = await thumb.boundingBox();
  expect(box?.width ?? 0).toBeCloseTo(72, 0);
  expect(box?.height ?? 0).toBeCloseTo(72, 0);
});
