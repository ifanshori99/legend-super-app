// Kelola area guard per path (bead legend-5bjh): a report.aggregate.view holder
// (the shareholder) opens only the 7 aggregate reports; /kelola, /audit and
// every other report still need dashboard.management.view.
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
const kelola = await import(`${base}/kelola-guard.ts`);
const dashboard = await import("../packages/shared/src/dashboard/index.ts");
const rbac = await import("../packages/shared/src/access/index.ts");

const shareholder = {
  authenticated: true,
  permissions: [...rbac.roleTemplate("shareholder").permissions],
  mfaRequired: true,
  mfaVerified: true,
};
const status = (access, pathname) =>
  guard.evaluateGuard(kelola.kelolaGuardForPath(pathname), access).status;

describe("legend-5bjh: shareholder reaches only the aggregate reports", () => {
  test("the shareholder holds report.aggregate.view and not the kelola permission", () => {
    assert.ok(shareholder.permissions.includes("report.aggregate.view"));
    assert.equal(
      shareholder.permissions.includes("dashboard.management.view"),
      false,
    );
    assert.equal(
      guard.evaluateArea(defs.AREAS.kelola, shareholder).status,
      "forbidden",
    );
  });

  test("each of the 7 aggregate report routes opens", () => {
    assert.equal(dashboard.AGGREGATE_VIEW_REPORT_CODES.length, 7);
    for (const code of dashboard.AGGREGATE_VIEW_REPORT_CODES) {
      const route = dashboard.reportRouteForCode(code);
      assert.equal(status(shareholder, route), "allowed", route);
      assert.equal(status(shareholder, `${route}/`), "allowed", route);
    }
  });

  test("/kelola, /audit, the builder and other reports stay closed", () => {
    const closed = [
      "/kelola",
      "/kelola/akuntansi",
      "/audit",
      "/reports",
      "/reports/builder",
      dashboard.reportRouteForCode("sales.per_employee"),
      dashboard.reportRouteForCode("finance.supplier_due"),
      `${dashboard.reportRouteForCode("sales.daily")}/extra`,
    ];
    for (const path of closed)
      assert.equal(status(shareholder, path), "forbidden", path);
  });

  test("without a second factor the aggregate report asks for it", () => {
    const route = dashboard.reportRouteForCode("sales.daily");
    assert.equal(
      status({ ...shareholder, mfaVerified: false }, route),
      "mfa_required",
    );
  });

  test("signed out stays unauthenticated; the management permission is unchanged", () => {
    const route = dashboard.reportRouteForCode("sales.daily");
    assert.equal(
      status({ ...shareholder, authenticated: false, permissions: [] }, route),
      "unauthenticated",
    );
    const manager = {
      ...shareholder,
      permissions: ["dashboard.management.view"],
    };
    for (const path of ["/kelola", "/audit", "/reports/builder", route])
      assert.equal(status(manager, path), "allowed", path);
    assert.deepEqual(defs.AREAS.kelola.guard.anyOf, [
      "dashboard.management.view",
    ]);
  });
});
