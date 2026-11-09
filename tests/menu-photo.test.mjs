import assert from "node:assert/strict";
import { test } from "node:test";
import * as menu from "../packages/shared/src/menu/index.ts";
import * as qr from "../packages/shared/src/qr-order/index.ts";
import * as sample from "../packages/shared/src/qr-order/sample.ts";
import * as site from "../packages/shared/src/website/index.ts";
import * as guestMenu from "../apps/web/src/features/ws08-website/lib/guest-menu.ts";

// Contract tests for owner decision Q23 (legend-pnsa): every menu item must
// have a photo, so an item can only be active (published) with a mediaId. The
// API and the back-office form both read this rule from the contract.
//
// legend-qf0i adds the guest side of the rule: a legacy active row without a
// photo stays in the back office and never reaches a public read (QR order
// menu, public website menu).

test("Q23 legend-pnsa: MENU_PHOTO_REQUIRED is an UPPER_SNAKE code answering 422", () => {
  assert.equal("MENU_PHOTO_REQUIRED" in menu.menuErrorHttpStatus, true);
  assert.equal(menu.menuErrorHttpStatus.MENU_PHOTO_REQUIRED, 422);
  assert.deepEqual(menu.MENU_ERROR_CODES, ["MENU_PHOTO_REQUIRED"]);
  assert.equal(typeof menu.MENU_PHOTO_REQUIRED_MESSAGE, "string");
  assert.ok(menu.MENU_PHOTO_REQUIRED_MESSAGE.length > 0);
});

test("Q23 legend-pnsa: the rule is active without a photo", () => {
  assert.equal(
    menu.menuItemPhotoMissing({ isActive: true, mediaId: null }),
    true,
  );
  assert.equal(
    menu.menuItemPhotoMissing({ isActive: true, mediaId: undefined }),
    true,
  );
  assert.equal(
    menu.menuItemPhotoMissing({
      isActive: true,
      mediaId: "00000000-0000-4000-8000-000000007000",
    }),
    false,
  );
  // A draft may live without a photo; that is how the import lands its rows.
  assert.equal(
    menu.menuItemPhotoMissing({ isActive: false, mediaId: null }),
    false,
  );
});

test("Q23 legend-pnsa: a new item defaults to a draft, not to published", () => {
  const parsed = menu.createItemInputSchema.parse({
    categoryId: "00000000-0000-4000-8000-000000000100",
    name: "Kopi Susu Aren",
  });
  assert.equal(parsed.isActive, false);
  assert.equal(parsed.mediaId, undefined);
  // Publishing at creation is an explicit opt-in.
  assert.equal(
    menu.createItemInputSchema.parse({
      categoryId: "00000000-0000-4000-8000-000000000100",
      name: "Kopi Susu Aren",
      isActive: true,
    }).isActive,
    true,
  );
  // The update patch carries both fields optionally, so activation can send
  // its photo in the same request.
  assert.equal(
    menu.updateItemInputSchema.parse({ isActive: true }).isActive,
    true,
  );
  assert.equal(
    menu.updateItemInputSchema.parse({ mediaId: null, isActive: false })
      .mediaId,
    null,
  );
});

test("Q23 legend-pnsa: legacy fixture items without a photo stay readable", () => {
  // The mock catalog predates the rule; such a row may be read and edited but
  // can never be published again, which the predicate reports.
  const fixtures = menu.cafeLegendMenuFixtures;
  menu.menuFixtureSchema.parse(fixtures);
  const legacy = { ...fixtures.items[0], mediaId: null, isActive: true };
  assert.equal(
    menu.menuItemAdminSchema.parse({ ...legacy, mediaUrl: null }).mediaId,
    null,
  );
  assert.equal(menu.menuItemPhotoMissing(legacy), true);
  assert.equal(
    menu.menuItemPhotoMissing({ ...legacy, isActive: false }),
    false,
  );
});

// ---- legend-qf0i: guest/public reads hide the legacy row ------------------

test("Q23 legend-qf0i: only an active row with a photo is visible to guests", () => {
  const mediaId = "00000000-0000-4000-8000-000000007900";
  assert.equal(menu.menuItemVisibleToGuests({ isActive: true, mediaId }), true);
  // The legacy row: active, no photo, sellable — hidden from every guest read.
  assert.equal(
    menu.menuItemVisibleToGuests({ isActive: true, mediaId: null }),
    false,
  );
  assert.equal(
    menu.menuItemVisibleToGuests({ isActive: true, mediaId: undefined }),
    false,
  );
  // A draft never reaches a guest, with or without a photo.
  assert.equal(
    menu.menuItemVisibleToGuests({ isActive: false, mediaId: null }),
    false,
  );
  assert.equal(
    menu.menuItemVisibleToGuests({ isActive: false, mediaId }),
    false,
  );
});

test("Q23 legend-qf0i: the QR guest menu drops the item without a photo", () => {
  // Fixture-level case: the demo catalogue gives every item a photo, so the
  // legacy state is built by removing one item's photo instead of changing the
  // demo data. The categories stay (navigation), the item does not.
  const table = qr.qrOrderFixtures.tables.find((entry) => entry.code === "A03");
  assert.ok(table);
  const zone = qr.qrOrderFixtures.zones[0];
  const photoed = sample.buildQrMenu(
    { table, zone },
    { photoFor: (name) => (name === "Cappuccino" ? null : "/x.jpg") },
  );
  // The builder keeps the photo-less item (the back office still has it); the
  // guest filter is what removes it.
  assert.equal(
    photoed.items.find((item) => item.name === "Cappuccino")?.photoUrl,
    null,
  );
  const filteredAll = sample.hidePhotoLessMenuItems(photoed);
  assert.equal(
    filteredAll.items.some((item) => item.name === "Cappuccino"),
    false,
  );
  assert.equal(filteredAll.items.length, photoed.items.length - 1);
  // Categories stay: the guest still navigates the menu structure.
  assert.deepEqual(filteredAll.categories, photoed.categories);
  // Every remaining item keeps its photo.
  assert.ok(filteredAll.items.every((item) => item.photoUrl !== null));
});

test("Q23 legend-qf0i: the public website menu drops the item without a photo", () => {
  const page = site.cafeLegendWebsiteFixtures.menuPage;
  const kept = guestMenu.withGuestPhotos(page, () => "/sample/menu/x.jpg");
  assert.equal(
    kept.sections.flatMap((section) => section.items).length,
    page.sections.flatMap((section) => section.items).length,
  );
  const legacy = page.sections.flatMap((section) => section.items)[0];
  const oneMissing = guestMenu.withGuestPhotos(page, (item) =>
    item.id === legacy.id ? null : "/sample/menu/x.jpg",
  );
  const names = oneMissing.sections.flatMap((section) =>
    section.items.map((item) => item.name),
  );
  assert.equal(names.includes(legacy.name), false);
  // A page where every item lacks a photo renders sections with no items.
  const none = guestMenu.withGuestPhotos(page, () => null);
  assert.ok(none.sections.every((section) => section.items.length === 0));
});
