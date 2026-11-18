// Route areas contract (bead legend-fbu; PRD v1.7 §3 F1 densities, §3 F3,
// §5 "Peta situs", AUTH-05 MFA rule). Pure logic of apps/web/src/lib/areas:
// who may open which area, density per area, navigation as data.
// Acceptance IDs used in test names: FE-AREA-01 … FE-AREA-08.
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

const base = "../apps/web/src/lib/areas";
const defs = await import(`${base}/definitions.ts`);
const guard = await import(`${base}/guard.ts`);
const accessLib = await import(`${base}/access.ts`);
const nav = await import(`${base}/nav.ts`);
const outletSel = await import(`${base}/outlet-selection.ts`);
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
    // AUTH-05 fails closed too: MFA required and not verified until the API says so.
    assert.equal(access.mfaRequired, true);
    assert.equal(access.mfaVerified, false);
    for (const area of defs.AREA_LIST.filter(
      (a) => a.guard.kind === "permission",
    ))
      assert.ok(
        ["forbidden", "mfa_required"].includes(open(area.key, access)),
        area.key,
      );
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

// legend-oldg: the real (non-mock) access comes from GET /api/me/access.
describe("FE-AREA-09 resolveAreaAccess reads the access view, fails closed", () => {
  const session = { user: { id: "u1" } };
  const view = (extra = {}) => ({
    permissions: ["org.structure.manage", "kds.ticket.process"],
    mfaRequired: false,
    mfaVerified: false,
    stations: ["11111111-1111-4111-8111-111111111111"],
    outlets: [],
    activeOutletId: null,
    supportSession: null,
    ...extra,
  });
  const ok = (v) => async () => v;
  const boom = (error) => async () => {
    throw error;
  };

  test("no session → anonymous, API never called", async () => {
    let called = 0;
    const access = await accessLib.resolveAreaAccess(null, async () => {
      called += 1;
      return view();
    });
    assert.equal(access.authenticated, false);
    assert.equal(called, 0);
  });

  test("allowed: permissions, stations and mfa flags come from the view", async () => {
    const access = await accessLib.resolveAreaAccess(session, ok(view()));
    assert.equal(access.authenticated, true);
    assert.deepEqual(access.permissions, [
      "org.structure.manage",
      "kds.ticket.process",
    ]);
    assert.deepEqual(access.stations, ["11111111-1111-4111-8111-111111111111"]);
    assert.equal(access.mfaRequired, false);
    assert.equal(access.supportSession, null);
  });

  test("mfa_required and not verified keeps the MFA gate closed", async () => {
    const access = await accessLib.resolveAreaAccess(
      session,
      ok(view({ mfaRequired: true, mfaVerified: false })),
    );
    assert.equal(access.mfaRequired, true);
    assert.equal(access.mfaVerified, false);
    assert.equal(
      open("owner", { ...access, permissions: rbac.PERMISSION_CODES }),
      "mfa_required",
    );
  });

  test("support session is carried through", async () => {
    const support = {
      accessMode: "read_only",
      expiresAt: "2026-11-10T10:00:00Z",
    };
    const access = await accessLib.resolveAreaAccess(
      session,
      ok(view({ supportSession: support })),
    );
    assert.deepEqual(access.supportSession, support);
  });

  test("403 / 401 / network / malformed → fail closed, no permissions", async () => {
    for (const fetchView of [
      boom(Object.assign(new Error("forbidden"), { status: 403 })),
      boom(Object.assign(new Error("unauthorized"), { status: 401 })),
      boom(new Error("network down")),
      ok({ nonsense: true }),
      ok(null),
    ]) {
      const access = await accessLib.resolveAreaAccess(session, fetchView);
      assert.deepEqual(access, accessLib.accessFromSession(session));
      assert.equal(access.permissions.length, 0);
      assert.equal(access.mfaRequired, true);
    }
  });
});

// legend-2aqp: the staff outlet context comes from the assigned outlets.
describe("FE-AREA-10 outlet selection from the session outlets", () => {
  const session = { user: { id: "u1" } };
  const make = (n, name) => ({
    id: `00000000-0000-4000-8000-00000000000${n}`,
    name,
    timeZone: "Asia/Jakarta",
    businessDayCutoff: "04:00",
  });
  const a = make(1, "Bandung");
  const b = make(2, "Bandung 2");
  const fakeStorage = (initial = null) => {
    let value = initial;
    return {
      getItem: () => value,
      setItem: (_key, next) => {
        value = next;
      },
    };
  };

  test("0 outlets: no selection, choice none", () => {
    assert.equal(outletSel.outletChoice([]), "none");
    assert.equal(outletSel.resolveSelectedOutlet([], a.id), null);
    assert.equal(outletSel.resolveSelectedOutlet([], null), null);
  });

  test("1 outlet: selected without a picker, saved id ignored", () => {
    assert.equal(outletSel.outletChoice([a]), "single");
    assert.equal(outletSel.resolveSelectedOutlet([a], null), a);
    assert.equal(outletSel.resolveSelectedOutlet([a], b.id), a);
  });

  test("2+ outlets: picker, saved pick wins, invalid falls back to first", () => {
    assert.equal(outletSel.outletChoice([a, b]), "multiple");
    assert.equal(outletSel.resolveSelectedOutlet([a, b], b.id), b);
    assert.equal(outletSel.resolveSelectedOutlet([a, b], null), a);
    assert.equal(outletSel.resolveSelectedOutlet([a, b], "gone"), a);
    assert.equal(outletSel.resolveSelectedOutlet([a, b], undefined), a);
  });

  // The real registry (import.meta.glob) is not available in node: load each
  // feature's nav.ts the same way the glob does.
  const loadFeatureNav = async () => {
    const { readdirSync, existsSync } = await import("node:fs");
    const root = new URL("../apps/web/src/features/", import.meta.url);
    const entries = [];
    for (const name of readdirSync(root)) {
      const file = new URL(`${name}/nav.ts`, root);
      if (existsSync(file)) entries.push(...(await import(file.href)).default);
    }
    return entries;
  };
  const scopedEntry = (area, outletScopedPaths) => ({
    area,
    labelKey: "nav.management.inventory",
    to: "/kelola/x",
    icon,
    outletScopedPaths,
  });

  test("kelola picker: only nav-declared outlet paths (legend-gyq04)", () => {
    const entries = [
      scopedEntry("kelola", ["/kelola/roster", "/kelola/inventori/stok"]),
      scopedEntry("ops", ["/pos/meja"]),
      { ...scopedEntry("kelola", undefined), to: "/kelola/perangkat" },
    ];
    const uses = (path) => outletSel.kelolaUsesOutletContext(path, entries);
    assert.equal(uses("/kelola/roster"), true);
    assert.equal(uses("/kelola/inventori/stok/abc"), true);
    // Own pickers and name-only lookups: no second control.
    assert.equal(uses("/kelola/perangkat"), false);
    assert.equal(uses("/kelola/inventori"), false);
    assert.equal(uses("/kelola/rosterx"), false);
    assert.equal(uses("/"), false);
    // Only Kelola entries count.
    assert.equal(uses("/pos/meja"), false);
    assert.equal(
      outletSel.kelolaUsesOutletContext("/kelola/roster", []),
      false,
    );
  });

  test("kelola picker: registered nav keeps the legend-sp41n screens", async () => {
    const entries = await loadFeatureNav();
    const uses = (path) => outletSel.kelolaUsesOutletContext(path, entries);
    assert.equal(uses("/kelola/roster"), true);
    assert.equal(uses("/kelola/inventori/stok/abc"), true);
    assert.equal(uses("/kelola/pengadaan"), true);
    assert.equal(uses("/kelola/pengaturan/open-bill"), true);
    assert.equal(uses("/kelola/perangkat"), false);
    assert.equal(uses("/kelola/inventori"), false);
    assert.equal(uses("/kelola/rosterx"), false);
  });

  test("kelola picker: every declared path is a real Kelola route", async () => {
    const { readdirSync } = await import("node:fs");
    const routes = readdirSync(
      new URL("../apps/web/src/routes/_kelola/", import.meta.url),
    ).map((name) => name.replace(/\.tsx$/, "").replace(/_(?=\.)/g, ""));
    const paths = (await loadFeatureNav())
      .filter((entry) => entry.area === "kelola")
      .flatMap((entry) => entry.outletScopedPaths ?? []);
    assert.ok(paths.length > 0);
    for (const prefix of paths) {
      const dotted = prefix.slice(1).replaceAll("/", ".");
      assert.ok(
        routes.some((name) => name === dotted || name.startsWith(`${dotted}.`)),
        `no route file for ${prefix}`,
      );
    }
  });

  test("2+ outlets: screen is held until the saved pick is read", () => {
    assert.equal(outletSel.outletPickPending([a, b], undefined), true);
    assert.equal(outletSel.outletPickPending([a, b], null), false);
    assert.equal(outletSel.outletPickPending([a, b], b.id), false);
    assert.equal(outletSel.outletPickPending([a], undefined), false);
    assert.equal(outletSel.outletPickPending([], undefined), false);
  });

  test("0 outlets: Kelola for a manager, home for the rest", () => {
    assert.equal(outletSel.noOutletNext(roleAccess("all")), "kelola");
    // A pending second factor still leads to the Kelola gate screen.
    assert.equal(
      outletSel.noOutletNext(
        roleAccess("all", { mfaRequired: true, mfaVerified: false }),
      ),
      "kelola",
    );
    assert.equal(
      outletSel.noOutletNext(roleAccess("all", { permissions: [] })),
      "home",
    );
    assert.equal(
      outletSel.noOutletNext(
        roleAccess("all", { permissions: ["kds.ticket.process"] }),
      ),
      "home",
    );
    assert.equal(outletSel.noOutletNext(accessLib.ANONYMOUS_ACCESS), "home");
  });

  test("outlet UI copy: picker label, announcement, 0-outlet hint", () => {
    assert.equal(t("area.outletPicker"), "Pilih outlet");
    assert.equal(
      t("area.outletChanged", { name: "Cafe Legend Bandung" }),
      "Outlet diganti ke Cafe Legend Bandung",
    );
    assert.equal(
      t("area.noOutletHint"),
      "Minta pemilik atau manajer menugaskan akun Anda ke outlet.",
    );
    assert.equal(t("area.noOutletKelola"), "Buka Kelola");
  });

  test("saved pick round-trips; blocked storage never throws", () => {
    const storage = fakeStorage();
    assert.equal(outletSel.readSavedOutletId(storage), null);
    outletSel.saveOutletId(b.id, storage);
    assert.equal(outletSel.readSavedOutletId(storage), b.id);
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    assert.equal(outletSel.readSavedOutletId(blocked), null);
    assert.doesNotThrow(() => outletSel.saveOutletId(a.id, blocked));
    assert.equal(outletSel.readSavedOutletId(null), null);
  });

  test("outlets come from the access view; failures and anonymous have none", async () => {
    const view = {
      permissions: ["kds.ticket.process"],
      mfaRequired: false,
      mfaVerified: false,
      stations: [],
      outlets: [a, b],
      activeOutletId: null,
      supportSession: null,
    };
    const access = await accessLib.resolveAreaAccess(session, async () => view);
    assert.deepEqual(access.outlets, [a, b]);
    const failed = await accessLib.resolveAreaAccess(session, async () => {
      throw new Error("down");
    });
    assert.deepEqual(failed.outlets, []);
    assert.deepEqual(accessLib.ANONYMOUS_ACCESS.outlets, []);
    assert.equal(accessLib.accessForMockRole("all").outlets.length, 1);
  });
});
