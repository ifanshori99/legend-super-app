import assert from "node:assert/strict";
import { test } from "node:test";
import * as lib from "../apps/web/src/features/ws01-access/lib.ts";

// legend-wc69d (WS-01 FE RBAC admin): the grant dialog offers only roles the
// viewer may hand out (assertCanGrantRole). Owner comes from an Owner only;
// other roles need every permission held at tenant scope, or top authority.
// The API decides again; the helper only keeps the screen from offering what
// it will refuse.

const NOW = new Date("2026-11-13T10:00:00.000Z");
const PAST = "2026-01-01T00:00:00.000Z";
const FUTURE = "2027-01-01T00:00:00.000Z";
const TENANT = { type: "tenant" };
const BRAND = { type: "brand", id: "b1" };

const role = (id, templateKey, permissions = []) => ({
  id,
  templateKey,
  permissions,
});
const roles = [
  role("r-owner", "owner", ["access.role.assign", "access.role.manage"]),
  role("r-admin", "tenant_admin", ["access.role.assign", "access.role.manage"]),
  role("r-manager", "manager", ["access.role.assign", "menu.item.view"]),
  role("r-custom", null, ["access.role.assign"]),
  role("r-menu", null, ["menu.item.view", "menu.item.edit"]),
  role("r-empty", null, []),
];
const assignment = (id, userId, roleId, over = {}) => ({
  id,
  tenantId: "t1",
  userId,
  roleId,
  scope: TENANT,
  validFrom: PAST,
  validUntil: null,
  assignedBy: "x",
  assignedAt: PAST,
  ...over,
});
// An explicit `undefined` must reach the helper (a default parameter would turn
// it into "viewer"), so the unknown-viewer case really runs.
const ids = (viewerAssignments, ...rest) => {
  const viewerUserId = rest.length ? rest[0] : "viewer";
  return lib
    .grantableRoles({ roles, viewerUserId, viewerAssignments, now: NOW })
    .map((r) => r.id);
};

test("wc69d · Owner sees every role, Owner included", () => {
  assert.deepEqual(
    ids([assignment("a1", "viewer", "r-owner")]),
    roles.map((r) => r.id),
  );
});

test("wc69d · Admin Tenant never sees the Owner role", () => {
  const list = ids([assignment("a1", "viewer", "r-admin")]);
  assert.ok(!list.includes("r-owner"));
  assert.ok(list.includes("r-admin") && list.includes("r-menu"));
});

test("wc69d · custom role holder sees only roles within what they hold", () => {
  assert.deepEqual(ids([assignment("a1", "viewer", "r-custom")]), [
    "r-custom",
    "r-empty",
  ]);
});

test("wc69d · manager does not see roles with permissions it lacks", () => {
  // r-custom holds only access.role.assign, which the manager has too; the
  // owner and admin roles need access.role.manage, which it lacks.
  const list = ids([assignment("a1", "viewer", "r-manager")]);
  assert.deepEqual(list, ["r-manager", "r-custom", "r-empty"]);
});

test("wc69d · brand-scoped, ended and future assignments grant nothing", () => {
  for (const over of [
    { scope: BRAND },
    { validUntil: PAST },
    { validFrom: FUTURE },
  ]) {
    const list = ids([assignment("a1", "viewer", "r-owner", over)]);
    assert.deepEqual(list, ["r-empty"], JSON.stringify(over));
  }
});

test("wc69d · another user's assignment never counts", () => {
  assert.deepEqual(ids([assignment("a1", "eve", "r-owner")]), ["r-empty"]);
});

test("wc69d · unknown viewer or loading data fails closed", () => {
  assert.deepEqual(ids([assignment("a1", "viewer", "r-owner")], undefined), [
    "r-empty",
  ]);
  assert.deepEqual(ids([]), ["r-empty"]);
});
