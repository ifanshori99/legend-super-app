// legend-ykam (part 2): where a signed-in visitor lands after sign-in or on
// /sign-in. A session that holds the back-office permission
// (dashboard.management.view, the guard of the kelola area) lands on the
// back-office dashboard /kelola; a customer or any account without it stays on
// the customer home siteConfig.appHomePath (/member). Pure logic, no database.
//
// Assumptions (the coordinator named the function, not its file):
//  - `postLoginPath(access)` is exported from
//    apps/web/src/lib/areas/post-login.ts and takes an AreaAccess (the same
//    value the area guards use) and returns a path string.
//  - Management is decided by the permission only; a pending second factor
//    (AUTH-05) does not change the landing: /kelola itself asks for it.
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
const access = await import(`${base}/access.ts`);
const { siteConfig } = await import("../packages/shared/src/site.ts");

const load = async () => {
  const module = await import(`${base}/post-login.ts`);
  assert.equal(
    typeof module.postLoginPath,
    "function",
    "post-login.ts must export postLoginPath",
  );
  return module.postLoginPath;
};

describe("legend-ykam postLoginPath", () => {
  for (const role of ["owner", "general_manager", "tenant_admin"]) {
    test(`a ${role} session lands on the back-office dashboard`, async () => {
      const postLoginPath = await load();
      const view = access.accessForMockRole(role);
      assert.ok(
        view.permissions.includes("dashboard.management.view"),
        `fixture: ${role} should hold dashboard.management.view`,
      );
      assert.equal(postLoginPath(view), "/kelola");
    });
  }

  test("a management session with the second factor still pending lands on /kelola (the area asks for it)", async () => {
    const postLoginPath = await load();
    const view = {
      ...access.accessForMockRole("general_manager"),
      mfaRequired: true,
      mfaVerified: false,
    };
    assert.equal(postLoginPath(view), "/kelola");
  });

  for (const role of ["cashier", "waiter", "employee", "barista_cook"]) {
    test(`a ${role} session without management permission stays on the customer home`, async () => {
      const postLoginPath = await load();
      const view = access.accessForMockRole(role);
      assert.ok(
        !view.permissions.includes("dashboard.management.view"),
        `fixture: ${role} must not hold dashboard.management.view`,
      );
      assert.equal(postLoginPath(view), siteConfig.appHomePath);
      assert.equal(postLoginPath(view), "/member");
    });
  }

  test("a signed-in customer whose permissions are unknown (fails closed) stays on /member", async () => {
    const postLoginPath = await load();
    const view = access.accessFromSession({ user: {} });
    assert.equal(postLoginPath(view), "/member");
  });

  test("an anonymous visitor never gets the back-office path", async () => {
    const postLoginPath = await load();
    assert.notEqual(postLoginPath(access.ANONYMOUS_ACCESS), "/kelola");
  });
});
