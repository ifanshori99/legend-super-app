import assert from "node:assert/strict";
import { test } from "node:test";
import * as menu from "../packages/shared/src/menu/index.ts";

// Contract tests for owner decision Q23 (legend-pnsa): every menu item must
// have a photo, so an item can only be active (published) with a mediaId. The
// API and the back-office form both read this rule from the contract.

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
