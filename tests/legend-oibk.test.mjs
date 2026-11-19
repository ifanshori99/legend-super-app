// Member PWA bottom nav (bead legend-oibk; DESIGN.md v2 §5 CustomerShell:
// bottom nav ≤5 items, 64px, safe-area padding). Verifies the slot split the
// shell applies and the customer nav order that decides which destinations
// stay in the bar and which move into the "Lainnya" sheet.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, test } from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier))
        return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const navLib = await import("../apps/web/src/lib/areas/nav.ts");
const i18n = await import("../packages/shared/src/i18n/index.ts");

const t = i18n.createTranslator();
const icon = () => null;
const entry = (area, labelKey, to, order) => ({
  area,
  labelKey,
  to,
  icon,
  order,
});

// The customer-area entries as features register them (orders fixed by
// legend-oibk: member screens, then facilities, then Wi-Fi).
const customerEntries = [
  entry("customer", "nav.customer.memberPoints", "/member/poin", 10),
  entry("customer", "nav.customer.memberRewards", "/member/reward", 20),
  entry("customer", "nav.customer.memberVouchers", "/member/voucher", 30),
  entry("customer", "nav.customer.memberMissions", "/member/misi", 40),
  entry("customer", "nav.customer.facility", "/member/fasilitas", 50),
  entry("customer", "nav.customer.wifi", "/wifi", 60),
];

function customerNav(pathname) {
  return navLib
    .buildAreaNav({
      area: "customer",
      entries: customerEntries,
      indexIcon: icon,
      access: {},
      pathname,
      t,
    })
    .map((item) => item.label);
}

describe("Legend-oibk: CustomerShell bottom nav keeps five slots", () => {
  test("Legend-oibk: at most five items stay in the bar, the rest go to Lainnya", () => {
    const five = navLib.splitBottomNav(["a", "b", "c", "d", "e"]);
    assert.deepEqual(five.primary, ["a", "b", "c", "d", "e"]);
    assert.deepEqual(five.overflow, []);

    const seven = navLib.splitBottomNav(["a", "b", "c", "d", "e", "f", "g"]);
    assert.deepEqual(seven.primary, ["a", "b", "c", "d"]);
    assert.deepEqual(seven.overflow, ["e", "f", "g"]);
    assert.equal(seven.primary.length + 1, navLib.BOTTOM_NAV_MAX_SLOTS);

    // Short bars (QR journey, previews) are untouched.
    assert.deepEqual(navLib.splitBottomNav(["a", "b", "c"]), {
      primary: ["a", "b", "c"],
      overflow: [],
    });
  });

  test("Legend-oibk: member bar keeps Beranda, Poin, Hadiah, Voucher; Misi, Fasilitas and Wi-Fi overflow", () => {
    const labels = customerNav("/member");
    assert.deepEqual(labels, [
      "Member",
      "Poin",
      "Hadiah",
      "Voucher",
      "Misi",
      "Fasilitas",
      "Wi-Fi",
    ]);
    const { primary, overflow } = navLib.splitBottomNav(labels);
    assert.deepEqual(primary, ["Member", "Poin", "Hadiah", "Voucher"]);
    assert.deepEqual(overflow, ["Misi", "Fasilitas", "Wi-Fi"]);
  });

  test("Legend-oibk: an overflow screen still resolves the area index as home", () => {
    // /member/fasilitas matches the Fasilitas entry (longest path), so the
    // Lainnya slot carries the active state instead of a bar link.
    const items = navLib.buildAreaNav({
      area: "customer",
      entries: customerEntries,
      indexIcon: icon,
      access: {},
      pathname: "/member/fasilitas",
      t,
    });
    assert.equal(items.find((item) => item.current)?.label, "Fasilitas");
  });
});
