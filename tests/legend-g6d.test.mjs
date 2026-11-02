import assert from "node:assert/strict";
import { test } from "node:test";
import * as access from "../packages/shared/src/access/index.ts";
import { MESSAGE_KEYS } from "../packages/shared/src/i18n/index.ts";
import * as lib from "../apps/web/src/features/ws01-access/lib.ts";

// Acceptance tests for the RBAC admin screens (legend-g6d, PRD v1.7 §3 F7).
// Test names carry TEN-03 (outlet scope) and AUTH-06 (distinct approver).

const fixtures = access.cafeLegendAccessFixtures;
const now = fixtures.now;
const roles = fixtures.roles;
const roleOf = (key) => {
  const role = roles.find((row) => row.templateKey === key);
  assert.ok(role, `fixture role ${key}`);
  return role;
};

test("TEN-03 · scope picker offers only the scope types the role allows", () => {
  const cashier = roleOf("cashier");
  assert.deepEqual(lib.scopeOptionsForRole(cashier), ["outlet"]);
  const owner = roleOf("owner");
  assert.deepEqual(lib.scopeOptionsForRole(owner), ["tenant", "brand"]);
  // A grant at a station for an outlet-only role is not offered and would be
  // refused by the API (ROLE_SCOPE_NOT_ALLOWED).
  assert.equal(lib.scopeIsAllowed(cashier, { type: "station" }), false);
  assert.equal(lib.scopeIsAllowed(cashier, { type: "outlet" }), true);
});

test("TEN-03 · assignment rows keep the outlet scope that narrows the data", () => {
  const lookup = {
    brands: new Map([[fixtures.brandId, "Cafe Legend"]]),
    outlets: new Map([[fixtures.outletIds.bandung, "Cafe Legend Bandung"]]),
    stations: new Map([[fixtures.stations[0].id, fixtures.stations[0].name]]),
  };
  const outletScope = {
    type: "outlet",
    id: fixtures.outletIds.bandung,
  };
  assert.equal(lib.scopeName(outletScope, lookup), "Cafe Legend Bandung");
  assert.equal(lib.scopeName({ type: "tenant", id: null }, lookup), null);
  // An unknown id fails closed: the screen shows the type and a short id
  // rather than pretending the target is the whole tenant.
  assert.equal(
    lib.scopeName(
      { type: "outlet", id: "9e4b7c21-5d6f-4a8b-b3c0-1f2e3d4c5b6a" },
      lookup,
    ),
    null,
  );
  assert.equal(lib.scopeIsComplete({ type: "outlet", id: "" }), false);
  assert.equal(lib.scopeIsComplete(outletScope), true);
});

test("TEN-03 · validity windows: active, scheduled, expired", () => {
  const base = {
    validFrom: "2026-11-01T00:00:00.000Z",
    validUntil: null,
  };
  assert.equal(lib.assignmentStatus(base, now), "active");
  assert.equal(
    lib.assignmentStatus(
      { validFrom: "2026-12-01T00:00:00.000Z", validUntil: null },
      now,
    ),
    "scheduled",
  );
  assert.equal(
    lib.assignmentStatus(
      {
        validFrom: "2026-10-01T00:00:00.000Z",
        validUntil: "2026-10-31T00:00:00.000Z",
      },
      now,
    ),
    "expired",
  );
  assert.equal(lib.validityIsOrdered(null, "2026-12-01T00:00:00.000Z"), true);
  assert.equal(
    lib.validityIsOrdered(
      "2026-12-02T00:00:00.000Z",
      "2026-12-01T00:00:00.000Z",
    ),
    false,
  );
});

test("TEN-03 · holder counts include only assignments active now", () => {
  const counts = lib.activeHolderCounts(fixtures.assignments, now);
  for (const [roleId, count] of counts) {
    const expected = fixtures.assignments.filter(
      (row) =>
        row.roleId === roleId && lib.assignmentStatus(row, now) === "active",
    ).length;
    assert.equal(count, expected);
  }
  // Every role key present in the map has at least one active holder.
  for (const [roleId, count] of counts) {
    assert.ok(
      fixtures.assignments.some(
        (row) =>
          row.roleId === roleId && lib.assignmentStatus(row, now) === "active",
      ),
    );
    assert.ok(count >= 1);
  }
});

test("AUTH-06 · matrix rejects a tier without an approver role", () => {
  const draft = [
    {
      actionType: "refund",
      tiers: [
        {
          key: "tier-1",
          thresholdIdr: null,
          levels: [{ key: "level-1", roleId: "" }],
        },
      ],
    },
  ];
  const kinds = lib.matrixIssues(draft).map((issue) => issue.kind);
  assert.ok(kinds.includes("no_approver"));
  assert.ok(kinds.includes("missing_level"));
});

test("AUTH-06 · matrix maps contiguous levels and keeps thresholds", () => {
  const policies = fixtures.approvalPolicies.filter(
    (row) => row.actionType === "refund",
  );
  const draft = lib.matrixDraftFromPolicies(policies);
  const body = lib.matrixPoliciesFromDraft(draft);
  const mapped = body.filter((row) => row.actionType === "refund");
  assert.deepEqual(
    mapped.map((row) => [row.thresholdIdr, row.levels]),
    policies
      .sort(
        (a, b) =>
          (a.thresholdIdr ?? -1) - (b.thresholdIdr ?? -1) ||
          a.levels - b.levels,
      )
      .map((row) => [row.thresholdIdr, row.levels]),
  );
  // Levels are 1-based and contiguous per tier (approvalMatrixSchema rule).
  const byTier = new Map();
  for (const row of mapped) {
    const key = String(row.thresholdIdr);
    byTier.set(key, [...(byTier.get(key) ?? []), row.levels]);
  }
  for (const levels of byTier.values())
    assert.deepEqual(
      [...new Set(levels)].sort((a, b) => a - b),
      levels.map((_, index) => index + 1),
    );
  assert.equal(
    lib.matrixIssues(lib.matrixDraftFromPolicies(fixtures.approvalPolicies))
      .length,
    0,
  );
});

test("AUTH-06 · actions without a policy stay uncovered (fail closed)", () => {
  const draft = lib.matrixDraftFromPolicies(
    fixtures.approvalPolicies.filter((row) => row.actionType === "refund"),
  );
  const coverage = lib.matrixCoverage(draft);
  assert.equal(coverage.covered, 1);
  assert.equal(coverage.total, access.APPROVAL_ACTION_TYPES.length);
  assert.ok(coverage.uncovered.includes("payroll"));
  assert.ok(!coverage.uncovered.includes("refund"));
  // Adding an action flips it to covered once it has a tier.
  const withPayroll = lib.addActionRow(draft, "payroll");
  assert.equal(lib.matrixCoverage(withPayroll).covered, 2);
});

test("AUTH-06 · matrix editor surfaces non-contiguous levels and an empty matrix", () => {
  const draft = [
    {
      actionType: "discount",
      tiers: [
        {
          key: "tier-1",
          thresholdIdr: 50_000,
          levels: [
            { key: "level-1", roleId: "role-a" },
            { key: "level-2", roleId: "role-b" },
            { key: "level-3", roleId: "role-c" },
          ],
        },
      ],
    },
  ];
  assert.equal(lib.matrixIssues(draft).length, 0);
  const empty = [{ actionType: "discount", tiers: [] }];
  assert.ok(lib.matrixIssues(empty).some((issue) => issue.kind === "empty"));
  const negative = [
    {
      actionType: "expense",
      tiers: [
        {
          key: "tier-1",
          thresholdIdr: -1,
          levels: [{ key: "level-1", roleId: "role-a" }],
        },
      ],
    },
  ];
  assert.ok(
    lib.matrixIssues(negative).some((issue) => issue.kind === "bad_threshold"),
  );
});

test("text contract · every tenant permission and approval action has a label", () => {
  for (const permission of access.PERMISSION_CODES) {
    if (access.permissionHasTag(permission, "platform")) continue;
    assert.ok(
      MESSAGE_KEYS.includes(`access.perm.${permission}`),
      `missing label for ${permission}`,
    );
  }
  for (const action of access.APPROVAL_ACTION_TYPES)
    assert.ok(
      MESSAGE_KEYS.includes(`access.action.${action}`),
      `missing label for ${action}`,
    );
});

test("legend-g6d · role filters split templates from custom roles", () => {
  const templates = lib.filterRoles(roles, { kind: "template" });
  assert.ok(templates.every((role) => role.isTemplate));
  assert.equal(
    templates.length,
    roles.filter((role) => role.isTemplate).length,
  );
  const custom = lib.filterRoles(roles, { kind: "custom" });
  assert.ok(custom.length > 0);
  assert.ok(custom.every((role) => lib.roleKind(role) === "custom"));
  // "Waiter" and the custom "Waiter + Pembayaran" both match.
  assert.equal(lib.filterRoles(roles, { search: "waiter" }).length, 2);
  assert.equal(lib.filterRoles(roles, { search: "zzz" }).length, 0);
});

test("legend-g6d · MFA is forced for a custom role that reaches finance or payroll (AUTH-05)", () => {
  assert.equal(lib.customRoleMfaRequired(["payroll.view"]), true);
  assert.equal(lib.customRoleMfaRequired(["access.role.manage"]), true);
  assert.equal(lib.customRoleMfaRequired(["menu.item.view"]), false);
  assert.equal(
    lib.customRoleMfaRequired(["menu.item.view", "payroll.view"]),
    true,
  );
});
