// Founder 21 Nov (keputusan no.14, bead legend-ff393, card 1257): on a shared
// tablet the reservation desk, Tanya AI at KDS and the facility / operations
// screens are hidden in release 1. Hidden = out of the menu and "not found"
// (the root route throws notFound for a closed pathname), not an empty 403.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, test } from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    // Feature nav.ts files import through the web "@/" alias (apps/web/src).
    if (specifier === "@/lib/api/mock-flag") {
      // import.meta.env does not exist in node.
      return {
        url: "data:text/javascript,export const API_MOCK=false",
        shortCircuit: true,
      };
    }
    if (specifier.startsWith("@/")) {
      const target = new URL(
        `../apps/web/src/${specifier.slice(2)}`,
        import.meta.url,
      ).href;
      return nextResolve(
        /\.[cm]?[jt]s$/.test(target) ? target : `${target}.ts`,
        context,
      );
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier))
        return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const base = "../apps/web/src";
const guard = await import(`${base}/lib/areas/guard.ts`);
const accessLib = await import(`${base}/lib/areas/access.ts`);
const navLib = await import(`${base}/lib/areas/nav.ts`);
const defs = await import(`${base}/lib/areas/definitions.ts`);
const screens =
  await import("../packages/shared/src/access/shared-device-screens.ts");
const i18n = await import("../packages/shared/src/i18n/index.ts");
const reservationNav = (
  await import(`${base}/features/ws08-reservation/nav.ts`)
).default;
const aiNav = (await import(`${base}/features/ws12-ai-chat/nav.ts`)).default;

const t = i18n.createTranslator();
const icon = () => null;
const shared = {
  ...accessLib.accessForMockRole("owner"),
  permissions: ["reservation.view", "ai.ask", "pos.order.create"],
  authenticated: true,
  mfaRequired: false,
  sharedDevice: true,
};
const nav = (area, entries, access, pathname) =>
  navLib
    .buildAreaNav({
      area,
      entries,
      indexIcon: icon,
      access,
      pathname,
      t,
    })
    .map((item) => item.href);

describe("1257 hidden on a shared tablet", () => {
  for (const path of [
    "/pos/reservasi",
    "/pos/reservasi/",
    "/pos/Reservasi",
    "/kds/tanya-ai",
    "/kds/tanya-ai/panduan",
    "/fasilitas",
    "/fasilitas/darurat",
    "/operasional/suhu",
  ]) {
    test(`${path} is closed and answers not found`, () => {
      assert.equal(screens.isSharedDeviceScreenAllowed(path), false);
      assert.equal(guard.isScreenClosedOnSharedDevice(shared, path), true);
    });
  }

  test("working screens stay open", () => {
    for (const path of [
      "/pos",
      "/pos/kasir",
      "/pos/meja",
      "/pos/ganti-pengguna",
      "/kds",
      "/kds/ganti-pengguna",
      "/expo",
      "/pickup",
    ])
      assert.equal(screens.isSharedDeviceScreenAllowed(path), true, path);
  });

  test("a prefix lookalike is not caught by the closed list", () => {
    assert.equal(screens.isSharedDeviceScreenAllowed("/pos/reservasix"), true);
  });

  test("the reservation menu entry is not offered", () => {
    const entries = [...reservationNav];
    assert.ok(
      nav("ops", entries, { ...shared, sharedDevice: false }, "/pos").includes(
        "/pos/reservasi",
      ),
    );
    assert.ok(!nav("ops", entries, shared, "/pos").includes("/pos/reservasi"));
  });

  test("the KDS Tanya AI menu entries are not offered", () => {
    const entries = [...aiNav];
    const kds = nav("kitchen", entries, shared, "/kds");
    assert.ok(!kds.includes("/kds/tanya-ai"));
    assert.ok(!kds.includes("/kds/tanya-ai/panduan"));
  });

  test("a work area whose landing page is closed is not reachable", () => {
    const names = guard
      .reachableWorkAreas({ ...shared, permissions: ["pos.order.create"] })
      .map((a) => a.indexPath);
    assert.ok(!names.includes("/fasilitas"));
  });

  test("the same screens stay open off a shared tablet", () => {
    const normal = { ...shared, sharedDevice: false };
    assert.equal(
      guard.isScreenClosedOnSharedDevice(normal, "/pos/reservasi"),
      false,
    );
    assert.equal(
      guard.isScreenClosedOnSharedDevice(normal, "/kds/tanya-ai"),
      false,
    );
  });
});

void defs;
