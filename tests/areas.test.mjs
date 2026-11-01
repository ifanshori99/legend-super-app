// Route areas contract (bead legend-fbu; PRD v1.7 §3 F1 densities, §3 F3,
// §5 "Peta situs", AUTH-05 MFA rule). Pure logic of apps/web/src/lib/areas:
// who may open which area, density per area, navigation as data.
// Acceptance IDs used in test names: FE-AREA-01 … FE-AREA-08.
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

const base = "../apps/web/src/lib/areas";
const defs = await import(`${base}/definitions.ts`);
const guard = await import(`${base}/guard.ts`);
const accessLib = await import(`${base}/access.ts`);
const nav = await import(`${base}/nav.ts`);
const i18n = await import("../packages/shared/src/i18n/index.ts");
const rbac = await import("../packages/shared/src/access/index.ts");

const t = i18n.createTranslator();
const icon = () => null;
const roleAccess = (key, extra = {}) => ({
  ...accessLib.accessForMockRole(key),
  ...extra,
});
const open = (area, access) =>
  guard.evaluateArea(defs.AREAS[area], access).status;

describe("FE-AREA-01 PRD §5 URL prefixes belong to exactly one area", () => {
  const expected = {
    "/": "public",
    "/menu": "public",
    "/reservasi": "public",
    "/masuk": "public",
    "/t/abc": "customer",
    "/f/shower": "customer",
    "/member": "customer",
    "/member/fasilitas/tiket": "customer",
    "/wifi": "customer",
    "/pos": "ops",
    "/pos/meja/12": "ops",
    "/fasilitas/bilik": "ops",
    "/operasional/checklist": "ops",
    "/kds": "kitchen",
    "/kds/bar": "kitchen",
    "/expo": "kitchen",
    "/pickup": "kitchen",
    "/kelola/laporan": "kelola",
    "/owner": "owner",
    "/shareholder/bagi-hasil": "shareholder",
    "/karyawan/absensi": "karyawan",
    "/platform/tenant": "platform",
  };
  for (const [path, area] of Object.entries(expected))
    test(`${path} → ${area}`, () =>
      assert.equal(defs.resolveAreaForPath(path)?.key, area));

  test("lookalike prefixes and unknown paths are not claimed", () => {
    assert.equal(defs.resolveAreaForPath("/posting"), null);
    assert.equal(defs.resolveAreaForPath("/kelolaan"), null);
    assert.equal(defs.resolveAreaForPath("/sign-in"), null);
  });

  test("no base path is claimed by two areas", () => {
    const seen = new Map();
    for (const area of defs.AREA_LIST)
      for (const path of area.basePaths) {
        assert.equal(seen.has(path), false, `${path} claimed twice`);
        seen.set(path, area.key);
      }
  });

  test("each area index sits under its own base paths", () => {
    for (const area of defs.AREA_LIST)
      assert.equal(defs.resolveAreaForPath(area.indexPath)?.key, area.key);
  });
});

describe("FE-AREA-02 density and shell per area (PRD §3 F1, DESIGN.md §1)", () => {
  const expected = {
    public: ["hangat", "customer"],
    customer: ["hangat", "customer"],
    karyawan: ["hangat", "customer"],
    ops: ["kontras", "operations"],
    kitchen: ["kontras", "operations"],
    kelola: ["padat", "management"],
    owner: ["padat", "management"],
    shareholder: ["padat", "management"],
    platform: ["padat", "management"],
  };
  for (const [area, [density, shell]] of Object.entries(expected))
    test(`${area} uses ${density} / ${shell} shell`, () => {
      assert.equal(defs.AREAS[area].density, density);
      assert.equal(defs.AREAS[area].shell, shell);
    });

  test("kitchen is always dark; edge-served areas are ops and kitchen", () => {
    assert.equal(defs.AREAS.kitchen.forcedMode, "dark");
    assert.deepEqual(
      defs.AREA_LIST.filter((a) => a.servedBy === "edge").map((a) => a.key),
      ["ops", "kitchen"],
    );
  });

  test("every area except public is noindex (PRD §5 Diindeks: Tidak)", () => {
    for (const area of defs.AREA_LIST)
      assert.equal(area.noindex, area.key !== "public", area.key);
  });
});

describe("FE-AREA-03 anonymous visitors", () => {
  test("public and customer areas are open", () => {
    assert.equal(open("public", accessLib.ANONYMOUS_ACCESS), "allowed");
    assert.equal(open("customer", accessLib.ANONYMOUS_ACCESS), "allowed");
  });
  test("every work area sends an anonymous visitor to sign in", () => {
    for (const area of defs.AREA_LIST.filter(
      (a) => a.guard.kind === "permission",
    ))
      assert.equal(
        open(area.key, accessLib.ANONYMOUS_ACCESS),
        "unauthenticated",
      );
  });
  test("member pages need a session but no role", () => {
    assert.equal(
      guard.evaluateGuard(defs.SESSION_GUARD, accessLib.ANONYMOUS_ACCESS)
        .status,
      "unauthenticated",
    );
    assert.equal(
      guard.evaluateGuard(defs.SESSION_GUARD, roleAccess("employee")).status,
      "allowed",
    );
  });
});

describe("FE-AREA-04 AUTH-05 second factor on dashboards and back office", () => {
  const guarded = ["kelola", "owner", "shareholder", "platform"];
  const grantFor = {
    kelola: "general_manager",
    owner: "owner",
    shareholder: "shareholder",
    platform: "super_admin",
  };
  for (const area of guarded) {
    test(`${area} asks for MFA before the permission is even considered`, () => {
      const access = roleAccess(grantFor[area], { mfaVerified: false });
      assert.equal(access.mfaRequired, true);
      assert.equal(open(area, access), "mfa_required");
    });
    test(`${area} opens once the second factor is verified`, () => {
      assert.equal(open(area, roleAccess(grantFor[area])), "allowed");
    });
  }
  test("device surfaces use the staff PIN, not MFA (§3.6)", () => {
    for (const [area, role] of [
      ["ops", "cashier"],
      ["kitchen", "barista_cook"],
      ["karyawan", "employee"],
    ])
      assert.equal(
        open(area, roleAccess(role, { mfaVerified: false })),
        "allowed",
        area,
      );
  });
  test("surfaces in the guard match the contract's MFA-guarded list", () => {
    for (const area of guarded)
      assert.equal(
        rbac.isMfaGuardedSurface(defs.AREAS[area].guard.surface),
        true,
        area,
      );
  });
});

describe("FE-AREA-05 role templates reach only their areas (deny by default)", () => {
  const reach = (role) =>
    defs.AREA_LIST.filter(
      (a) =>
        a.guard.kind === "permission" &&
        open(a.key, roleAccess(role)) === "allowed",
    ).map((a) => a.key);

  test("cashier works the POS, nothing else", () =>
    assert.deepEqual(reach("cashier"), ["ops"]));
  test("kitchen staff open the KDS, not the POS or management", () => {
    assert.ok(reach("barista_cook").includes("kitchen"));
    for (const denied of ["kelola", "owner", "shareholder", "platform"])
      assert.equal(reach("barista_cook").includes(denied), false, denied);
  });
  test("shareholder sees only the shareholder dashboard", () =>
    assert.deepEqual(reach("shareholder"), ["shareholder"]));
  test("employee opens the HRIS, not management", () =>
    assert.deepEqual(reach("employee"), ["karyawan"]));
  test("super admin reaches the platform panel but no tenant dashboard", () =>
    assert.deepEqual(reach("super_admin"), ["platform"]));
  test("owner reaches management dashboards, never the platform panel", () => {
    assert.ok(reach("owner").includes("owner"));
    assert.ok(reach("owner").includes("kelola"));
    assert.equal(reach("owner").includes("platform"), false);
  });
  test("a signed-in account without known permissions fails closed", () => {
    const access = accessLib.accessFromSession({ user: { id: "u1" } });
    assert.equal(access.authenticated, true);
    for (const area of defs.AREA_LIST.filter(
      (a) => a.guard.kind === "permission",
    ))
      assert.equal(open(area.key, access), "forbidden", area.key);
  });
  test("reachableWorkAreas lists exactly what the guard allows", () => {
    assert.deepEqual(
      guard.reachableWorkAreas(roleAccess("cashier")).map((a) => a.key),
      ["ops"],
    );
    assert.deepEqual(guard.reachableWorkAreas(accessLib.ANONYMOUS_ACCESS), []);
  });
  test("every area permission exists in the RBAC catalog", () => {
    for (const area of defs.AREA_LIST)
      if (area.guard.kind === "permission")
        for (const code of area.guard.anyOf)
          assert.equal(rbac.isPermissionCode(code), true, code);
  });
});

describe("FE-AREA-06 navigation as data", () => {
  const entries = [
    {
      area: "kelola",
      labelKey: "nav.management.crm",
      to: "/kelola/crm",
      icon,
      order: 20,
      anyPermission: ["crm.customer.view"],
    },
    {
      area: "kelola",
      labelKey: "nav.management.inventory",
      to: "/kelola/inventori",
      icon,
      order: 10,
      anyPermission: ["inventory.stock.view"],
    },
    {
      area: "owner",
      labelKey: "nav.management.dashboard",
      to: "/owner/x",
      icon,
    },
  ];
  const build = (access, pathname) =>
    nav.buildAreaNav({
      area: "kelola",
      entries,
      indexIcon: icon,
      access,
      pathname,
      t,
    });

  test("area index is first, then by order; other areas' entries are ignored", () => {
    const items = build(roleAccess("owner"), "/kelola");
    assert.deepEqual(
      items.map((i) => i.href),
      ["/kelola", "/kelola/inventori", "/kelola/crm"],
    );
    assert.equal(items[0].label, t("area.kelola.name"));
  });
  test("items the visitor cannot use are hidden", () => {
    const items = build(roleAccess("general_manager"), "/kelola");
    assert.equal(
      items.some((i) => i.href === "/kelola/crm"),
      false,
    );
  });
  test("the longest matching path is current, once", () => {
    const items = build(roleAccess("owner"), "/kelola/inventori/stok/42");
    assert.deepEqual(
      items.filter((i) => i.current).map((i) => i.href),
      ["/kelola/inventori"],
    );
    assert.deepEqual(
      build(roleAccess("owner"), "/kelola")
        .filter((i) => i.current)
        .map((i) => i.href),
      ["/kelola"],
    );
  });
  test("every area has catalog text for name, empty title and hint", () => {
    for (const area of defs.AREA_LIST)
      for (const key of [area.nameKey, area.emptyTitleKey, area.emptyHintKey])
        assert.notEqual(t(key), key, key);
  });
});

describe("FE-AREA-07 mock role cookie (development only)", () => {
  test("absent → all areas; known role → that role; garbage → signed out", () => {
    assert.equal(accessLib.parseMockRole(undefined), "all");
    assert.equal(accessLib.parseMockRole("cashier"), "cashier");
    assert.equal(accessLib.parseMockRole("none"), "none");
    assert.equal(accessLib.parseMockRole("root; drop table"), "none");
  });
  test("none is anonymous; all holds the whole catalog", () => {
    assert.equal(accessLib.accessForMockRole("none").authenticated, false);
    assert.equal(
      accessLib.accessForMockRole("all").permissions.length,
      rbac.PERMISSION_CODES.length,
    );
  });
});

describe("FE-AREA-08 gate texts exist in the catalog", () => {
  for (const key of [
    "gate.forbiddenTitle",
    "gate.forbiddenHint",
    "gate.mfaTitle",
    "gate.mfaHint",
    "gate.backHome",
    "auth.signIn",
    "area.reachable",
    "layout.offlineRegion",
    "app.defaultBrand",
    "area.ops.outletUnset",
  ])
    test(key, () => assert.notEqual(t(key), key));
});
