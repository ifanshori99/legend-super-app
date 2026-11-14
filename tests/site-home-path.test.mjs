// legend-ykam: siteConfig.appHomePath (where sign-up, sign-in and a signed-in
// visitor on /sign-in land) must not point at a leftover starter screen
// ("/notes"); it must be a fixed internal path that a real route of a defined
// area serves. Pure logic, no database.
//
// Assumption (the card says "arahkan ke dashboard back-office" but a new
// sign-up is a customer without dashboard.management.view, so /kelola would be
// refused for them; e2e/auth.spec.ts and docs/frontend.md expect /member):
// the contract tested here is "a real, area-owned landing route, never
// /notes", not "always /kelola". The back-office index route is asserted to
// exist so a role-aware landing can use it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

const { siteConfig } = await import("../packages/shared/src/site.ts");
const { AREAS } = await import("../apps/web/src/lib/areas/definitions.ts");
const routeTree = readFileSync(
  new URL("../apps/web/src/routeTree.gen.ts", import.meta.url),
  "utf8",
);

const hasRoute = (path) =>
  new RegExp(`fullPath: '${path.replace(/\//g, "\\/")}\\/?'`).test(routeTree);
const owner = (path) =>
  Object.values(AREAS).find((area) =>
    area.basePaths.some((base) =>
      base === "/"
        ? path === "/"
        : path === base || path.startsWith(`${base}/`),
    ),
  );

describe("legend-ykam app home path", () => {
  test("appHomePath is not the removed starter Notes screen", () => {
    assert.notEqual(siteConfig.appHomePath, "/notes");
    assert.ok(!siteConfig.appHomePath.startsWith("/notes/"));
    assert.equal(hasRoute("/notes"), false);
  });

  test("appHomePath is a fixed internal path (no open redirect)", () => {
    assert.match(siteConfig.appHomePath, /^\/(?!\/)[^?#:\\]*$/);
  });

  test("appHomePath is served by a real route of a defined area that is not the public brand site", () => {
    assert.ok(
      hasRoute(siteConfig.appHomePath),
      `no route serves ${siteConfig.appHomePath}`,
    );
    const area = owner(siteConfig.appHomePath);
    assert.ok(area, `no area owns ${siteConfig.appHomePath}`);
    assert.notEqual(area.key, "public");
    assert.notEqual(siteConfig.appHomePath, siteConfig.homePath);
  });

  test("the back-office dashboard index exists and is guarded by the dashboard permission", () => {
    assert.equal(AREAS.kelola.indexPath, "/kelola");
    assert.ok(hasRoute("/kelola"), "no /kelola route");
    assert.equal(AREAS.kelola.guard.kind, "permission");
    assert.deepEqual(
      [...AREAS.kelola.guard.anyOf],
      ["dashboard.management.view"],
    );
  });
});
